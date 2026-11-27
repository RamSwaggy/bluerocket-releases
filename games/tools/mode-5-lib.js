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
   It waits for the game's event bus (TP.M5.on) to exist, then records
   every event we care about into window.__m5log, tagged with the round
   number and the wall-clock time. It also counts animation frames so we
   can work out a real frames-per-second figure. */
function instrumentScript() {
  window.__m5log = [];      // { name, t, round, data }
  window.__m5frames = 0;    // requestAnimationFrame callbacks seen
  window.__m5hooked = false;
  const NAMES = ["roundCountdown", "roundStart", "overdrive", "roundEnd", "matchEnd", "trailStart",
    "fill", "pop", "splat", "land", "bump", "pickupSpawn", "pickup", "hint"];
  const tick = () => { window.__m5frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
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

/* Reads the match state the contract promises (TP.M5.match: phase,
   timeLeft, round, scores, players) and flattens it into plain values.
   Runs inside the page. Forgiving about shape: scores may be an array or
   an object keyed by player; players may hold a `car` or be the car. */
function readStateInPage() {
  const M5 = window.TP && window.TP.M5;
  const m = M5 && M5.match;
  if (!m) return { ready: false };
  let scores = m.scores;
  if (scores && !Array.isArray(scores)) scores = Object.values(scores);
  scores = (scores || []).map(Number);
  const players = (m.players || []).map((p, i) => {
    const car = (p && p.car) || p || {};
    const pos = car.pos || p.pos || {};
    return {
      i,
      name: p && p.name,
      controller: p && p.controller,
      x: Number(pos.x), z: Number(pos.z),
      heading: Number(car.heading),
      onGround: car.onGround,
    };
  });
  return { ready: true, phase: m.phase, round: m.round, timeLeft: Number(m.timeLeft), scores, players };
}

module.exports = { BROWSER_ARGS, PAGE_FILE, launch, pageUrl, collectErrors, instrumentScript, readStateInPage };
