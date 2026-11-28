/* =====================================================================
   mode-5-ui.js — checks Mode 5's menu, pause overlay and long-session
   health the way a player would hit them: keyboard only, a gamepad
   only, and a lot of starting, quitting, resizing and tab-switching.

   Usage (from the games folder):
     node tools/mode-5-ui.js [part]
       part = menu-kb | menu-pad | pause | sweep | all (default all)

   menu-kb   Tab through the title menu; change every match option and a
             seat's controller and name with keys only; start with Enter.
             Checks what Gameplay was asked to start matches the choices.
   menu-pad  Same, with a fake gamepad (navigator.getGamepads stub):
             which options can a pad change, can it start, and does
             Start / d-pad / A work in the pause overlay.
   pause     Esc pause → Resume, Restart, Menu with the keyboard. Also
             checks the game actually stops while paused, and that W/S
             (which also drive the car) only move the pause selection.
   sweep     Resize the window 20 times mid-match, hide/show the tab,
             freeze/unfreeze the page, then start → quit → start 5 times
             and watch for leaks: event-bus listeners, DOM nodes, JS
             heap, DOM event listeners, FPS, and sounds per event
             (duplicate listeners show up as doubled sounds).

   Every check prints PASS / FAIL / WARN with details. Exit code 0 = no
   FAIL and no page errors.
   ===================================================================== */
const { launch, pageUrl, collectErrors, instrumentScript, readStateInPage } = require("./mode-5-lib");

const part = process.argv[2] || "all";
const results = [];
const result = (level, name, detail) => { results.push({ level, name, detail }); console.log(`${level.padEnd(4)}  ${name}: ${detail}`); };
const check = (ok, name, detail, warnOnly) => result(ok ? "PASS" : warnOnly ? "WARN" : "FAIL", name, detail);

/* ---------- Extra in-page instrumentation for this tool ----------
   1. Live listener count per event name on the mode's event bus: we
      catch TP.M5.on / TP.M5.off as events.js defines them and mirror
      every add/remove. Growth across start → quit cycles = a leak.
   2. Every TP.M5.startMatch(config) call is recorded (what the menu
      actually asked for).
   3. Every TP.M5.Audio.play(name) is counted, for the doubled-sound check.
   4. A fake gamepad, driven from the test with window.__pad. */
function uiInstrument() {
  window.TP = window.TP || {};
  TP.M5 = TP.M5 || {};
  const mirror = window.__m5listeners = {};       // name → array of fns
  let realOn = null, realOff = null;
  Object.defineProperty(TP.M5, "on", {
    configurable: true, enumerable: true,
    get() { return realOn; },
    set(fn) {
      realOn = function (name, f) {
        (mirror[name] = mirror[name] || []).push(f);
        return fn.apply(this, arguments);
      };
    },
  });
  Object.defineProperty(TP.M5, "off", {
    configurable: true, enumerable: true,
    get() { return realOff; },
    set(fn) {
      realOff = function (name, f) {
        const l = mirror[name]; if (l) { const i = l.indexOf(f); if (i !== -1) l.splice(i, 1); }
        return fn.apply(this, arguments);
      };
    },
  });
  window.__starts = [];
  window.__sounds = {};
  const wrapLater = () => {
    if (TP.M5.startMatch && !TP.M5.startMatch.__qc) {
      const orig = TP.M5.startMatch;
      TP.M5.startMatch = function (cfg) {
        try { window.__starts.push(JSON.parse(JSON.stringify(cfg || {}))); } catch (e) { window.__starts.push({ unserialisable: true }); }
        return orig.apply(this, arguments);
      };
      TP.M5.startMatch.__qc = true;
    }
    if (TP.M5.Audio && TP.M5.Audio.play && !TP.M5.Audio.play.__qc) {
      const orig = TP.M5.Audio.play;
      TP.M5.Audio.play = function (name) { window.__sounds[name] = (window.__sounds[name] || 0) + 1; return orig.apply(this, arguments); };
      TP.M5.Audio.play.__qc = true;
    }
    setTimeout(wrapLater, 20);
  };
  wrapLater();
  // Fake gamepad: standard mapping, 17 buttons, 4 axes.
  window.__pad = null;
  window.__padOn = (on) => {
    window.__pad = on ? { index: 0, id: "QC stub pad (STANDARD GAMEPAD)", connected: true, mapping: "standard", timestamp: 0,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), axes: [0, 0, 0, 0] } : null;
  };
  navigator.getGamepads = () => [window.__pad, null, null, null];
}

// Press a fake-pad button for a few frames, then release it.
async function padPress(page, b, ms = 120) {
  await page.evaluate((b) => { const p = window.__pad; p.buttons[b] = { pressed: true, touched: true, value: 1 }; p.timestamp++; }, b);
  await page.waitForTimeout(ms);
  await page.evaluate((b) => { const p = window.__pad; p.buttons[b] = { pressed: false, touched: false, value: 0 }; p.timestamp++; }, b);
  await page.waitForTimeout(ms);
}
async function padAxis(page, a, v, ms = 150) {
  await page.evaluate(({ a, v }) => { window.__pad.axes[a] = v; window.__pad.timestamp++; }, { a, v });
  await page.waitForTimeout(ms);
  await page.evaluate(({ a }) => { window.__pad.axes[a] = 0; window.__pad.timestamp++; }, { a });
  await page.waitForTimeout(ms);
}

async function newPage(browser, viewport) {
  const page = await browser.newPage({ viewport: viewport || { width: 1280, height: 800 } });
  const errors = collectErrors(page);
  await page.addInitScript(uiInstrument);
  await page.addInitScript(instrumentScript);
  // A known starting setup: seat 1 keyboard 1, the rest bots; default options.
  await page.addInitScript(() => {
    try {
      if (sessionStorage.getItem("qcSeeded")) return;       // only on the first load
      sessionStorage.setItem("qcSeeded", "1");
      localStorage.setItem("rocketRumble.setup.v1", JSON.stringify({ slots: [
        { name: "Blue", controller: "kb1" }, { name: "Orange", controller: "bot" },
        { name: "Green", controller: "bot" }, { name: "Pink", controller: "bot" }] }));
      localStorage.removeItem("rocketRumble.mode5.options");
    } catch (e) { /* storage blocked */ }
  });
  return { page, errors };
}
const menuOpen = (page) => page.evaluate(() => !!(TP.M5.Menu && TP.M5.Menu.isOpen));
const pauseOpen = (page) => page.evaluate(() => !!(TP.M5.Pause && TP.M5.Pause.isOpen));
const lastStart = (page) => page.evaluate(() => window.__starts[window.__starts.length - 1]);
const describeFocus = (page) => page.evaluate(() => {
  const e = document.activeElement;
  if (!e || e === document.body) return "body";
  return `${e.tagName.toLowerCase()}${e.dataset.k ? "[" + e.dataset.k + ":" + e.textContent.trim() + "]" : ""}${e.getAttribute("aria-label") ? "(" + e.getAttribute("aria-label") + ")" : ""}${e.id ? "#" + e.id : ""}${!e.dataset.k && e.tagName === "BUTTON" ? "'" + e.textContent.trim() + "'" : ""}${e.tagName === "A" ? "'" + e.textContent.trim() + "'" : ""}`;
});
async function waitPlay(page, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const s = await page.evaluate(readStateInPage);
    if (s.ready && s.phase === "play") return s;
    await page.waitForTimeout(150);
  }
  return null;
}

/* =====================================================================
   menu-kb
   ===================================================================== */
async function menuKeyboard(browser) {
  console.log("\n--- menu-kb: title menu with the keyboard only ---");
  const { page, errors } = await newPage(browser);
  await page.goto(pageUrl({}));
  await page.waitForFunction(() => TP.M5.Menu && TP.M5.Menu.isOpen, null, { timeout: 15000 });
  await page.waitForTimeout(500);

  // 1. Tab order: what does Tab reach, and is START in it?
  const order = [];
  for (let i = 0; i < 40; i++) { await page.keyboard.press("Tab"); order.push(await describeFocus(page)); }
  const uniq = [...new Set(order)];
  console.log("  Tab order: " + uniq.join(" → "));
  check(uniq.some((d) => d.includes("#m5m-start")), "Tab reaches START", `${uniq.length} focusable stops`);
  const optStops = uniq.filter((d) => d.startsWith("button[")).length;
  const optTotal = await page.evaluate(() => document.querySelectorAll("#m5m-opts button[data-k]").length);
  check(optStops === optTotal, "Tab reaches every option button", `${optStops}/${optTotal}`);

  // Focus is visible? (a focused button should look different)
  const ring = await page.evaluate(() => {
    const b = document.querySelector("#m5m-opts button[data-k]");
    b.blur(); const a = getComputedStyle(b); const before = a.outline + a.boxShadow + a.borderColor;
    b.focus(); const c = getComputedStyle(b); const after = c.outline + c.boxShadow + c.borderColor;
    return { before, after, focusVisible: b.matches(":focus-visible") };
  });
  check(ring.before !== ring.after, "keyboard focus is visible on option buttons", ring.before === ring.after ? "no outline/shadow/border change on focus" : "styles change on focus");

  // 2. Space on every option button selects it.
  const opts = await page.evaluate(() => [...document.querySelectorAll("#m5m-opts button[data-k]")].map((b) => ({ k: b.dataset.k, c: b.dataset.c, t: b.textContent.trim() })));
  const bad = [];
  for (const o of opts) {
    await page.focus(`#m5m-opts button[data-k="${o.k}"][data-c="${o.c}"]`);
    await page.keyboard.press("Space");
    await page.waitForTimeout(40);
    const pressed = await page.evaluate((o) => document.querySelector(`#m5m-opts button[data-k="${o.k}"][data-c="${o.c}"]`).getAttribute("aria-pressed"), o);
    if (pressed !== "true") bad.push(`${o.k}:${o.t}`);
    if (await menuOpen(page) === false) { bad.push(`${o.k}:${o.t} STARTED THE MATCH`); break; }
  }
  check(!bad.length, "Space selects every option", bad.length ? "failed: " + bad.join(", ") : `${opts.length} buttons`);
  // Focus kept after selecting? (renderOptions rebuilds the buttons)
  await page.focus('#m5m-opts button[data-k="rounds"][data-c="0"]');
  await page.keyboard.press("Space");
  const focusAfter = await describeFocus(page);
  check(focusAfter.startsWith("button[rounds"), "focus stays on the option after Space", `focus is now on ${focusAfter}` + (focusAfter.startsWith("button[") ? "" : " (keyboard user loses their place; next Tab restarts from the top)"));

  // 3. Enter on an option button: should select it, not start the match.
  await page.focus('#m5m-opts button[data-k="difficulty"][data-c="2"]');
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const startedByEnter = !(await menuOpen(page));
  const hardPressed = await page.evaluate(() => { const b = document.querySelector('#m5m-opts button[data-k="difficulty"][data-c="2"]'); return b && b.getAttribute("aria-pressed"); });
  check(!startedByEnter, "Enter on an option button selects it (doesn't start)", startedByEnter ? `pressing Enter on "Bots: Hard" STARTED THE MATCH (aria-pressed ${hardPressed}). Repro: Tab to any option, press Enter.` : `aria-pressed ${hardPressed}`);
  if (startedByEnter) {
    // Back to a fresh menu for the rest.
    await page.goto(pageUrl({}));
    await page.waitForFunction(() => TP.M5.Menu && TP.M5.Menu.isOpen, null, { timeout: 15000 });
  }

  // 4. Seat 2's controller with arrow keys, seat 1's name by typing.
  await page.focus('#m5m-seats select[data-i="1"]');
  const before = await page.evaluate(() => document.querySelector('#m5m-seats select[data-i="1"]').value);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => ({ v: document.querySelector('#m5m-seats select[data-i="1"]').value, slot: TP.M5.Menu.slots[1].controller }));
  check(after.v !== before && after.slot === after.v, "arrow keys change a seat's controller", `${before} → ${after.v} (menu slot: ${after.slot})`);
  await page.keyboard.press("ArrowUp"); // back to bot
  await page.focus('#m5m-seats input[data-i="0"]');
  await page.keyboard.press("Control+A");
  await page.keyboard.type("QCtester");
  const typed = await page.evaluate(() => TP.M5.Menu.slots[0].name);
  check(typed === "QCtester", "typing a seat name works", `slot 0 name "${typed}"`);
  // Typing a name with letters that are game keys (W, A, S, D, M, P) mustn't do anything else.
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Swamp");
  const stillOpen = await menuOpen(page);
  // (M toggles mute; the HUD would say "Sound off (M)".)
  const muted = await page.evaluate(() => document.body.innerText.includes("Sound off"));
  check(stillOpen && !muted, "typing game keys in the name box is harmless", `menu open ${stillOpen}, "Sound off" shown ${muted}`);

  // 5. Pick non-default options (with the MOUSE, since the keyboard can't
  //    if the Space check above failed), then Enter (focus on body)
  //    starts with them. Checks the choices reach Gameplay.
  for (const [k, c] of [["rounds", 2], ["roundLength", 0], ["difficulty", 0], ["arena", 1], ["teams", 1]]) {
    const sel = `#m5m-opts button[data-k="${k}"][data-c="${c}"]`;
    if (await page.$(sel)) await page.click(sel);
  }
  const want = await page.evaluate(() => ({ ...TP.M5.Menu.options }));
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  const startsBefore = await page.evaluate(() => window.__starts.length);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const started = !(await menuOpen(page)) && (await page.evaluate(() => window.__starts.length)) > startsBefore;
  const cfg = await lastStart(page);
  check(started, "Enter starts the match", started ? "menu closed, startMatch called" : "nothing happened");
  if (started) {
    const arenas = await page.evaluate(() => (TP.M5.ARENAS || []).map((a) => a.id));
    const mism = [];
    if (cfg.rounds !== want.rounds) mism.push(`rounds ${cfg.rounds} vs ${want.rounds}`);
    if (cfg.roundTime !== want.roundLength) mism.push(`roundTime ${cfg.roundTime} vs ${want.roundLength}`);
    if (cfg.botLevel !== want.difficulty) mism.push(`botLevel ${cfg.botLevel} vs ${want.difficulty}`);
    if (want.arena !== "random" && arenas[cfg.arena] !== want.arena) mism.push(`arena #${cfg.arena} (${arenas[cfg.arena]}) vs ${want.arena}`);
    if (cfg.teams !== want.teams) mism.push(`teams ${cfg.teams} vs ${want.teams}`);
    if (!cfg.players || cfg.players[0].name !== "Swamp" || cfg.players[0].controller !== "kb1") mism.push(`seat 1 ${JSON.stringify(cfg.players && cfg.players[0])}`);
    check(!mism.length, "match started with the chosen options", mism.length ? mism.join("; ") : JSON.stringify({ ...cfg, players: cfg.players.map((p) => p.controller) }));
    // Does the running match honour them?
    await page.waitForTimeout(800);
    const live = await page.evaluate(() => { const m = TP.M5.match; return { rounds: m.rounds, roundTime: m.roundTime, arena: m.arena && m.arena.id, level: m.players.map((p) => p.level), teams: m.teams }; });
    const liveBad = [];
    if (live.rounds !== want.rounds) liveBad.push(`match.rounds ${live.rounds}`);
    if (live.roundTime !== want.roundLength) liveBad.push(`match.roundTime ${live.roundTime}`);
    if (want.arena !== "random" && live.arena !== want.arena) liveBad.push(`arena ${live.arena}`);
    if (want.teams === "2v2" && !live.teams) liveBad.push(`teams not applied (match.teams ${live.teams})`);
    check(!liveBad.length, "running match uses the options", liveBad.length ? liveBad.join("; ") : JSON.stringify(live), true);
    const saved = await page.evaluate(() => TP.Rumble.loadSetup().slots[0]);
    check(saved.name === "Swamp", "seat setup saved back to the hub on Start", JSON.stringify(saved));
  }
  check(!errors.length, "menu-kb: no page errors", errors.join(" | ") || "clean");
  await page.close();
}

/* =====================================================================
   menu-pad
   ===================================================================== */
async function menuPad(browser) {
  console.log("\n--- menu-pad: title menu and pause with a gamepad only ---");
  const { page, errors } = await newPage(browser);
  await page.goto(pageUrl({}));
  await page.waitForFunction(() => TP.M5.Menu && TP.M5.Menu.isOpen, null, { timeout: 15000 });
  await page.evaluate(() => window.__padOn(true));
  await page.waitForTimeout(400);

  // Can the pad move around / change anything? Snapshot options + focus,
  // push the d-pad and stick in every direction, snapshot again.
  const snap = () => page.evaluate(() => JSON.stringify({ o: TP.M5.Menu.options, s: TP.M5.Menu.slots.map((s) => s.controller), f: document.activeElement && document.activeElement.outerHTML.slice(0, 60), hl: document.querySelectorAll(".rr-nav-focus, .sel, [data-nav-focus]").length }));
  const s0 = await snap();
  for (const b of [13, 13, 15, 15, 12, 14]) await padPress(page, b);
  for (const [a, v] of [[1, 1], [0, 1], [1, -1], [0, -1]]) await padAxis(page, a, v);
  const s1 = await snap();
  check(s0 !== s1, "gamepad can move through the menu / change options", s0 === s1 ? "d-pad and stick do nothing: a pad player can't change rounds, length, bots, arena, teams or seats (only A = Start). shared/js/menunav.js (TP.MenuNav.attach) does this for the other modes" : "something changed", false);
  await padPress(page, 1); // B: nothing should break
  check(await menuOpen(page), "B on the menu doesn't break anything", "menu still open");

  // A starts.
  await padPress(page, 0);
  await page.waitForTimeout(400);
  check(!(await menuOpen(page)), "gamepad A starts the match", (await menuOpen(page)) ? "menu still open" : "started");
  const st = await waitPlay(page);
  if (st) {
    // Start = pause; d-pad down + A = Restart; Start again = resume.
    await padPress(page, 9);
    check(await pauseOpen(page), "gamepad Start pauses", (await pauseOpen(page)) ? "pause open" : "no pause");
    await padPress(page, 9);
    check(!(await pauseOpen(page)), "gamepad Start again resumes", (await pauseOpen(page)) ? "still paused" : "resumed");
    await padPress(page, 9);
    await padPress(page, 13);
    const sel = await page.evaluate(() => TP.M5.Pause.sel);
    const nStarts = await page.evaluate(() => window.__starts.length);
    await padPress(page, 0);
    await page.waitForTimeout(300);
    const restarted = (await page.evaluate(() => window.__starts.length)) > nStarts;
    check(sel === 1 && restarted, "pad d-pad + A picks Restart", `sel ${sel}, restarted ${restarted}`);
    await waitPlay(page);
    await padPress(page, 9);
    await padAxis(page, 1, 1); await padAxis(page, 1, 1);
    const sel2 = await page.evaluate(() => TP.M5.Pause.sel);
    await padPress(page, 0);
    await page.waitForTimeout(300);
    check(sel2 === 2 && (await menuOpen(page)), "pad stick + A picks Menu (back to title)", `sel ${sel2}, menu open ${await menuOpen(page)}`);
  } else check(false, "pad: round starts", "no play phase");
  check(!errors.length, "menu-pad: no page errors", errors.join(" | ") || "clean");
  await page.close();
}

/* =====================================================================
   pause
   ===================================================================== */
async function pauseFlow(browser) {
  console.log("\n--- pause: Esc → Resume / Restart / Menu with the keyboard ---");
  const { page, errors } = await newPage(browser);
  await page.goto(pageUrl({}));
  await page.waitForFunction(() => TP.M5.Menu && TP.M5.Menu.isOpen, null, { timeout: 15000 });
  await page.keyboard.press("Enter");
  if (!(await waitPlay(page))) { check(false, "pause: round starts", "no play phase"); await page.close(); return; }
  await page.waitForTimeout(1500);

  // Esc pauses; does the game stop? (timeLeft and car positions)
  await page.keyboard.press("Escape");
  const p1 = await page.evaluate(readStateInPage);
  await page.waitForTimeout(2000);
  const p2 = await page.evaluate(readStateInPage);
  check(await pauseOpen(page), "Esc opens pause", "overlay shown");
  const clockMoved = p1.timeLeft - p2.timeLeft;
  const carsMoved = Math.max(...p1.players.map((p, i) => Math.hypot(p.x - p2.players[i].x, p.z - p2.players[i].z)));
  check(clockMoved < 0.05 && carsMoved < 0.05, "game stops while paused", `in 2 s paused: clock ran ${clockMoved.toFixed(2)} s, a car moved ${carsMoved.toFixed(1)} units`);
  // W/S move the selection; they're also the drive keys for seat 1.
  const me0 = (await page.evaluate(readStateInPage)).players[0];
  await page.keyboard.down("KeyS"); await page.waitForTimeout(400); await page.keyboard.up("KeyS");
  const me1 = (await page.evaluate(readStateInPage)).players[0];
  const sel = await page.evaluate(() => TP.M5.Pause.sel);
  const drove = Math.hypot(me1.x - me0.x, me1.z - me0.z);
  check(sel === 1 && drove < 0.05, "S moves the pause selection only", `selection ${sel}; seat-1 car moved ${drove.toFixed(2)} units while S was held`);
  await page.keyboard.press("KeyW");
  // Enter = Resume.
  await page.keyboard.press("Enter");
  check(!(await pauseOpen(page)), "Enter on Resume resumes", (await pauseOpen(page)) ? "still paused" : "resumed");
  // Jump key on resume: Space also confirms. Does the Enter/Space that
  // closes the pause make the car jump? (seat 1 is kb1, Space = jump)
  // Restart: Esc, Down, Enter.
  const m1 = await page.evaluate(() => { window.__m5match1 = TP.M5.match; return TP.M5.match.round; });
  await page.keyboard.press("Escape"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({ newMatch: TP.M5.match !== window.__m5match1, round: TP.M5.match.round, phase: TP.M5.match.phase }));
  check(r.newMatch && r.phase === "countdown", "Restart restarts", JSON.stringify(r));
  // Label says "Restart round": in a best-of-3 that should be the current round, not the whole match.
  check(true, "note", "\"Restart round\" calls TP.M5.restart() = startMatch(lastConfig), i.e. restarts the WHOLE match (round 1, wins reset). Label vs behaviour, see report");
  // Menu: Esc, Down, Down, Enter.
  await waitPlay(page);
  await page.keyboard.press("Escape"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  check(await menuOpen(page), "Menu returns to the title menu", (await menuOpen(page)) ? "menu open" : "not open");
  const hudHidden = await page.evaluate(() => { const h = TP.M5.hud && TP.M5.hud.root; return !h || getComputedStyle(h).display === "none" || getComputedStyle(h).visibility === "hidden" || Number(getComputedStyle(h).opacity) < 0.05 || !h.classList.contains("show"); });
  check(hudHidden, "HUD hidden behind the menu", hudHidden ? "hidden" : "HUD still visible over the menu", true);
  // Esc on the title menu: should do nothing harmful.
  await page.keyboard.press("Escape");
  check(await menuOpen(page) && !(await pauseOpen(page)), "Esc on the title menu is harmless", "ok");
  check(!errors.length, "pause: no page errors", errors.join(" | ") || "clean");
  await page.close();
}

/* =====================================================================
   sweep
   ===================================================================== */
async function sweep(browser) {
  console.log("\n--- sweep: resize, hide/show, freeze, start → quit × 5 ---");
  const { page, errors } = await newPage(browser);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => {
    // Collect garbage first so the heap number is what's really kept alive.
    await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
    const { metrics } = await cdp.send("Performance.getMetrics");
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    return { heapMB: m.JSHeapUsedSize / 1048576, nodes: m.Nodes, domListeners: m.JSEventListeners };
  };
  const busCount = () => page.evaluate(() => Object.values(window.__m5listeners).reduce((s, l) => s + l.length, 0));
  const busByName = () => page.evaluate(() => Object.fromEntries(Object.entries(window.__m5listeners).map(([k, v]) => [k, v.length]).filter(([, n]) => n)));
  const fpsOver = async (ms) => { const a = await page.evaluate(() => window.__m5frames); await page.waitForTimeout(ms); const b = await page.evaluate(() => window.__m5frames); return (b - a) / (ms / 1000); };

  await page.goto(pageUrl({}));
  await page.waitForFunction(() => TP.M5.Menu && TP.M5.Menu.isOpen, null, { timeout: 15000 });
  // Seat 1 as a bot for this part, so nothing is waiting on keys.
  await page.evaluate(() => { TP.M5.Menu.slots[0].controller = "bot"; });
  await page.keyboard.press("Enter");
  await waitPlay(page);

  // 1. Resize 20 times mid-match.
  const sizes = [[390, 844], [844, 390], [1024, 768], [1920, 1080], [320, 568], [1280, 800]];
  for (let i = 0; i < 20; i++) { const [w, h] = sizes[i % sizes.length]; await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(80); }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);
  const canvas = await page.evaluate(() => { const c = document.getElementById("game"); return { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight, dpr: devicePixelRatio }; });
  check(Math.abs(canvas.cw - 1280) <= 1 && Math.abs(canvas.ch - 800) <= 1 && canvas.w === Math.round(canvas.cw * Math.min(canvas.dpr, 2)), "canvas follows 20 resizes", JSON.stringify(canvas));
  check(!errors.length, "no errors after resizes", errors.slice(0, 3).join(" | ") || "clean");

  // 2. Hide the tab (visibilitychange): should pause.
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  const pausedOnHide = await pauseOpen(page);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  check(pausedOnHide, "hiding the tab pauses", pausedOnHide ? "paused" : "did not pause");
  if (await pauseOpen(page)) await page.keyboard.press("Escape");

  // 3. Freeze the page for 4 s (what a background tab gets), then wake it:
  //    no error, no huge catch-up jump in the round clock.
  //    Headless Chrome doesn't always honour the freeze; if animation
  //    frames kept coming during it, the check is inconclusive (WARN).
  const f0 = await page.evaluate(() => window.__m5frames);
  const tl0 = (await page.evaluate(readStateInPage)).timeLeft;
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  await new Promise((r) => setTimeout(r, 4000));
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  const f1 = await page.evaluate(() => window.__m5frames);
  const tl1 = (await page.evaluate(readStateInPage)).timeLeft;
  if (f1 - f0 > 10) result("WARN", "no catch-up jump after the tab wakes", `inconclusive: the page kept animating during the freeze (${f1 - f0} frames); main.js caps a frame at 0.1 s / 5 steps, so by code review a wake can't jump more than 0.083 s`);
  else check(tl0 - tl1 < 1.5, "no catch-up jump after the tab wakes", `round clock moved ${(tl0 - tl1).toFixed(2)} s across a 4 s freeze (${f1 - f0} frames during it)`);

  // 4. Start → quit → start, 5 times. Measure after each start, once play is on.
  const rows = [];
  for (let c = 1; c <= 6; c++) {
    await waitPlay(page);
    await page.waitForTimeout(500);
    const snd0 = await page.evaluate(() => ({ ...window.__sounds }));
    const ev0 = await page.evaluate(() => window.__m5log.length);
    const fps = await fpsOver(3000);
    const snd1 = await page.evaluate(() => ({ ...window.__sounds }));
    const evs = await page.evaluate((n) => window.__m5log.slice(n).map((e) => e.name), ev0);
    const cnt = (n) => evs.filter((x) => x === n).length;
    const dsnd = (n) => (snd1[n] || 0) - (snd0[n] || 0);
    const m = await metrics();
    const row = { cycle: c, bus: await busCount(), fps: Math.round(fps), heapMB: +m.heapMB.toFixed(1), nodes: m.nodes, domListeners: m.domListeners,
      pickupSnd: `${dsnd("pickup")}/${cnt("pickup")}`, bumpSnd: `${dsnd("bump")}/${cnt("bump")}` };
    rows.push(row);
    console.log("  " + JSON.stringify(row));
    if (c === 6) break;
    // Quit to the menu (Esc → Menu), then start again with Enter.
    await page.keyboard.press("Escape"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
    await page.keyboard.press("Enter");
  }
  // Sounds per event: count GO per roundStart over the whole run instead (precise).
  const goRatio = await page.evaluate(() => ({ go: window.__sounds.go || 0, starts: window.__m5log.filter((e) => e.name === "roundStart").length }));
  const first = rows[1] || rows[0], last = rows[rows.length - 1];     // row 1 = first menu-started match after warm-up
  check(last.bus <= first.bus, "event-bus listeners don't grow", `${rows.map((r) => r.bus).join(" → ")}` + (last.bus > first.bus ? ` (by name: ${JSON.stringify(await busByName())})` : ""));
  check(last.nodes <= first.nodes * 1.15 + 50, "DOM nodes don't grow", rows.map((r) => r.nodes).join(" → "));
  check(last.domListeners <= first.domListeners + 10, "DOM event listeners don't grow", rows.map((r) => r.domListeners).join(" → "));
  check(last.heapMB <= first.heapMB * 1.5 + 5, "JS heap stays flat", rows.map((r) => r.heapMB + "MB").join(" → "), true);
  check(last.fps >= first.fps * 0.8, "FPS doesn't drop", rows.map((r) => r.fps).join(" → "));
  check(goRatio.go <= goRatio.starts, "GO sound once per round start (no doubled listeners)", `${goRatio.go} GO sounds for ${goRatio.starts} roundStarts (includes menu backdrop rounds)`);
  check(!errors.length, "sweep: no page errors", errors.slice(0, 5).join(" | ") || "clean");
  await page.close();
}

(async () => {
  const browser = await launch();
  try {
    if (part === "menu-kb" || part === "all") await menuKeyboard(browser);
    if (part === "menu-pad" || part === "all") await menuPad(browser);
    if (part === "pause" || part === "all") await pauseFlow(browser);
    if (part === "sweep" || part === "all") await sweep(browser);
  } catch (e) {
    result("FAIL", "tool crashed", String(e && e.stack || e).split("\n").slice(0, 4).join(" | "));
  }
  await browser.close();
  const fails = results.filter((r) => r.level === "FAIL").length, warns = results.filter((r) => r.level === "WARN").length;
  console.log(`\n${results.length} checks: ${fails} FAIL, ${warns} WARN`);
  console.log(fails ? "RESULT: FAIL" : "RESULT: PASS");
  process.exit(fails ? 1 : 0);
})();
