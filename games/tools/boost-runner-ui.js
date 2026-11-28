/* =====================================================================
   boost-runner-ui.js — plays the REAL page (index.html) the way a person
   does: through the menu, with Player 1 on Keyboard 1 pressing actual
   keys, and checks the screens and HUD on the way.

   Usage (from the games folder):
     node tools/boost-runner-ui.js [seed] [shotsDir]
     node tools/boost-runner-ui.js 7 /tmp/br-shots

   seed      course and bot seed (?seed=S, default 7)
   shotsDir  where to save screenshots (default: no screenshots). Keep
             them OUTSIDE the repo.

   What it does, in plain English:
     1. Opens the menu. Checks it has Start, "← All modes" and the
        Controls button ([data-open-controls]), opens the Controls
        screen and closes it again with Escape.
     2. Sets Player 1 to Keyboard 1 (the other seats stay empty, so bots
        play them) and clicks Start race, at speed 4.
     3. The human path: holds D (drive) and taps Space (jump) and Left
        Shift (boost) with real key presses, so it goes through the shared
        TP.Input code, not a script. Checks the human car moves forward,
        jumps and boosts, and that a jump press never restarts the match
        (a focused, hidden Start button must not eat Space).
     4. Grey-panel check: at every new round's countdown, no player panel
        may still be grey ("out") from the round before.
     5. Round-win card at speed 1: when two cars are left in round 2, the
        game drops to normal speed, and the round card must show for at
        least 1.5 s of real time before the next round clears it.
     6. Lets the match finish (speed 8) and checks the match-end card has
        Rematch and Menu.

   FAILS on page errors, or any check above. Exit code 0 = PASS.
   ===================================================================== */
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const seed = Number(process.argv[2] || 7);
const shots = process.argv[3] || null;
if (shots) fs.mkdirSync(shots, { recursive: true });

(async () => {
  const browser = await chromium.launch({ args: ["--mute-audio"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  const fails = [];
  const ok = (cond, msg) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) fails.push(msg); };
  page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE ERROR: " + m.text()); });
  const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, name + ".png") }); };
  const wait = (ms) => page.waitForTimeout(ms);
  const state = () => page.evaluate(() => {
    const g = BR.game;
    return g ? { state: g.state, round: g.roundNumber, alive: g.cars.filter((c) => c.alive).length, attract: TP.brApp.attract } : null;
  });

  const file = "file:///" + path.resolve(__dirname, "../boost-runner/index.html").replace(/\\/g, "/");
  await page.goto(`${file}?seed=${seed}&speed=4`);
  await page.waitForSelector("#start", { timeout: 30000 });
  await wait(800);

  /* ---------- 1. Menu ---------- */
  console.log("Menu");
  ok(await page.$("#start") !== null, "Start race button");
  ok(await page.$(`a[href*="index.html"]`) !== null, "← All modes link");
  ok(await page.$("[data-open-controls]") !== null, "Controls button (data-open-controls)");
  const kb1Hint = await page.$eval("#keys", (t) => t.textContent);
  ok(/Keyboard 1/.test(kb1Hint) && /Space/.test(kb1Hint), `key hints built from bindings ("${kb1Hint.slice(0, 60)}…")`);
  await shot("1-menu");
  await page.click("[data-open-controls]");
  await wait(600);
  const ctrlOpen = await page.evaluate(() => !!document.querySelector(".ctrl-menu, #controls-menu, [data-controls-menu]") ||
    [...document.querySelectorAll("div")].some((d) => /Keyboard 1/.test(d.textContent || "") && /Reset/.test(d.textContent || "") && d.offsetParent !== null));
  ok(ctrlOpen, "Controls screen opens");
  await shot("2-controls");
  await page.keyboard.press("Escape");
  await wait(500);
  ok(await page.isVisible("#start"), "Escape closes Controls and the menu is back");

  /* ---------- 2. Start with Player 1 on Keyboard 1 ---------- */
  await page.selectOption("#c0", "kb1");
  for (const i of [1, 2, 3]) await page.selectOption("#c" + i, "off");
  await page.click("#start");
  await page.waitForFunction(() => BR.game && !TP.brApp.attract && BR.game.state === "race", null, { timeout: 20000 });
  const seat0 = await page.evaluate(() => TP.brApp.players[0].controller);
  ok(seat0 === "kb1", `seat 1 is Keyboard 1 (${seat0})`);

  /* ---------- 3. The human path, with real key presses ---------- */
  console.log("Human path (Keyboard 1)");
  const x0 = await page.evaluate(() => BR.game.cars[0].x);
  const starts0 = await page.evaluate(() => BR.events.filter((e) => e.type === "round_start" && e.round === 1).length);
  await page.keyboard.down("KeyD");
  let pressed = 0;
  let boostSeen = false;
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Space", { delay: 60 });
    if (i % 3 === 1) {
      // Hold boost and sample, while it's held, whether the car is boosting.
      // (Checking the meter afterwards doesn't work: it refills in seconds.)
      await page.keyboard.down("ShiftLeft");
      await wait(150);
      if (await page.evaluate(() => BR.game.cars[0].alive && BR.game.cars[0].boosting)) boostSeen = true;
      await wait(100);
      await page.keyboard.up("ShiftLeft");
    }
    pressed++;
    await wait(220);
    if (i === 4) await shot("3-race");
  }
  const after = await page.evaluate(() => {
    const ev = BR.events;
    return {
      x: BR.game.cars[0].x,
      jumps: ev.filter((e) => e.type === "jump" && e.seat === 0).length,
      starts: ev.filter((e) => e.type === "round_start" && e.round === 1).length,
      round: BR.game.roundNumber,
    };
  });
  await page.keyboard.up("KeyD");
  ok(after.x > x0 + 20 || after.round > 1, `human car drove forward (x ${x0.toFixed(1)} → ${after.x.toFixed(1)})`);
  ok(after.jumps >= 2, `human jumps registered (${after.jumps} from ${pressed} presses)`);
  ok(boostSeen, "human boost (Left Shift) makes the car boost");
  ok(after.starts === starts0, "pressing Space never restarted the match");

  /* ---------- 4 + 5. Grey panels at each countdown, round card at speed 1 ---------- */
  console.log("Rounds");
  // A watcher inside the page: at every countdown frame, record any grey panel.
  await page.evaluate(() => {
    window.__ui = { grey: [], cardShown: null, cardHidden: null, slowed: false };
    const tick = () => {
      const g = BR.game, u = window.__ui;
      if (g && !TP.brApp.attract) {
        if (g.state === "countdown" && g.roundNumber > 1) {
          const out = [...document.querySelectorAll(".pcard.out")].map((e) => e.id);
          if (out.length) u.grey.push({ round: g.roundNumber, out });
        }
        // Slow to real time when two cars are left in round 2+.
        if (!u.slowed && g.roundNumber >= 2 && g.state === "race" && g.cars.filter((c) => c.alive).length <= 2) {
          g.speed = 1; u.slowed = performance.now();
        }
        const card = document.querySelector("#overlay.show .card.round");
        if (u.slowed && card && u.cardShown === null) u.cardShown = performance.now();
        if (u.cardShown !== null && !card && u.cardHidden === null) u.cardHidden = performance.now();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // Wait for the round card at speed 1 (up to 120 s of real time).
  await page.waitForFunction(() => window.__ui.cardShown !== null, null, { timeout: 150000 }).catch(() => {});
  await wait(500);
  await shot("4-round-card");
  await page.waitForFunction(() => window.__ui.cardHidden !== null || BR.game.state === "match_end", null, { timeout: 20000 }).catch(() => {});
  const ui = await page.evaluate(() => window.__ui);
  const shownFor = ui.cardShown && ui.cardHidden ? (ui.cardHidden - ui.cardShown) / 1000 : null;
  ok(ui.cardShown !== null, "round-win card appeared at speed 1");
  ok(shownFor === null || shownFor >= 1.5, `round-win card stayed up ${shownFor === null ? "until match end" : shownFor.toFixed(1) + " s"} (need ≥ 1.5 s)`);

  /* ---------- 6. Finish the match ---------- */
  await page.evaluate(() => { BR.game.speed = 8; });
  await page.waitForFunction(() => BR.game.state === "match_end" && document.querySelector("#m-rematch"), null, { timeout: 200000 }).catch(() => {});
  await wait(800);
  await shot("5-match-end");
  const ui2 = await page.evaluate(() => window.__ui);
  ok(!ui2.grey.length, `no grey panels during a countdown${ui2.grey.length ? ": " + JSON.stringify(ui2.grey.slice(0, 3)) : ""}`);
  ok(await page.$("#m-rematch") !== null && await page.$("#m-menu") !== null, "match-end card has Rematch and Menu");

  console.log(errors.length ? "\nERRORS:\n" + [...new Set(errors)].map((e) => "  - " + e).join("\n") : "\nNo page errors.");
  const pass = !errors.length && !fails.length;
  console.log(pass ? "RESULT: PASS" : `RESULT: FAIL (${fails.length} check(s), ${errors.length} error(s))`);
  await browser.close();
  process.exit(pass ? 0 : 1);
})();
