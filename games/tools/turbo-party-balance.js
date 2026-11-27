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
     • each board trophy bought: who, on which turn, coins left after
     • times a player reached the trophy but couldn't afford it
     • anyone who bought 2+ board trophies in a single turn
     • anyone who finished with 40+ coins and 0 trophies ("stuck rich")
     • bonus trophies handed out at the end
     • whether the bonus trophies changed who came 1st
   Then it prints one row per match and a totals summary.

   How it works: the game code isn't changed. Before the page's scripts
   run, we plant "setters" on window.TP so that the moment board.js
   registers TP.Board (and game.js registers TP.Game) we wrap a few of
   their methods with small recorders:
     Board.takeTurn   → counts turns (a new turn starts with player 1)
     Board.trophyStop → sees each visit to the trophy and whether it
                        ended in a purchase (trophy count went up)
     Game.finale      → snapshots trophies before and after the bonus
                        trophies, so we know who led on board trophies
   The recorders only read state; they never change what happens.

   Exit code 0 = every match finished with no page errors.
   Needs Playwright (pre-installed in cloud sessions).
   ===================================================================== */
const path = require("path");
const { chromium } = require("playwright");

const matches = Number(process.argv[2] || 20);
const turns = Number(process.argv[3] || 6);
const speed = Number(process.argv[4] || 8);
const parallel = Math.max(1, Number(process.argv[5] || 2));

// Each match is allowed this much real time before we call it stuck.
// A 6-turn match at 8× takes roughly 1.5–2 minutes on SwiftShader.
const MATCH_TIMEOUT_MS = Math.max(120, turns * 45 * (8 / speed)) * 1000;

const STUCK_RICH_COINS = 40; // "finished with 40+ coins and no trophies"

/* ---------------------------------------------------------------------
   Code that runs inside the page before any game script.
   It must be self-contained (it's serialised and injected).
   --------------------------------------------------------------------- */
function installRecorder() {
  // Everything we learn goes here; the test reads it back at the end.
  const rec = {
    turn: 0,            // current turn number (1-based once play starts)
    buys: [],           // { player, turn, coinsAfter }
    cantAfford: [],     // { player, turn, coins }
    declined: [],       // { player, turn, coins } — had the coins, said no
    beforeBonus: null,  // [{ name, trophies, coins }] just before bonuses
    afterBonus: null,   // same, after bonuses
    done: false,
  };
  window.__balance = rec;

  // Wrap the Board class's methods the moment board.js registers it.
  function patchBoard(Board) {
    const takeTurn = Board.prototype.takeTurn;
    Board.prototype.takeTurn = function (player) {
      // Players always go in seat order, so seat 0 starting = new turn.
      if (player.index === 0) rec.turn++;
      return takeTurn.apply(this, arguments);
    };

    const trophyStop = Board.prototype.trophyStop;
    Board.prototype.trophyStop = async function (player) {
      const coins = player.coins;
      const trophies = player.trophies;
      const cost = TP.TROPHY_COST;
      await trophyStop.apply(this, arguments);
      // Decide what happened by looking at the trophy count afterwards.
      if (player.trophies > trophies) {
        rec.buys.push({ player: player.name, turn: rec.turn, coinsAfter: player.coins });
      } else if (coins < cost) {
        rec.cantAfford.push({ player: player.name, turn: rec.turn, coins });
      } else {
        rec.declined.push({ player: player.name, turn: rec.turn, coins });
      }
    };
  }

  // Wrap Game.finale to snapshot standings either side of the bonuses.
  function patchGame(Game) {
    const finale = Game.prototype.finale;
    Game.prototype.finale = async function () {
      const snap = () => this.players.map((p) => ({ name: p.name, trophies: p.trophies, coins: p.coins }));
      rec.beforeBonus = snap();
      // Bonus trophies are awarded inside finale(), before the results
      // card. We can't split finale, so the "after" snapshot is taken by
      // the test itself once the FINAL STANDINGS card is showing.
      return finale.apply(this, arguments);
    };
  }

  // Plant setters for TP.Board / TP.Game. util.js does
  // `window.TP = window.TP || {}`, so our object is kept.
  const TPobj = window.TP || {};
  let BoardCls, GameCls;
  Object.defineProperty(TPobj, "Board", {
    configurable: true, enumerable: true,
    get() { return BoardCls; },
    set(v) { BoardCls = v; patchBoard(v); },
  });
  Object.defineProperty(TPobj, "Game", {
    configurable: true, enumerable: true,
    get() { return GameCls; },
    set(v) { GameCls = v; patchGame(v); },
  });
  window.TP = TPobj;
}

/* ---------------------------------------------------------------------
   Play one match in its own browser context and return its record.
   --------------------------------------------------------------------- */
async function playMatch(browser, n) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE ERROR: " + m.text()); });
  await page.addInitScript(installRecorder);

  const file = "file:///" + path.resolve(__dirname, "../turbo-party/index.html").replace(/\\/g, "/");
  const started = Date.now();
  await page.goto(`${file}?demo&turns=${turns}&speed=${speed}`);

  // Wait for the FINAL STANDINGS card. Bonus trophies are all given out
  // by then, so that's when we take the "after bonuses" snapshot.
  let finished = false;
  try {
    await page.waitForFunction(() => {
      const ov = document.getElementById("overlay");
      return ov && ov.classList.contains("show") && document.getElementById("card").innerText.startsWith("FINAL STANDINGS");
    }, null, { timeout: MATCH_TIMEOUT_MS, polling: 500 });
    finished = true;
  } catch (e) { /* timed out — reported below */ }

  const rec = await page.evaluate(() => {
    const r = window.__balance;
    if (TP.game) r.afterBonus = TP.game.players.map((p) => ({ name: p.name, trophies: p.trophies, coins: p.coins }));
    return r;
  });
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
  out.cantAfford = r.cantAfford.length;
  out.declined = r.declined.length;

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
  out.boardTrophies = r.buys.length;

  // "Stuck rich": 40+ coins at the end and no board trophies bought.
  // (Measured before bonuses, so a bonus trophy doesn't hide the problem;
  //  we also note whether they had 0 even after bonuses.)
  out.stuckRich = r.beforeBonus
    .map((p, i) => ({ ...p, finalTrophies: r.afterBonus[i].trophies }))
    .filter((p) => p.trophies === 0 && p.coins >= STUCK_RICH_COINS)
    .map((p) => `${p.name}(${p.coins}c${p.finalTrophies ? `, ${p.finalTrophies} bonus` : ""})`);

  // Who's 1st by the game's own rule: trophies, then coins.
  const rank = (list) => list.slice().sort((a, b) => b.trophies - a.trophies || b.coins - a.coins);
  const first = (list) => {
    const s = rank(list);
    const tied = s.filter((p) => p.trophies === s[0].trophies && p.coins === s[0].coins);
    return tied.map((p) => p.name).join("=");
  };
  out.winnerBefore = first(r.beforeBonus);
  out.winnerAfter = first(r.afterBonus);
  out.bonusDecided = out.winnerBefore !== out.winnerAfter;
  out.final = rank(r.afterBonus).map((p) => `${p.name} ${p.trophies}/${p.coins}`).join(", ");
  return out;
}

(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"] });
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
      console.log(`match ${String(n).padStart(2)}  ${a.finished ? "ok  " : "STUCK"} ${a.seconds.toFixed(0)}s  board buys: ${buys}`);
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker));
  await browser.close();
  results.sort((x, y) => x.a.n - y.a.n);

  /* ---------- Per-match table ---------- */
  console.log("\n #  | board buys (player@turn)          | 2-in-1 | can't afford | 40+c & 0🏆 (pre-bonus) | bonus | 1st before→after bonus | final (🏆/coins)");
  console.log("----+-----------------------------------+--------+--------------+------------------------+-------+-------------------------+-----------------");
  for (const { a } of results) {
    if (!a.finished) { console.log(`${String(a.n).padStart(3)} | DID NOT FINISH (${a.errors} errors)`); continue; }
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
  const byPlayer = {};
  allBuys.forEach((b) => { byPlayer[b.player] = (byPlayer[b.player] || 0) + 1; });
  const byTurn = {};
  allBuys.forEach((b) => { byTurn[b.turn] = (byTurn[b.turn] || 0) + 1; });
  const winsBy = {};
  done.forEach((a) => { winsBy[a.winnerAfter] = (winsBy[a.winnerAfter] || 0) + 1; });

  console.log("\nTOTALS");
  console.log(`  matches finished:            ${done.length} / ${matches}`);
  console.log(`  board trophies bought:       ${allBuys.length}  (avg ${(allBuys.length / (done.length || 1)).toFixed(2)} per match)`);
  console.log(`  matches with 0 board buys:   ${done.filter((a) => a.buys.length === 0).length}`);
  console.log(`  board buys by player:        ${JSON.stringify(byPlayer)}`);
  console.log(`  board buys by turn:          ${JSON.stringify(byTurn)}`);
  console.log(`  reached trophy, too poor:    ${sum((a) => a.cantAfford)}   declined with coins: ${sum((a) => a.declined)}`);
  console.log(`  2 buys in one turn:          ${done.filter((a) => a.doubleBuys.length).length} matches`);
  console.log(`  40+ coins & 0 board 🏆:      ${sum((a) => a.stuckRich.length)} players in ${done.filter((a) => a.stuckRich.length).length} matches`);
  console.log(`  bonus trophies:              ${sum((a) => a.bonusTrophies)}  (avg ${(sum((a) => a.bonusTrophies) / (done.length || 1)).toFixed(2)} per match)`);
  console.log(`  share of all trophies bonus: ${((sum((a) => a.bonusTrophies) / ((sum((a) => a.bonusTrophies) + allBuys.length) || 1)) * 100).toFixed(0)}%`);
  console.log(`  bonuses changed 1st place:   ${done.filter((a) => a.bonusDecided).length} / ${done.length}`);
  console.log(`  winners:                     ${JSON.stringify(winsBy)}`);

  const errs = results.flatMap((r) => r.raw.errors.map((e) => `match ${r.a.n}: ${e}`));
  console.log(errs.length ? "\nERRORS:\n" + errs.join("\n") : "\nNo page errors.");
  const ok = !errs.length && results.every((r) => r.a.finished);
  console.log(ok ? "RESULT: PASS (all matches finished)" : "RESULT: FAIL");
  process.exit(ok ? 0 : 1);
})();
