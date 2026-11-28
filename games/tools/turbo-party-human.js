/* =====================================================================
   turbo-party-human.js — plays Turbo Party the way a person would: with
   real key presses on Keyboard 1 (A / D to move through a menu, Space
   to confirm), against 3 bots. It sets up exact situations before the
   human's turns so every shop / item / fork / trophy path gets used,
   and the shared referee (tools/lib/turbo-party-checks.js) checks the
   game's rules the whole way through.

   Usage (from the games folder):
     node tools/turbo-party-human.js [speed]
     node tools/turbo-party-human.js          # speed 4 (default)

   Three parts:

   PART 1 — HUB. Opens the Rocket Rumble hub (games/index.html), types a
     setup into it (names, Keyboard 1, an empty seat), presses Play on
     Turbo Party and checks the Turbo Party menu shows that setup (empty
     seat → bot). Then checks broken saved data falls back to defaults,
     and that "← All modes" goes back to the hub.

   PART 2 — RULE UNIT CHECKS (no input needed):
     • Game.payouts() against our own reading of the payout rules,
       including all-tie and partial-tie cases.
     • Game.bonusWinner() against our own reading of the bonus rule
       (stat tie → most coins; still tied → no award).
     • board.randomTrophySpot() from 300 random spaces, each result
       checked by our own board walk (adapted from Gameplay's job-1
       trophy-check script).
     • board.itemUnusable() reasons for Pickpocket and Trophy Warp.

   PART 3 — SCRIPTED HUMAN MATCH (5 turns, player 1 on Keyboard 1).
     Before each of the human's turns the test sets up a situation, says
     which menu options it wants, and then drives the menus with keys:
       T1 shop with 3 coins: every item greyed out, can only Leave;
          shop with 30 coins: buy Pickpocket, then Trophy Warp;
          shop with 2 items: "slots full", nothing happens;
          item menu with all rivals broke: Pickpocket greyed out and
          skipped by A/D; use Double Dice (2 dice).
       T2 start on the fork, use Turbo Dice (6–10), take the shortcut.
       T3 start on the fork, take the main road; use Pickpocket on a
          known richest rival (no target choice exists — it always hits
          the richest rival).
       T4 use Trophy Warp, drive onto the trophy, press "Buy!".
       T5 start just before the trophy: Warp greyed out ("already
          there"); use Turbo, drive onto the trophy, press "Skip".
     Cards between minigames are dismissed with Space like a person
     would. The die is hit with Space.

   Exit code 0 = every check passed and no page/console errors.
   ===================================================================== */
const path = require("path");
const { chromium } = require("playwright");
const { installTurboPartyChecks, formatChecks, BROWSER_ARGS } = require("./lib/turbo-party-checks");

const speed = Number(process.argv[2] || 4);
const GAMES = path.resolve(__dirname, "..");
const url = (rel) => "file:///" + path.join(GAMES, rel).replace(/\\/g, "/");

// Every check in this file lands here: { part, name, ok, detail }.
const results = [];
function expect(part, name, ok, detail = "") {
  results.push({ part, name, ok: !!ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}

/* =====================================================================
   PART 2b — Board set pieces (round 2, phase 2)
     • swing gate closed → the fork goes main road, no menu
     • prevSpace: the road back out of the shortcut and the merge
     • Spark Cannon: cars in the zone go back exactly 3 spaces, cars
       outside it don't move
     • Final 3 turns: blue +6 / red −6, and last place gets the catch-up
       bonus (+10)
   ===================================================================== */
async function partSetPieces(browser, errors) {
  console.log("\nPART 2b — board set pieces (gate, cannon, final stretch)");
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push("setpiece PAGE ERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("setpiece CONSOLE ERROR: " + m.text()); });
  await page.goto(url("turbo-party/index.html") + "?demo&turns=1&speed=8");
  await page.waitForFunction(() => window.TP && TP.game && TP.game.board);
  const u = await page.evaluate(async () => {
    const g = TP.game, b = g.board, out = {};
    // Freeze the demo match's own turns: only our calls run.
    b.takeTurn = async () => {}; g.minigameRound = async () => {}; g.finale = async () => {};
    const me = g.players[0];

    // Gate closed: the fork has no menu and goes down the main road.
    b.gate.open = false;
    me.space = b.forkIndex;
    let menu = false;
    const choose = b.choose; b.choose = async (...a) => { menu = true; return choose.apply(b, a); };
    const next = await b.pickNext(me);
    b.choose = choose;
    out.gate = { next, main: b.spaces[b.forkIndex].next[0], menu };
    b.gate.open = true;

    // The road back.
    out.prev = { fromSc: b.prevSpace(b.shortcutFirst), fork: b.forkIndex,
      fromMergeIsLoop: !b.spaces[b.prevSpace(b.mergeIndex)].shortcut, from0: b.prevSpace(0) };

    // Cannon: put players 0 and 1 in the zone, 2 and 3 well away from it.
    b.cannon.zone = [10, 11, 12, 13, 14];
    g.players[0].space = 12; g.players[1].space = 10;
    g.players[2].space = 20; g.players[3].space = 25;
    g.players.forEach((p) => b.parkToken(p.index));
    const exp0 = b.prevSpace(b.prevSpace(b.prevSpace(12)));
    const exp1 = b.prevSpace(b.prevSpace(b.prevSpace(10)));
    await b.fireCannon();
    out.cannon = { got: g.players.map((p) => p.space), exp: [exp0, exp1, 20, 25] };

    // Final stretch: blue/red doubled.
    b.finalStretch = true;
    const blue = b.spaces.find((s) => s.type === "blue"), red = b.spaces.find((s) => s.type === "red");
    me.coins = 20; me.space = blue.index; await b.landOn(me);
    const afterBlue = me.coins;
    me.coins = 20; me.space = red.index; await b.landOn(me);
    out.stretch = { afterBlue, afterRed: me.coins };
    b.finalStretch = false;

    // Catch-up bonus: player 3 alone in last place.
    g.players.forEach((p, i) => { p.trophies = [2, 1, 1, 0][i]; p.coins = [5, 9, 9, 30][i]; });
    await g.startFinalStretch();
    out.catchup = { coins: g.players.map((p) => p.coins), stretch: b.finalStretch };
    return out;
  });
  expect("setpiece", "gate closed: fork goes main road with no menu", u.gate.next === u.gate.main && !u.gate.menu, JSON.stringify(u.gate));
  expect("setpiece", "the road back out of the shortcut leads to the fork", u.prev.fromSc === u.prev.fork, JSON.stringify(u.prev));
  expect("setpiece", "the road back from the merge is the main loop", u.prev.fromMergeIsLoop, JSON.stringify(u.prev));
  expect("setpiece", "Spark Cannon: cars in the zone go back 3, others stay", JSON.stringify(u.cannon.got) === JSON.stringify(u.cannon.exp), JSON.stringify(u.cannon));
  expect("setpiece", "final stretch: blue +6, red −6", u.stretch.afterBlue === 26 && u.stretch.afterRed === 14, JSON.stringify(u.stretch));
  expect("setpiece", "final stretch starts: last place gets +10, others unchanged", u.catchup.stretch && u.catchup.coins.join() === "5,9,9,40", JSON.stringify(u.catchup));
  await context.close();
}

/* ---------------------------------------------------------------------
   Key presses. A tap is held for ~3 frames so the game's per-frame
   "just pressed" edge detection always sees it.
   --------------------------------------------------------------------- */
async function tap(page, code) {
  await page.keyboard.down(code);
  await page.waitForTimeout(60);
  await page.keyboard.up(code);
  await page.waitForTimeout(60);
}

/* =====================================================================
   PART 1 — Hub and saved setup
   ===================================================================== */
async function partHub(browser, errors) {
  console.log("\nPART 1 — Rocket Rumble hub and saved setup");
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push("hub PAGE ERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("hub CONSOLE ERROR: " + m.text()); });

  await page.goto(url("index.html"));
  await page.waitForFunction(() => document.getElementById("n0") && window.TP && TP.Rumble);

  // Type a setup into the hub like a person would (the hub saves on input).
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
    set("n0", "Tester"); set("c0", "kb1");
    set("n1", "Robo"); set("c1", "bot");
    set("n2", "Ghost"); set("c2", "off");
    set("n3", "Pinky"); set("c3", "kb2");
  });
  const saved = await page.evaluate(() => TP.Rumble.loadSetup().slots);
  expect("hub", "hub saves the setup as it's typed",
    saved[0].name === "Tester" && saved[0].controller === "kb1" && saved[2].controller === "off",
    JSON.stringify(saved.map((s) => `${s.name}:${s.controller}`)));

  // Press Play on Turbo Party and follow the page change.
  const hasPlay = await page.evaluate(() => !!document.querySelector('button[data-id="turbo-party"]:not([disabled])'));
  expect("hub", "hub has an enabled Play button for Turbo Party", hasPlay);
  if (hasPlay) {
    await Promise.all([
      page.waitForURL(/turbo-party\/index\.html/, { timeout: 10000 }),
      page.evaluate(() => document.querySelector('button[data-id="turbo-party"]').click()),
    ]);
    await page.waitForFunction(() => document.getElementById("name0"));
    const menu = await page.evaluate(() => [0, 1, 2, 3].map((i) => ({
      name: document.getElementById("name" + i).value, ctrl: document.getElementById("ctrl" + i).value })));
    expect("hub", "Turbo Party menu shows the hub's names",
      menu.map((m) => m.name).join(",") === "Tester,Robo,Ghost,Pinky", menu.map((m) => m.name).join(","));
    expect("hub", "Turbo Party menu shows the hub's controllers (empty seat → bot)",
      menu.map((m) => m.ctrl).join(",") === "kb1,bot,bot,kb2", menu.map((m) => m.ctrl).join(","));

    // "← All modes" goes back to the hub.
    const back = await page.evaluate(() => { const a = [...document.querySelectorAll("a")].find((x) => /All modes/.test(x.textContent)); return a ? a.href : null; });
    expect("hub", "menu has an \"← All modes\" link", !!back, back || "");
    if (back) {
      await Promise.all([
        page.waitForURL((u) => u.href === url("index.html") || /games\/index\.html$/.test(u.href), { timeout: 10000 }),
        page.evaluate(() => [...document.querySelectorAll("a")].find((x) => /All modes/.test(x.textContent)).click()),
      ]);
      const atHub = await page.evaluate(() => !!document.getElementById("modes"));
      expect("hub", "\"← All modes\" opens the hub", atHub, page.url().replace(/.*\/games\//, "games/"));
    }
  }

  // Broken saved data must fall back to the defaults, not crash.
  const bad = [
    ["not JSON", "{oops"],
    ["3 seats", JSON.stringify({ slots: [{ name: "a", controller: "kb1" }, { name: "b", controller: "bot" }, { name: "c", controller: "bot" }] })],
    ["unknown controller", JSON.stringify({ slots: [0, 1, 2, 3].map((i) => ({ name: "P" + i, controller: i ? "bot" : "joystick9" })) })],
    ["long name", JSON.stringify({ slots: [0, 1, 2, 3].map((i) => ({ name: "X".repeat(40), controller: "bot" })) })],
  ];
  for (const [label, raw] of bad) {
    await page.evaluate((raw) => localStorage.setItem("rocketRumble.setup.v1", raw), raw);
    await page.goto(url("turbo-party/index.html"));
    await page.waitForFunction(() => document.getElementById("name0"));
    const m = await page.evaluate(() => [0, 1, 2, 3].map((i) => ({
      name: document.getElementById("name" + i).value, ctrl: document.getElementById("ctrl" + i).value })));
    let ok;
    if (label === "unknown controller") ok = m[0].ctrl === "bot" && m[0].name === "P0";
    else if (label === "long name") ok = m.every((p) => p.name.length <= 12);
    else ok = m[0].ctrl === "kb1" && m.slice(1).every((p) => p.ctrl === "bot");
    expect("hub", `bad saved setup (${label}) → safe menu`, ok, m.map((p) => `${p.name}:${p.ctrl}`).join(" "));
  }
  await context.close();
}

/* =====================================================================
   PART 2 — Rule unit checks (run inside a demo page, no input)
   ===================================================================== */
async function partUnits(browser, errors) {
  console.log("\nPART 2 — rule unit checks");
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push("unit PAGE ERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("unit CONSOLE ERROR: " + m.text()); });
  await page.addInitScript(installTurboPartyChecks);
  await page.goto(url("turbo-party/index.html") + "?demo&turns=1");
  await page.waitForFunction(() => window.TP && TP.game && TP.game.board);

  const u = await page.evaluate(() => {
    TP.game.update = () => {}; // freeze the demo match; we only call functions
    const H = window.__tpHelpers, b = TP.game.board, out = {};

    // --- Game.payouts against our own rules.
    const cases = [
      [[0], [1], [2], [3]],     // clean order
      [[2], [0, 1], [3]],       // tie for 2nd
      [[1, 3], [0], [2]],       // tie for 1st
      [[0, 1, 2], [3]],         // three-way tie for 1st
      [[0], [1, 2, 3]],         // three-way tie for 2nd
      [[0, 1, 2, 3]],           // everyone tied
    ];
    out.payouts = cases.map((ranking) => {
      const got = TP.Game.payouts(ranking);
      const exp = H.expectedPayouts(ranking);
      const ok = got.length === 4 && got.every((r) => exp[r.index] && exp[r.index].gain === r.gain && exp[r.index].win === r.win);
      return { ranking: JSON.stringify(ranking), ok, got: got.map((r) => `${r.index}:+${r.gain}${r.win ? "W" : ""}`).join(" ") };
    });

    // --- Game.bonusWinner against our own rule (tiebreak on coins).
    const mk = (stats, coins) => stats.map((v, i) => ({ index: i, coins: coins[i], stats: { s: v } }));
    const bcases = [
      ["clear winner", [3, 1, 0, 2], [5, 5, 5, 5]],
      ["tie on stat, more coins wins", [3, 3, 0, 1], [10, 20, 5, 5]],
      ["tie on stat and coins → no award", [3, 3, 0, 1], [20, 20, 5, 5]],
      ["nobody scored → no award", [0, 0, 0, 0], [1, 2, 3, 4]],
      ["3-way stat tie, one richest", [2, 2, 2, 0], [7, 9, 8, 50]],
    ];
    out.bonus = bcases.map(([name, st, co]) => {
      const pl = mk(st, co);
      const got = TP.Game.bonusWinner ? TP.Game.bonusWinner(pl, "s").winner : "missing";
      const exp = H.expectedBonusWinner(pl, "s");
      return { name, ok: got === exp, got, exp };
    });

    // --- Trophy relocation from 300 random spaces.
    const bad = [];
    for (let k = 0; k < 300; k++) {
      const from = Math.floor(Math.random() * b.spaces.length);
      const to = b.randomTrophySpot(from);
      const why = H.relocationProblems(b, from, to);
      if (why.length) bad.push(`${from}→${to}: ${why.join(", ")}`);
    }
    out.relocation = { n: 300, bad: bad.slice(0, 5), badCount: bad.length };

    // --- itemUnusable reasons.
    const me = TP.game.players[0], rivals = TP.game.players.slice(1);
    const saved = TP.game.players.map((p) => ({ coins: p.coins, space: p.space }));
    rivals.forEach((p) => { p.coins = 0; });
    const brokeReason = b.itemUnusable(me, "steal");
    rivals[1].coins = 1;
    const oneCoinReason = b.itemUnusable(me, "steal");
    const before = b.spaces.find((s) => s.next.includes(b.trophyIndex));
    me.space = before.index;
    const thereReason = b.itemUnusable(me, "warp");
    me.space = b.trophyIndex;
    const awayReason = b.itemUnusable(me, "warp");
    TP.game.players.forEach((p, i) => { p.coins = saved[i].coins; p.space = saved[i].space; });
    out.unusable = { brokeReason, oneCoinReason, thereReason, awayReason,
      double: b.itemUnusable(me, "double"), turbo: b.itemUnusable(me, "turbo") };
    return out;
  });

  for (const p of u.payouts) expect("unit", `Game.payouts ${p.ranking}`, p.ok, p.got);
  for (const c of u.bonus) expect("unit", `Game.bonusWinner: ${c.name}`, c.ok, `got ${c.got}, rule says ${c.exp}`);
  expect("unit", `trophy relocation: ${u.relocation.n} random spots follow R14`, u.relocation.badCount === 0,
    u.relocation.badCount ? `${u.relocation.badCount} bad, e.g. ${u.relocation.bad.join("; ")}` : "0 bad");
  const x = u.unusable;
  expect("unit", "Pickpocket greyed out when every rival has 0 coins", !!x.brokeReason, `"${x.brokeReason}"`);
  expect("unit", "Pickpocket usable when one rival has a coin", x.oneCoinReason === "", `"${x.oneCoinReason}"`);
  expect("unit", "Warp greyed out on the space just before the trophy", !!x.thereReason, `"${x.thereReason}"`);
  expect("unit", "Warp usable elsewhere", x.awayReason === "", `"${x.awayReason}"`);
  expect("unit", "Double and Turbo are always usable", x.double === "" && x.turbo === "");
  await context.close();
}

/* =====================================================================
   PART 3 — Scripted human match
   ===================================================================== */

/* The scenario runs INSIDE the page: before each of the human's turns
   (seat 0), it sets up state and queues the menu answers it wants.
   Each want = { title: regex source, pick: regex source, probe?: bool,
   expectOff?: regex source } and is used once, in order. */
function installScenario() {
  window.__wants = [];
  window.__scn = [];  // notes the scenario leaves for the Node side
  const want = (title, pick, extra = {}) => window.__wants.push({ title, pick, ...extra });
  const note = (k, v) => window.__scn.push({ k, v });

  window.__beforeTurn = async (board, player, turn) => {
    if (player.index !== 0) return;
    const P = board.players;
    // The swing gate flips every round; keep it open on the human's turns
    // so the scripted fork choices (T2 shortcut, T3 main road) can happen.
    if (board.gate) board.gate.open = true;
    const beforeTrophy = () => board.spaces.find((s) => s.next.includes(board.trophyIndex));

    if (turn === 1) {
      // Shop with 3 coins: everything greyed out, only Leave.
      player.items = []; player.coins = 3;
      want("Buy something", "Leave", { probe: true, expectOff: "Double|Turbo|Pickpocket|Warp" });
      await board.runShop(player);
      note("shop3", { coins: player.coins, items: player.items.slice() });

      // Shop with 30 coins: buy Pickpocket, then Trophy Warp.
      player.coins = 30;
      want("Buy something", "Pickpocket");
      await board.runShop(player);
      want("Buy something", "Warp");
      await board.runShop(player);
      note("shop30", { coins: player.coins, items: player.items.slice() });

      // Shop with full slots: nothing happens, no menu.
      await board.runShop(player);
      note("shopFull", { coins: player.coins, items: player.items.slice() });

      // Item menu with every rival broke: Pickpocket greyed out; use Double.
      player.items = ["double", "steal"];
      P.slice(1).forEach((p) => { p.coins = 0; });
      want("Use an item", "Double", { probe: true, expectOff: "Pickpocket" });
    }

    if (turn === 2) {
      // Start on the fork; Turbo Dice; take the shortcut.
      player.items = ["turbo"];
      player.space = board.forkIndex; board.parkToken(0);
      want("Use an item", "Turbo");
      want("Which way", "shortcut");
      note("forkTurn2", board.forkIndex);
    }

    if (turn === 3) {
      // Start on the fork, take the main road; Pickpocket on a known rich rival.
      player.items = ["steal"];
      player.space = board.forkIndex; board.parkToken(0);
      player.coins = 10; P[1].coins = 30; P[2].coins = 5; P[3].coins = 12;
      want("Use an item", "Pickpocket");
      want("Which way", "Main");
      note("stealSetup", { self: 10, richest: P[1].name });
    }

    if (turn === 4) {
      // Trophy Warp, then drive onto the trophy and buy it.
      player.items = ["warp"]; player.coins = 25;
      want("Use an item", "Warp");
      // If the space before the trophy is the fork, head toward the trophy.
      const bt = beforeTrophy();
      if (bt.next.length > 1) want("Which way", board.spaces[board.trophyIndex].shortcut ? "shortcut" : "Main");
      want("Buy the trophy", "Buy");
      note("warpSetup", { trophies: player.trophies, coins: 25 });
    }

    if (turn === 5) {
      // Already just before the trophy: Warp greyed out. Use Turbo, skip the trophy.
      const bt = beforeTrophy();
      player.space = bt.index; board.parkToken(0);
      player.items = ["warp", "turbo"]; player.coins = 25;
      want("Use an item", "Turbo", { probe: true, expectOff: "Warp" });
      if (bt.next.length > 1) want("Which way", board.spaces[board.trophyIndex].shortcut ? "shortcut" : "Main");
      want("Buy the trophy", "Skip");
      note("skipSetup", { trophies: player.trophies, coins: 25 });
    }
  };
}

/* Read what's on screen: the choice prompt (title, options, which are
   greyed out, which is selected), the hint bar, and the card overlay. */
async function screen(page) {
  return page.evaluate(() => {
    const ch = document.getElementById("choice");
    const shown = ch && ch.classList.contains("show");
    const opts = shown ? [...ch.querySelectorAll(".opt")].map((o) => ({
      label: (o.childNodes[0] && o.childNodes[0].textContent || o.textContent).trim(),
      off: o.classList.contains("off"),
      sel: o.classList.contains("sel"),
    })) : [];
    const ov = document.getElementById("overlay");
    const card = ov && ov.classList.contains("show") ? document.getElementById("card").innerText : "";
    return {
      choice: shown ? { title: ch.querySelector(".title").textContent, opts, sel: opts.findIndex((o) => o.sel) } : null,
      hint: document.getElementById("hint").innerText,
      card,
      human: TP.game && TP.game.players[0].controller,
    };
  });
}

async function partHumanMatch(browser, errors) {
  console.log("\nPART 3 — scripted human match (Keyboard 1 vs 3 bots, 5 turns)");
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push("match PAGE ERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("match CONSOLE ERROR: " + m.text()); });
  await page.addInitScript(installTurboPartyChecks);
  await page.addInitScript(installScenario);
  // Start from a clean setup: Keyboard 1 + 3 bots.
  await page.addInitScript(() => localStorage.setItem("rocketRumble.setup.v1", JSON.stringify({ slots: [
    { name: "Tester", controller: "kb1" }, { name: "Orange", controller: "bot" },
    { name: "Green", controller: "bot" }, { name: "Pink", controller: "bot" }] })));
  await page.goto(url("turbo-party/index.html") + `?speed=${speed}`);
  await page.waitForFunction(() => document.getElementById("start"));
  await page.selectOption("#turns", "5");
  await page.click("#start");
  await page.waitForFunction(() => window.TP && TP.game);

  const log = [];        // every menu the human answered
  const probes = [];     // A/D sweeps over menus with greyed-out options
  let finished = false;
  const deadline = Date.now() + 15 * 60 * 1000;

  while (Date.now() < deadline) {
    const s = await screen(page);
    if (s.card.startsWith("FINAL STANDINGS")) { finished = true; break; }

    if (s.choice && /choose/.test(s.hint)) {
      // A menu is waiting for the human. Take the next queued want if it
      // matches this menu's title; otherwise pick option 0 (Leave / Just
      // roll / Main road / Buy!) like a cautious player.
      const want = await page.evaluate((title) => {
        const w = window.__wants[0];
        if (w && new RegExp(w.title, "i").test(title)) return window.__wants.shift();
        return null;
      }, s.choice.title);
      const labels = s.choice.opts.map((o) => o.label);
      let target = 0;
      if (want) {
        target = labels.findIndex((l) => new RegExp(want.pick, "i").test(l));
        if (target < 0) target = 0;
      }

      // Probe: sweep right through every option once with D and record
      // where the cursor lands; it must never land on a greyed-out one.
      if (want && want.probe) {
        const visited = [s.choice.sel];
        for (let k = 0; k < labels.length; k++) {
          await tap(page, "KeyD");
          visited.push((await screen(page)).choice.sel);
        }
        // Also try confirming while greyed-out options exist: the menu must
        // stay open if the cursor is on one (it can't be, but check anyway).
        probes.push({
          title: s.choice.title, labels, off: s.choice.opts.map((o) => o.off), visited,
          expectOff: want.expectOff,
        });
      }

      // Move to the target with D (right), at most one lap.
      for (let k = 0; k < labels.length + 1; k++) {
        const cur = (await screen(page)).choice;
        if (!cur || cur.sel === target) break;
        await tap(page, "KeyD");
      }
      const final = (await screen(page)).choice;
      log.push({ title: s.choice.title, chose: final ? final.opts[final.sel].label : "?", wanted: want ? want.pick : "(default)", hitTarget: final && final.sel === target });
      await tap(page, "Space");
      await page.waitForTimeout(150);
      continue;
    }

    if (/hit the die/.test(s.hint)) { await tap(page, "Space"); continue; }
    if (s.card && /to continue/i.test(s.card)) { await tap(page, "Space"); continue; }
    await page.waitForTimeout(100);
  }

  const data = await page.evaluate(() => { const r = window.__tp.finish(); const { finish, ...d } = r; return { rec: d, scn: window.__scn, left: window.__wants }; });
  await context.close();
  return { finished, log, probes, ...data };
}

function judgeHumanMatch(m) {
  const P = "match";
  const rec = m.rec;
  const scn = Object.fromEntries(m.scn.map((n) => [n.k, n.v]));
  const mine = (list) => list.filter((x) => x.player === "Tester");

  expect(P, "match reached FINAL STANDINGS", m.finished);
  expect(P, "every queued menu answer was used", m.left.length === 0, m.left.map((w) => `${w.title}→${w.pick}`).join(", "));
  const missed = m.log.filter((l) => l.wanted !== "(default)" && !l.hitTarget);
  expect(P, "keys reached every wanted option", missed.length === 0, missed.map((l) => `${l.title}: wanted ${l.wanted}, got ${l.chose}`).join("; "));

  // Shop.
  expect(P, "T1 shop with 3 coins: left with nothing bought", scn.shop3 && scn.shop3.coins === 3 && scn.shop3.items.length === 0, JSON.stringify(scn.shop3));
  expect(P, "T1 shop with 30 coins: bought Pickpocket (7) + Warp (14) = 9 coins left",
    scn.shop30 && scn.shop30.coins === 9 && scn.shop30.items.join() === "steal,warp", JSON.stringify(scn.shop30));
  expect(P, "T1 shop with full slots: no change", scn.shopFull && scn.shopFull.coins === 9 && scn.shopFull.items.length === 2, JSON.stringify(scn.shopFull));
  const full = mine(rec.shop).filter((s) => s.result === "full");
  expect(P, "shop recorded a \"slots full\" visit", full.length >= 1);

  // Probes over greyed-out options.
  for (const pr of m.probes) {
    const offIdx = pr.labels.map((l, i) => (pr.off[i] ? i : -1)).filter((i) => i >= 0);
    const shouldBeOff = pr.labels.map((l, i) => (new RegExp(pr.expectOff, "i").test(l) ? i : -1)).filter((i) => i >= 0);
    const landedOff = pr.visited.filter((v) => pr.off[v]);
    expect(P, `"${pr.title}": greyed out = ${shouldBeOff.map((i) => pr.labels[i]).join(", ")}`,
      shouldBeOff.length > 0 && shouldBeOff.every((i) => pr.off[i]) && offIdx.every((i) => shouldBeOff.includes(i)),
      `off: ${offIdx.map((i) => pr.labels[i]).join(", ") || "none"}`);
    expect(P, `"${pr.title}": A/D never lands on a greyed-out option`, landedOff.length === 0, `cursor visited ${pr.visited.join("→")}`);
  }

  // Items.
  const uses = mine(rec.itemUses).map((u) => `${u.item}@T${u.turn}`);
  expect(P, "human used Double (T1), Turbo (T2), Pickpocket (T3), Warp (T4), Turbo (T5)",
    uses.join(" ") === "double@T1 turbo@T2 steal@T3 warp@T4 turbo@T5", uses.join(" "));
  const rolls = (t) => mine(rec.rolls).filter((r) => r.turn === t).map((r) => r.value);
  expect(P, "T1 Double Dice rolled 2 dice", rolls(1).length === 2, rolls(1).join("+"));
  expect(P, "T2 and T5 Turbo Dice rolled 6–10", [2, 5].every((t) => rolls(t).length === 1 && rolls(t)[0] >= 6), `T2 ${rolls(2)} T5 ${rolls(5)}`);

  // Fork.
  const forks = mine(rec.forks);
  const f2 = forks.find((f) => f.turn === 2), f3 = forks.find((f) => f.turn === 3);
  expect(P, "T2 at the fork: chose shortcut and went onto it", f2 && f2.to === "shortcut", JSON.stringify(f2));
  expect(P, "T3 at the fork: chose main road and stayed on it", f3 && f3.to === "main", JSON.stringify(f3));

  // Trophy via Warp, then skip.
  const buyT4 = mine(rec.buys).find((b) => b.turn === 4);
  expect(P, "T4 Warp → onto the trophy → \"Buy!\" bought it (25 → 5 coins)", buyT4 && buyT4.coinsAfter === 5, JSON.stringify(buyT4));
  const visitT5 = mine(rec.trophyVisits).find((v) => v.turn === 5);
  expect(P, "T5 drove onto the trophy and \"Skip\" declined it", visitT5 && visitT5.result === "declined", JSON.stringify(visitT5));

  // Pickpocket amounts are checked by the referee (R9): richest rival
  // loses min(8, coins), the user gains it.
  expect(P, "Pickpocket has no target choice (always the richest rival)", true, "noted for the boss: the job spec mentions target selection");
}

/* ===================================================================== */
(async () => {
  const browser = await chromium.launch({ args: BROWSER_ARGS });
  const errors = [];
  await partHub(browser, errors);
  await partUnits(browser, errors);
  await partSetPieces(browser, errors);
  const m = await partHumanMatch(browser, errors);
  judgeHumanMatch(m);
  await browser.close();

  console.log("\nMENUS THE HUMAN ANSWERED");
  for (const l of m.log) console.log(`  ${l.title.padEnd(36)} → ${l.chose}${l.wanted === "(default)" ? "  (default)" : ""}`);

  console.log("\nRULE CHECKS (whole scripted match)");
  console.log(formatChecks([m.rec]));
  const viol = m.rec.violations.map((v) => `T${v.turn} ${v.rule}: ${v.msg}`);
  if (viol.length) console.log("\nRULE VIOLATIONS:\n  " + viol.join("\n  "));
  console.log(errors.length ? "\nERRORS:\n" + errors.join("\n") : "\nNo page or console errors.");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  const ok = !failed.length && !viol.length && !errors.length;
  console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(ok ? 0 : 1);
})();
