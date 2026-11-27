/* =====================================================================
   mode-5-smoke.js — plays a whole Mode 5 match with 4 bots in a
   headless browser and checks that it behaves.

   Usage (from the games folder):
     node tools/mode-5-smoke.js [rounds] [speed] [maxSeconds] [time]
     node tools/mode-5-smoke.js 1 8 120          # 1 round, 8x speed
     node tools/mode-5-smoke.js 3 8 240 40       # best of 3, 40 s rounds

   `time` (optional) is the round length in seconds, passed to the page
   as ?time=T so tests don't have to sit through full 2:00 rounds.

   What it checks (each one prints PASS/FAIL):
     1. the match reaches phase "matchEnd" before maxSeconds (real time)
     2. scores are never negative and never add up to more than 100 %
     3. every bot gets at least one `fill` event in every round
        (a bot that never closes a loop isn't playing the game)
     4. at least one `pop` happens somewhere in the match
     5. no page errors and no console errors
     6. FPS sanity: the page keeps animating (>= 5 fps under software
        WebGL; under 20 fps prints a warning, not a failure)
   Exit code 0 = every check passed, 1 = anything failed.

   Needs Playwright (pre-installed in cloud sessions).
   ===================================================================== */
const { launch, pageUrl, collectErrors, instrumentScript, readStateInPage } = require("./mode-5-lib");

const rounds = Number(process.argv[2] || 1);
const speed = Number(process.argv[3] || 8);
const maxSeconds = Number(process.argv[4] || 240);
const time = process.argv[5] ? Number(process.argv[5]) : undefined;

const FPS_FAIL = 5;   // below this the page is effectively frozen
const FPS_WARN = 20;  // below this, worth a look (swiftshader is slow)

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = collectErrors(page);
  await page.addInitScript(instrumentScript);

  const url = pageUrl({ demo: true, speed, rounds, time });
  console.log("Opening " + url.replace(/^.*mode-5\//, "mode-5/"));
  await page.goto(url);

  /* ---------- Watch the match ----------
     Poll the state every half second (so we catch bad scores quickly),
     print a status line every 3 seconds, stop at matchEnd or time-out. */
  const start = Date.now();
  let finished = false;
  let lastPrint = -Infinity;
  let scoreProblems = [];   // first few bad score readings, with context
  let samples = 0;
  let lastState = null;
  while (!finished && (Date.now() - start) / 1000 < maxSeconds) {
    await page.waitForTimeout(500);
    const s = await page.evaluate(readStateInPage);
    const wall = (Date.now() - start) / 1000;
    if (!s.ready) {
      if (wall - lastPrint >= 3) { console.log(`${wall.toFixed(0).padStart(4)}s  (waiting for TP.M5.match)`); lastPrint = wall; }
      continue;
    }
    samples++;
    lastState = s;

    // Check 2 on every sample: no negatives, total never above 100 %.
    const sum = s.scores.reduce((a, b) => a + b, 0);
    const bad = s.scores.some((x) => !Number.isFinite(x) || x < 0) || sum > 100.0001;
    if (bad && scoreProblems.length < 5) scoreProblems.push(`at ${wall.toFixed(1)}s, round ${s.round}, phase ${s.phase}: scores [${s.scores.join(", ")}] sum ${sum.toFixed(3)}`);

    if (wall - lastPrint >= 3) {
      const pct = s.scores.map((x) => (Number.isFinite(x) ? x.toFixed(1) : String(x)).padStart(5) + "%").join(" ");
      const tl = Number.isFinite(s.timeLeft) ? s.timeLeft.toFixed(1).padStart(6) + "s left" : "";
      console.log(`${wall.toFixed(0).padStart(4)}s  ${String(s.phase).padEnd(12)} round ${s.round}  ${tl}  ${pct}  (sum ${sum.toFixed(1)}%)`);
      lastPrint = wall;
    }
    if (s.phase === "matchEnd") finished = true;
  }
  const wallTotal = (Date.now() - start) / 1000;

  /* ---------- Gather the event log and FPS ---------- */
  const { log, frames, hooked } = await page.evaluate(() => ({ log: window.__m5log, frames: window.__m5frames, hooked: window.__m5hooked }));
  const fps = frames / wallTotal;

  // Split events into rounds by the order of roundStart events. (Using
  // the order rather than match.round avoids depending on whether the
  // game counts rounds from 0 or 1.)
  const perRound = [];  // [{ fills: Map(player → count), pops }]
  let cur = null;
  for (const e of log) {
    if (e.name === "roundStart") { cur = { fills: new Map(), pops: 0 }; perRound.push(cur); continue; }
    if (!cur) continue;
    if (e.name === "fill") { const p = e.data && e.data.player; cur.fills.set(p, (cur.fills.get(p) || 0) + 1); }
    if (e.name === "pop") cur.pops++;
  }
  const count = (n) => log.filter((e) => e.name === n).length;
  const nPlayers = lastState ? lastState.players.length : 0;

  /* ---------- Report ---------- */
  console.log("\nEvents: " + ["roundStart", "roundEnd", "matchEnd", "trailStart", "fill", "pop", "splat", "land", "bump", "pickupSpawn", "pickup", "overdrive"]
    .map((n) => `${n} ${count(n)}`).join(", "));
  perRound.forEach((r, i) => {
    const fills = [...r.fills.entries()].map(([p, c]) => `p${p}:${c}`).join(" ") || "none";
    console.log(`Round ${i + 1}: fills ${fills}, pops ${r.pops}`);
  });
  const endEvt = log.find((e) => e.name === "matchEnd");
  if (endEvt) console.log("matchEnd data: " + JSON.stringify(endEvt.data).slice(0, 400));
  if (lastState) console.log(`Final scores: [${lastState.scores.map((x) => x.toFixed(1)).join(", ")}]`);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });
  check("match reaches matchEnd", finished, finished ? `after ${wallTotal.toFixed(0)}s` : `last phase "${lastState && lastState.phase}" after ${wallTotal.toFixed(0)}s`);
  check("scores >= 0 and sum <= 100%", samples > 0 && !scoreProblems.length, samples ? (scoreProblems.join("; ") || `${samples} samples ok`) : "never read any scores");
  // Every bot fills at least once in every round that started.
  const missing = [];
  if (!hooked) missing.push("event bus TP.M5.on never appeared");
  if (!perRound.length) missing.push("no roundStart events");
  perRound.forEach((r, i) => {
    // Player ids may be 0-based indexes or 1-based; accept either, as
    // long as nPlayers distinct players filled.
    if (r.fills.size < nPlayers) missing.push(`round ${i + 1}: only ${r.fills.size}/${nPlayers} players filled (${[...r.fills.keys()].join(",") || "-"})`);
  });
  check("every bot fills every round", !missing.length, missing.join("; ") || `${perRound.length} round(s)`);
  check("at least one pop in the match", count("pop") > 0, `${count("pop")} pops`);
  check("no page/console errors", !errors.length, errors.length ? `${errors.length} error(s)` : "clean");
  check("FPS sanity", fps >= FPS_FAIL, `${fps.toFixed(1)} fps${fps < FPS_WARN ? " (WARNING: low)" : ""}`);

  console.log("");
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(32)} ${c.detail}`);
  if (errors.length) console.log("\nERRORS:\n" + errors.slice(0, 30).join("\n"));
  const allOk = checks.every((c) => c.ok);
  console.log(allOk ? "\nRESULT: PASS" : "\nRESULT: FAIL");
  await browser.close();
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error("TOOL CRASHED: " + (e && e.stack || e)); process.exit(1); });
