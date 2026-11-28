/* =====================================================================
   mode-5-lib.js — small helpers shared by the Mode 5 test tools
   (mode-5-smoke.js, mode-5-shots.js, mode-5-probe.js). Not a test by
   itself.

   Why a shared file: all three tools need to launch the same headless
   browser, open the same page, listen to the game's event bus and read
   the match state in the same forgiving way. Keeping that in one place
   means a change to the game's contract (DESIGN.md → "Code
   architecture") only needs fixing here.
   ===================================================================== */
const path = require("path");
const { chromium } = require("playwright");

// SwiftShader = software WebGL, so this works on machines with no GPU.
// --mute-audio is a team rule for every headless run.
const BROWSER_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"];

// The page under test, as a file:// URL (the game runs without a server).
// M5_PAGE=/path/to/other.html points the tools at another page (used to
// self-test the tools against a stub before the real build exists).
const PAGE_FILE = "file:///" + path.resolve(process.env.M5_PAGE || path.resolve(__dirname, "../mode-5/index.html")).replace(/\\/g, "/").replace(/^\/+/, "");

async function launch() {
  return chromium.launch({ args: BROWSER_ARGS });
}

// Builds "index.html?demo&speed=8&rounds=1" style URLs. Values of `true`
// become bare flags (?demo), undefined/null values are left out.
function pageUrl(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === false) continue;
    parts.push(v === true ? k : `${k}=${encodeURIComponent(v)}`);
  }
  return PAGE_FILE + (parts.length ? "?" + parts.join("&") : "");
}

// Collects page errors and console errors into an array, so every tool
// can fail on "no console errors" the same way.
function collectErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE ERROR: " + m.text()); });
  return errors;
}

/* ---------- In-page instrumentation ----------
   Installed with page.addInitScript, so it runs before any game script.

   1. Event log: waits for the game's event bus (TP.M5.on), then records
      every event we care about into window.__m5log, tagged with the
      round number and the wall-clock time.
   2. Frame counter: counts animation frames for a real FPS figure.
   3. Step monitor: wraps TP.M5.Match.prototype.step, so it sees EVERY
      1/60 s physics step (polling from Node every half second would miss
      a car that pops through a wall for a few frames at 16x speed).
      During "play" it tracks, in game seconds:
        - the longest stretch where the scores didn't change at all
          (a frozen score bar = a frozen game, or bots doing nothing);
        - any car outside the arena walls or below the floor surface;
        - any car moving slower than 1 unit/s for more than 3 s while
          not stunned (stuck on a wall, a pillar, a ramp, another car).
      Results go into window.__m5mon (plain values only). */
function instrumentScript() {
  window.__m5log = [];      // { name, t, round, data }
  window.__m5frames = 0;    // requestAnimationFrame callbacks seen
  window.__m5hooked = false;
  const NAMES = ["roundCountdown", "roundStart", "overdrive", "roundEnd", "matchEnd", "trailStart",
    "fill", "pop", "splat", "land", "bump", "pickupSpawn", "pickup", "hint", "dry"];
  const tick = () => { window.__m5frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);

  const mon = window.__m5mon = {
    playSeconds: 0,          // game seconds spent in "play", whole match
    rounds: [],              // per round: { round, maxFlat, flatAt, playSeconds }
    bounds: [],              // first few out-of-arena / below-floor readings
    boundsCount: 0,
    stuck: [],               // every stuck episode: { car, round, at, x, z, seconds }
    maxStuck: 0,
  };
  const OUT_TOL = 0.25;      // how far past the wall line counts as "outside"
  const FLOOR_TOL = 0.25;    // how far under the floor surface counts as "below"
  const STUCK_SPEED = 1, STUCK_TIME = 3;

  function hookStep() {
    const M5 = window.TP && window.TP.M5;
    if (!M5 || !M5.Match || !M5.Match.prototype || !M5.Match.prototype.step) return setTimeout(hookStep, 20);
    const orig = M5.Match.prototype.step;
    M5.Match.prototype.step = function (dt) {
      const r = orig.apply(this, arguments);
      try { watch(this, dt); } catch (e) { mon.watchError = String(e && e.message || e); }
      return r;
    };
  }
  let cur = null;            // current round's record
  let lastScores = "";
  let stuckT = [];           // seconds each car has been slow
  let stuckLogged = [];      // index into mon.stuck of each car's open episode
  function watch(m, dt) {
    if (m.phase !== "play") return;
    if (!cur || cur.round !== m.round) {
      cur = { round: m.round, maxFlat: 0, flatAt: null, playSeconds: 0, _since: 0 };
      mon.rounds.push(cur);
      lastScores = ""; stuckT = []; stuckLogged = [];
    }
    cur.playSeconds += dt; mon.playSeconds += dt;
    // Score freeze: time since the scores last changed by any amount.
    const sc = JSON.stringify(m.scores);
    if (sc !== lastScores) { lastScores = sc; cur._since = 0; }
    else {
      cur._since += dt;
      if (cur._since > cur.maxFlat) { cur.maxFlat = cur._since; cur.flatAt = Math.round((cur.playSeconds - cur._since) * 10) / 10; }
    }
    const a = m.arena, half = a && a.half;
    (m.cars || []).forEach((c, i) => {
      const x = c.pos.x, y = c.pos.y, z = c.pos.z;
      // Bounds: inside the walls, and not under the floor (ramps raise it).
      let why = null;
      if (half && (Math.abs(x) > half + OUT_TOL || Math.abs(z) > half + OUT_TOL)) why = "outside walls";
      else if (a && a.groundHeightAt && y < a.groundHeightAt(x, z) - FLOOR_TOL) why = `below floor (y ${y.toFixed(2)} < ground ${a.groundHeightAt(x, z).toFixed(2)})`;
      if (!Number.isFinite(x + y + z)) why = "position is NaN";
      if (why) {
        mon.boundsCount++;
        if (mon.bounds.length < 8) mon.bounds.push({ car: i, round: m.round, at: Math.round(cur.playSeconds * 10) / 10, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), why });
      }
      // Stuck: slow, on purpose or not, while not stunned.
      const speed = Math.hypot(c.vel.x, c.vel.z);
      if (speed < STUCK_SPEED && !(c.stun > 0)) stuckT[i] = (stuckT[i] || 0) + dt; else { stuckT[i] = 0; stuckLogged[i] = undefined; }
      if (stuckT[i] > STUCK_TIME) {
        if (stuckLogged[i] === undefined) {
          stuckLogged[i] = mon.stuck.length;
          mon.stuck.push({ car: i, round: m.round, at: Math.round((cur.playSeconds - stuckT[i]) * 10) / 10, x: +x.toFixed(1), z: +z.toFixed(1), seconds: 0 });
        }
        mon.stuck[stuckLogged[i]].seconds = Math.round(stuckT[i] * 10) / 10;
        mon.maxStuck = Math.max(mon.maxStuck, stuckT[i]);
      }
    });
  }
  hookStep();

  const tryHook = () => {
    const M5 = window.TP && window.TP.M5;
    if (!M5 || typeof M5.on !== "function") return setTimeout(tryHook, 20);
    for (const name of NAMES) {
      M5.on(name, (data) => {
        // Copy only plain values: event payloads may hold THREE objects.
        let copy = null;
        try { copy = JSON.parse(JSON.stringify(data === undefined ? null : data)); } catch (e) { copy = String(data); }
        const m = M5.match;
        window.__m5log.push({ name, t: performance.now(), round: m ? m.round : null, data: copy });
      });
    }
    window.__m5hooked = true;
  };
  tryHook();
}

/* Reads the match state (TP.M5.match: phase, timeLeft, round, scores,
   players, cars) and flattens it into plain values. Runs inside the
   page. The cars live in match.cars[i] (same order as match.players);
   players[i].car is accepted too in case that changes. */
function readStateInPage() {
  const M5 = window.TP && window.TP.M5;
  const m = M5 && M5.match;
  if (!m) return { ready: false };
  let scores = m.scores;
  if (scores && !Array.isArray(scores)) scores = Object.values(scores);
  scores = (scores || []).map(Number);
  const players = (m.players || []).map((p, i) => {
    const car = (m.cars && m.cars[i]) || (p && p.car) || {};
    const pos = car.pos || {};
    return {
      i,
      name: p && p.name,
      controller: p && p.controller,
      x: Number(pos.x), y: Number(pos.y), z: Number(pos.z),
      speed: car.vel ? Math.hypot(car.vel.x, car.vel.z) : NaN,
      heading: Number(car.heading),
      onGround: car.onGround,
      stun: car.stun || 0,
    };
  });
  return { ready: true, phase: m.phase, round: m.round, timeLeft: Number(m.timeLeft), scores, players };
}

/* ---------- One whole bot match ----------
   Opens the page with the given URL options and watches until phase
   "matchEnd" or maxSeconds of real time. Used by mode-5-smoke.js (one
   match, verbose) and mode-5-batch.js (many matches, summary).
   Returns everything both tools need to judge the match. */
async function runMatch(browser, { speed, rounds, time, maxSeconds, verbose, extra }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = collectErrors(page);
  await page.addInitScript(instrumentScript);
  const url = pageUrl({ demo: true, speed, rounds, time, ...(extra || {}) });
  if (verbose) console.log("Opening " + url.replace(/^.*mode-5\//, "mode-5/"));
  await page.goto(url);

  const start = Date.now();
  let finished = false, lastPrint = -Infinity, samples = 0, lastState = null;
  const scoreProblems = [];
  // Wall-clock hang check: timeLeft must keep moving while in "play".
  let lastTL = null, lastTLWall = 0, maxHang = 0;
  while (!finished && (Date.now() - start) / 1000 < maxSeconds) {
    await page.waitForTimeout(500);
    const s = await page.evaluate(readStateInPage);
    const wall = (Date.now() - start) / 1000;
    if (!s.ready) {
      if (verbose && wall - lastPrint >= 3) { console.log(`${wall.toFixed(0).padStart(4)}s  (waiting for TP.M5.match)`); lastPrint = wall; }
      continue;
    }
    samples++;
    lastState = s;
    const sum = s.scores.reduce((a, b) => a + b, 0);
    const bad = s.scores.some((x) => !Number.isFinite(x) || x < 0) || sum > 100.0001;
    if (bad && scoreProblems.length < 5) scoreProblems.push(`at ${wall.toFixed(1)}s, round ${s.round}, phase ${s.phase}: scores [${s.scores.join(", ")}] sum ${sum.toFixed(3)}`);
    if (s.phase === "play") {
      if (s.timeLeft !== lastTL) { lastTL = s.timeLeft; lastTLWall = wall; }
      else maxHang = Math.max(maxHang, wall - lastTLWall);
    } else { lastTL = null; }
    if (verbose && wall - lastPrint >= 3) {
      const pct = s.scores.map((x) => (Number.isFinite(x) ? x.toFixed(1) : String(x)).padStart(5) + "%").join(" ");
      const tl = Number.isFinite(s.timeLeft) ? s.timeLeft.toFixed(1).padStart(6) + "s left" : "";
      console.log(`${wall.toFixed(0).padStart(4)}s  ${String(s.phase).padEnd(10)} round ${s.round}  ${tl}  ${pct}  (sum ${sum.toFixed(1)}%)`);
      lastPrint = wall;
    }
    if (s.phase === "matchEnd") finished = true;
  }
  const wallTotal = (Date.now() - start) / 1000;
  const { log, frames, hooked, mon } = await page.evaluate(() => ({ log: window.__m5log, frames: window.__m5frames, hooked: window.__m5hooked, mon: window.__m5mon }));
  await page.close();

  // Split events into rounds by the order of roundStart events.
  const perRound = [];
  let cur = null;
  for (const e of log) {
    if (e.name === "roundStart") { cur = { fills: new Map(), pops: 0, bestFill: 0 }; perRound.push(cur); continue; }
    if (!cur) continue;
    if (e.name === "fill") {
      const p = e.data && e.data.player;
      cur.fills.set(p, (cur.fills.get(p) || 0) + 1);
      cur.bestFill = Math.max(cur.bestFill, Number(e.data && e.data.pct) || 0);
    }
    if (e.name === "pop") cur.pops++;
  }
  return { finished, wallTotal, samples, lastState, scoreProblems, maxHang, log, frames, hooked, mon, errors, perRound, fps: frames / wallTotal };
}

module.exports = { BROWSER_ARGS, PAGE_FILE, launch, pageUrl, collectErrors, instrumentScript, readStateInPage, runMatch };
