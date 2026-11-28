/* =====================================================================
   car-fighter-training.js — checks Car Fighter's training mode, the
   tutorial and the pause menu, through the real page with real key
   presses (keyboard 1), the way a player would.

   Usage (from the games folder):
     node tools/car-fighter-training.js            # everything (~2 min)
     node tools/car-fighter-training.js training   # training rules + pause
     node tools/car-fighter-training.js tutorial   # play all 6 lessons
   Options: --p1=rivet|haulback|skitter (your car, default rivet)

   Part "training": menu → Training → car select → Start training, then:
     clock       the timer shows ∞ and state.timer never goes down
     readout     E E E on the standing dummy shows a combo in the panel
     refill      the dummy's health is full again once the combo ends
     noko        a dummy left on 1 health can't be KO'd (it stays at 1)
     meter       with "Refill super meter" on, P1's meter stays full
     pause       Esc freezes the fight (no frames pass) and shows the card
     padnav      every pause-card control is reachable with the arrows
     dummy       setting the dummy to "Block everything" makes it block
     movelist    the move list has every move of the car, and Esc goes back
     resume      Esc resumes, and the Space that's still held doesn't jump
     restart     Restart training gives a fresh fight
     quit        Quit to menu goes back to the menu
   Part "tutorial": menu → Tutorial, then plays each lesson with real
   keys and checks it moves on by itself, and that "Tutorial complete!"
   shows at the end.

   Exit code 0 = every check passed and there were no page errors.
   Real time (key presses can't be fast-forwarded): run it in the
   background. Headless Chromium, --mute-audio, closed at the end.
   ===================================================================== */
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const flags = {};
const pos = [];
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) flags[m[1]] = m[2]; else pos.push(a);
}
const which = pos[0] || "all";
const P1CAR = flags.p1 || "rivet";
const PAGE = pathToFileURL(path.resolve(__dirname, "../car-fighter/index.html")).href;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(9)} ${detail}`);
}

async function openPage(browser, errors) {
  // Small window: software WebGL draws faster, so key timing is closer
  // to a real browser's (see car-fighter-human.js).
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE ERROR: " + m.text()); });
  await page.goto(PAGE);
  await page.waitForSelector("#training", { timeout: 30000 });
  await page.selectOption("#ctrl0", "kb1");
  return page;
}

// A real tap: held ~50 ms so the game's input poll sees it.
async function tap(page, key, holdMs = 50) {
  await page.keyboard.down(key);
  await page.waitForTimeout(holdMs);
  await page.keyboard.up(key);
}
const st = (page) => page.evaluate(() => {
  const s = TP.fight.state;
  return { frame: s.frame, timer: s.timer, phase: s.phase, cars: s.cars.map((c) => ({ x: c.x, state: c.state, hp: c.health, max: c.maxHealth, sup: c.super })) };
});
// Walk P1 toward the dummy until they're within `d`.
async function closeIn(page, d = 3.1) {
  for (let i = 0; i < 40; i++) {
    const s = await st(page);
    const gap = s.cars[1].x - s.cars[0].x;
    if (Math.abs(gap) <= d) return true;
    const k = gap > 0 ? "KeyD" : "KeyA";
    await page.keyboard.down(k); await page.waitForTimeout(90); await page.keyboard.up(k);
  }
  return false;
}
const towardKey = async (page) => ((await st(page)).cars[1].x > (await st(page)).cars[0].x ? "KeyD" : "KeyA");
const awayKey = async (page) => ((await towardKey(page)) === "KeyD" ? "KeyA" : "KeyD");

/* ---------- Part 1: training rules and the pause menu ---------- */
async function partTraining(browser, errors) {
  const page = await openPage(browser, errors);
  await page.click("#training");
  await page.waitForSelector("#fight");
  await page.click(`.tile[data-seat="0"][data-car="${P1CAR}"]`);
  await page.click("#fight");
  await page.waitForFunction(() => window.TP && TP.fight && TP.fight.state.training, null, { timeout: 15000 });
  await page.mouse.click(5, 5);

  // clock
  const a = await st(page);
  await page.waitForTimeout(1500);
  const b = await st(page);
  const timerTxt = await page.$eval("#timer", (e) => e.textContent);
  record("clock", timerTxt === "∞" && b.timer === a.timer && b.frame > a.frame, `timer shows "${timerTxt}", state.timer ${a.timer} → ${b.timer}, frames ${a.frame} → ${b.frame}`);

  // readout + refill: E E E on the standing dummy
  let comboTxt = "", refilled = false, tries = 0;
  for (; tries < 5 && !/\d+ hits/.test(comboTxt); tries++) {
    await closeIn(page);
    for (let i = 0; i < 3; i++) { await tap(page, "KeyE"); await page.waitForTimeout(140); }
    await page.waitForTimeout(1500);
    comboTxt = await page.$eval("#coach", (e) => e.innerText.replace(/\n/g, " "));
  }
  const after = await st(page);
  refilled = after.cars[1].hp === after.cars[1].max;
  record("readout", /Combo\s+\d+ hits/.test(comboTxt), `panel: "${comboTxt.slice(0, 120)}"`);
  record("refill", refilled, `dummy health after the combo ${after.cars[1].hp}/${after.cars[1].max}`);

  // noko: put the dummy on 1 health, hit it, it stays alive
  await page.evaluate(() => { TP.fight._fighters[1].health = 1; });
  let ko = false;
  for (let t = 0; t < 4; t++) {
    await closeIn(page);
    await tap(page, "KeyR");
    await page.waitForTimeout(500);
    const s = await st(page);
    if (s.cars[1].state === "ko" || s.phase !== "fight" && s.phase !== "hitstop") ko = true;
  }
  const s2 = await st(page);
  record("noko", !ko && s2.cars[1].hp >= 1, `dummy state ${s2.cars[1].state}, health ${s2.cars[1].hp}, phase ${s2.phase}`);
  record("meter", s2.cars[0].sup >= 300, `P1 super ${s2.cars[0].sup}`);

  // pause
  await tap(page, "Escape");
  await page.waitForTimeout(300);
  const f1 = (await st(page)).frame;
  await page.waitForTimeout(800);
  const f2 = (await st(page)).frame;
  const cardOn = await page.$eval("#overlay", (e) => e.classList.contains("show") && !!document.querySelector("#presume"));
  record("pause", cardOn && f1 === f2, `card ${cardOn ? "shown" : "missing"}, frames ${f1} → ${f2}`);

  // padnav: arrows reach every control on the pause card
  const reach = await page.evaluate(async () => {
    const card = document.getElementById("card");
    const all = [...card.querySelectorAll("button, select, input, a")].filter((e) => e.offsetParent);
    const seen = new Set();
    const cur = () => card.querySelector(".rr-nav-focus") || document.activeElement;
    const press = (key) => window.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true }));
    const wait = () => new Promise((r) => setTimeout(r, 40));
    for (let round = 0; round < 3; round++) {
      for (const k of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft",
        "ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp", "ArrowRight", "ArrowDown"]) {
        press(k); await wait(); seen.add(cur());
      }
    }
    const missing = all.filter((e) => !seen.has(e)).map((e) => e.id || e.textContent.trim());
    return { total: all.length, missing };
  });
  record("padnav", reach.missing.length === 0, `${reach.total - reach.missing.length}/${reach.total} reached${reach.missing.length ? "; missing " + reach.missing.join(", ") : ""}`);

  // dummy: block everything
  await page.selectOption("#pdummy", "block");
  // movelist
  await page.click("#pmoves");
  await page.waitForSelector(".movelist");
  const ml = await page.evaluate((car) => {
    const names = [...document.querySelectorAll(".movelist td.mn")].map((e) => e.textContent);
    const want = Object.values(TP.fighterMoves(car)).filter((m) => m.input && !m.internal).map((m) => m.name);
    return { names, missing: want.filter((n) => !names.includes(n)) };
  }, P1CAR);
  await tap(page, "Escape");
  await page.waitForTimeout(300);
  const backOnPause = await page.evaluate(() => !!document.querySelector("#presume"));
  record("movelist", ml.missing.length === 0 && backOnPause, `${ml.names.length} rows${ml.missing.length ? ", missing " + ml.missing.join(", ") : ""}; Esc back to pause: ${backOnPause}`);

  // resume while holding Space: no jump until it's let go
  await page.keyboard.down("Space");
  await page.waitForTimeout(80);
  await tap(page, "Escape");
  await page.waitForTimeout(500);
  const r1 = await st(page);
  const paused = await page.evaluate(() => TP.Match.isPaused());
  await page.keyboard.up("Space");
  record("resume", !paused && r1.cars[0].state !== "air", `paused ${paused}, P1 state while Space held: ${r1.cars[0].state}`);

  // dummy blocks now
  let blocked = false;
  for (let t = 0; t < 4 && !blocked; t++) {
    const n = await page.evaluate(() => TP.fight.events.length);
    await closeIn(page);
    await tap(page, "KeyR");
    await page.waitForTimeout(700);
    blocked = await page.evaluate((n) => TP.fight.events.slice(n).some((e) => e.type === "block" && e.victim === 1), n);
  }
  record("dummy", blocked, `dummy set to block: ${blocked ? "it blocked the Ram" : "no block seen"}`);

  // restart
  const oldFight = await page.evaluate(() => (window.__old = TP.fight, TP.fight.state.frame));
  await tap(page, "Escape");
  await page.waitForSelector("#prestart");
  await page.click("#prestart");
  await page.waitForTimeout(600);
  const fresh = await page.evaluate(() => TP.fight !== window.__old && !!TP.fight.state.training && !TP.Match.isPaused());
  record("restart", fresh, `new training fight: ${fresh} (old one was at frame ${oldFight})`);

  // quit
  await tap(page, "Escape");
  await page.waitForSelector("#pquit");
  await page.click("#pquit");
  await page.waitForSelector("#training", { timeout: 10000 });
  record("quit", true, "back on the menu");
  await page.close();
}

/* ---------- Part 2: the tutorial, played with real keys ---------- */
async function partTutorial(browser, errors) {
  const page = await openPage(browser, errors);
  await page.click("#tutorial");
  await page.waitForFunction(() => window.TP && TP.FightTraining && TP.FightTraining.active, null, { timeout: 15000 });
  await page.mouse.click(5, 5);
  const lesson = () => page.evaluate(() => TP.FightTraining.lesson);
  const done = () => page.evaluate(() => /Tutorial complete/.test(document.getElementById("card").textContent) &&
    document.getElementById("overlay").classList.contains("show"));

  const plays = [
    async () => { // Move
      for (const k of ["KeyA", "KeyD", "KeyA", "KeyD"]) { await page.keyboard.down(k); await page.waitForTimeout(900); await page.keyboard.up(k); }
    },
    async () => { // Dodge
      await tap(page, "KeyW", 70); await page.waitForTimeout(700); await tap(page, "KeyS", 70); await page.waitForTimeout(700);
    },
    async () => { // Guard: hold away for a few seconds while it attacks
      const k = await awayKey(page);
      await page.keyboard.down(k); await page.waitForTimeout(4500); await page.keyboard.up(k);
    },
    async () => { // Combo
      await closeIn(page);
      for (let i = 0; i < 3; i++) { await tap(page, "KeyE"); await page.waitForTimeout(140); }
      await page.waitForTimeout(600);
    },
    async () => { // Throw
      await closeIn(page, 3.2);
      await page.keyboard.down("KeyE"); await page.keyboard.down("KeyR");
      await page.waitForTimeout(70);
      await page.keyboard.up("KeyE"); await page.keyboard.up("KeyR");
      await page.waitForTimeout(1200);
    },
    async () => { // Signature: hold Boost, tap Heavy
      await closeIn(page);
      await page.keyboard.down("ShiftLeft"); await page.waitForTimeout(40);
      await tap(page, "KeyR");
      await page.keyboard.up("ShiftLeft");
      await page.waitForTimeout(1500);
    },
  ];
  const names = ["move", "dodge", "guard", "combo", "throw", "signature"];
  for (let i = 0; i < plays.length; i++) {
    let ok = false, n = 0;
    for (; n < 8 && !ok; n++) {
      if (await done()) { ok = true; break; }
      if ((await lesson()) > i) { ok = true; break; }
      await plays[i]();
      await page.waitForTimeout(1500);   // the lesson moves on ~1.2 s after it's done
      ok = (await lesson()) > i || (i === plays.length - 1 && await done());
    }
    record("t:" + names[i], ok, ok ? `done after ${n + (ok ? 1 : 0)} go(es)` : `stuck on lesson ${(await lesson()) + 1}: "${await page.$eval("#coach", (e) => e.innerText.replace(/\n/g, " ").slice(0, 100))}"`);
    if (!ok) break;
  }
  if (results.find((r) => r.name === "t:signature" && r.ok)) {
    await page.waitForTimeout(500);
    const fin = await done();
    record("t:finish", fin, fin ? '"Tutorial complete!" card shown' : "no end card");
    if (fin) {
      await page.click("#tfree");
      await page.waitForTimeout(500);
      const free = await page.evaluate(() => !TP.Match.isPaused() && /TRAINING/.test(document.getElementById("coach").textContent));
      record("t:free", free, `"Keep practising" goes to free training: ${free}`);
    }
  }
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ args: ["--mute-audio"] });
  const errors = [];
  try {
    if (which === "all" || which === "training") await partTraining(browser, errors);
    if (which === "all" || which === "tutorial") await partTutorial(browser, errors);
  } catch (e) {
    errors.push("TOOL ERROR: " + (e && e.stack || e));
  } finally {
    await browser.close();
  }
  console.log(errors.length ? "\n" + errors.join("\n") : "\nNo page errors.");
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  const ok = !errors.length && results.length && passed === results.length;
  console.log(`RESULT: ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
})();
