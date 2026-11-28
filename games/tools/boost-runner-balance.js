/* =====================================================================
   boost-runner-balance.js — plays many seeded Boost Runner rounds with
   bots, as fast as the computer can step them, and reports the numbers
   that tell us whether the game is fair and well paced.

   Usage (from the games folder):
     node tools/boost-runner-balance.js [rounds] [firstSeed] [bots] [difficulty]
     node tools/boost-runner-balance.js 200
     node tools/boost-runner-balance.js 200 1000 4 hard

   rounds      how many rounds to play (default 100). Each round is a
               fresh one-round match with its own seed, so every round
               has a new course and the same starting grid.
   firstSeed   seed of the first round; the rest count up (default 1)
   bots        cars per round, 2-4 (default 4)
   difficulty  easy | normal | hard (default normal)

   REPORTS
     - wins per seat (are the start positions fair?) and draws
     - who gets knocked out first, per seat
     - round length: average, median, shortest, longest; how many reached
       sudden death (120 s) and how many ran past 135 s
     - KOs by cause ("behind" = the camera's trailing edge caught the car,
       "fell" = dropped off the bottom), and how many rounds the camera
       squeeze decided (every KO in the round was "behind")
     - per chunk: times entered, KOs there, and the KO rate; plus chunks
       no bot ever cleared
     - stuck cars (alive, racing, no forward progress for 3 s), with seed,
       round time, position and how many bumps the car took just before
       (several = a pile-up, none = probably geometry or a bot bug), so
       each one can be replayed
     - page errors

   Exit code 0 = it ran with no page errors and no stuck cars. The balance
   numbers themselves are for people to read; they don't fail the run.

   How it works: it opens sim.html with no flags (so nothing starts by
   itself), then for each seed calls BR.createGame(...) and steps the
   game 1/60 s at a time inside the page, watching every step. No
   rendering, no real-time waiting.
   ===================================================================== */
const path = require("path");
const { chromium } = require("playwright");

const rounds = Number(process.argv[2] || 100);
const firstSeed = Number(process.argv[3] || 1);
const bots = Math.min(4, Math.max(2, Number(process.argv[4] || 4)));
const difficulty = process.argv[5] || "normal";

(async () => {
  const browser = await chromium.launch({ args: ["--mute-audio"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error") errors.push("CONSOLE ERROR: " + t);
    if (t.includes("[Rocket Rumble]") && t.includes("Ignored")) errors.push("CAR FEEL WARNING: " + t);
  });

  const file = "file:///" + path.resolve(__dirname, "../boost-runner/sim.html").replace(/\\/g, "/");
  await page.goto(file);
  await page.waitForFunction(() => window.BR && BR.createGame && BR.Match, null, { timeout: 30000 });

  console.log(`Boost Runner balance: ${rounds} rounds, seeds ${firstSeed}..${firstSeed + rounds - 1}, ${bots} bots (${difficulty})\n`);
  const started = Date.now();

  // Play in batches so we can print progress and keep each evaluate() short.
  const BATCH = 10;
  const all = [];
  for (let done = 0; done < rounds; done += BATCH) {
    const n = Math.min(BATCH, rounds - done);
    const batch = await page.evaluate(({ seed0, n, bots, difficulty }) => {
      const STEP = 1 / 60;
      const STUCK_SECONDS = 3;
      const PROGRESS_UNITS = 0.5;
      const MAX_STEPS = 60 * 200; // 200 s of game time per round, a safety net
      const out = [];
      for (let k = 0; k < n; k++) {
        const seed = seed0 + k;
        const seats = [];
        for (let i = 0; i < bots; i++) seats.push({ name: TP.DEFAULT_NAMES[i], controller: "bot", difficulty });
        // One-round match: winsToTake 1. A draw starts another round, so we
        // only look at round 1 to keep every sample on the same footing.
        const g = BR.createGame({ seed, seats, winsToTake: 1 });
        const rec = { seed, winner: undefined, time: null, kos: [], stuck: [], chunksEntered: {}, nan: false, timedOut: false };
        const best = {};
        const stuckSeen = {};
        const bumpTimes = {}; // seat -> race times of bumps it was in (to tell a pile-up from a geometry trap)
        let steps = 0;
        let evSeen = 0;
        while (steps < MAX_STEPS && !g.finished) {
          g.step(STEP);
          steps++;
          // Read new events from round 1 only.
          for (; evSeen < g.events.length; evSeen++) {
            const e = g.events[evSeen];
            if (e.round !== undefined && e.round !== 1) continue;
            if (e.type === "ko") rec.kos.push({ seat: e.seat, cause: e.cause, chunk: e.id, t: e.t });
            if (e.type === "bump") for (const s of [e.a, e.b]) (bumpTimes[s] = bumpTimes[s] || []).push(e.t);
            if (e.type === "chunk_enter") rec.chunksEntered[e.id] = (rec.chunksEntered[e.id] || 0) + 1;
            if (e.type === "round_end" && rec.time === null) { rec.winner = e.winner; rec.time = e.t; }
          }
          if (rec.time !== null) break; // round 1 decided
          if (g.state !== "race") continue;
          const t = g.raceTime;
          for (const c of g.cars) {
            if (![c.x, c.y, c.vx, c.vy].every(isFinite)) rec.nan = true;
            if (!c.alive) continue;
            const b = best[c.seat];
            if (!b || c.x > b.x + PROGRESS_UNITS) best[c.seat] = { x: c.x, t };
            else if (t - b.t > STUCK_SECONDS && !stuckSeen[c.seat]) {
              stuckSeen[c.seat] = true;
              const ch = g.course.chunks[c.chunkIndex];
              // Bumps in the stuck window: several = a pile-up, none = something trapped it.
              const bumps = (bumpTimes[c.seat] || []).filter((bt) => bt >= t - STUCK_SECONDS - 0.5).length;
              rec.stuck.push({ seat: c.seat, t: Math.round(t * 10) / 10, x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10, chunk: ch ? ch.id : c.chunkIndex, bumps });
            }
          }
        }
        if (rec.time === null) { rec.timedOut = true; rec.time = g.raceTime; }
        g.dispose();
        out.push(rec);
      }
      return out;
    }, { seed0: firstSeed + done, n, bots, difficulty });
    all.push(...batch);
    process.stdout.write(`  ${all.length}/${rounds} rounds (${((Date.now() - started) / 1000).toFixed(0)} s)\r`);
  }
  console.log("");

  /* ---------- Summarise ---------- */
  const names = ["Blue", "Orange", "Green", "Pink"].slice(0, bots);
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "-");
  const pad = (s, n) => String(s).padEnd(n);

  // Wins and first KOs per seat.
  const wins = names.map(() => 0);
  const firstOut = names.map(() => 0);
  let draws = 0;
  for (const r of all) {
    if (r.winner === null) draws++;
    else if (r.winner !== undefined) wins[r.winner]++;
    if (r.kos.length) firstOut[r.kos[0].seat]++;
  }
  const fair = 100 / bots;
  console.log(`\nWINS PER SEAT (a fair share is ${fair.toFixed(1)}% each)`);
  names.forEach((n, i) => console.log(`  ${pad(n, 7)} ${String(wins[i]).padStart(4)}  ${pct(wins[i], rounds).padStart(6)}   knocked out first ${String(firstOut[i]).padStart(4)}  ${pct(firstOut[i], rounds).padStart(6)}`));
  console.log(`  draws   ${String(draws).padStart(4)}  ${pct(draws, rounds).padStart(6)}`);
  // A rough fairness flag: more than 10 points away from a fair share.
  const unfair = names.filter((n, i) => Math.abs((100 * wins[i]) / rounds - fair) > 10);
  if (unfair.length) console.log(`  ! more than 10 points from a fair share: ${unfair.join(", ")}`);

  // Round length.
  const times = all.map((r) => r.time).sort((a, b) => a - b);
  const avg = times.reduce((s, x) => s + x, 0) / times.length;
  const median = times[Math.floor(times.length / 2)];
  const sudden = all.filter((r) => r.time > 120).length;
  const tooLong = all.filter((r) => r.time > 135 || r.timedOut).length;
  console.log(`\nROUND LENGTH (race time; design target 45-90 s)`);
  console.log(`  average ${avg.toFixed(1)} s, median ${median.toFixed(1)} s, shortest ${times[0].toFixed(1)} s, longest ${times[times.length - 1].toFixed(1)} s`);
  const inTarget = all.filter((r) => r.time >= 45 && r.time <= 90).length;
  console.log(`  in 45-90 s: ${inTarget} (${pct(inTarget, rounds)}), under 45 s: ${all.filter((r) => r.time < 45).length}, over 90 s: ${all.filter((r) => r.time > 90).length}`);
  console.log(`  reached sudden death (>120 s): ${sudden} (${pct(sudden, rounds)}), past 135 s or never ended: ${tooLong}`);

  // KO causes, and how many rounds the camera squeeze decided on its own.
  const kos = all.flatMap((r) => r.kos);
  const byCause = {};
  kos.forEach((k) => (byCause[k.cause] = (byCause[k.cause] || 0) + 1));
  const squeezeRounds = all.filter((r) => r.kos.length && r.kos.every((k) => k.cause === "behind")).length;
  console.log(`\nKOs BY CAUSE (${kos.length} KOs)`);
  for (const [c, n] of Object.entries(byCause).sort((a, b) => b[1] - a[1])) console.log(`  ${pad(c, 8)} ${String(n).padStart(5)}  ${pct(n, kos.length)}`);
  console.log(`  rounds where every KO was "behind" (decided by the camera squeeze): ${squeezeRounds} (${pct(squeezeRounds, rounds)})`);

  // Per chunk: entered, KOs, KO rate.
  const entered = {};
  const koAt = {};
  all.forEach((r) => Object.entries(r.chunksEntered).forEach(([id, n]) => (entered[id] = (entered[id] || 0) + n)));
  kos.forEach((k) => (koAt[k.chunk] = (koAt[k.chunk] || 0) + 1));
  const ids = [...new Set([...Object.keys(entered), ...Object.keys(koAt)])].sort((a, b) => (koAt[b] || 0) - (koAt[a] || 0));
  console.log(`\nPER CHUNK (KO rate = KOs there / cars that entered it)`);
  console.log(`  ${pad("chunk", 14)} ${"entered".padStart(8)} ${"KOs".padStart(6)} ${"KO rate".padStart(8)}`);
  for (const id of ids) console.log(`  ${pad(id, 14)} ${String(entered[id] || 0).padStart(8)} ${String(koAt[id] || 0).padStart(6)} ${pct(koAt[id] || 0, entered[id] || 0).padStart(8)}`);
  const known = await page.evaluate(() => Object.keys(BR.CHUNKS || {}).filter((id) => id !== "start"));
  const neverEntered = known.filter((id) => !entered[id]);
  if (neverEntered.length) console.log(`  never entered in these rounds: ${neverEntered.join(", ")}`);

  // Stuck cars and other problems.
  const stuck = all.flatMap((r) => r.stuck.map((s) => ({ ...s, seed: r.seed })));
  const nan = all.filter((r) => r.nan).map((r) => r.seed);
  const timedOut = all.filter((r) => r.timedOut).map((r) => r.seed);
  console.log(`\nSTUCK CARS (${stuck.length})`);
  stuck.slice(0, 30).forEach((s) => console.log(`  seed ${s.seed}: ${names[s.seat]} at t=${s.t}s x=${s.x} y=${s.y} in chunk ${s.chunk}, ${s.bumps} bump(s) in the last ${3.5} s${s.bumps ? " (pile-up?)" : " (no bumps: geometry or bot trap?)"}   (replay: sim.html?demo&rounds=1&seed=${s.seed})`));
  if (stuck.length > 30) console.log(`  ... and ${stuck.length - 30} more`);
  if (nan.length) console.log(`\nNaN POSITIONS in seeds: ${nan.join(", ")}`);
  if (timedOut.length) console.log(`\nROUNDS THAT NEVER ENDED (200 s safety net) in seeds: ${timedOut.join(", ")}`);

  console.log(errors.length ? "\nERRORS:\n" + [...new Set(errors)].map((e) => "  - " + e).join("\n") : "\nNo page errors.");
  console.log(`Took ${((Date.now() - started) / 1000).toFixed(0)} s.`);
  const ok = !errors.length && !stuck.length && !nan.length && !timedOut.length;
  console.log(ok ? "RESULT: PASS (no errors, no stuck cars)" : "RESULT: FAIL (see above)");
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
