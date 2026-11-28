/* =====================================================================
   deflect-duel-fun.js: the Deflect Duel v2 "fun table". It plays N
   all-bot matches as fast as possible and measures whether the game
   plays the way the design wants (DESIGN.md §9). It reads the counted
   events the rules record (TP.duel.events), so nothing is guessed.

   Usage (from the games folder):
     node tools/deflect-duel-fun.js [matches=40] [players=4] [lives=3]

   What it prints, and what we're aiming for. These are FLAGS for the
   boss to judge, not pass/fail, except page errors and stuck matches:
     • Rally length        strikes between KOs/resets, median 4–12
     • Escalation          median KO speed well above base (16), the top
                           speed long rallies reach, how often a rally
                           reaches the top tier (sometimes, not most)
     • Rally-ending speeds how many rallies end in each speed band
     • Aerial share        strikes made off the ground, at least 20%
     • Flip strikes        dodge-flips that slammed the ball
     • Bot connect rate    by ball speed band: strikes per swipe at an
                           enemy ball (should fall with speed, never 0%)
     • Clashes, bunts (flip resets), bumps, stalemates per match
     • Wins by seat and match length (fairness, no stalls)

   Plain-English summary: it's the "is this actually fun to watch and
   play?" report, in numbers.

   Needs Playwright (pre-installed in cloud sessions).
   ===================================================================== */
const path = require("path");
const { chromium } = require("playwright");

const matches = Number(process.argv[2] || 40);
const players = Number(process.argv[3] || 4);
const lives = Number(process.argv[4] || 3);
const MAX_GAME_SEC = 300; // a match longer than 5 game-minutes counts as stuck

const indexFile = path.resolve(__dirname, "../deflect-duel/index.html");

// Runs INSIDE the page: plays one match by stepping the rules directly,
// then returns the counted events and the result.
function playOne({ players, lives, maxSec }) {
  if (window.TP.duel) window.TP.duel.paused = true;
  window.TP.duelTest.newMatch({ players, lives });
  const d = window.TP.duel;
  d.paused = true;
  let t = 0;
  while (d.state !== "over" && d.time < maxSec && t < maxSec * 3) {
    d.update(1 / 60);
    t += 1 / 60;
  }
  return {
    over: d.state === "over",
    time: d.time,
    winnerSeat: d.state === "over" ? d.players[d.winner].seat : -1,
    maxSpeed: d.cfg.maxSpeed,
    baseSpeed: d.cfg.baseSpeed,
    stats: d.stats,
    events: d.events.map((e) => ({ type: e.type, player: e.player, speed: e.speed, ballSpeed: e.ballSpeed, threat: e.threat, aerial: e.aerial, flip: e.flip, carY: e.carY })),
  };
}

const median = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(0) + "%" : "–");
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "–");

(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"] });
  let exitCode = 0;
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto("file:///" + indexFile.replace(/\\/g, "/") + `?demo&test&players=${players}&lives=${lives}`);
    await page.waitForFunction(() => window.TP && TP.duel && TP.duelTest && TP.duelTest.newMatch, null, { timeout: 20000 });

    const runs = [];
    for (let m = 0; m < matches; m++) runs.push(await page.evaluate(playOne, { players, lives, maxSec: MAX_GAME_SEC }));

    /* ---------- Turn the events into rallies ----------
       A rally = the strikes since the last KO or stalemate reset. It
       ends at a KO (with the ball's speed then) or a reset. */
    const rallies = []; // { strikes, top, endSpeed|null }
    const connect = {}; // band → { swings, strikes }
    const bands = [[0, 40], [40, 100], [100, 160], [160, Infinity]];
    const bandOf = (v) => bands.findIndex(([lo, hi]) => v >= lo && v < hi);
    bands.forEach((_, k) => (connect[k] = { swings: 0, strikes: 0 }));
    let strikes = 0, aerial = 0, high = 0, flips = 0, koSpeeds = [];
    const wins = new Array(4).fill(0);
    const lengths = [];
    let stuck = 0, top = runs[0].maxSpeed, base = runs[0].baseSpeed;
    const totals = { clashes: 0, bunts: 0, bumps: 0, stalemates: 0 };

    for (const r of runs) {
      if (!r.over) stuck++;
      else wins[r.winnerSeat]++;
      lengths.push(r.time);
      for (const k of Object.keys(totals)) totals[k] += r.stats[k] || 0;
      let cur = { strikes: 0, top: 0 };
      // Pair each threatening swipe with the strike that follows it from
      // the same player (if any) before the ball changes hands.
      const pending = new Map();
      for (const e of r.events) {
        if (e.type === "swing" && e.threat) {
          const b = bandOf(e.ballSpeed || 0);
          connect[b].swings++;
          pending.set(e.player, b);
        } else if (e.type === "strike") {
          strikes++;
          if (e.aerial) aerial++;
          if ((e.carY || 0) > 2.5) high++;
          if (e.flip) flips++;
          cur.strikes++;
          cur.top = Math.max(cur.top, e.speed || 0);
          if (pending.has(e.player)) { connect[pending.get(e.player)].strikes++; }
          pending.clear();
        } else if (e.type === "ko") {
          koSpeeds.push(e.speed || 0);
          rallies.push({ strikes: cur.strikes, top: cur.top, endSpeed: e.speed || 0 });
          cur = { strikes: 0, top: 0 };
          pending.clear();
        } else if (e.type === "stalemate") {
          rallies.push({ strikes: cur.strikes, top: cur.top, endSpeed: null });
          cur = { strikes: 0, top: 0 };
          pending.clear();
        }
      }
    }

    const rl = rallies.map((x) => x.strikes);
    const long = rallies.filter((x) => x.strikes >= 8);
    const reachedTop = rallies.filter((x) => x.top >= top * 0.9).length;
    const endBands = bands.map(([lo, hi]) => rallies.filter((x) => x.endSpeed !== null && x.endSpeed >= lo && x.endSpeed < hi).length);
    const M = runs.length;

    console.log(`\nDeflect Duel FUN TABLE: ${M} matches, ${players} bots, ${lives} lives (base ${base}, top ${top})`);
    console.log("──────────────────────────────────────────────────────────────────");
    console.log(`Rally length (strikes)     median ${f1(median(rl))}, mean ${f1(rl.reduce((a, b) => a + b, 0) / (rl.length || 1))}, longest ${Math.max(0, ...rl)}   [aim: median 4–12]`);
    console.log(`Median KO speed            ${f1(median(koSpeeds))}   [aim: well above base ${base}]`);
    console.log(`Top speed, long rallies    median ${f1(median(long.map((x) => x.top)))} over ${long.length} rallies of 8+ strikes`);
    console.log(`Rallies reaching top tier  ${reachedTop}/${rallies.length} (${pct(reachedTop, rallies.length)})   [aim: sometimes, not most]`);
    console.log(`Rally-ending speed bands   <40: ${endBands[0]}  40–100: ${endBands[1]}  100–160: ${endBands[2]}  160+: ${endBands[3]}`);
    console.log(`Aerial strikes             ${aerial}/${strikes} (${pct(aerial, strikes)})   [aim: ≥20%]`);
    console.log(`  of which real aerials     ${high}/${strikes} (${pct(high, strikes)}) with the car more than 2.5 up (flying, not a hop)`);
    console.log(`Flip strikes               ${flips} (${f1(flips / M)} per match)`);
    console.log(`Bot connect rate (swipes at an enemy ball, by its speed):`);
    bands.forEach(([lo, hi], k) => console.log(`   ${String(lo).padStart(3)}–${hi === Infinity ? "max" : hi}: ${connect[k].strikes}/${connect[k].swings} (${pct(connect[k].strikes, connect[k].swings)})`));
    console.log(`Per match                  clashes ${f1(totals.clashes / M)}, bunts (flip resets) ${f1(totals.bunts / M)}, bumps ${f1(totals.bumps / M)}, stalemates ${f1(totals.stalemates / M)}   [aim: stalemates <1]`);
    console.log(`Wins by seat               ${wins.slice(0, players).map((w, i) => `seat ${i + 1}: ${w}`).join("  ")}`);
    console.log(`Match length               median ${f1(median(lengths))} s, longest ${f1(Math.max(...lengths))} s, stuck ${stuck}`);
    if (errors.length) { console.log(`\nPage errors:\n  ${errors.slice(0, 5).join("\n  ")}`); exitCode = 1; }
    if (stuck) exitCode = 1;
    console.log(exitCode ? "\nRESULT: FAIL" : "\nRESULT: PASS (no errors, nothing stuck)");
  } finally {
    await browser.close();
  }
  process.exit(exitCode);
})();
