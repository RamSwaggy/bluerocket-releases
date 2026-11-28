/* =====================================================================
   tools/lib/turbo-party-checks.js — the in-page "referee" shared by the
   Turbo Party test tools (balance, human). It watches a real match and
   writes down two things:

     1. RECORDS  — what happened: trophy buys, item buys and uses, dice
                   rolls, fork choices, bonus trophies, standings.
     2. VIOLATIONS — any time the game broke one of its own rules.

   It never changes the game's behaviour. It works by wrapping a few
   methods on TP.Board and TP.Game the moment those classes are
   registered (see "How the hooks get in" at the bottom).

   Rules checked (each violation names the rule id):
     R1 coins     every player's coins are a whole number ≥ 0, always
     R2 trophies  a player's trophy count never goes down
     R3 items     a player holds at most 2 items, all real item ids
     R4 buy       a trophy purchase costs exactly TROPHY_COST and gives
                  exactly +1 trophy; you can't buy with < TROPHY_COST
     R5 double    nobody buys two board trophies in the same turn
                  (counted as a violation; the job spec says "no double buys")
     R6 move      every hop goes to one of the current space's `next`
                  spaces; at the fork it goes where the choice said;
                  the shortcut is only entered from the fork and only
                  left at the merge
     R7 lap       passing the start line (space 0) pays exactly +5
     R8 shop      a shop purchase takes exactly the item's price and adds
                  that item; a failed purchase (too poor / slots full)
                  changes nothing
     R9 items-use an item is removed when used; Double Dice = 2 rolls,
                  Turbo Dice = 1 roll of 6–10, Pickpocket moves
                  min(8, coins) from the richest rival, Trophy Warp puts
                  you on a space whose `next` includes the trophy
     R10 steps    the number of hops in a turn = the dice total, plus 3
                  if the turn ended on a boost pad (boosts don't chain)
     R11 stats    spacesMoved = hops actually made; coinsEarned and
                  minigameWins never go down
     R12 payout   minigame payouts follow the Director's ruling, worked
                  out here independently of Game.payouts: places pay
                  10/6/3/0, tied players share the higher place (and use
                  up the places they share), a tie for 1st is a win for
                  each; if ALL players tie, everyone gets 3 and nobody
                  gets a win. The coins and wins players actually receive
                  must match exactly.
     R13 bonus    each bonus trophy goes to the one player with the
                  highest stat; a tie on the stat is broken on coins (at
                  the end of the match); still tied on coins → nobody
                  gets it; best stat 0 → nobody gets it
     R14 relocate after a trophy buy (and at the start) the trophy lands
                  10+ spaces ahead of the buyer by the shortest forward
                  route, never on start or a shop, and never on the
                  shortcut when the buyer is on it or reaches the fork in
                  under 10 spaces. Distances are worked out here with our
                  own walk of the board, not the board's spacesAhead().
                  (Adapted from Gameplay's job-1 trophy-check script.)

   The bonus list (R13) mirrors BONUSES in turbo-party/js/game.js. If
   Gameplay changes that list, update BONUS_STATS below.
   ===================================================================== */

/* Everything below is injected into the page with addInitScript, so it
   must be ONE self-contained function with no outside references. */
function installTurboPartyChecks() {
  const BONUS_STATS = ["minigameWins", "coinsEarned", "spacesMoved"];
  const MAX_ITEMS = 2;
  const PAYOUT = [10, 6, 3, 0];   // mirrors game.js
  const ALL_TIE_PAYOUT = 3;       // mirrors game.js
  const MIN_TROPHY_AHEAD = 10;    // mirrors board.js

  /* Our own, independent idea of the payout rules (R12). Given a ranking
     like [[2], [0, 1], [3]] returns { index: { gain, win } }. */
  function expectedPayouts(ranking) {
    const out = {};
    const all = ranking.flat();
    if (ranking.length === 1 && all.length > 1) {
      all.forEach((i) => { out[i] = { gain: ALL_TIE_PAYOUT, win: false }; });
      return out;
    }
    let place = 0;
    for (const group of ranking) {
      group.forEach((i) => { out[i] = { gain: PAYOUT[place], win: place === 0 }; });
      place += group.length;
    }
    return out;
  }

  /* Our own reading of the bonus-trophy rule (R13). `players` is a list
     of { coins, stats } in seat order. Returns the winning seat or null. */
  function expectedBonusWinner(players, stat) {
    const best = Math.max(...players.map((p) => p.stats[stat]));
    if (best <= 0) return null;
    const tied = players.map((p, i) => i).filter((i) => players[i].stats[stat] === best);
    if (tied.length === 1) return tied[0];
    const most = Math.max(...tied.map((i) => players[i].coins));
    const rich = tied.filter((i) => players[i].coins === most);
    return rich.length === 1 ? rich[0] : null;
  }

  /* Fewest forward hops from `from` to every space (R14). Plain
     breadth-first walk over each space's `next` list. */
  function hopsFrom(spaces, from) {
    const d = spaces.map(() => Infinity);
    d[from] = 0;
    const q = [from];
    while (q.length) {
      const i = q.shift();
      for (const n of spaces[i].next) if (d[n] === Infinity) { d[n] = d[i] + 1; q.push(n); }
    }
    return d;
  }
  // Every reason the trophy landing on `to` breaks R14 for a buyer on `from`.
  function relocationProblems(board, from, to) {
    const why = [];
    const d = hopsFrom(board.spaces, from);
    const s = board.spaces[to];
    if (!(d[to] >= MIN_TROPHY_AHEAD) || d[to] === Infinity) why.push(`only ${d[to]} hops ahead`);
    if (s.type === "start" || s.type === "shop") why.push(`on ${s.type}`);
    const scAhead = board.spaces[from].shortcut || d[board.forkIndex] < MIN_TROPHY_AHEAD;
    if (scAhead && s.shortcut) why.push("on the shortcut, which is directly ahead");
    return why;
  }

  const rec = {
    turn: 0,
    buys: [],          // { player, turn, coinsAfter }
    trophyVisits: [],  // { player, turn, coins, result: "bought"|"poor"|"declined" }
    shop: [],          // { player, turn, result: "bought"|"left"|"poor"|"full", item }
    itemUses: [],      // { player, turn, item }
    rolls: [],         // { player, turn, value, min }
    forks: [],         // { player, turn, to: "main"|"shortcut" }
    beforeBonus: null, // [{ name, trophies, coins, stats }]
    afterBonus: null,
    violations: [],    // { rule, msg, turn }
    checksRun: {},     // rule id → how many times it was checked
  };
  window.__tp = rec;

  // Record that a rule was checked, and whether it held. The same
  // message is only stored once, so a broken state that persists for
  // many frames shows up as one violation, not thousands.
  const seen = new Set();
  function check(rule, ok, msg) {
    rec.checksRun[rule] = (rec.checksRun[rule] || 0) + 1;
    if (!ok && !seen.has(rule + msg)) {
      seen.add(rule + msg);
      rec.violations.push({ rule, msg, turn: rec.turn });
    }
    return ok;
  }

  const snapPlayers = (players) => players.map((p) => ({
    name: p.name, trophies: p.trophies, coins: p.coins,
    stats: Object.assign({}, p.stats), items: p.items.slice(),
  }));

  /* ---------------- Board hooks ---------------- */
  function patchBoard(Board) {
    const P = Board.prototype;

    // --- takeTurn: count turns, measure hops vs dice, check per-turn rules.
    const takeTurn = P.takeTurn;
    P.takeTurn = async function (player) {
      if (player.index === 0) rec.turn++;
      // Scenario hook for scripted tests (may change state, or even run
      // extra shop visits). Runs before the turn, awaited.
      if (window.__beforeTurn) await window.__beforeTurn(this, player, rec.turn);

      const turnState = { player, hops: 0, rolls: [], boostLanding: false, mode: "normal" };
      this.__turn = turnState;
      const movedBefore = player.stats.spacesMoved;
      await takeTurn.apply(this, arguments);
      this.__turn = null;

      // R10: hops = dice total (+3 if the landing space was a boost pad).
      const total = turnState.rolls.reduce((s, v) => s + v, 0);
      const expected = total + (turnState.boostLanding ? 3 : 0);
      check("R10", turnState.hops === expected,
        `${player.name} T${rec.turn}: hopped ${turnState.hops}, dice ${turnState.rolls.join("+")}${turnState.boostLanding ? " +3 boost" : ""} = ${expected}`);
      // R9: roll counts for the dice items.
      if (turnState.mode === "double") check("R9", turnState.rolls.length === 2, `${player.name}: Double Dice rolled ${turnState.rolls.length} dice`);
      if (turnState.mode === "turbo") check("R9", turnState.rolls.length === 1 && turnState.rolls[0] >= 6 && turnState.rolls[0] <= 10, `${player.name}: Turbo Dice rolled ${turnState.rolls.join(",")}`);
      if (turnState.mode === "normal") check("R9", turnState.rolls.length === 1, `${player.name}: plain turn rolled ${turnState.rolls.length} dice`);
      // R11: spacesMoved counts the hops.
      check("R11", player.stats.spacesMoved - movedBefore === turnState.hops,
        `${player.name}: spacesMoved +${player.stats.spacesMoved - movedBefore} but hopped ${turnState.hops}`);
    };

    // --- rollDie: record every die result.
    const rollDie = P.rollDie;
    P.rollDie = async function (player, human, min) {
      const v = await rollDie.apply(this, arguments);
      rec.rolls.push({ player: player.name, turn: rec.turn, value: v, min });
      check("R9", Number.isInteger(v) && v >= min && v <= 10, `${player.name}: die gave ${v} (min ${min})`);
      if (this.__turn) this.__turn.rolls.push(v);
      return v;
    };

    // --- pickNext: remember fork choices so R6 can check the hop.
    const pickNext = P.pickNext;
    P.pickNext = async function (player) {
      const from = this.spaces[player.space];
      const next = await pickNext.apply(this, arguments);
      if (from.next.length > 1) {
        rec.forks.push({ player: player.name, turn: rec.turn, to: this.spaces[next].shortcut ? "shortcut" : "main" });
      }
      this.__lastPick = { from: from.index, next };
      return next;
    };

    // --- stepForward: R6 movement, R7 lap bonus.
    const stepForward = P.stepForward;
    P.stepForward = async function (player) {
      const from = this.spaces[player.space];
      const coinsBefore = player.coins;
      this.__lastPick = null;
      this.__lapPaid = null;
      await stepForward.apply(this, arguments);
      const to = this.spaces[player.space];
      if (this.__turn && this.__turn.player === player) this.__turn.hops++;
      check("R6", from.next.includes(to.index), `${player.name}: hopped ${from.index}→${to.index}, allowed ${from.next.join("/")}`);
      if (this.__lastPick) check("R6", this.__lastPick.next === to.index, `${player.name}: fork chose ${this.__lastPick.next} but landed ${to.index}`);
      // Entering the shortcut only from the fork; leaving it only at the merge.
      if (to.shortcut && !from.shortcut) check("R6", from.index === this.forkIndex, `${player.name}: entered shortcut from ${from.index}, fork is ${this.forkIndex}`);
      if (from.shortcut && !to.shortcut) check("R6", to.index === this.mergeIndex, `${player.name}: left shortcut at ${to.index}, merge is ${this.mergeIndex}`);
      if (to.index === 0) check("R7", this.__lapPaid === 5, `${player.name}: lap bonus paid ${this.__lapPaid} (coins were ${coinsBefore})`);
    };

    // --- addCoins: R1 clamping, and capture the lap-bonus payment.
    const addCoins = P.addCoins;
    P.addCoins = function (player, amount, label) {
      const before = player.coins;
      const r = addCoins.apply(this, arguments);
      check("R1", player.coins === Math.max(0, before + amount), `${player.name}: addCoins(${amount}) ${before}→${player.coins}`);
      if (label && /^Lap bonus/.test(label)) this.__lapPaid = player.coins - before;
      return r;
    };

    // --- landOn: note boost landings for R10 (only the outer call).
    const landOn = P.landOn;
    P.landOn = async function (player, fromBoost) {
      if (!fromBoost && this.__turn && this.__turn.player === player && this.spaces[player.space].type === "boost") {
        this.__turn.boostLanding = true;
      }
      return landOn.apply(this, arguments);
    };

    // --- placeTrophy: R14 at the start of the match (buyer = start line).
    const placeTrophy = P.placeTrophy;
    P.placeTrophy = function (index) {
      if (this.trophyIndex === undefined && this.spaces && this.spaces.length) {
        const why = relocationProblems(this, 0, index);
        check("R14", !why.length, `first trophy spot ${index}: ${why.join(", ")}`);
      }
      return placeTrophy.apply(this, arguments);
    };

    // --- trophyStop: R4 purchase maths, R5 double buys, R14 relocation.
    const trophyStop = P.trophyStop;
    P.trophyStop = async function (player) {
      const coins = player.coins, trophies = player.trophies, cost = TP.TROPHY_COST;
      const alreadyBought = this.trophyBoughtThisTurn === true;
      const from = player.space;
      await trophyStop.apply(this, arguments);
      let result;
      if (player.trophies > trophies) {
        check("R5", !alreadyBought, `${player.name}: bought again after the once-per-turn flag was set`);
        const why = relocationProblems(this, from, this.trophyIndex);
        check("R14", !why.length, `${player.name} bought on ${from}, trophy moved to ${this.trophyIndex}: ${why.join(", ")}`);
        result = "bought";
        check("R4", coins >= cost, `${player.name}: bought trophy with only ${coins} coins`);
        check("R4", player.trophies === trophies + 1 && player.coins === coins - cost,
          `${player.name}: trophy buy went ${trophies}🏆/${coins}c → ${player.trophies}🏆/${player.coins}c`);
        const sameTurn = rec.buys.filter((b) => b.player === player.name && b.turn === rec.turn).length;
        check("R5", sameTurn === 0, `${player.name}: bought a 2nd board trophy in turn ${rec.turn}`);
        rec.buys.push({ player: player.name, turn: rec.turn, coinsAfter: player.coins });
      } else {
        result = alreadyBought ? "once-per-turn" : coins < cost ? "poor" : "declined";
        check("R4", player.coins === coins, `${player.name}: trophy visit without a buy changed coins ${coins}→${player.coins}`);
      }
      rec.trophyVisits.push({ player: player.name, turn: rec.turn, coins, result });
    };

    // --- runShop: R8.
    const runShop = P.runShop;
    P.runShop = async function (player) {
      const coins = player.coins, items = player.items.slice();
      await runShop.apply(this, arguments);
      const added = player.items.length - items.length;
      if (added === 1) {
        const id = player.items[player.items.length - 1];
        const price = TP.ITEMS[id].price;
        check("R8", coins - player.coins === price, `${player.name}: bought ${id} (${price}) but coins went ${coins}→${player.coins}`);
        check("R8", coins >= price, `${player.name}: bought ${id} (${price}) with ${coins} coins`);
        rec.shop.push({ player: player.name, turn: rec.turn, result: "bought", item: id, coins });
      } else {
        check("R8", added === 0 && player.coins === coins, `${player.name}: shop with no purchase changed coins/items`);
        const result = items.length >= MAX_ITEMS ? "full" : "left-or-poor";
        rec.shop.push({ player: player.name, turn: rec.turn, result, coins });
      }
    };

    // --- useItem: R9 effects.
    const useItem = P.useItem;
    P.useItem = async function (player, id) {
      rec.itemUses.push({ player: player.name, turn: rec.turn, item: id });
      const coinsBefore = this.players.map((p) => p.coins);
      const rich = this.players.filter((p) => p !== player).sort((a, b) => b.coins - a.coins)[0];
      const mode = await useItem.apply(this, arguments);
      if (this.__turn && this.__turn.player === player) this.__turn.mode = mode;
      if (id === "steal") {
        const amt = Math.min(8, coinsBefore[rich.index]);
        check("R9", rich.coins === coinsBefore[rich.index] - amt && player.coins === coinsBefore[player.index] + amt,
          `${player.name}: Pickpocket on ${rich.name}: ${coinsBefore[rich.index]}→${rich.coins}, self ${coinsBefore[player.index]}→${player.coins} (expected ${amt})`);
      }
      if (id === "warp") {
        check("R9", this.spaces[player.space].next.includes(this.trophyIndex),
          `${player.name}: warped to ${player.space}, trophy is at ${this.trophyIndex}`);
      }
      check("R9", mode === (id === "double" || id === "turbo" ? id : "normal"), `${player.name}: ${id} returned roll mode ${mode}`);
      return mode;
    };
  }

  /* ---------------- Game hooks ---------------- */
  function patchGame(Game) {
    const P = Game.prototype;

    // --- Game.payouts (static): remember the last ranking it was given,
    //     so the round check below knows the real finishing order.
    if (typeof Game.payouts === "function") {
      const payouts = Game.payouts;
      Game.payouts = function (ranking) {
        rec.lastRanking = JSON.parse(JSON.stringify(ranking));
        return payouts.apply(this, arguments);
      };
    }

    // --- minigameRound: R12 payouts, compared with our own rule.
    const round = P.minigameRound;
    P.minigameRound = async function () {
      const before = snapPlayers(this.players);
      rec.lastRanking = null;
      await round.apply(this, arguments);
      const after = snapPlayers(this.players);
      const ranking = rec.lastRanking;
      if (!check("R12", !!ranking, "minigame round finished without calling Game.payouts")) return;
      const exp = expectedPayouts(ranking);
      rec.rounds = rec.rounds || [];
      rec.rounds.push({ turn: rec.turn, ranking, allTie: ranking.length === 1 });
      after.forEach((p, i) => {
        const gain = p.coins - before[i].coins;
        const win = p.stats.minigameWins - before[i].stats.minigameWins;
        const e = exp[i] || { gain: 0, win: false };
        check("R12", gain === e.gain && win === (e.win ? 1 : 0) && p.stats.coinsEarned - before[i].stats.coinsEarned === e.gain,
          `${p.name}: ranking ${JSON.stringify(ranking)} → got +${gain} coins/${win} win, rule says +${e.gain}/${e.win ? 1 : 0}`);
      });
    };

    // --- finale: R13 bonus trophies. Snapshot before; the test reads the
    //     "after" snapshot once the FINAL STANDINGS card is up.
    const finale = P.finale;
    P.finale = async function () {
      rec.beforeBonus = snapPlayers(this.players);
      rec.bonusesOn = this.bonuses;
      await finale.apply(this, arguments);
    };
  }

  // Called by the test after FINAL STANDINGS shows: grab the final
  // standings and check R13 against the pre-bonus snapshot.
  rec.finish = function () {
    if (!TP.game || !rec.beforeBonus) return rec;
    rec.afterBonus = snapPlayers(TP.game.players);
    const b = rec.beforeBonus;
    const expected = b.map(() => 0);
    if (rec.bonusesOn !== false) {
      for (const stat of BONUS_STATS) {
        const w = expectedBonusWinner(b, stat);
        if (w !== null) expected[w]++;
      }
    }
    rec.afterBonus.forEach((p, i) => {
      const got = p.trophies - b[i].trophies;
      check("R13", got === expected[i], `${p.name}: got ${got} bonus trophies, expected ${expected[i]}`);
      check("R1", p.coins === b[i].coins, `${p.name}: coins changed during bonuses ${b[i].coins}→${p.coins}`);
    });
    return rec;
  };

  /* ---------------- Always-on rules (R1–R3, R11) ----------------
     Checked every animation frame while a match exists. */
  let last = null;
  function everyFrame() {
    const g = window.TP && TP.game;
    if (g && g.players) {
      g.players.forEach((p, i) => {
        check("R1", Number.isInteger(p.coins) && p.coins >= 0, `${p.name}: coins = ${p.coins}`);
        check("R3", p.items.length <= MAX_ITEMS && p.items.every((id) => TP.ITEMS[id]), `${p.name}: items = ${JSON.stringify(p.items)}`);
        if (last && last[i]) {
          check("R2", p.trophies >= last[i].trophies, `${p.name}: trophies ${last[i].trophies}→${p.trophies}`);
          check("R11", p.stats.coinsEarned >= last[i].earned, `${p.name}: coinsEarned went down`);
          check("R11", p.stats.minigameWins >= last[i].wins, `${p.name}: minigameWins went down`);
        }
      });
      rec.checksRun.frames = (rec.checksRun.frames || 0) + 1;
      last = g.players.map((p) => ({ trophies: p.trophies, earned: p.stats.coinsEarned, wins: p.stats.minigameWins }));
    }
    requestAnimationFrame(everyFrame);
  }
  requestAnimationFrame(everyFrame);

  // Direct-test helpers for the human/unit tool (not sent back to Node).
  window.__tpHelpers = { expectedPayouts, expectedBonusWinner, relocationProblems, hopsFrom, check };

  /* ---------------- How the hooks get in ----------------
     This runs before any game script. util.js does
     `window.TP = window.TP || {}`, so the object we create here is the
     one the game uses. We give it setters for Board and Game: the
     instant board.js / game.js assign TP.Board / TP.Game, we wrap
     their prototypes, before any match is created. */
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

/* Node side: helpers the tools share. */
const RULE_NAMES = {
  R1: "coins ≥ 0, whole", R2: "trophies never drop", R3: "≤2 valid items",
  R4: "trophy buy maths", R5: "no double buy", R6: "fork/shortcut movement",
  R7: "lap bonus +5", R8: "shop maths", R9: "item effects", R10: "hops = dice",
  R11: "stats", R12: "minigame payout", R13: "bonus trophies",
  R14: "trophy relocation",
};

// One-line-per-rule summary: how many checks ran and how many failed.
function formatChecks(recs) {
  const runs = {}, fails = {};
  for (const r of recs) {
    for (const [k, n] of Object.entries(r.checksRun || {})) runs[k] = (runs[k] || 0) + n;
    for (const v of r.violations || []) fails[v.rule] = (fails[v.rule] || 0) + 1;
  }
  return Object.keys(RULE_NAMES).map((k) =>
    `  ${k.padEnd(4)} ${RULE_NAMES[k].padEnd(24)} ${String(runs[k] || 0).padStart(6)} checks  ${fails[k] ? `${fails[k]} FAILED` : "ok"}`
  ).join("\n");
}

const BROWSER_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"];

module.exports = { installTurboPartyChecks, formatChecks, RULE_NAMES, BROWSER_ARGS };
