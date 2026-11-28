/* =====================================================================
   mode-5-batch.js — plays many all-bot Mode 5 matches back to back and
   sums them up: is any seat favoured, how big do fills get, how often
   do trails get popped, do cars get stuck, any errors.

   Usage (from the games folder):
     node tools/mode-5-batch.js [matches] [speed] [time] [rounds] [extra]
     node tools/mode-5-batch.js 10 16 40 1
     node tools/mode-5-batch.js 10 16 40 1 bot=hard     # extra URL options

   One fresh page per match (same as a player reloading). Each match uses
   the same step monitor as mode-5-smoke.js. Prints one line per match,
   then a summary (including fill-size and pop-size histograms). Exit code 0 = every match finished with no errors,
   no out-of-bounds car and no score freeze; stuck cars are reported but
   don't fail the run (judge them by the numbers).
   ===================================================================== */
const { launch, runMatch } = require("./mode-5-lib");

const matches = Number(process.argv[2] || 10);
const speed = Number(process.argv[3] || 16);
const time = Number(process.argv[4] || 40);
const rounds = Number(process.argv[5] || 1);
const extra = {};
for (const kv of process.argv.slice(6)) { const [k, v] = kv.split("="); extra[k] = v === undefined ? true : v; }
const maxSeconds = 60 + rounds * (time + 15) * 2;   // generous real-time limit per match

(async () => {
  const browser = await launch();
  const seatWins = [0, 0, 0, 0];      // match wins by seat (-1 = draw counted separately)
  const roundWinsBySeat = [0, 0, 0, 0];
  let draws = 0, roundDraws = 0;
  const pctBySeat = [[], [], [], []]; // final round % per seat, every round
  let bestFill = 0, bestFillWhere = "";
  const popsPerRound = [];
  const fillSizes = [];               // cells of every fill event, all matches
  const smallFills = [];              // fills flagged small:true by the game (if it does that)
  const popSizes = [];                // cells of every pop event
  const fillsPerRound = [];
  const stuck = [];
  let failures = 0;
  const allErrors = [];

  for (let n = 1; n <= matches; n++) {
    const r = await runMatch(browser, { speed, rounds, time, maxSeconds, verbose: false, extra });
    const end = r.log.find((e) => e.name === "matchEnd");
    const roundEnds = r.log.filter((e) => e.name === "roundEnd");
    for (const re of roundEnds) {
      (re.data.scores || []).forEach((s, i) => pctBySeat[i].push(s));
      if (re.data.winner >= 0) roundWinsBySeat[re.data.winner]++; else roundDraws++;
    }
    if (end) { if (end.data.winner >= 0) seatWins[end.data.winner]++; else draws++; }
    r.perRound.forEach((pr, i) => {
      popsPerRound.push(pr.pops);
      fillsPerRound.push([...pr.fills.values()].reduce((a, b) => a + b, 0));   // real fills only (small ones excluded)
      if (pr.bestFill > bestFill) { bestFill = pr.bestFill; bestFillWhere = `match ${n} round ${i + 1}`; }
    });
    r.mon.stuck.forEach((s) => stuck.push({ match: n, ...s }));
    for (const e of r.log) {
      if (e.name === "fill" && e.data) (e.data.small ? smallFills : fillSizes).push(Number(e.data.cells) || 0);
      if (e.name === "pop" && e.data) popSizes.push({ cells: Number(e.data.cells) || 0, minor: !!e.data.minor });
    }
    const maxFlat = Math.max(0, ...r.mon.rounds.map((x) => x.maxFlat));
    const bad = !r.finished || r.errors.length || r.mon.boundsCount || maxFlat >= 10 || r.maxHang >= 10 || r.scoreProblems.length;
    if (bad) failures++;
    r.errors.forEach((e) => allErrors.push(`match ${n}: ${e}`));
    const finalPct = roundEnds.length ? roundEnds[roundEnds.length - 1].data.scores.map((x) => x.toFixed(1).padStart(5)).join(" ") : "-";
    console.log(`match ${String(n).padStart(2)}: ${r.finished ? "done" : "DNF "} ${r.wallTotal.toFixed(0).padStart(3)}s  winner ${end ? end.data.winner : "?"}  last round % [${finalPct}]` +
      `  pops ${r.perRound.map((p) => p.pops).join("/")}  best fill +${Math.max(0, ...r.perRound.map((p) => p.bestFill)).toFixed(1)}%` +
      `  freeze ${maxFlat.toFixed(1)}s  OOB ${r.mon.boundsCount}  stuck ${r.mon.stuck.length}  errors ${r.errors.length}  ${r.fps.toFixed(0)}fps`);
    if (r.mon.boundsCount) console.log("   out of bounds: " + JSON.stringify(r.mon.bounds.slice(0, 3)));
  }
  await browser.close();

  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  console.log("\n===== SUMMARY =====");
  console.log(`Matches: ${matches} (speed ${speed}, ${time}s rounds, ${rounds} round(s) each, extra ${JSON.stringify(extra)})`);
  console.log(`Match wins by seat [0 Blue, 1 Orange, 2 Green, 3 Pink]: ${seatWins.join(", ")}  draws ${draws}`);
  console.log(`Round wins by seat: ${roundWinsBySeat.join(", ")}  draws ${roundDraws}`);
  console.log(`Average final % by seat: ${pctBySeat.map((a) => avg(a).toFixed(1)).join(", ")}  (unpainted ${(100 - pctBySeat.reduce((s, a) => s + avg(a), 0)).toFixed(1)}%)`);
  console.log(`Best single fill: +${bestFill.toFixed(1)}% (${bestFillWhere})`);
  console.log(`Pops per round: avg ${avg(popsPerRound).toFixed(1)}, min ${Math.min(...popsPerRound)}, max ${Math.max(...popsPerRound)}`);
  console.log(`Real fills per round (all cars, small:true excluded): avg ${avg(fillsPerRound).toFixed(1)}`);
  // Fill-size histogram: lots of 1-5 cell fills = FILL effects/sounds
  // spamming for nothing; we want few, meaningful fills.
  const hist = (arr, buckets) => buckets.map(([lo, hi]) => `${lo}${hi === Infinity ? "+" : "-" + hi}: ${arr.filter((x) => x >= lo && x <= hi).length}`).join("  ");
  const B = [[1, 1], [2, 5], [6, 7], [8, 20], [21, 60], [61, 150], [151, 400], [401, Infinity]];
  console.log(`Fill sizes in cells (${fillSizes.length} fill events): ${hist(fillSizes, B)}`);
  if (smallFills.length) console.log(`  plus ${smallFills.length} fill events flagged small:true`);
  const popB = [[1, 1], [2, 5], [6, 20], [21, Infinity]];
  console.log(`Pop sizes in cells (${popSizes.length} pops, ${popSizes.filter((p) => p.minor).length} minor): ${hist(popSizes.map((p) => p.cells), popB)}`);
  console.log(`Stuck episodes (speed < 1 for > 3 s, not stunned): ${stuck.length}` + (stuck.length ? `, longest ${Math.max(...stuck.map((s) => s.seconds))}s` : ""));
  stuck.slice(0, 15).forEach((s) => console.log(`   match ${s.match} car ${s.car} round ${s.round} at ${s.at}s, pos (${s.x}, ${s.z}), ${s.seconds}s`));
  console.log(allErrors.length ? "Errors:\n   " + allErrors.slice(0, 20).join("\n   ") : "Errors: none");
  console.log(failures ? `\nRESULT: FAIL (${failures} bad match(es))` : "\nRESULT: PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("TOOL CRASHED: " + (e && e.stack || e)); process.exit(1); });
