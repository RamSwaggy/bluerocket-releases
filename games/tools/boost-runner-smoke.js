/* =====================================================================
   boost-runner-smoke.js — plays a whole Boost Runner match with bots in
   a headless browser and checks the things that must never break.

   Usage (from the games folder):
     node tools/boost-runner-smoke.js [rounds] [speed] [timeoutSec] [seed] [page]
     node tools/boost-runner-smoke.js 3 8 240
     node tools/boost-runner-smoke.js 3 8 240 12345
     node tools/boost-runner-smoke.js 3 8 240 12345 index.html

   rounds      round wins needed to take the match (?rounds=N, default 3)
   speed       game speed multiplier (?speed=X, default 8)
   timeoutSec  real-time limit for the whole run (default 240)
   seed        course and bot seed (?seed=S, default 1). Same seed = same match.
   page        sim.html (logic only, the default) or index.html (full game)

   FAILS on any of:
     - a page error or console error
     - a "[Rocket Rumble] ... Ignored" warning (a mode tried to change
       part of the shared car feel)
     - car tuning that differs from TP.CAR_TUNING outside TP.MODE_TUNABLE
     - a round longer than 120 s of game time
     - a stuck car: alive, round in play, and no forward progress for
       more than 3 s of game time
     - a soft-lock: game time stops moving, or 0-1 cars left and no
       round end within 2 s of game time
     - a NaN or infinite car position or velocity
     - no match end within the time limit

   PRINTS the KO order of every round (time, car, cause, chunk), the
   final wins, and PASS/FAIL. Exit code 0 = PASS, 1 = FAIL.

   STATUS: written against the DESIGN.md section 8 hook shapes and
   tested only against a throwaway mock page. The field names it reads
   live in the READ helpers inside installWatcher(); they get updated
   to match js/README.md once Gameplay ships js/br.js and sim.html.

   Needs Playwright (pre-installed in cloud sessions).
   ===================================================================== */
const path = require("path");
const { chromium } = require("playwright");

const rounds = Number(process.argv[2] || 3);
const speed = Number(process.argv[3] || 8);
const timeoutSec = Number(process.argv[4] || 240);
const seed = process.argv[5] || "1";
const pageName = process.argv[6] || "sim.html";

// Limits from DESIGN.md section 5 and the boss's job description.
const MAX_ROUND_SECONDS = 120; // the hard backstop; a round past this is a bug
const STUCK_SECONDS = 3; // alive with no forward progress for this long = stuck
const PROGRESS_UNITS = 0.5; // how far forward (world units) counts as progress
const NO_END_SECONDS = 2; // 0-1 cars left but no round end for this long = soft-lock
const FROZEN_REAL_SECONDS = 10; // game clock not moving for this long (real time) = soft-lock

/* ---------------------------------------------------------------------
   The watcher. This function runs INSIDE the page. It samples the game
   about 60 times a second (real time), keeps its own records in
   window.__qc, and never changes the game's state.

   All the field names it reads from window.BR sit in the READ helpers
   at the top, so when Gameplay publishes js/README.md only that part
   needs adjusting.
   --------------------------------------------------------------------- */
function installWatcher(limits) {
  // ----- READ helpers: the only place that knows BR's field names -----
  const R = {
    ready: () => !!(window.BR && window.BR.game),
    game: () => window.BR.game,
    roundNo: (g) => g.round,
    roundState: (g) => g.state, // "countdown" | "play" | "over" | "match_over"
    time: (g) => g.time, // seconds of game time in this round
    cars: (g) => g.cars || [],
    carId: (c) => (c.name || c.id),
    carAlive: (c) => c.alive,
    carX: (c) => c.x,
    carY: (c) => c.y,
    carVX: (c) => (c.vx !== undefined ? c.vx : c.vel && c.vel.x),
    carVY: (c) => (c.vy !== undefined ? c.vy : c.vel && c.vel.y),
    carChunk: (c) => c.chunk,
    carWins: (c) => c.wins,
    carTuning: (c) => c.tuning || (c.car && c.car.tuning) || (c.car && c.car.t),
    // BR.events may be an array, or an object holding one.
    events: () => {
      const e = window.BR.events;
      if (Array.isArray(e)) return e;
      return (e && (e.log || e.list || e.all)) || [];
    },
    matchOver: (g) => g.state === "match_over" || g.matchOver === true || !!g.winner,
  };

  const qc = (window.__qc = {
    failures: [], // strings; any entry = FAIL
    samples: 0,
    lastGameClock: null, // for the "frozen" soft-lock check (read from Node)
    matchOver: false,
    tuningChecked: false,
  });
  const fail = (msg) => { if (qc.failures.length < 50) qc.failures.push(msg); };

  // Per-round memory: best x reached by each car and when.
  let roundKey = null;
  let best = {}; // carId -> { x, t }
  let stuckReported = {};
  let nanReported = {}; // carId -> true once a bad value has been reported this round
  let fewLeftSince = null;
  let roundTooLongReported = false;

  function sample() {
    if (!R.ready()) return;
    const g = R.game();
    qc.samples++;
    const state = R.roundState(g);
    const t = R.time(g);
    const cars = R.cars(g);
    qc.lastGameClock = `${R.roundNo(g)}:${state}:${t}`;
    if (R.matchOver(g)) { qc.matchOver = true; return; }

    // New round: reset the per-round memory.
    const key = R.roundNo(g);
    if (key !== roundKey) {
      roundKey = key;
      best = {};
      stuckReported = {};
      nanReported = {};
      fewLeftSince = null;
      roundTooLongReported = false;
    }

    // Shared car feel: tuning may only differ in TP.MODE_TUNABLE keys.
    // Checked once, on the first sample that has cars.
    if (!qc.tuningChecked && cars.length && window.TP && TP.CAR_TUNING && TP.MODE_TUNABLE) {
      qc.tuningChecked = true;
      cars.forEach((c) => {
        const tun = R.carTuning(c);
        if (!tun) { fail(`can't find the tuning object on car ${R.carId(c)} (update the READ helpers)`); return; }
        for (const k of new Set([...Object.keys(TP.CAR_TUNING), ...Object.keys(tun)])) {
          if (TP.MODE_TUNABLE.includes(k)) continue;
          if (tun[k] !== TP.CAR_TUNING[k]) {
            fail(`car ${R.carId(c)} tuning "${k}" is ${tun[k]}, shared value is ${TP.CAR_TUNING[k]} (not in MODE_TUNABLE)`);
          }
        }
      });
    }

    // NaN / infinity in any car's position or velocity.
    for (const c of cars) {
      const vals = [R.carX(c), R.carY(c), R.carVX(c), R.carVY(c)];
      // Report the first bad sample per car per round, so one bug doesn't flood the report.
      if (vals.some((v) => typeof v !== "number" || !isFinite(v)) && !nanReported[R.carId(c)]) {
        nanReported[R.carId(c)] = true;
        fail(`round ${key} t=${Number(t).toFixed(2)}: car ${R.carId(c)} has a bad position/velocity [x, y, vx, vy] = [${vals.join(", ")}]`);
      }
    }

    if (state !== "play") return;

    // Round too long: the 120 s backstop should have ended it.
    if (t > limits.MAX_ROUND_SECONDS && !roundTooLongReported) {
      roundTooLongReported = true;
      fail(`round ${key} is still going at ${t.toFixed(1)} s (limit ${limits.MAX_ROUND_SECONDS} s)`);
    }

    // Stuck cars: alive but no forward progress for STUCK_SECONDS.
    for (const c of cars) {
      const id = R.carId(c);
      if (!R.carAlive(c)) continue;
      const x = R.carX(c);
      if (!best[id] || x > best[id].x + limits.PROGRESS_UNITS) best[id] = { x, t };
      else if (t - best[id].t > limits.STUCK_SECONDS && !stuckReported[id]) {
        stuckReported[id] = true;
        fail(`round ${key} t=${t.toFixed(2)}: car ${id} stuck at x=${x.toFixed(1)} y=${R.carY(c).toFixed(1)} in chunk ${R.carChunk(c)} (no progress for ${limits.STUCK_SECONDS} s)`);
      }
    }

    // Soft-lock: 0 or 1 cars left but the round doesn't end.
    const alive = cars.filter(R.carAlive).length;
    if (alive <= 1) {
      if (fewLeftSince === null) fewLeftSince = t;
      else if (t - fewLeftSince > limits.NO_END_SECONDS) {
        fail(`round ${key}: ${alive} car(s) left since t=${fewLeftSince.toFixed(2)} but the round hasn't ended`);
        fewLeftSince = Infinity; // report once
      }
    } else fewLeftSince = null;
  }

  // setInterval keeps running in a headless page even without rendering.
  setInterval(sample, 16);
  // Expose the READ helpers so Node can use the same field names.
  window.__qcRead = R;
}

/* ---------------------------------------------------------------------
   Node side: open the page, watch the console, poll a status line every
   3 seconds, then print the KO order and the result.
   --------------------------------------------------------------------- */
(async () => {
  // SwiftShader = software WebGL, so this works on machines with no GPU.
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
  page.on("console", (m) => {
    const text = m.text();
    if (m.type() === "error") errors.push("CONSOLE ERROR: " + text);
    // The shared car code warns like this when a mode changes a fixed setting.
    if (text.includes("[Rocket Rumble]") && text.includes("Ignored")) errors.push("CAR FEEL WARNING: " + text);
  });

  await page.addInitScript(installWatcher, { MAX_ROUND_SECONDS, STUCK_SECONDS, PROGRESS_UNITS, NO_END_SECONDS });

  const file = "file:///" + path.resolve(__dirname, "../boost-runner", pageName).replace(/\\/g, "/");
  const url = `${file}?demo&rounds=${rounds}&speed=${speed}&seed=${encodeURIComponent(seed)}`;
  console.log(`Boost Runner smoke: ${pageName}  rounds=${rounds} speed=${speed} seed=${seed}\n`);
  await page.goto(url);

  let finished = false;
  let frozenFor = 0;
  let lastClock = null;
  let status = null;
  for (let t = 0; t < timeoutSec && !finished; t += 3) {
    await page.waitForTimeout(3000);
    status = await page.evaluate(() => {
      const R = window.__qcRead;
      if (!R || !R.ready()) return { ready: false, clock: null, failures: (window.__qc || {}).failures || [] };
      const g = R.game();
      return {
        ready: true,
        round: R.roundNo(g),
        state: R.roundState(g),
        time: R.time(g),
        cars: R.cars(g).map((c) => `${R.carId(c)} ${R.carAlive(c) ? "alive" : "KO"} w${R.carWins(c)}`).join(" | "),
        clock: window.__qc.lastGameClock,
        matchOver: window.__qc.matchOver,
        failures: window.__qc.failures,
      };
    });
    if (!status.ready) {
      console.log(`${String(t + 3).padStart(4)}s  waiting for window.BR.game ...`);
      continue;
    }
    console.log(`${String(t + 3).padStart(4)}s  round ${status.round} ${String(status.state).padEnd(10)} t=${Number(status.time).toFixed(1).padStart(6)}  ${status.cars}`);

    // Frozen game clock = soft-lock (unless the match has ended).
    if (status.clock === lastClock && !status.matchOver) frozenFor += 3;
    else frozenFor = 0;
    lastClock = status.clock;
    if (frozenFor >= FROZEN_REAL_SECONDS) {
      errors.push(`SOFT-LOCK: game clock stuck at "${status.clock}" for ${frozenFor} s of real time`);
      break;
    }
    if (status.matchOver) finished = true;
  }

  // KO order per round, from BR.events, plus final wins.
  const summary = await page.evaluate(() => {
    const R = window.__qcRead;
    if (!R || !R.ready()) return null;
    const ev = R.events();
    const byRound = {};
    for (const e of ev) {
      if (e.type !== "ko" && e.type !== "round_end") continue;
      const r = e.round !== undefined ? e.round : "?";
      (byRound[r] = byRound[r] || []).push(e);
    }
    return {
      rounds: byRound,
      wins: R.cars(R.game()).map((c) => `${R.carId(c)} ${R.carWins(c)}`).join(", "),
      eventCount: ev.length,
    };
  });

  const watcherFailures = (status && status.failures) || [];
  if (summary) {
    for (const [r, list] of Object.entries(summary.rounds)) {
      console.log(`\nRound ${r}:`);
      for (const e of list) {
        if (e.type === "ko") {
          console.log(`  KO  t=${Number(e.t).toFixed(2).padStart(6)}  ${e.car ?? e.id ?? e.seat}  cause=${e.cause}  chunk=${e.chunk}`);
        } else {
          console.log(`  END t=${Number(e.t).toFixed(2).padStart(6)}  winner=${e.winner ?? "draw"}`);
        }
      }
    }
    console.log(`\nFinal wins: ${summary.wins}   (${summary.eventCount} events logged)`);
  }

  const problems = [...errors, ...watcherFailures.map((f) => "CHECK: " + f)];
  if (!finished) problems.push(`NO MATCH END within ${timeoutSec} s real time`);
  console.log(problems.length ? "\nPROBLEMS:\n" + problems.map((p) => "  - " + p).join("\n") : "\nNo problems found.");
  console.log(`Repro: node tools/boost-runner-smoke.js ${rounds} ${speed} ${timeoutSec} ${seed} ${pageName}`);
  console.log(!problems.length ? "RESULT: PASS (match finished)" : "RESULT: FAIL");
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})();
