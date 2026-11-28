/* =====================================================================
   controls-test.js: checks the Controls (rebinding) screen end to end.
   Usage (from games/):   node tools/controls-test.js

   Uses a fake gamepad (navigator.getGamepads is replaced with one we
   control) and the real keyboard, on the real hub page. Checks:
     1. The Controls screen opens from the hub button and from pad View.
     2. Keyboard rebind: Keyboard 1 Jump → K. Saved, used by the game
        input, and shown in hints (TP.keyNames).
     3. Esc cancels a rebind without changing it.
     4. Pad rebind: A picks the slot, then pressing A again binds A
        (the held press is not captured by mistake); a stick push binds
        an axis.
     5. B closes the screen; the hub menu underneath didn't react.
     6. Reset restores defaults; reload keeps saved bindings.
     7. Every mode page still loads its menu with a Controls button.
   ===================================================================== */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
function serve() {
  const srv = http.createServer((req, res) => {
    const file = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname)));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => srv.listen(0, () => ok(srv)));
}

// Fake pad: window.__pad.press(i) / release(i) / axis(i, v).
const FAKE_PAD = `
  (() => {
    const pad = { id: "Xbox Wireless Controller (STANDARD GAMEPAD)", index: 0, connected: true, mapping: "standard",
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] };
    window.__pad = {
      press: (i) => { pad.buttons[i] = { pressed: true, value: 1 }; },
      release: (i) => { pad.buttons[i] = { pressed: false, value: 0 }; },
      axis: (i, v) => { pad.axes[i] = v; },
    };
    navigator.getGamepads = () => [pad, null, null, null];
  })();`;

let failed = 0;
const check = (ok, msg) => { console.log((ok ? "  ✓ " : "  ✗ ") + msg); if (!ok) failed++; };

(async () => {
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch({ args: ["--mute-audio"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(FAKE_PAD);
  await page.addInitScript(() => { try { sessionStorage.setItem("rr.seenTitle", "1"); } catch (e) {} });
  await page.goto(base + "index.html");
  await page.waitForTimeout(800);
  const wait = (ms = 120) => page.waitForTimeout(ms);
  const tap = async (i) => { await page.evaluate((i) => __pad.press(i), i); await wait(); await page.evaluate((i) => __pad.release(i), i); await wait(); };
  const isOpen = () => page.evaluate(() => !!document.getElementById("rr-controls"));

  console.log("Controls screen");
  await page.click("[data-open-controls]");
  await wait(400);
  check(await isOpen(), "opens from the hub's Controls button");

  // --- Keyboard rebind ---
  await page.click('#rr-controls [data-tab="1"]'); await wait();
  await page.click('#rr-controls [data-bind="jump:0"]'); await wait();
  check(/Press a key/.test(await page.textContent('#rr-controls [data-bind="jump:0"]')), "slot shows 'Press a key…'");
  await page.keyboard.press("KeyK"); await wait();
  check((await page.textContent('#rr-controls [data-bind="jump:0"]')).trim() === "K", "Keyboard 1 Jump rebound to K");
  check(await page.evaluate(() => TP.keyNames("kb1").confirm === "K"), "hints follow the new binding");
  check(await page.evaluate(() => JSON.parse(localStorage.getItem("rumble.controls.v1")).kb1.bindings.jump[0].code === "KeyK"), "saved to localStorage");
  await page.keyboard.down("KeyK");
  check(await page.evaluate(() => { TP.Input.poll(); return TP.Input.get("kb1").jump; }), "game input reads K as Jump");
  await page.keyboard.up("KeyK");

  await page.click('#rr-controls [data-bind="hit:0"]'); await wait();
  await page.keyboard.press("Escape"); await wait();
  check((await page.textContent('#rr-controls [data-bind="hit:0"]')).trim() === "E", "Esc cancels a rebind (Hit stays E)");
  check(await isOpen(), "…and Esc during a rebind doesn't close the screen");

  // --- Pad rebind (driven only by the fake pad) ---
  await tap(4); // LB: previous tab → Controller
  check(await page.evaluate(() => document.querySelector("#rr-controls .tab.on").textContent === "Controller"), "LB switches tab");
  await page.evaluate(() => document.querySelector('#rr-controls [data-bind="heavy:0"]').focus());
  await tap(0);  // A picks the slot
  await wait(150);
  check(/Press a button/.test(await page.textContent('#rr-controls [data-bind="heavy:0"]')), "A on a slot starts listening");
  await tap(0);  // A again: should bind A, not be swallowed
  check((await page.textContent('#rr-controls [data-bind="heavy:0"]')).trim() === "A", "pressing A binds A (held press not captured early)");
  check(await isOpen(), "binding A didn't also click something");
  await page.evaluate(() => document.querySelector('#rr-controls [data-bind="boost:1"]').focus());
  await tap(0); await wait(150);
  await page.evaluate(() => __pad.axis(3, 0.9)); await wait(); await page.evaluate(() => __pad.axis(3, 0)); await wait();
  check((await page.textContent('#rr-controls [data-bind="boost:1"]')).trim() === "Right Stick Down", "a stick push binds an axis");
  // Park the highlight on the current tab so pressing A for the input
  // checks below just re-selects that tab (instead of starting a rebind).
  await page.evaluate(() => document.querySelector('#rr-controls [data-tab="0"]').focus());
  await page.evaluate(() => __pad.press(3)); await wait();
  check(await page.evaluate(() => { TP.Input.poll(); return TP.Input.get("pad0").heavy === false; }), "old Heavy button (Y) no longer fires Heavy");
  await page.evaluate(() => { __pad.release(3); __pad.press(0); }); await wait();
  check(await page.evaluate(() => { TP.Input.poll(); return TP.Input.get("pad0").heavy === true; }), "new Heavy button (A) fires Heavy");
  await page.evaluate(() => __pad.release(0)); await wait();

  // --- Reset ---
  await page.click("#rr-controls [data-reset]"); await wait();
  check((await page.textContent('#rr-controls [data-bind="heavy:0"]')).trim() === "Y", "Reset Controller restores Y for Heavy");

  // --- Close with B; hub underneath must not react ---
  const hubBefore = await page.evaluate(() => [...document.querySelectorAll("#slots select")].map((s) => s.value).join());
  await tap(1);
  check(!(await isOpen()), "B closes the screen");
  const hubAfter = await page.evaluate(() => [...document.querySelectorAll("#slots select")].map((s) => s.value).join());
  check(hubBefore === hubAfter && page.url().endsWith("index.html"), "hub underneath didn't react to presses made in the screen");
  check(/K/.test(await page.textContent("#keys")), "hub's controls table shows the rebound key");

  // --- View opens it; reload keeps bindings ---
  await tap(8);
  check(await isOpen(), "pad View button opens Controls from a menu");
  await tap(1);
  await page.reload(); await wait(800);
  check(await page.evaluate(() => TP.keyNames("kb1").confirm === "K"), "bindings survive a reload");

  // --- Every mode menu has the button ---
  for (const m of ["turbo-party", "deflect-duel", "car-fighter"]) {
    await page.goto(base + m + "/index.html"); await wait(1500);
    await page.keyboard.press("KeyZ"); await wait(600);
    const has = await page.evaluate(() => !!document.querySelector("[data-open-controls]"));
    check(has, `${m}: menu has a Controls button`);
    if (has) { await page.click("[data-open-controls]"); await wait(400); check(await isOpen(), `${m}: Controls screen opens`); await page.keyboard.press("Escape"); await wait(); check(!(await isOpen()), `${m}: Esc closes it`); }
  }

  check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""));
  await browser.close();
  srv.close();
  console.log(failed ? `\nRESULT: FAIL (${failed})` : "\nRESULT: PASS");
  process.exit(failed ? 1 : 0);
})();
