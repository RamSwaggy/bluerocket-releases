/* =====================================================================
   turbo-party-balance.js — plays many full 4-bot Turbo Party matches in
   headless browsers and reports how the trophies were won. Built to
   answer "is the trophy too hard to buy?" and "do the bonus trophies
   decide the game?", and to re-run the exact same check after a
   balance change so the numbers can be compared.

   Usage (from the games folder):
     node tools/turbo-party-balance.js [matches] [turns] [speed] [parallel]
     node tools/turbo-party-balance.js 20 6          # the standard check
     node tools/turbo-party-balance.js 4 6 8 2       # quick look

     matches   how many matches to play            (default 20)
     turns     turns per match                     (default 6)
     speed     game-time multiplier, like ?speed=  (default 8)
     parallel  matches running at the same time    (default 2)

   For every match it records:
     • each board trophy bought: who, on which turn
     • times a player reached the trophy but couldn't afford it
     • anyone who bought 2+ board trophies in a single turn
     • anyone who finished with 40+ coins and 0 board trophies
     • bonus trophies handed out at the end
     • whether the bonus trophies changed who came 1st
     • items bought at shops and items used
   Then it prints one row per match, totals, and the rule checks.

   The recording and the rule checks (coins never negative, correct
   bonus trophies, legal movement, ...) come from the shared referee in
   tools/lib/turbo-party-checks.js. The game code isn't changed.

   Exit code 0 = every match finished, no page errors, no rule broken.
   Needs Playwright (pre-installed in cloud sessions).
   ===================================================================== */
const path = require("path");
const { chromium } = require("playwright");
const { installTurboPartyChecks, formatChecks, BROWSER_ARGS } = require("./lib/turbo-party-checks");

const matches = Number(process.argv[2] || 20);
const turns = Number(process.argv[3] || 6);
const speed = Number(process.argv[4] || 8);
const parallel = Math.max(1, Number(process.argv[5] || 2));

// Each match is allowed this much real time before we call it stuck.
// A 6-turn match at 8× takes about 100–115 s with 2 running at once.
const MATCH_TIMEOUT_MS = Math.max(120, turns * 45 * (8 / speed)) * 1000;

const STUCK_RICH_COINS = 40; // "finished with 40+ coins and no board trophy"

/* ---------------------------------------------------------------------
   Play one match in its own browser context and return its record.
   --------------------------------------------------------------------- */
async function playMatch(browser, n) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE ERROR: " + m.text()); });
  await page.addInitScript(installTurboPartyChecks);

  const file = "file:///" + path.resolve(__dirname, "../turbo-party/index.html").replace(/\\/g, "/");
  const started = Date.now();
  await page.goto(`${file}?demo&turns=${turns}&speed=${speed}`);

  // Wait for the FINAL STANDINGS card: all bonus trophies are given out
  // by then, so the referee can take its "after bonuses" snapshot.
  let finished = false;
  try {
    await page.waitForFunction(() => {
      const ov = document.getElementById("overlay");
      return ov && ov.classList.contains("show") && document.getElementById("card").innerText.startsWith("FINAL STANDINGS");
    }, null, { timeout: MATCH_TIMEOUT_MS, polling: 500 });
    finished = true;
  } catch (e) { /* timed out — reported below */ }

  // `finish` is a function, so it can't be sent back; return the data.
  const rec = await page.evaluate(() => { const r = window.__tp.finish(); const { finish, ...data } = r; return data; });
  await context.close();
  return { n, finished, errors, seconds: (Date.now() - started) / 1000, rec };
}

/* ---------------------------------------------------------------------
   Turn a raw record into the numbers we report.
   --------------------------------------------------------------------- */
function analyse(m) {
  const r = m.rec;
  const out = { n: m.n, finished: m.finished, errors: m.errors.length, seconds: m.seconds };
  out.buys = r.buys;
  out.cantAfford = r.trophyVisits.filter((v) => v.result === "poor").length;
  out.declined = r.trophyVisits.filter((v) => v.result === "declined").length;
  out.itemBuys = r.shop.filter((s) => s.result === "bought").map((s) => s.item);
  out.itemUses = r.itemUses.map((u) => u.item);
  out.violations = r.violations;

  // 2+ purchases by the same player in the same turn.
  const perTurn = {};
  for (const b of r.buys) {
    const k = `${b.player}@T${b.turn}`;
    perTurn[k] = (perTurn[k] || 0) + 1;
  }
  out.doubleBuys = Object.entries(perTurn).filter(([, c]) => c >= 2).map(([k, c]) => `${k}×${c}`);

  if (!r.beforeBonus || !r.afterBonus) return out;

  // Bonus trophies = trophies gained between the two snapshots.
  out.bonusTrophies = r.afterBonus.reduce((s, p, i) => s + (p.trophies - r.beforeBonus[i].trophies), 0);

  // "Stuck rich": 40+ coins and no board trophy before the bonuses
  // (so a bonus trophy doesn't hide the problem; we note it if they got one).
  out.stuckRich = r.beforeBonus
    .map((p, i) => ({ ...p, finalTrophies: r.afterBonus[i].trophies }))
    .filter((p) => p.trophies === 0 && p.coins >= STUCK_RICH_COINS)
    .map((p) => `${p.name}(${p.coins}c${p.finalTrophies ? `, ${p.finalTrophies} bonus` : ""})`);

  // Who's 1st by the game's own rule: trophies, then coins.
  const rank = (list) => list.slice().sort((a, b) => b.trophies - a.trophies || b.coins - a.coins);
  const first = (list) => {
    const s = rank(list);
    return s.filter((p) => p.trophies === s[0].trophies && p.coins === s[0].coins).map((p) => p.name).join("=");
  };
  out.winnerBefore = first(r.beforeBonus);
  out.winnerAfter = first(r.afterBonus);
  out.bonusDecided = out.winnerBefore !== out.winnerAfter;
  out.final = rank(r.afterBonus).map((p) => `${p.name} ${p.trophies}/${p.coins}`).join(", ");
  return out;
}

const countBy = (list) => list.reduce((o, k) => ((o[k] = (o[k] || 0) + 1), o), {});

(async () => {
  const browser = await chromium.launch({ args: BROWSER_ARGS });
  console.log(`Turbo Party balance: ${matches} matches × ${turns} turns at ${speed}× speed, ${parallel} at a time\n`);

  // Simple worker pool: `parallel` matches in flight at once.
  const results = [];
  let next = 1;
  async function worker() {
    while (next <= matches) {
      const n = next++;
      const m = await playMatch(browser, n);
      const a = analyse(m);
      results.push({ raw: m, a });
      const buys = a.buys.map((b) => `${b.player}@T${b.turn}`).join(" ") || "none";
      console.log(`match ${String(n).padStart(2)}  ${a.finished ? "ok  " : "STUCK"} ${a.seconds.toFixed(0)}s  board buys: ${buys}${a.violations.length ? `  ⚠ ${a.violations.length} rule violations` : ""}`);
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker));
  await browser.close();
  results.sort((x, y) => x.a.n - y.a.n);

  /* ---------- Per-match table ---------- */
  console.log("\n #  | board buys (player@turn)          | 2-in-1 | can't afford | 40+c & 0🏆 (pre-bonus) | bonus | 1st before→after bonus | final (🏆/coins)");
  console.log("----+-----------------------------------+--------+--------------+------------------------+-------+-------------------------+-----------------");
  for (const { a } of results) {
    if (!a.finished || !a.winnerAfter) { console.log(`${String(a.n).padStart(3)} | DID NOT FINISH (${a.errors} errors)`); continue; }
    const buys = a.buys.map((b) => `${b.player}@T${b.turn}`).join(" ") || "—";
    console.log([
      String(a.n).padStart(3),
      buys.padEnd(33),
      (a.doubleBuys.join(" ") || "—").padEnd(6),
      String(a.cantAfford).padEnd(12),
      (a.stuckRich.join(" ") || "—").padEnd(22),
      String(a.bonusTrophies).padEnd(5),
      `${a.winnerBefore}→${a.winnerAfter}${a.bonusDecided ? " ⚠" : ""}`.padEnd(23),
      a.final,
    ].join(" | "));
  }

  /* ---------- Totals ---------- */
  const done = results.map((r) => r.a).filter((a) => a.finished && a.winnerAfter);
  const sum = (f) => done.reduce((s, a) => s + f(a), 0);
  const allBuys = done.flatMap((a) => a.buys);
  const bonus = sum((a) => a.bonusTrophies);

  console.log("\nTOTALS");
  console.log(`  matches finished:            ${done.length} / ${matches}`);
  console.log(`  board trophies bought:       ${allBuys.length}  (avg ${(allBuys.length / (done.length || 1)).toFixed(2)} per match)`);
  console.log(`  matches with 0 board buys:   ${done.filter((a) => a.buys.length === 0).length}`);
  console.log(`  board buys by player:        ${JSON.stringify(countBy(allBuys.map((b) => b.player)))}`);
  console.log(`  board buys by turn:          ${JSON.stringify(countBy(allBuys.map((b) => b.turn)))}`);
  console.log(`  reached trophy, too poor:    ${sum((a) => a.cantAfford)}   declined with coins: ${sum((a) => a.declined)}`);
  console.log(`  2 buys in one turn:          ${done.filter((a) => a.doubleBuys.length).length} matches`);
  console.log(`  40+ coins & 0 board 🏆:      ${sum((a) => a.stuckRich.length)} players in ${done.filter((a) => a.stuckRich.length).length} matches`);
  console.log(`  bonus trophies:              ${bonus}  (avg ${(bonus / (done.length || 1)).toFixed(2)} per match)`);
  console.log(`  share of all trophies bonus: ${((bonus / ((bonus + allBuys.length) || 1)) * 100).toFixed(0)}%`);
  console.log(`  bonuses changed 1st place:   ${done.filter((a) => a.bonusDecided).length} / ${done.length}`);
  console.log(`  winners:                     ${JSON.stringify(countBy(done.map((a) => a.winnerAfter)))}`);
  console.log(`  items bought:                ${JSON.stringify(countBy(done.flatMap((a) => a.itemBuys)))}`);
  console.log(`  items used:                  ${JSON.stringify(countBy(done.flatMap((a) => a.itemUses)))}`);

  /* ---------- Rule checks ---------- */
  console.log("\nRULE CHECKS (all matches)");
  console.log(formatChecks(results.map((r) => r.raw.rec)));
  const viol = results.flatMap((r) => r.a.violations.map((v) => `match ${r.a.n} T${v.turn} ${v.rule}: ${v.msg}`));
  if (viol.length) console.log("\nRULE VIOLATIONS:\n" + viol.join("\n"));

  const errs = results.flatMap((r) => r.raw.errors.map((e) => `match ${r.a.n}: ${e}`));
  console.log(errs.length ? "\nERRORS:\n" + errs.join("\n") : "\nNo page errors.");
  const ok = !errs.length && !viol.length && results.every((r) => r.a.finished);
  console.log(ok ? "RESULT: PASS (all matches finished, no rule broken)" : "RESULT: FAIL");
  process.exit(ok ? 0 : 1);
})();
