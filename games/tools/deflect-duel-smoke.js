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
     • no koLog entry has the ball's owner as its victim
     • ball speed is never NaN/Infinity and never over DUEL_CFG.maxSpeed
     • ball and every car still in play stay inside the arena walls
     • the match reaches state "over" before the time limit
     • at the end there is exactly one winner, it has more than 0 lives,
       and every other car is out

   The rule checks run INSIDE the page on every animation frame (not just
   at the 3-second status lines), so a ball that leaves the arena for a
   single frame is still caught.

   Prints a status line every 3 s, then the final result.

   STEPPED MANY-MATCH MODE (balance and stuck-match check):
     node tools/deflect-duel-smoke.js --matches 50 [--players 4] [--lives 3]
   Plays N all-bot matches by calling TP.duel.update(1/60) directly (no
   real time, so 50 matches take seconds, not hours), with the same
   per-step rule checks. Reports wins per seat, match lengths, KOs and
   stalemate resets per match, and how ball speed compares with car speed
   (cars top out at 17, 27 boosting: a ball faster than 27 can't be
   outrun, only hit back or jumped). FAILS on rule breaks, page errors or
   a match still going after 5 game-minutes; balance oddities are FLAGGED
   for the boss, not failed. Needs TP.duel.update / newMatch / paused.
   Exit code 0 = PASS, 1 = FAIL (including "the game isn't built yet").

   Test hooks (used to test this script itself):
     DEFLECT_DUEL_INDEX=/path/to/index.html  test a different copy of the
       game, e.g. the QC mock in tools/fixtures/deflect-duel-mock/
     DEFLECT_DUEL_QUERY=mockbug=nocap        extra URL parameters to add

   Needs Playwright (pre-installed in cloud sessions; on Windows run
   `npm i -g playwright` then `npx playwright install chromium` once).
   ===================================================================== */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// ---------- Arguments ----------
// Either the positional form (players speed timeoutSec lives) or the
// stepped form (--matches N --players P --lives L).
const argv = process.argv.slice(2);
const flagArg = (name, dflt) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : dflt; };
const stepped = argv.includes("--matches");
const matches = Number(flagArg("matches", 0));
const players = Number(stepped ? flagArg("players", 4) : argv[0] || 4);
const speed = Number(stepped ? 1 : argv[1] || 8);
const timeoutSec = Number(stepped ? 1e9 : argv[2] || 180);
const lives = Number(stepped ? flagArg("lives", 3) : argv[3] || 3);
const MAX_MATCH_GAME_SEC = 300;   // stepped mode: a match longer than 5 game-minutes is "stuck"

// Stop early with a clear message if the arguments make no sense, rather
// than launching a browser and failing in a confusing way later.
function usageFail(msg) {
  console.log(`Bad arguments: ${msg}`);
  console.log("Usage: node tools/deflect-duel-smoke.js [players 2-4] [speed] [timeoutSec] [lives]");
  console.log("   or: node tools/deflect-duel-smoke.js --matches N [--players 2-4] [--lives L]");
  console.log("RESULT: FAIL (bad arguments)");
  process.exit(1);
}
if (stepped && !(Number.isInteger(matches) && matches >= 1)) usageFail(`--matches must be a whole number of at least 1 (got "${flagArg("matches")}")`);
if (!Number.isInteger(players) || players < 2 || players > 4) usageFail(`players must be 2, 3 or 4 (got "${stepped ? flagArg("players") : argv[0]}")`);
if (!(speed > 0)) usageFail(`speed must be a positive number (got "${argv[1]}")`);
if (!(timeoutSec > 0)) usageFail(`timeoutSec must be a positive number (got "${argv[2]}")`);
if (!Number.isInteger(lives) || lives < 1) usageFail(`lives must be a whole number of at least 1 (got "${stepped ? flagArg("lives") : argv[3]}")`);

// ---------- Is the game there at all? ----------
// While Deflect Duel is still being built, duel.js / main.js don't exist.
// Say so plainly instead of reporting a wall of "file not found" errors.
const indexFile = path.resolve(process.env.DEFLECT_DUEL_INDEX || path.join(__dirname, "../deflect-duel/index.html"));
const gameDir = path.dirname(indexFile);
// (A test copy pointed to with DEFLECT_DUEL_INDEX only needs its index.html.)
const needed = process.env.DEFLECT_DUEL_INDEX ? [path.basename(indexFile)] : ["index.html", "js/duel.js", "js/main.js"];
const missing = needed.filter((f) => !fs.existsSync(path.join(gameDir, f)));
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
   This function is sent into the page and runs on every animation frame
   (or, in stepped mode, after every update() the test makes).
   It only READS the game state and writes what it finds into
   window.__ddQC; it never changes the game. It must not throw (an error
   here would look like a game error), so everything is wrapped in try. */
function installMonitor({ ballSlack, carSlack, stepped }) {
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
      const gt = window.TP.duel.t;
      const t = (typeof gt === "number" ? gt : performance.now() / 1000).toFixed(2);
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

    // --- New KOs: the ball never KOs its own owner (Reece's rule) ---
    const log = d.koLog || [];
    if (qc.koSeen === undefined || qc.koSeen > log.length) qc.koSeen = 0;
    const who = (w) => (w === null || w === undefined ? null : typeof w === "number" ? w
      : typeof w === "string" ? ps.findIndex((p) => p.name === w) : w.index !== undefined ? w.index : ps.findIndex((p) => p.name === w.name));
    for (; qc.koSeen < log.length; qc.koSeen++) {
      const e = log[qc.koSeen] || {};
      const v = who(e.victim), o = who(e.owner);
      if (v !== null && v === o) flag(`${(ps[v] || {}).name}: KO'd by their own ball`);
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

  // Safe to call from anywhere: never throws into the game.
  qc.check = () => { try { check(); } catch (e) { if (!qc.monitorError) qc.monitorError = String(e && e.stack || e); } };
  // Forget the last match's lives (a new match legitimately "raises" them).
  qc.reset = () => { qc.lastLives = null; qc.wasOut = null; qc.koSeen = 0; };
  if (stepped) return;
  function loop() { qc.check(); requestAnimationFrame(loop); }
  requestAnimationFrame(loop);
}

/* ---------- Stepped mode: play one whole all-bot match in-page ----------
   Runs inside the page. Steps TP.duel.update(1/60) until the match is
   over (or maxSec of game time passes), running the rule monitor after
   every step and gathering balance numbers. Returns plain numbers. */
function playSteppedMatch({ players, lives, maxSec, carMax, boostMax }) {
  const d = window.TP.duel, qc = window.__ddQC, DT = 1 / 60;
  const xz = (p) => (Array.isArray(p) ? { x: p[0], y: p[1] || 0, z: p[2] } : { x: p.x, y: p.y || 0, z: p.z });
  const idx = (who) => (who === null || who === undefined ? null : typeof who === "number" ? who
    : typeof who === "string" ? d.players.findIndex((p) => p.name === who) : who.index !== undefined ? who.index : d.players.findIndex((p) => p.name === who.name));
  d.paused = true;
  d.newMatch({ players, lives });
  if (typeof d.setBot === "function") d.players.forEach((p, i) => d.setBot(i, true));
  qc.reset();
  const vBefore = qc.violationCount;
  const st = { t: 0, playT: 0, over17: 0, over27: 0, resets: 0, serveSpeeds: [], returns: 0, jumpDodges: 0, carTop: 0, carFastLong: 0 };
  let wasNeutral = d.ball.neutral, lastOwner = d.ball.neutral ? null : idx(d.ball.owner), kos = d.koLog.length;
  const near = d.players.map(() => false), fastFor = d.players.map(() => 0);
  const rad = (window.TP.DUEL_CFG.ballRadius || 0.8) + 1.35;
  while (d.state !== "over" && st.t < maxSec) {
    d.update(DT); st.t += DT; qc.check();
    const b = d.ball, own = b.neutral ? null : idx(b.owner), koNow = d.koLog.length;
    if (d.state === "play" && !b.neutral) {
      st.playT += DT;
      if (b.speed > carMax) st.over17 += DT;
      if (b.speed > boostMax) st.over27 += DT;
    }
    if (wasNeutral && !b.neutral) st.serveSpeeds.push(b.speed);               // first hit off a serve
    if (!wasNeutral && b.neutral && koNow === kos) st.resets++;                // back to neutral with no KO = stalemate reset
    if (own !== null && lastOwner !== null && own !== lastOwner) st.returns++; // an enemy ball hit back
    // A jump dodge: an enemy ball passes within touching distance of a car that is in the air.
    d.players.forEach((p, i) => {
      if (p.out) return;
      const c = xz(p.pos), bp = xz(b.pos);
      const close = own !== null && own !== i && Math.hypot(c.x - bp.x, c.z - bp.z) < rad;
      if (close && !near[i] && p.airborne) st.jumpDodges++;
      near[i] = close;
      const v = p.car && p.car.vel ? Math.hypot(p.car.vel.x, p.car.vel.z) : 0;
      st.carTop = Math.max(st.carTop, v);
      fastFor[i] = v > boostMax * 1.1 ? fastFor[i] + DT : 0;
      if (fastFor[i] > 0.5) st.carFastLong++;
    });
    wasNeutral = b.neutral; lastOwner = own; kos = koNow;
  }
  return {
    over: d.state === "over", length: st.t, winner: idx(d.winner),
    kos: d.koLog.length, koSpeeds: d.koLog.map((e) => e.speed),
    resets: st.resets, playT: st.playT, over17: st.over17, over27: st.over27,
    serveSpeeds: st.serveSpeeds, returns: st.returns, jumpDodges: st.jumpDodges,
    carTop: st.carTop, carFastLong: st.carFastLong,
    violations: qc.violationCount - vBefore,
  };
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

/* ---------- Stepped many-match mode (Node side) ---------- */
async function runStepped(page, errors) {
  const url = "file:///" + indexFile.replace(/\\/g, "/") + `?demo&test&players=${players}&lives=${lives}` + (process.env.DEFLECT_DUEL_QUERY ? "&" + process.env.DEFLECT_DUEL_QUERY : "");
  console.log(`Deflect Duel stepped run: ${matches} matches, ${players} bots, ${lives} lives (5 game-minute limit each)`);
  await page.goto(url);
  const ready = await page.waitForFunction(() => window.TP && TP.duel && TP.DUEL_CFG && typeof TP.duel.update === "function" && typeof TP.duel.newMatch === "function", null, { timeout: 20000 }).then(() => true, () => false);
  if (!ready) {
    console.log("\nTP.duel.update / TP.duel.newMatch never appeared within 20 s (test hooks not wired up?).");
    if (errors.length) console.log("\nERRORS:\n" + errors.join("\n"));
    console.log("RESULT: FAIL (test interface not found)");
    return 1;
  }
  await page.evaluate(installMonitor, { ballSlack: BALL_SLACK, carSlack: CAR_SLACK, stepped: true });
  const car = await page.evaluate(() => ({ carMax: TP.CAR_TUNING.maxSpeed, boostMax: TP.CAR_TUNING.boostMax, names: null }));

  const results = [];
  const started = Date.now();
  for (let m = 0; m < matches; m++) {
    const r = await page.evaluate(playSteppedMatch, { players, lives, maxSec: MAX_MATCH_GAME_SEC, carMax: car.carMax, boostMax: car.boostMax });
    results.push(r);
    const mmss = `${Math.floor(r.length / 60)}:${String(Math.floor(r.length % 60)).padStart(2, "0")}`;
    console.log(`  #${String(m + 1).padStart(3)}  ${r.over ? "over " : "STUCK"} ${mmss}  winner seat ${r.winner === null ? "-" : r.winner + 1}  KOs ${r.kos}  resets ${r.resets}${r.violations ? `  ⚠ ${r.violations} rule breaks` : ""}`);
  }
  const s = await page.evaluate(() => window.__ddQC);

  // ---------- Summary ----------
  const sum = (a) => a.reduce((x, y) => x + y, 0), avg = (a) => (a.length ? sum(a) / a.length : 0);
  const median = (a) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const wins = Array.from({ length: players }, () => 0);
  results.forEach((r) => { if (r.winner !== null && r.winner >= 0 && r.winner < players) wins[r.winner]++; });
  const playT = sum(results.map((r) => r.playT));
  const koSpeeds = results.flatMap((r) => r.koSpeeds).filter((v) => typeof v === "number");
  const serves = results.flatMap((r) => r.serveSpeeds);
  const stuck = results.filter((r) => !r.over).length;
  const pct = (x) => (playT > 0 ? (100 * x / playT).toFixed(0) + "%" : "n/a");
  const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "n/a");

  console.log(`\nRan ${matches} matches in ${((Date.now() - started) / 1000).toFixed(1)} s real time.`);
  console.log(`Wins by seat:        ${wins.map((w, i) => `seat ${i + 1}: ${w}`).join("  ")}`);
  console.log(`Match length:        avg ${f1(avg(results.map((r) => r.length)))} s, longest ${f1(Math.max(...results.map((r) => r.length)))} s, stuck ${stuck}`);
  console.log(`Per match:           ${f1(avg(results.map((r) => r.kos)))} KOs, ${f1(avg(results.map((r) => r.resets)))} stalemate resets, ${f1(avg(results.map((r) => r.returns)))} balls hit back, ${f1(avg(results.map((r) => r.jumpDodges)))} jump dodges`);
  console.log(`Ball vs car speed:   ball faster than a car (${car.carMax}) ${pct(sum(results.map((r) => r.over17)))} of play, faster than a boosting car (${car.boostMax}) ${pct(sum(results.map((r) => r.over27)))}`);
  console.log(`Ball speed at KOs:   median ${f1(median(koSpeeds))}, min ${f1(Math.min(...koSpeeds))}, max ${f1(Math.max(...koSpeeds))}  (${koSpeeds.length} KOs with a speed logged)`);
  console.log(`Serve speed:         first hit off a serve ${f1(Math.min(...serves))}–${f1(Math.max(...serves))}`);
  console.log(`Car top speed seen:  ${f1(Math.max(...results.map((r) => r.carTop)))} (boost cap ${car.boostMax})`);

  // ---------- Flags (for the boss to judge, not failures) ----------
  const flags = [];
  const over27 = playT > 0 ? sum(results.map((r) => r.over27)) / playT : 0;
  if (over27 > 0.5) flags.push(`the ball is faster than a boosting car ${(over27 * 100).toFixed(0)}% of the time: nobody can outrun it, it's all swing timing and jumps`);
  if (koSpeeds.length && median(koSpeeds) < car.carMax) flags.push(`most KOs happen with the ball slower than a car (median ${f1(median(koSpeeds))} < ${car.carMax}): bots may not be dodging`);
  if (serves.length && Math.max(...serves) > car.carMax) flags.push(`a serve leaves faster (${f1(Math.max(...serves))}) than a car can drive (${car.carMax}), so a neutral ball can't be chased down`);
  if (matches >= 20) wins.forEach((w, i) => { if (w > 2 * matches / players) flags.push(`seat ${i + 1} won ${w}/${matches}, more than twice its fair share: check spawn fairness`); });
  if (results.some((r) => r.carFastLong)) flags.push(`a car stayed above ${(car.boostMax * 1.1).toFixed(1)} for over 0.5 s (faster than boost allows)`);
  if (avg(results.map((r) => r.resets)) > 1) flags.push(`more than one stalemate reset per match on average: bots may be ignoring the ball`);
  if (koSpeeds.length < sum(results.map((r) => r.kos))) flags.push("some koLog entries have no speed, so the speed analysis is partial");
  console.log(flags.length ? "\nFLAGS (for the boss, not failures):\n- " + flags.join("\n- ") : "\nNo balance flags.");

  // ---------- Failures ----------
  const fails = [];
  if (s.monitorError) fails.push("The QC monitor crashed reading TP.duel: " + s.monitorError.split("\n")[0]);
  if (s.violationCount) fails.push(`${s.violationCount} rule break(s):\n    ` + s.violations.join("\n    "));
  if (stuck) fails.push(`${stuck} match(es) still going after ${MAX_MATCH_GAME_SEC / 60} game-minutes`);
  const noWinner = results.filter((r) => r.over && (r.winner === null || r.winner < 0)).length;
  if (noWinner) fails.push(`${noWinner} finished match(es) had no winner`);
  fails.push(...errors);
  if (fails.length) { console.log("\nPROBLEMS:\n- " + fails.join("\n- ")); console.log("RESULT: FAIL"); return 1; }
  console.log("\nNo page errors. All rule checks held in every match.");
  console.log("RESULT: PASS");
  return 0;
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

    if (stepped) return finish(await runStepped(page, errors));

    const url = "file:///" + indexFile.replace(/\\/g, "/") + `?demo&players=${players}&lives=${lives}&speed=${speed}` + (process.env.DEFLECT_DUEL_QUERY ? "&" + process.env.DEFLECT_DUEL_QUERY : "");
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
