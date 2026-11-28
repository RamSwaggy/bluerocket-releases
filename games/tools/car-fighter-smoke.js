/* =====================================================================
   car-fighter-smoke.js — plays one whole Car Fighter match, bot vs bot,
   in a headless browser (rendering ON, so the real page is exercised),
   and checks that it behaves.

   Usage (from the games folder):
     node tools/car-fighter-smoke.js [speed] [maxSeconds] [seed]
     node tools/car-fighter-smoke.js 8 180 12345

   Optional flags (anywhere on the command line):
     --page=<path>   test a different page (default car-fighter/index.html)
     --extra=<query> extra URL options, e.g. --extra="&p1=haulback&bot=hard"

   What PASS means:
     • fight.state.phase reaches "matchEnd" before maxSeconds (wall clock)
     • no page errors and no console errors
     • every game frame (we wrap fight.step) passes the sanity checks:
         - no NaN / Infinity anywhere in fight.state
         - 0 <= health <= maxHealth for both cars
         - 0 <= super <= 300
         - both cars inside the arena (see ARENA below)
     • 2 to 4 rounds were played (best of 3, plus a possible sudden death)

   It prints one line per round (winner, how it ended, length, health
   left on both cars) and exits 0 on PASS, 1 on FAIL.

   The fight-core contract this relies on is DESIGN.md §9:
     window.TP.fight.state / .events / .step(), TP.MOVES, TP.FIGHTERS.
   Needs Playwright (pre-installed in cloud sessions).
   ===================================================================== */
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

// ---- Command line: positional numbers plus a couple of --flags. ----
const flags = {};
const pos = [];
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) flags[m[1]] = m[2];
  else pos.push(a);
}
const speed = Number(pos[0] || 8);
const maxSeconds = Number(pos[1] || 180);
const seed = Number(pos[2] || 12345);
const pagePath = path.resolve(__dirname, "..", flags.page || "car-fighter/index.html");

/* Arena bounds used by the "cars inside the arena" check.
   DESIGN.md doesn't give the turntable size yet, so if the game exposes
   TP.Fight.ARENA ({ halfX, halfZ, minY, maxY }) we use that; otherwise
   these generous defaults only catch cars that have flown off for good. */
const DEFAULT_ARENA = { halfX: 40, halfZ: 40, minY: -2, maxY: 60 };

(async () => {
  // SwiftShader = software WebGL, so this works on machines with no GPU.
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE ERROR: " + m.text()); });

  const url = pathToFileURL(pagePath).href + `?demo&speed=${speed}&seed=${seed}` + (flags.extra || "");
  console.log("Loading " + url);
  let result = { finished: false, reason: "" };

  try {
    await page.goto(url);
    // Wait for match.js to publish the fight for tests.
    await page.waitForFunction(() => window.TP && TP.fight && TP.fight.state, null, { timeout: 30000 });

    // ---- Install the per-frame checker inside the page. ----
    // We wrap fight.step so the checks run after EVERY game frame, however
    // many frames match.js runs per animation frame at high speed.
    await page.evaluate((DEFAULT_ARENA) => {
      const fight = TP.fight;
      const A = Object.assign({}, DEFAULT_ARENA, (TP.Fight && TP.Fight.ARENA) || {});
      const qc = (window.__qc = {
        framesChecked: 0,
        violations: [],        // first few problems, with the frame they happened on
        violationCount: 0,
        rounds: [],            // one entry per round_end event
        roundStartFrame: 0,
        lastPhase: fight.state.phase,
      });

      function flag(msg) {
        qc.violationCount++;
        if (qc.violations.length < 20) qc.violations.push(`frame ${fight.state.frame}: ${msg}`);
      }

      // Walk the whole state object looking for NaN / Infinity in any number.
      function findBadNumbers(obj, where, depth) {
        if (depth > 6 || obj === null || obj === undefined) return;
        if (typeof obj === "number") { if (!Number.isFinite(obj)) flag(`${where} is ${obj}`); return; }
        if (typeof obj !== "object") return;
        for (const k of Object.keys(obj)) findBadNumbers(obj[k], `${where}.${k}`, depth + 1);
      }

      function check() {
        const s = fight.state;
        qc.framesChecked++;
        findBadNumbers(s, "state", 0);
        (s.cars || []).forEach((c, i) => {
          const who = `P${i + 1}`;
          if (c.health < 0 || c.health > c.maxHealth) flag(`${who} health ${c.health} outside 0..${c.maxHealth}`);
          if (c.super < 0 || c.super > 300) flag(`${who} super ${c.super} outside 0..300`);
          if (Math.abs(c.x) > A.halfX || Math.abs(c.z) > A.halfZ || c.y < A.minY || c.y > A.maxY)
            flag(`${who} outside arena at (${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)})`);
        });
        if (s.phase !== qc.lastPhase) qc.lastPhase = s.phase;
      }

      /* Record a summary line each time a round ends, using the state at that
         moment. We read new entries from fight.events after each step rather
         than calling fight.onEvent, in case onEvent only holds one listener
         (we mustn't knock out Art and UI's sparks and sounds). */
      qc.eventIndex = 0;
      function readNewEvents() {
        const list = fight.events || [];
        for (; qc.eventIndex < list.length; qc.eventIndex++) onEvent(list[qc.eventIndex]);
      }
      function onEvent(e) {
        const s = fight.state;
        if (e.type === "round_start") qc.roundStartFrame = e.frame;
        if (e.type === "round_end") {
          const rr = (s.roundResults || [])[qc.rounds.length] || {};
          qc.rounds.push({
            round: s.round,
            frames: e.frame - qc.roundStartFrame,
            timer: s.timer,
            winner: e.winner !== undefined ? e.winner : rr.winner,
            reason: e.reason || rr.reason || rr.type || null,
            health: s.cars.map((c) => [c.health, c.maxHealth]),
          });
        }
      }

      const realStep = fight.step.bind(fight);
      fight.step = function (inputs) {
        const r = realStep(inputs);
        try { check(); readNewEvents(); } catch (err) { flag("checker crashed: " + err.message); }
        return r;
      };
    }, DEFAULT_ARENA);

    // ---- Watch the match, printing a status line every 3 seconds. ----
    for (let t = 0; t < maxSeconds; t += 3) {
      await page.waitForTimeout(3000);
      const s = await page.evaluate(() => {
        const st = TP.fight.state;
        return {
          phase: st.phase, round: st.round, timer: st.timer, wins: st.roundWins,
          hp: st.cars.map((c) => Math.round(c.health)), frames: __qc.framesChecked,
        };
      });
      console.log(`${String(t + 3).padStart(4)}s  ${String(s.phase).padEnd(9)} round ${s.round}  timer ${Number(s.timer).toFixed(1).padStart(5)}  ` +
        `HP ${s.hp.join(" / ")}  wins ${JSON.stringify(s.wins)}  (${s.frames} frames checked)`);
      if (s.phase === "matchEnd") { result.finished = true; break; }
    }
    if (!result.finished) result.reason = `phase never reached "matchEnd" within ${maxSeconds}s`;

    // ---- Collect the report. ----
    const qc = await page.evaluate(() => ({
      ...__qc,
      winner: TP.fight.state.winner,
      roundWins: TP.fight.state.roundWins,
    }));

    console.log("\nRounds:");
    for (const r of qc.rounds) {
      // Work out how the round ended if the game didn't say.
      const [h1, h2] = r.health;
      let how = r.reason;
      if (!how) {
        if (h1[0] <= 0 && h2[0] <= 0) how = "double KO";
        else if (h1[0] <= 0 || h2[0] <= 0) how = "KO";
        else if (r.timer <= 0.0001) how = h1[0] / h1[1] === h2[0] / h2[1] ? "time-out draw" : "time-out";
        else how = "?";
      }
      const who = r.winner === 0 ? "P1" : r.winner === 1 ? "P2" : r.winner === null || r.winner === -1 || r.winner === "draw" ? "draw" : String(r.winner);
      console.log(`  Round ${r.round}: ${who.padEnd(4)} by ${String(how).padEnd(13)} ${(r.frames / 60).toFixed(1).padStart(5)}s   ` +
        `HP left P1 ${Math.round(h1[0])}/${h1[1]}  P2 ${Math.round(h2[0])}/${h2[1]}`);
    }
    console.log(`Match winner: ${qc.winner === 0 ? "P1" : qc.winner === 1 ? "P2" : qc.winner}   round wins ${JSON.stringify(qc.roundWins)}`);
    console.log(`Frames checked: ${qc.framesChecked}`);

    if (result.finished && (qc.rounds.length < 2 || qc.rounds.length > 4)) {
      result.finished = false;
      result.reason = `${qc.rounds.length} rounds played (expected 2 to 4)`;
    }
    if (qc.framesChecked === 0) errors.push("CHECKER: fight.step was never called after the checker was installed");
    if (qc.violationCount) {
      errors.push(`CHECKS: ${qc.violationCount} state violations, first ones:\n  ` + qc.violations.join("\n  "));
    }
  } catch (err) {
    result.reason = "tool error: " + err.message;
  }

  console.log(errors.length ? "\nERRORS:\n" + errors.join("\n") : "\nNo page errors, all per-frame checks passed.");
  const pass = result.finished && !errors.length;
  console.log(pass ? "RESULT: PASS (match finished)" : `RESULT: FAIL (${result.reason || "errors above"})`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})();
