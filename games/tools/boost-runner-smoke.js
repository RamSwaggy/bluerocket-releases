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
     - a round whose race time goes past 135 s (sudden death starts at
       120 s and must finish the round within about 15 s; reaching
       120 s is printed as a WARNING)
     - a stuck car: alive, racing, and no forward progress for more than
       3 s of race time
     - a soft-lock: the game clock stops moving, or 0-1 cars left and no
       round end within 2 s of race time
     - a NaN or infinite car position or velocity
     - no match end within the time limit

   PRINTS the KO order of every round (race time, car, cause, chunk), the
   winner, the final wins, a repro command, then PASS/FAIL.
   Exit code 0 = PASS, 1 = FAIL.

   Field names come from Gameplay's games/boost-runner/js/README.md
   (game.state "countdown" / "race" / "round_end" / "match_end",
   game.roundNumber, game.raceTime, game.cars, game.wins, game.course,
   BR.events with ko {seat, cause, x, y}, round_end, match_end ...).
   They are all read in the READ helpers inside installWatcher(), so a
   change to that contract only needs editing there.

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
const WARN_ROUND_SECONDS = 120; // race time when sudden death starts: worth a WARNING
const MAX_ROUND_SECONDS = 135; // sudden death must end the round within ~15 s, so past this is a bug
const STUCK_SECONDS = 3; // alive with no forward progress for this long = stuck
const PROGRESS_UNITS = 0.5; // how far forward (world units) counts as progress
const NO_END_SECONDS = 2; // 0-1 cars left but still racing for this long = soft-lock
const FROZEN_REAL_SECONDS = 10; // game clock not moving for this long (real time) = soft-lock

/* ---------------------------------------------------------------------
   The watcher. This function runs INSIDE the page. It samples the game
   about 60 times a second (real time), keeps its own records in
   window.__qc, and never changes the game's state.

   It also reads BR.events as they arrive and builds the per-round KO
   list itself: the README's ko event carries seat, cause, x and y, so
   the watcher adds the round number (from the latest round_start) and
   the chunk (course.chunkAt(x), looked up while that round's course is
   still live).
   --------------------------------------------------------------------- */
function installWatcher(limits) {
  // ----- READ helpers: the only place that knows BR's field names -----
  const R = {
    ready: () => !!(window.BR && window.BR.game),
    game: () => window.BR.game,
    roundNo: (g) => g.roundNumber,
    state: (g) => g.state, // "countdown" | "race" | "round_end" | "match_end"
    racing: (g) => g.state === "race",
    matchOver: (g) => g.state === "match_end",
    clock: (g) => g.time, // seconds since this round's countdown began (always moves)
    raceTime: (g) => g.raceTime, // seconds since GO; KO and event times use this
    cars: (g) => g.cars || [],
    carName: (c) => c.name || `seat ${c.seat}`,
    carAlive: (c) => c.alive,
    carX: (c) => c.x,
    carY: (c) => c.y,
    carVX: (c) => c.vx,
    carVY: (c) => c.vy,
    // car.chunkIndex points into course.chunks; print the chunk's id.
    carChunk: (g, c) => {
      const ch = g.course && g.course.chunks && g.course.chunks[c.chunkIndex];
      return ch ? ch.id : c.chunkIndex;
    },
    wins: (g) => g.wins || [],
    // The tuning object the cars run on. Not in README.md yet (the shared
    // car takes tuning as an update() argument), so try the likely spots.
    tuning: (g) => g.tuning || (g.cars && g.cars[0] && g.cars[0].tuning) || null,
    chunkAtX: (g, x) => {
      const ch = g.course && g.course.chunkAt && g.course.chunkAt(x);
      return ch ? ch.id : "?";
    },
    events: () => (Array.isArray(window.BR.events) ? window.BR.events : []),
  };

  const qc = (window.__qc = {
    failures: [], // strings; any entry = FAIL
    notes: [], // things worth printing that aren't failures
    lastClock: null, // for the "frozen" soft-lock check (read from Node)
    matchOver: false,
    tuningChecked: false,
    rounds: {}, // round number -> { kos: [...], end: {...} }
    matchEnd: null,
  });
  const fail = (msg) => { if (qc.failures.length < 50) qc.failures.push(msg); };
  const seatName = (g, s) => (s === null || s === undefined ? "draw" : R.carName(R.cars(g)[s] || { seat: s }));

  // Per-round memory, reset at each new round.
  let roundKey = null;
  let best = {}; // seat -> { x, t }: furthest x so far and when it was reached
  let stuckReported = {};
  let nanReported = {};
  let fewLeftSince = null;
  let tooLongReported = false;
  let warnedSuddenDeath = false;
  let eventsSeen = 0; // how many BR.events we've already processed
  let eventRound = 0; // round number from the latest round_start event

  // Read any new events since the last sample, in order.
  function readEvents(g) {
    const ev = R.events();
    for (; eventsSeen < ev.length; eventsSeen++) {
      const e = ev[eventsSeen];
      if (e.type === "round_start") eventRound = e.round;
      const r = (qc.rounds[eventRound] = qc.rounds[eventRound] || { kos: [], end: null });
      if (e.type === "ko") {
        // ko carries chunk (placed index) and id (chunk id); print the id, falling back to a lookup by x.
        r.kos.push({ t: e.t, car: seatName(g, e.seat), cause: e.cause, chunk: e.id != null ? `${e.id} (#${e.chunk})` : R.chunkAtX(g, e.x) });
      } else if (e.type === "round_end") {
        r.end = { t: e.t, winner: seatName(g, e.winner), wins: e.wins };
      } else if (e.type === "match_end") {
        qc.matchEnd = { winner: seatName(g, e.winner), wins: e.wins };
      }
    }
  }

  function sample() {
    if (!R.ready()) return;
    const g = R.game();
    readEvents(g);
    const cars = R.cars(g);
    qc.lastClock = `${R.roundNo(g)}:${R.state(g)}:${R.clock(g)}`;
    if (R.matchOver(g)) { qc.matchOver = true; return; }

    // New round: reset the per-round memory.
    if (R.roundNo(g) !== roundKey) {
      roundKey = R.roundNo(g);
      best = {};
      stuckReported = {};
      nanReported = {};
      fewLeftSince = null;
      tooLongReported = false;
      warnedSuddenDeath = false;
    }
    const key = roundKey;
    const t = R.raceTime(g);

    // Shared car feel: tuning may only differ from TP.CAR_TUNING in
    // TP.MODE_TUNABLE keys. Checked once, on the first sample with cars.
    if (!qc.tuningChecked && cars.length && window.TP && TP.CAR_TUNING && TP.MODE_TUNABLE) {
      qc.tuningChecked = true;
      const tun = R.tuning(g);
      if (!tun) qc.notes.push("!!! TUNING CHECK SKIPPED: no game.tuning to read, so the shared-car-feel check did NOT run. Gameplay is adding game.tuning (see js/README.md). !!!");
      else {
        for (const k of new Set([...Object.keys(TP.CAR_TUNING), ...Object.keys(tun)])) {
          if (TP.MODE_TUNABLE.includes(k)) continue;
          if (tun[k] !== TP.CAR_TUNING[k]) fail(`tuning "${k}" is ${tun[k]}, shared value is ${TP.CAR_TUNING[k]} (not in MODE_TUNABLE)`);
        }
      }
    }

    // NaN / infinity in any car's position or velocity (once per car per round).
    for (const c of cars) {
      const vals = [R.carX(c), R.carY(c), R.carVX(c), R.carVY(c)];
      if (vals.some((v) => typeof v !== "number" || !isFinite(v)) && !nanReported[c.seat]) {
        nanReported[c.seat] = true;
        fail(`round ${key} t=${Number(t).toFixed(2)}: ${R.carName(c)} has a bad position/velocity [x, y, vx, vy] = [${vals.join(", ")}]`);
      }
    }

    // The rest only makes sense while racing (cars are frozen in the countdown).
    if (!R.racing(g)) return;

    // Sudden death reached: allowed, but rounds should normally end long before.
    if (t > limits.WARN_ROUND_SECONDS && !warnedSuddenDeath) {
      warnedSuddenDeath = true;
      qc.notes.push(`WARNING: round ${key} reached sudden death (${limits.WARN_ROUND_SECONDS} s of racing)`);
    }

    // Round too long: sudden death should have ended it by now.
    if (t > limits.MAX_ROUND_SECONDS && !tooLongReported) {
      tooLongReported = true;
      fail(`round ${key} is still racing at ${t.toFixed(1)} s (limit ${limits.MAX_ROUND_SECONDS} s)`);
    }

    // Stuck cars: alive but no forward progress for STUCK_SECONDS.
    for (const c of cars) {
      if (!R.carAlive(c)) continue;
      const x = R.carX(c);
      const b = best[c.seat];
      if (!b || x > b.x + limits.PROGRESS_UNITS) best[c.seat] = { x, t };
      else if (t - b.t > limits.STUCK_SECONDS && !stuckReported[c.seat]) {
        stuckReported[c.seat] = true;
        fail(`round ${key} t=${t.toFixed(2)}: ${R.carName(c)} stuck at x=${x.toFixed(1)} y=${R.carY(c).toFixed(1)} in chunk ${R.carChunk(g, c)} (no progress for ${limits.STUCK_SECONDS} s)`);
      }
    }

    // Soft-lock: 0 or 1 cars left but the round keeps racing.
    const alive = cars.filter(R.carAlive).length;
    if (alive <= 1) {
      if (fewLeftSince === null) fewLeftSince = t;
      else if (t - fewLeftSince > limits.NO_END_SECONDS) {
        fail(`round ${key}: ${alive} car(s) left since t=${fewLeftSince.toFixed(2)} but the round is still racing`);
        fewLeftSince = Infinity; // report once
      }
    } else fewLeftSince = null;
  }

  // setInterval keeps running in a headless page even without rendering.
  setInterval(sample, 16);
  window.__qcRead = R;
}

/* ---------------------------------------------------------------------
   Node side: open the page, watch the console, print a status line
   every 3 seconds, then print the KO order and the result.
   --------------------------------------------------------------------- */
(async () => {
  // SwiftShader = software WebGL, so index.html works on machines with no GPU.
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

  await page.addInitScript(installWatcher, { WARN_ROUND_SECONDS, MAX_ROUND_SECONDS, STUCK_SECONDS, PROGRESS_UNITS, NO_END_SECONDS });

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
      const qc = window.__qc || {};
      if (!R || !R.ready()) return { ready: false, failures: qc.failures || [] };
      const g = R.game();
      const w = R.wins(g);
      return {
        ready: true,
        round: R.roundNo(g),
        state: R.state(g),
        raceTime: R.raceTime(g),
        cars: R.cars(g).map((c) => `${R.carName(c)} ${R.carAlive(c) ? "alive" : "KO"} ${w[c.seat] || 0}w`).join(" | "),
        clock: qc.lastClock,
        matchOver: qc.matchOver,
        failures: qc.failures,
      };
    });
    if (!status.ready) {
      console.log(`${String(t + 3).padStart(4)}s  waiting for window.BR.game ...`);
      continue;
    }
    console.log(`${String(t + 3).padStart(4)}s  round ${status.round} ${String(status.state).padEnd(10)} race ${Number(status.raceTime).toFixed(1).padStart(6)}s  ${status.cars}`);

    // Game clock not moving = soft-lock (unless the match has ended).
    if (status.clock === lastClock && !status.matchOver) frozenFor += 3;
    else frozenFor = 0;
    lastClock = status.clock;
    if (frozenFor >= FROZEN_REAL_SECONDS) {
      errors.push(`SOFT-LOCK: game clock stuck at "${status.clock}" for ${frozenFor} s of real time`);
      break;
    }
    if (status.matchOver) finished = true;
  }

  // Give the watcher one more sample so the last events are read.
  await page.waitForTimeout(100);
  const qc = await page.evaluate(() => window.__qc || null);

  if (qc) {
    for (const [r, info] of Object.entries(qc.rounds)) {
      if (r === "0" && !info.kos.length && !info.end) continue;
      console.log(`\nRound ${r}:`);
      for (const k of info.kos) console.log(`  KO   t=${Number(k.t).toFixed(2).padStart(6)}  ${String(k.car).padEnd(8)} cause=${String(k.cause).padEnd(7)} chunk=${k.chunk}`);
      if (info.end) console.log(`  END  t=${Number(info.end.t).toFixed(2).padStart(6)}  winner=${info.end.winner}  wins=${JSON.stringify(info.end.wins)}`);
    }
    if (qc.matchEnd) console.log(`\nMatch winner: ${qc.matchEnd.winner}   final wins: ${JSON.stringify(qc.matchEnd.wins)}`);
    // Notes are printed between banners so a skipped check can't hide in the output.
    if (qc.notes.length) {
      console.log("\n" + "=".repeat(72));
      qc.notes.forEach((n) => console.log(n));
      console.log("=".repeat(72));
    }
  }

  const problems = [...errors, ...((qc && qc.failures) || []).map((f) => "CHECK: " + f)];
  if (!finished) problems.push(`NO MATCH END within ${timeoutSec} s real time`);
  console.log(problems.length ? "\nPROBLEMS:\n" + problems.map((p) => "  - " + p).join("\n") : "\nNo problems found.");
  console.log(`Repro: node tools/boost-runner-smoke.js ${rounds} ${speed} ${timeoutSec} ${seed} ${pageName}`);
  console.log(!problems.length ? "RESULT: PASS (match finished)" : "RESULT: FAIL");
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})();
