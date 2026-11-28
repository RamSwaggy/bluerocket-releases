/* =====================================================================
   mode-5-smoke.js — plays a whole Mode 5 match with 4 bots in a
   headless browser and checks that it behaves.

   Usage (from the games folder):
     node tools/mode-5-smoke.js [rounds] [speed] [maxSeconds] [time]
     node tools/mode-5-smoke.js 1 8 120          # 1 round, 8 steps/frame
     node tools/mode-5-smoke.js 3 16 240 40      # best of 3, 40 s rounds

   `speed` = physics steps per frame (?speed=N in main.js); 0 = real time.
   `time` (optional) = round length in seconds (?time=T).

   What it checks (each one prints PASS/FAIL):
     1. the match reaches phase "matchEnd" before maxSeconds (real time)
     2. scores are never negative and never add up to more than 100 %
     3. every bot gets at least one real `fill` event (not small:true)
        in every round
     4. at least one `pop` happens somewhere in the match
     5. scores keep changing: no stretch of 10+ game seconds in "play"
        where the score bar doesn't move at all, and the round clock
        never stops for 10+ real seconds while in "play" (a hang)
     6. no car ever outside the arena walls or below the floor surface
        (checked on every physics step, see mode-5-lib.js)
     7. no page errors and no console errors
     8. FPS sanity: >= 5 fps under software WebGL (< 20 warns)
   Also printed, not a check: stuck cars (slower than 1 unit/s for 3+ s
   while not stunned). mode-5-batch.js counts those across many matches.
   Exit code 0 = every check passed, 1 = anything failed.
   ===================================================================== */
const { launch, runMatch } = require("./mode-5-lib");

const rounds = Number(process.argv[2] || 1);
const speed = Number(process.argv[3] || 8);
const maxSeconds = Number(process.argv[4] || 240);
const time = process.argv[5] ? Number(process.argv[5]) : undefined;

const FPS_FAIL = 5, FPS_WARN = 20;
const FREEZE_GAME_S = 10;   // check 5: score bar may not sit still this long
const HANG_WALL_S = 10;     // check 5: round clock may not stop this long

(async () => {
  const browser = await launch();
  const r = await runMatch(browser, { speed, rounds, time, maxSeconds, verbose: true });
  await browser.close();
  const count = (n) => r.log.filter((e) => e.name === n).length;
  const nPlayers = r.lastState ? r.lastState.players.length : 0;

  /* ---------- Report ---------- */
  console.log("\nEvents: " + ["roundStart", "roundEnd", "matchEnd", "trailStart", "fill", "pop", "dry", "splat", "land", "bump", "pickupSpawn", "pickup", "overdrive"]
    .map((n) => `${n} ${count(n)}`).join(", "));
  r.perRound.forEach((pr, i) => {
    const fills = [...pr.fills.entries()].sort((a, b) => a[0] - b[0]).map(([p, c]) => `p${p}:${c}`).join(" ") || "none";
    const mr = r.mon.rounds[i];
    console.log(`Round ${i + 1}: fills ${fills} (+${pr.small} small), best fill +${pr.bestFill.toFixed(1)}%, pops ${pr.pops} (${pr.minorPops} minor)` +
      (mr ? `, longest score freeze ${mr.maxFlat.toFixed(1)}s (from ${mr.flatAt}s)` : ""));
  });
  const endEvt = r.log.find((e) => e.name === "matchEnd");
  if (endEvt) console.log("matchEnd: winner " + endEvt.data.winner + ", standings " + JSON.stringify(endEvt.data.standings));
  if (r.lastState) console.log(`Final scores: [${r.lastState.scores.map((x) => x.toFixed(1)).join(", ")}]`);
  if (r.mon.stuck.length) console.log("Stuck cars: " + r.mon.stuck.map((s) => `car ${s.car} r${s.round} @${s.at}s (${s.x},${s.z}) for ${s.seconds}s`).join("; "));
  if (r.mon.watchError) console.log("Step monitor error: " + r.mon.watchError);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });
  check("match reaches matchEnd", r.finished, r.finished ? `after ${r.wallTotal.toFixed(0)}s` : `last phase "${r.lastState && r.lastState.phase}" after ${r.wallTotal.toFixed(0)}s`);
  check("scores >= 0 and sum <= 100%", r.samples > 0 && !r.scoreProblems.length, r.samples ? (r.scoreProblems.join("; ") || `${r.samples} samples ok`) : "never read any scores");
  const missing = [];
  if (!r.hooked) missing.push("event bus TP.M5.on never appeared");
  if (!r.perRound.length) missing.push("no roundStart events");
  r.perRound.forEach((pr, i) => {
    if (pr.fills.size < nPlayers) missing.push(`round ${i + 1}: only ${pr.fills.size}/${nPlayers} players filled (${[...pr.fills.keys()].join(",") || "-"})`);
  });
  check("every bot fills every round", !missing.length, missing.join("; ") || `${r.perRound.length} round(s)`);
  check("at least one pop in the match", count("pop") > 0, `${count("pop")} pops`);
  const maxFlat = Math.max(0, ...r.mon.rounds.map((x) => x.maxFlat));
  const freezeOk = maxFlat < FREEZE_GAME_S && r.maxHang < HANG_WALL_S && r.mon.rounds.length > 0;
  check("scores keep changing (no freeze)", freezeOk, `longest still score bar ${maxFlat.toFixed(1)} game-s, longest clock stall ${r.maxHang.toFixed(1)} real-s`);
  check("cars inside arena, above floor", r.mon.boundsCount === 0 && !r.mon.watchError,
    r.mon.boundsCount ? `${r.mon.boundsCount} bad steps, first: ${JSON.stringify(r.mon.bounds.slice(0, 3))}` : (r.mon.watchError || `${r.mon.playSeconds.toFixed(0)} game-s checked`));
  check("no page/console errors", !r.errors.length, r.errors.length ? `${r.errors.length} error(s)` : "clean");
  check("FPS sanity", r.fps >= FPS_FAIL, `${r.fps.toFixed(1)} fps${r.fps < FPS_WARN ? " (WARNING: low)" : ""}`);

  console.log("");
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(34)} ${c.detail}`);
  if (r.errors.length) console.log("\nERRORS:\n" + r.errors.slice(0, 30).join("\n"));
  const allOk = checks.every((c) => c.ok);
  console.log(allOk ? "\nRESULT: PASS" : "\nRESULT: FAIL");
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error("TOOL CRASHED: " + (e && e.stack || e)); process.exit(1); });
