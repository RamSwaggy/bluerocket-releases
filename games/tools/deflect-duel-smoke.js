/* =====================================================================
   deflect-duel-smoke.js — plays a whole Deflect Duel match with bots in
   a headless browser, checks the game's rules hold on every frame, and
   reports what happened.

   Usage (from the games folder):
     node tools/deflect-duel-smoke.js [players] [speed] [timeoutSec] [lives]
     node tools/deflect-duel-smoke.js 4 8 180
     node tools/deflect-duel-smoke.js 2 8 120 5

     players     2–4 bot cars (default 4)
     speed       game-speed multiplier for the demo (default 8)
     timeoutSec  give up after this many real seconds (default 180)
     lives       lives per car (default 3)

   It opens deflect-duel/index.html?demo&players=N&lives=L&speed=S and
   reads the game through the agreed test interface:
     TP.duel      players[] { name, lives, out, invuln, pos, airborne, kos }
                  ball { pos, vel, speed, owner, neutral }
                  freezeLeft, state ("serve" | "play" | "over"), winner, koLog[]
     TP.DUEL_CFG  arenaW, arenaD, maxSpeed, ...

   What it checks (any failure = FAIL):
     • no page errors, no console errors
     • no "[Rocket Rumble] ... can't be changed per mode" warning (a mode
       tried to change part of the shared car feel)
     • a car's lives never go up, and a car that is out stays out
     • ball speed is never NaN/Infinity and never over DUEL_CFG.maxSpeed
     • ball and every car still in play stay inside the arena walls
     • the match reaches state "over" before the time limit
     • at the end there is exactly one winner, it has more than 0 lives,
       and every other car is out

   The rule checks run INSIDE the page on every animation frame (not just
   at the 3-second status lines), so a ball that leaves the arena for a
   single frame is still caught.

   Prints a status line every 3 s, then the final result.
   Exit code 0 = PASS, 1 = FAIL (including "the game isn't built yet").

   Test hook: set DEFLECT_DUEL_INDEX=/path/to/index.html to point the
   test at a different copy of the game (used to test this script itself).

   Needs Playwright (pre-installed in cloud sessions; on Windows run
   `npm i -g playwright` then `npx playwright install chromium` once).
   ===================================================================== */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// ---------- Arguments ----------
const players = Number(process.argv[2] || 4);
const speed = Number(process.argv[3] || 8);
const timeoutSec = Number(process.argv[4] || 180);
const lives = Number(process.argv[5] || 3);

// Stop early with a clear message if the arguments make no sense, rather
// than launching a browser and failing in a confusing way later.
function usageFail(msg) {
  console.log(`Bad arguments: ${msg}`);
  console.log("Usage: node tools/deflect-duel-smoke.js [players 2-4] [speed] [timeoutSec] [lives]");
  console.log("RESULT: FAIL (bad arguments)");
  process.exit(1);
}
if (!Number.isInteger(players) || players < 2 || players > 4) usageFail(`players must be 2, 3 or 4 (got "${process.argv[2]}")`);
if (!(speed > 0)) usageFail(`speed must be a positive number (got "${process.argv[3]}")`);
if (!(timeoutSec > 0)) usageFail(`timeoutSec must be a positive number (got "${process.argv[4]}")`);
if (!Number.isInteger(lives) || lives < 1) usageFail(`lives must be a whole number of at least 1 (got "${process.argv[5]}")`);

// ---------- Is the game there at all? ----------
// While Deflect Duel is still being built, duel.js / main.js don't exist.
// Say so plainly instead of reporting a wall of "file not found" errors.
const indexFile = path.resolve(process.env.DEFLECT_DUEL_INDEX || path.join(__dirname, "../deflect-duel/index.html"));
const gameDir = path.dirname(indexFile);
const missing = ["index.html", "js/duel.js", "js/main.js"].filter((f) => !fs.existsSync(path.join(gameDir, f)));
if (missing.length) {
  console.log(`Deflect Duel isn't playable yet: missing ${missing.map((f) => "deflect-duel/" + f).join(", ")}.`);
  console.log("RESULT: FAIL (game files missing; nothing to test)");
  process.exit(1);
}

// How far outside the walls something may be before it counts as escaped.
// Positions are centres, so a little slack covers the ball/car radius and
// a frame of overlap before the wall pushes back.
const BALL_SLACK = 1.0;
const CAR_SLACK = 1.5;

/* ---------- The in-page rule monitor ----------
   This function is sent into the page and runs on every animation frame.
   It only READS the game state and writes what it finds into
   window.__ddQC; it never changes the game. It must not throw (an error
   here would look like a game error), so everything is wrapped in try. */
function installMonitor({ ballSlack, carSlack }) {
  const qc = (window.__ddQC = {
    frames: 0,           // frames on which TP.duel existed
    violations: [],      // first few rule breaks, as text
    violationCount: 0,
    maxBallSpeed: 0,
    lastLives: null,     // lives per car on the previous frame
    wasOut: null,        // which cars have been out
    monitorError: "",
  });

  // Positions might be THREE.Vector3s, plain {x,y,z} objects or [x,y,z]
  // arrays. Read x (across the arena) and z (into the arena) from any of them.
  const xz = (p) => (Array.isArray(p) ? { x: p[0], z: p[2] } : p ? { x: p.x, z: p.z } : { x: NaN, z: NaN });
  const finite = (n) => typeof n === "number" && Number.isFinite(n);

  function flag(msg) {
    qc.violationCount++;
    // Keep the first 20 so one runaway bug doesn't flood the report.
    if (qc.violations.length < 20) {
      const t = (performance.now() / 1000).toFixed(2);
      qc.violations.push(`[${t}s, state=${window.TP.duel.state}] ${msg}`);
    }
  }

  function check() {
    const d = window.TP && window.TP.duel;
    const cfg = window.TP && window.TP.DUEL_CFG;
    if (!d || !cfg) return;
    qc.frames++;

    const halfW = cfg.arenaW / 2, halfD = cfg.arenaD / 2;
    const ps = d.players || [];

    // --- Lives never go up; out stays out ---
    if (!qc.lastLives) { qc.lastLives = ps.map((p) => p.lives); qc.wasOut = ps.map((p) => !!p.out); }
    ps.forEach((p, i) => {
      if (!finite(p.lives)) flag(`${p.name}: lives is ${p.lives}`);
      else if (p.lives > qc.lastLives[i]) flag(`${p.name}: lives went UP from ${qc.lastLives[i]} to ${p.lives}`);
      if (qc.wasOut[i] && !p.out) flag(`${p.name}: was out, now back in`);
      if (p.lives <= 0 && !p.out) flag(`${p.name}: has ${p.lives} lives but isn't marked out`);
      qc.lastLives[i] = p.lives;
      qc.wasOut[i] = qc.wasOut[i] || !!p.out;
    });

    // --- Ball speed: a real number, never over the cap ---
    const b = d.ball;
    if (b) {
      if (!finite(b.speed)) flag(`ball speed is ${b.speed}`);
      else {
        qc.maxBallSpeed = Math.max(qc.maxBallSpeed, b.speed);
        if (b.speed > cfg.maxSpeed * 1.001) flag(`ball speed ${b.speed.toFixed(2)} is over maxSpeed ${cfg.maxSpeed}`);
      }
      // The velocity vector itself must agree with the cap too.
      if (b.vel) {
        const v = Array.isArray(b.vel) ? { x: b.vel[0], y: b.vel[1] || 0, z: b.vel[2] } : b.vel;
        const mag = Math.hypot(v.x, v.y || 0, v.z);
        if (!finite(mag)) flag(`ball velocity is not a number (${JSON.stringify(b.vel)})`);
        else if (mag > cfg.maxSpeed * 1.01) flag(`ball velocity length ${mag.toFixed(2)} is over maxSpeed ${cfg.maxSpeed}`);
      }
      // --- Ball inside the walls ---
      const bp = xz(b.pos);
      if (!finite(bp.x) || !finite(bp.z)) flag(`ball position is not a number (${JSON.stringify(b.pos)})`);
      else if (Math.abs(bp.x) > halfW + ballSlack || Math.abs(bp.z) > halfD + ballSlack)
        flag(`ball escaped the arena at x=${bp.x.toFixed(2)}, z=${bp.z.toFixed(2)} (walls at ±${halfW}, ±${halfD})`);
    }

    // --- Cars still in play stay inside the walls ---
    ps.forEach((p) => {
      if (p.out) return; // knocked-out cars may be parked off-stage
      const cp = xz(p.pos);
      if (!finite(cp.x) || !finite(cp.z)) flag(`${p.name}: position is not a number (${JSON.stringify(p.pos)})`);
      else if (Math.abs(cp.x) > halfW + carSlack || Math.abs(cp.z) > halfD + carSlack)
        flag(`${p.name}: left the arena at x=${cp.x.toFixed(2)}, z=${cp.z.toFixed(2)}`);
    });
  }

  function loop() {
    try { check(); } catch (e) { if (!qc.monitorError) qc.monitorError = String(e && e.stack || e); }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

/* ---------- Status snapshot (read once every 3 s) ---------- */
function snapshot() {
  const d = window.TP && window.TP.duel;
  const qc = window.__ddQC || {};
  const nameOf = (who) => {
    if (who === null || who === undefined || who === -1) return "";
    if (typeof who === "number") return (d.players[who] || {}).name || `#${who}`;
    if (typeof who === "string") return who;
    return who.name || "?";
  };
  if (!d) return { ready: false };
  const overlay = document.getElementById("overlay");
  const card = document.getElementById("card");
  return {
    ready: true,
    state: d.state,
    players: (d.players || []).map((p) => ({ name: p.name, lives: p.lives, out: !!p.out, kos: p.kos })),
    ballSpeed: d.ball ? d.ball.speed : NaN,
    ballOwner: d.ball ? (d.ball.neutral ? "neutral" : nameOf(d.ball.owner)) : "",
    freezeLeft: d.freezeLeft,
    koCount: (d.koLog || []).length,
    winnerRaw: d.winner === undefined ? null : (typeof d.winner === "object" && d.winner ? { name: d.winner.name } : d.winner),
    winnerName: nameOf(d.winner),
    maxSpeed: window.TP.DUEL_CFG ? window.TP.DUEL_CFG.maxSpeed : NaN,
    maxBallSpeed: qc.maxBallSpeed || 0,
    frames: qc.frames || 0,
    violations: qc.violations || [],
    violationCount: qc.violationCount || 0,
    monitorError: qc.monitorError || "",
    card: overlay && overlay.classList.contains("show") && card ? card.innerText : "",
  };
}

(async () => {
  let browser = null;
  let exitCode = 1;

  // One place that closes the browser and exits, used by every path out.
  async function finish(code) {
    exitCode = code;
    if (browser) { try { await browser.close(); } catch (e) { /* already gone */ } browser = null; }
    process.exit(exitCode);
  }
  process.on("SIGINT", () => { console.log("\nInterrupted."); console.log("RESULT: FAIL (interrupted)"); finish(1); });

  try {
    // SwiftShader = software WebGL, so this works on machines with no GPU.
    browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    const errors = [];
    page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
    page.on("console", (m) => {
      const text = m.text();
      if (m.type() === "error") errors.push("CONSOLE ERROR: " + text);
      // The shared car feel guard (TP.modeTuning) warns like this when a
      // mode tries to change a setting it isn't allowed to.
      else if (m.type() === "warning" && text.includes("[Rocket Rumble]")) errors.push("CAR-FEEL WARNING: " + text);
    });

    const url = "file:///" + indexFile.replace(/\\/g, "/") + `?demo&players=${players}&lives=${lives}&speed=${speed}`;
    console.log(`Deflect Duel smoke: ${players} bots, ${lives} lives, speed ×${speed}, limit ${timeoutSec}s`);
    await page.goto(url);

    // Wait for the test interface to show up before installing the monitor.
    try {
      await page.waitForFunction(() => window.TP && window.TP.duel && window.TP.DUEL_CFG, null, { timeout: 20000 });
    } catch (e) {
      console.log("\nTP.duel / TP.DUEL_CFG never appeared within 20 s (is ?demo mode wired up?).");
      if (errors.length) console.log("\nERRORS:\n" + errors.join("\n"));
      console.log("RESULT: FAIL (test interface not found)");
      return finish(1);
    }
    await page.evaluate(installMonitor, { ballSlack: BALL_SLACK, carSlack: CAR_SLACK });

    // ---------- Watch the match ----------
    let s = null;
    let over = false;
    const started = Date.now();
    while (!over && (Date.now() - started) / 1000 < timeoutSec) {
      await page.waitForTimeout(3000);
      s = await page.evaluate(snapshot);
      const t = Math.round((Date.now() - started) / 1000);
      const livesLine = s.players.map((p) => `${p.name} ${p.out ? "OUT" : "♥" + p.lives}`).join(" | ");
      const ball = `ball ${Number.isFinite(s.ballSpeed) ? s.ballSpeed.toFixed(1) : s.ballSpeed} ${s.ballOwner || "-"}`;
      console.log(`${String(t).padStart(4)}s  ${String(s.state).padEnd(5)}  ${livesLine}  ·  ${ball}  ·  KOs ${s.koCount}${s.violationCount ? `  ·  ⚠ ${s.violationCount} rule breaks` : ""}`);
      over = s.state === "over";
    }
    // Let the monitor see the final frame and the results screen settle.
    await page.waitForTimeout(500);
    s = await page.evaluate(snapshot);

    // ---------- Final checks ----------
    const fails = [];
    if (s.monitorError) fails.push("The QC monitor itself crashed reading TP.duel (interface shape changed?): " + s.monitorError.split("\n")[0]);
    if (s.frames === 0) fails.push("The monitor never saw a frame (TP.duel disappeared?)");
    if (s.violationCount) fails.push(`${s.violationCount} rule break(s) during the match:\n    ` + s.violations.join("\n    ") + (s.violationCount > s.violations.length ? `\n    ... and ${s.violationCount - s.violations.length} more` : ""));

    if (s.state !== "over") {
      fails.push(`Match didn't finish within ${timeoutSec}s (state is "${s.state}")`);
    } else {
      // Exactly one winner, with lives left; everyone else out.
      const alive = s.players.filter((p) => !p.out && p.lives > 0);
      const w = s.players.find((p) => p.name === s.winnerName);
      if (!s.winnerName) fails.push(`State is "over" but there's no winner (TP.duel.winner = ${JSON.stringify(s.winnerRaw)})`);
      else if (!w) fails.push(`Winner "${s.winnerName}" isn't one of the players`);
      else {
        if (!(w.lives > 0)) fails.push(`Winner ${w.name} has ${w.lives} lives (should be more than 0)`);
        if (w.out) fails.push(`Winner ${w.name} is marked out`);
      }
      if (alive.length !== 1) fails.push(`Expected exactly 1 car left at the end, found ${alive.length}: ${alive.map((p) => p.name).join(", ") || "none"}`);
      else if (w && alive[0].name !== w.name) fails.push(`Winner is ${w.name} but the car left standing is ${alive[0].name}`);
    }
    fails.push(...errors);

    // ---------- Report ----------
    console.log("\nFinal: " + s.players.map((p) => `${p.name} ${p.out ? "OUT" : p.lives + " lives"} (${p.kos ?? "?"} KOs)`).join(" | "));
    console.log(`Winner: ${s.winnerName || "none"}   KOs logged: ${s.koCount}   top ball speed: ${s.maxBallSpeed.toFixed(1)} / cap ${s.maxSpeed}   frames checked: ${s.frames}`);
    if (s.card) console.log("\nResults card:\n" + s.card.replace(/\n+/g, "\n"));

    if (fails.length) {
      console.log("\nPROBLEMS:\n- " + fails.join("\n- "));
      console.log(s.state === "over" ? "RESULT: FAIL (rule or error check failed)" : "RESULT: FAIL (match did not finish)");
      return finish(1);
    }
    console.log("\nNo page errors. All rule checks held.");
    console.log("RESULT: PASS (match finished)");
    return finish(0);
  } catch (e) {
    console.log("\nThe test script hit an error: " + (e && e.stack || e));
    console.log("RESULT: FAIL (test crashed)");
    return finish(1);
  }
})();
