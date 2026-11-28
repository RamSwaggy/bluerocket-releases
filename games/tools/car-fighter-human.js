/* =====================================================================
   car-fighter-human.js — plays Car Fighter the way a person would: it
   opens the real page, uses the real menu, and presses real keyboard
   keys (kb1: WASD, Space, E = Hit, R = Heavy) through Playwright. Then
   it checks fight.state and fight.events to see that each control does
   what DESIGN.md says.

   Usage (from the games folder):
     node tools/car-fighter-human.js            # moves + results card
     node tools/car-fighter-human.js moves      # only the controls part
     node tools/car-fighter-human.js results    # only the results card part
     node tools/car-fighter-human.js throws     # only the throws (training dummy)
   Options: --p1=rivet|haulback|skitter (P1's car, default rivet)
            --p2=...  (the bot's car, default rivet)  --diff=easy (the bot)

   Part 1, "moves": open car-fighter/index.html with no query string, set
   P1 to keyboard 1 and P2 to an Easy bot, click "Choose cars →", pick each
   seat's car on the select screen, click Fight!, check the fight really
   uses those cars, wait for phase "fight",
   then check, one at a time (each gets a few tries, because the bot
   moves and attacks on its own):
     walk      A / D moves P1 along the line
     block     holding away while the bot attacks gives a "block" event,
               chip damage only, and no hit-stun
     chain     E E E gives Jab > Swipe > Spinout
     heavy     R gives Ram
     launcher  toward + R gives Corkscrew
     (throw and throw30 run against the training dummy: see Part 1b)
     sidestep  tapping W puts P1 in the "sidestep" state
     flipkick  Space, then E in the air, gives Flip Kick
   A move "works" when the move starts from the key presses; whether it
   also connected (hit / block / throw) is printed alongside.

   Part 2, "results": opens index.html?roundTime=20, goes through the menu
   and car select the same way, lets
   the bot win, then checks the results card: Rematch starts a fresh
   match, and Menu goes back to the menu.

   Exit code 0 = every check passed and there were no page errors.
   Needs Playwright (pre-installed in cloud sessions). It runs in real
   time (keyboard input can't be fast-forwarded), so it takes a couple
   of minutes; run it in the background.
   ===================================================================== */
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const flags = {};
const pos = [];
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) flags[m[1]] = m[2];
  else pos.push(a);
}
const which = pos[0] || "all";
const P1CAR = flags.p1 || "rivet", P2CAR = flags.p2 || "rivet", DIFF = flags.diff || "easy";
const PAGE = pathToFileURL(path.resolve(__dirname, "../car-fighter/index.html")).href;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(9)} ${detail}`);
}

/* ---------- Browser and page helpers ---------- */
async function openPage(browser, query, errors) {
  // A small window: headless Chromium draws WebGL in software, and at
  // 1280x720 it only manages ~10 frames a second. Each rendered frame then
  // covers ~6 fight frames, so two keys pressed 30 ms apart land 6 fight
  // frames apart, past the 3-frame throw window. 640x360 draws about 4x
  // faster, which is much closer to what a person's browser does.
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE ERROR: " + m.text()); });
  await page.goto(PAGE + (query || ""));
  await page.waitForSelector("#next", { timeout: 30000 });
  return page;
}

/* The real M2 menu flow: seats → "Choose cars →" (#next) → car select →
   Fight! (#fight). Checks the fight that starts uses the cars picked. */
async function startFromMenu(page, p1car, p2car, diff) {
  await page.selectOption("#ctrl0", "kb1");
  await page.selectOption("#ctrl1", "bot");
  await page.selectOption("#diff1", diff).catch(() => {});
  await page.click("#next");
  await page.waitForSelector("#fight", { timeout: 10000 });
  await page.click(`.tile[data-seat="0"][data-car="${p1car}"]`);
  await page.click(`.tile[data-seat="1"][data-car="${p2car}"]`);
  await page.click("#fight");
  await waitForFight(page);
  const got = await page.evaluate(() => TP.fight.state.cars.map((c) => c.fighter));
  record("carselect", got[0] === p1car && got[1] === p2car, `picked ${p1car} vs ${p2car} (bot ${diff}); the fight has ${got.join(" vs ")}`);
}

/* A recorder inside the page: after every fight step it logs P1's and
   P2's state and move, so short states (a sidestep, a 4-frame jab) can't
   slip between our polls. It re-attaches itself when a new fight starts
   (Rematch makes a new TP.fight). */
async function installRecorder(page) {
  await page.evaluate(() => {
    const rec = (window.__rec = { log: [], fight: null });
    function attach() {
      const f = window.TP && TP.fight;
      if (f && f !== rec.fight && !f.__recWrapped) {
        rec.fight = f;
        f.__recWrapped = true;
        const step = f.step.bind(f);
        f.step = (inputs) => {
          const r = step(inputs);
          const s = f.state;
          rec.log.push({ frame: s.frame, phase: s.phase, c: s.cars.map((c) => [c.state, c.move]) });
          if (rec.log.length > 20000) rec.log.splice(0, 10000);
          return r;
        };
      }
      requestAnimationFrame(attach);
    }
    attach();
  });
}

// Plain snapshot of the fight for decisions in Node.
const snap = (page) => page.evaluate(() => {
  const s = TP.fight.state;
  return {
    frame: s.frame, phase: s.phase, round: s.round, wins: s.roundWins,
    cars: s.cars.map((c) => ({ x: c.x, z: c.z, y: c.y, state: c.state, move: c.move, hp: c.health })),
    nEv: TP.fight.events.length, logLen: window.__rec ? __rec.log.length : 0,
  };
});
const eventsSince = (page, n) => page.evaluate((n) => TP.fight.events.slice(n), n);
const logSince = (page, n) => page.evaluate((n) => __rec.log.slice(n), n);

// Wait until a fight phase is running (handles round cards and countdowns).
async function waitForFight(page, ms = 20000) {
  await page.waitForFunction(() => window.TP && TP.fight && TP.fight.state.phase === "fight", null, { timeout: ms });
}

/* A real key tap: down, held a moment, up. Playwright's
   keyboard.press() sends down and up back to back, inside one rendered
   frame, and the shared input only sees keys that are down when it
   polls, so a press() is invisible. No person taps that fast. */
// 90 ms: headless Chromium polls input only ~17 times a second, so a
// shorter tap can start and end between two polls and never be seen.
async function tap(page, key, holdMs = 90) {
  await page.keyboard.down(key);
  await page.waitForTimeout(holdMs);
  await page.keyboard.up(key);
}


/* Headless Chromium draws WebGL in software at ~15 frames a second, so
   each rendered frame runs ~4 fight steps and two keys pressed 30 ms
   apart reach the fight 4 steps apart (a real browser at 60 fps: 2).
   For timing-exact checks (throws), slow the fight down to the measured
   frame rate so it's back to one fight step per rendered frame, exactly
   like a real 60 fps browser. Returns a restore function. */
async function matchFrameRate(page) {
  const fps = await page.evaluate(() => new Promise((ok) => {
    let n = 0; const t0 = performance.now();
    const f = () => { n++; if (performance.now() - t0 < 600) requestAnimationFrame(f); else ok(n / ((performance.now() - t0) / 1000)); };
    requestAnimationFrame(f);
  }));
  const speed = Math.min(1, Math.max(0.1, fps / 60));
  await page.evaluate((s) => { TP.Match.options.speed = s; }, speed);
  return { fps, speed, slow: 1 / speed, restore: () => page.evaluate(() => { TP.Match.options.speed = 1; }) };
}

/* Make sure we're mid-round and close to the bot, with both cars free to
   act. If the match ended while we were testing, Rematch. */
async function getReady(page, maxDist = 3.0) {
  for (let tries = 0; tries < 80; tries++) {
    const s = await snap(page);
    if (s.phase === "matchEnd") {
      await page.waitForSelector("#rematch", { timeout: 10000 });
      await page.click("#rematch");
      await page.waitForTimeout(300);
      continue;
    }
    if (s.phase !== "fight") { await page.waitForTimeout(200); continue; }
    const [a, b] = s.cars;
    const dist = Math.abs(b.x - a.x);
    const free = ["idle", "walk", "block"].includes(a.state) && !["knockdown", "wakeup", "thrown", "ko", "juggle", "air"].includes(b.state);
    if (!free) { await page.waitForTimeout(100); continue; }
    if (dist <= maxDist) return s;
    // Walk toward the bot a little.
    const toward = b.x > a.x ? "KeyD" : "KeyA";
    await page.keyboard.down(toward);
    await page.waitForTimeout(80);
    await page.keyboard.up(toward);
  }
  return null;
}

// Which keys are "toward" and "away" for P1 right now?
const dirs = (s) => (s.cars[1].x > s.cars[0].x ? { toward: "KeyD", away: "KeyA" } : { toward: "KeyA", away: "KeyD" });

// Moves P1 started (in order, no repeats in a row) in a slice of the recorder log.
function movesStarted(log) {
  const out = [];
  for (const e of log) { const m = e.c[0][1]; if (m && out[out.length - 1] !== m) out.push(m); }
  return out;
}
const p1States = (log) => [...new Set(log.map((e) => e.c[0][0]))];
// P1's attacking events in a list of events, as "type:move".
const p1Hits = (evs) => evs.filter((e) => e.attacker === 0 && ["hit", "block", "throw", "whiff"].includes(e.type)).map((e) => `${e.type}:${e.move}`);

/* Try one check up to `tries` times. `act` does the inputs and returns
   { ok, detail }. Between tries we let things settle. */
async function attempt(page, name, tries, act) {
  let last = { ok: false, detail: "never got into position" };
  for (let i = 0; i < tries; i++) {
    // Push-apart keeps touching cars about 3.0 apart; throw range is 3.6.
    const s = await getReady(page, name.startsWith("throw") ? 3.4 : 3.0);
    if (!s) continue;
    last = await act(s);
    if (last.ok) break;
    await page.waitForTimeout(700);
  }
  record(name, last.ok, last.detail);
}

/* =====================================================================
   Part 1: controls against an Easy bot, started from the real menu.
   ===================================================================== */
async function partMoves(browser, errors) {
  const page = await openPage(browser, "", errors);
  // P1 on keyboard 1, P2 a bot (Easy by default: fewer blocks, slower reactions).
  await installRecorder(page);
  await startFromMenu(page, P1CAR, P2CAR, DIFF);
  await page.mouse.click(5, 5); // keep keyboard focus on the page, away from the menu buttons

  // ---- walk: hold toward for half a second ----
  await attempt(page, "walk", 3, async (s) => {
    const d = dirs(s);
    // Back off first so there's room to walk in.
    await page.keyboard.down(d.away); await page.waitForTimeout(400); await page.keyboard.up(d.away);
    const a = await snap(page);
    await page.keyboard.down(d.toward);
    await page.waitForTimeout(500);
    const log = await logSince(page, a.logLen);
    await page.keyboard.up(d.toward);
    const b = await snap(page);
    const moved = Math.abs(b.cars[0].x - a.cars[0].x);
    const sawWalk = p1States(log).includes("walk");
    return { ok: moved > 0.5 && sawWalk, detail: `A/D moved P1 ${moved.toFixed(2)} units (states ${p1States(log).join(",")})` };
  });

  // ---- block: hold away until the bot attacks ----
  await attempt(page, "block", 4, async (s) => {
    const d = dirs(s);
    await page.keyboard.down(d.away);
    let found = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 6000 && !found) {
      await page.waitForTimeout(100);
      const evs = await eventsSince(page, s.nEv);
      found = evs.find((e) => e.attacker === 1 && (e.type === "block" || e.type === "hit"));
    }
    await page.keyboard.up(d.away);
    if (!found) return { ok: false, detail: "the bot never attacked within 6 s" };
    const log = await logSince(page, s.logLen);
    const tookHitstun = p1States(log).includes("hitstun");
    if (found.type !== "block") return { ok: false, detail: `held away but got "${found.type}" from ${found.move} (P1 states ${p1States(log).join(",")})` };
    const table = TP_MOVE_DAMAGE[found.move];
    const chipOk = table === undefined || Math.abs(found.damage - table * 0.15) <= 1;
    return { ok: chipOk && !tookHitstun, detail: `blocked the bot's ${found.move}: damage ${found.damage.toFixed(1)} (15% of ${table} = ${table !== undefined ? (table * 0.15).toFixed(1) : "?"}), hit-stun ${tookHitstun ? "YES" : "no"}` };
  });

  // ---- light chain E E E ----
  await attempt(page, "chain", 5, async (s) => {
    // ~130 ms per press (90 ms tap + 40 ms): inside even Skitter's 12-frame Jab.
    for (let i = 0; i < 3; i++) { await tap(page, "KeyE"); await page.waitForTimeout(40); }
    await page.waitForTimeout(700);
    const moves = movesStarted(await logSince(page, s.logLen));
    const ok = moves.slice(0, 3).join(">") === "jab>swipe>spinout";
    return { ok, detail: `moves ${moves.join(" > ") || "none"}; events ${JSON.stringify(p1Hits(await eventsSince(page, s.nEv)))}` };
  });

  // ---- heavy R ----
  await attempt(page, "heavy", 4, async (s) => {
    await tap(page, "KeyR");
    await page.waitForTimeout(900);
    const moves = movesStarted(await logSince(page, s.logLen));
    return { ok: moves[0] === "ram", detail: `moves ${moves.join(" > ") || "none"}; events ${JSON.stringify(p1Hits(await eventsSince(page, s.nEv)))}` };
  });

  // ---- launcher: toward + R ----
  await attempt(page, "launcher", 4, async (s) => {
    const d = dirs(s);
    await page.keyboard.down(d.toward);
    await page.waitForTimeout(30);
    await tap(page, "KeyR");
    await page.waitForTimeout(150);
    await page.keyboard.up(d.toward);
    await page.waitForTimeout(900);
    const log = await logSince(page, s.logLen);
    const moves = movesStarted(log);
    const p2 = [...new Set(log.map((e) => e.c[1][0]))];
    return { ok: moves[0] === "corkscrew", detail: `moves ${moves.join(" > ") || "none"}; events ${JSON.stringify(p1Hits(await eventsSince(page, s.nEv)))}; P2 states ${p2.join(",")}` };
  });

  // ---- sidestep: tap W ----
  await attempt(page, "sidestep", 3, async (s) => {
    await tap(page, "KeyW");
    await page.waitForTimeout(600);
    const log = await logSince(page, s.logLen);
    const zs = await snap(page);
    return { ok: p1States(log).includes("sidestep"), detail: `P1 states ${p1States(log).join(",")}` };
  });

  // ---- flip kick: Space, then E once airborne ----
  await attempt(page, "flipkick", 4, async (s) => {
    await tap(page, "Space");
    await page.waitForTimeout(120);
    await tap(page, "KeyE");
    await page.waitForTimeout(1000);
    const log = await logSince(page, s.logLen);
    const moves = movesStarted(log);
    return { ok: moves.includes("flip_kick"), detail: `P1 states ${p1States(log).join(",")}; moves ${moves.join(" > ") || "none"}; events ${JSON.stringify(p1Hits(await eventsSince(page, s.nEv)))}` };
  });

  await page.close();
}


/* =====================================================================
   Part 1b: throws, against the TRAINING dummy (it stands still).
   Against the Easy bot these two were flaky: at 3 units apart the bot
   swings first and P1 is in hit-stun when the keys arrive. The dummy
   never attacks, so this checks only what it should: that real E + R
   presses (together, and 30 ms apart) make a Tow Hook.
   ===================================================================== */
async function partThrows(browser, errors) {
  const page = await openPage(browser, "", errors);
  await installRecorder(page);
  await page.selectOption("#ctrl0", "kb1");
  await page.click("#training");
  await page.waitForSelector("#fight", { timeout: 10000 });
  await page.click(`.tile[data-seat="0"][data-car="${P1CAR}"]`);
  await page.click(`.tile[data-seat="1"][data-car="${P2CAR}"]`);
  await page.click("#fight");
  await waitForFight(page);
  await page.mouse.click(5, 5);
  const rate = await matchFrameRate(page);
  console.log(`      (throws: page draws ${rate.fps.toFixed(0)} fps, fight speed ${rate.speed.toFixed(2)} so 1 step = 1 frame)`);
  // ---- throw: E + R together, up close ----
  await attempt(page, "throw", 4, async (s) => {
    await page.keyboard.down("KeyE");
    await page.keyboard.down("KeyR");
    await page.waitForTimeout(60 * rate.slow);
    await page.keyboard.up("KeyE");
    await page.keyboard.up("KeyR");
    await page.waitForTimeout(1300 * rate.slow);
    const moves = movesStarted(await logSince(page, s.logLen));
    const evs = p1Hits(await eventsSince(page, s.nEv));
    return {
      // "jab > tow_hook" is the designed kara-throw (the 2nd key landed a
      // frame later and turned the Jab into the throw): also a pass.
      ok: moves.includes("tow_hook") && evs.includes("throw:tow_hook"),
      detail: `distance ${Math.abs(s.cars[1].x - s.cars[0].x).toFixed(2)}, P2 was "${s.cars[1].state}"; moves ${moves.join(" > ") || "none"}; events ${JSON.stringify(evs)}`,
    };
  });

  // ---- throw30: E, then R about 30 ms later, as real key presses ----
  await attempt(page, "throw30", 4, async (s) => {
    await page.keyboard.down("KeyE");
    await page.waitForTimeout(30 * rate.slow);   // 30 ms of fight time = 2 frames
    await page.keyboard.down("KeyR");
    await page.waitForTimeout(60 * rate.slow);
    await page.keyboard.up("KeyE");
    await page.keyboard.up("KeyR");
    await page.waitForTimeout(1300 * rate.slow);
    const moves = movesStarted(await logSince(page, s.logLen));
    const evs = p1Hits(await eventsSince(page, s.nEv));
    return {
      ok: moves.includes("tow_hook") && evs.includes("throw:tow_hook"),
      detail: `distance ${Math.abs(s.cars[1].x - s.cars[0].x).toFixed(2)}, P2 was "${s.cars[1].state}"; moves ${moves.join(" > ") || "none"}; events ${JSON.stringify(evs)}`,
    };
  });

  await page.close();
}

/* =====================================================================
   Part 2: the results card (Rematch, Menu), with 20-second rounds.
   ===================================================================== */
async function partResults(browser, errors) {
  const page = await openPage(browser, "?roundTime=20", errors);
  await startFromMenu(page, P1CAR, P2CAR, "hard");
  // P1 does nothing; the bot wins (by KO or on time) within about a minute.
  await page.waitForSelector("#rematch", { timeout: 150000 });
  const card = await page.evaluate(() => document.getElementById("card").innerText.split("\n").filter(Boolean).slice(0, 3).join(" | "));
  const end1 = await snap(page);
  record("results", end1.phase === "matchEnd", `results card shown: "${card}", wins ${JSON.stringify(end1.wins)}`);

  // Rematch: a fresh fight, round 1, no round wins, both cars at full health.
  const oldFight = await page.evaluateHandle(() => TP.fight);
  await page.click("#rematch");
  await waitForFight(page);
  const re = await page.evaluate((old) => {
    const s = TP.fight.state;
    return { fresh: TP.fight !== old, round: s.round, wins: s.roundWins, hp: s.cars.map((c) => c.health + "/" + c.maxHealth), overlay: document.getElementById("overlay").classList.contains("show") };
  }, oldFight);
  record("rematch", re.fresh && re.round === 1 && re.wins[0] === 0 && re.wins[1] === 0 && !re.overlay,
    `new fight ${re.fresh}, round ${re.round}, wins ${JSON.stringify(re.wins)}, HP ${re.hp.join(" ")}, card hidden ${!re.overlay}`);

  // Menu: play that one out too, then press Menu; the seats menu ("Choose cars →") should come back.
  await page.waitForSelector("#menu", { timeout: 150000 });
  await page.click("#menu");
  await page.waitForSelector("#next", { timeout: 15000 }).catch(() => {});
  const menu = await page.evaluate(() => ({ url: location.search, hasNext: !!document.getElementById("next"), fight: window.TP && TP.fight ? TP.fight.state.phase : null }));
  record("menu", menu.hasNext, `after Menu: query "${menu.url}", "Choose cars" button ${menu.hasNext ? "shown" : "missing"}, fight phase ${menu.fight}`);
  await page.close();
}

// Table damage for the chip check, filled from the page once.
let TP_MOVE_DAMAGE = {};

(async () => {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"],
  });
  const errors = [];
  try {
    // Read the move table once (for chip damage).
    const p = await openPage(browser, "", errors);
    // The bot (P2) is the attacker in the block check, so use its car's own table.
    TP_MOVE_DAMAGE = await p.evaluate((car) => Object.fromEntries(Object.entries(TP.fighterMoves ? TP.fighterMoves(car) : TP.MOVES).map(([k, m]) => [k, m.damage])), P2CAR);
    await p.close();
    if (which === "all" || which === "moves") await partMoves(browser, errors);
    if (which === "all" || which === "moves" || which === "throws") await partThrows(browser, errors);
    if (which === "all" || which === "results") await partResults(browser, errors);
  } catch (err) {
    record("tool", false, "tool error: " + err.message.split("\n")[0]);
  }
  console.log(errors.length ? "\nERRORS:\n" + errors.join("\n") : "\nNo page errors.");
  const pass = results.length && results.every((r) => r.ok) && !errors.length;
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed.`);
  console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
  await browser.close();
  process.exit(pass ? 0 : 1);
})();
