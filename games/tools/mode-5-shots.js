/* =====================================================================
   mode-5-shots.js — takes screenshots of Mode 5 at phone, tablet and
   desktop sizes, so layout problems (cut-off HUD, overlapping text,
   unreadable floor, cars off screen) show up without a real device.

   Usage (from the games folder):
     node tools/mode-5-shots.js [outDir] [speed] [sizes]
     node tools/mode-5-shots.js /tmp/m5-shots 8
     node tools/mode-5-shots.js /tmp/m5-shots 8 390x844,1920x1080

   For each size (default: 390x844 phone portrait, 844x390 phone
   landscape, 1024x768 tablet, 1920x1080 desktop) it saves:
     <size>-1-menu.png        the title menu, top
     <size>-2-menu-bottom.png the title menu scrolled to the bottom
     <size>-3-play.png        a bot round in full swing
     <size>-4-pause.png       the pause overlay (Esc) during play
     <size>-5-roundend.png    the end-of-round card
     <size>-6-matchend.png    the end-of-match results card
   It also prints a few automatic layout checks per state: anything
   wider than the screen (sideways scrolling), cars outside the camera
   view, and HUD text boxes overlapping each other.
   Pictures go to a scratch folder (default <system temp>/mode-5-shots).
   NEVER commit them, and never show them outside the Surprise team.

   Exit code 0 = every picture taken with no page errors.
   ===================================================================== */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch, pageUrl, collectErrors, instrumentScript, readStateInPage } = require("./mode-5-lib");

const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mode-5-shots"));
const speed = Number(process.argv[3] || 8);
const SIZES = (process.argv[4] || "390x844,844x390,1024x768,1920x1080").split(",").map((s) => s.split("x").map(Number));
const STATES = 6;

// Waits (polling the match state) until test(state) is true, or gives up.
async function waitForState(page, test, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await page.evaluate(readStateInPage);
    if (s.ready && test(s)) return s;
    await page.waitForTimeout(200);
  }
  return null;
}
const waitEvent = (page, name, timeout) =>
  page.waitForFunction((n) => (window.__m5log || []).some((e) => e.name === n), name, { timeout }).then(() => true, () => false);

/* Automatic layout checks, run inside the page.
   - page wider than the screen → sideways scroll on phones
   - each car projected through the game camera: on screen or not
   - visible HUD/overlay text boxes that overlap each other */
function layoutChecksInPage() {
  const out = [];
  const W = innerWidth, H = innerHeight;
  if (document.documentElement.scrollWidth > W + 1) out.push(`page is ${document.documentElement.scrollWidth}px wide on a ${W}px screen (sideways scroll)`);
  // Cars vs camera (needs the world's camera; main.js keeps it private, so
  // look for it where the HUD gets it).
  const m = TP.M5 && TP.M5.match;
  const cam = TP.M5 && TP.M5.hud && TP.M5.hud.camera;
  if (m && cam && m.cars && window.THREE) {
    m.cars.forEach((c, i) => {
      const v = new THREE.Vector3(c.pos.x, c.pos.y + 0.5, c.pos.z).project(cam);
      if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || v.z > 1) out.push(`car ${i} is off screen (ndc ${v.x.toFixed(2)}, ${v.y.toFixed(2)})`);
    });
  }
  // Overlapping visible text leaves (elements with their own text).
  const els = [...document.querySelectorAll("body *")].filter((e) => {
    if (!e.childNodes.length || ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return false;
    const cs = getComputedStyle(e);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05) return false;
    let p = e; while (p) { const s = getComputedStyle(p); if (s.display === "none" || Number(s.opacity) < 0.05) return false; p = p.parentElement; }
    const r = e.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0 && r.top < H && r.left < W;
  });
  const boxes = els.map((e) => ({ e, r: e.getBoundingClientRect(), t: e.textContent.trim().slice(0, 24) }));
  const hits = [];
  for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
    const A = boxes[a], B = boxes[b];
    if (A.e.contains(B.e) || B.e.contains(A.e)) continue;
    const ix = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left);
    const iy = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
    if (ix > 4 && iy > 4) hits.push(`"${A.t}" overlaps "${B.t}"`);
  }
  if (hits.length) out.push(`text overlaps: ${hits.slice(0, 4).join("; ")}${hits.length > 4 ? ` (+${hits.length - 4} more)` : ""}`);
  // Text cut off at the screen edge.
  const cut = boxes.filter(({ r }) => r.left < -1 || r.right > W + 1).map(({ t }) => `"${t}"`);
  if (cut.length) out.push(`text past the screen edge: ${cut.slice(0, 4).join(", ")}`);
  return out;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  const problems = [];
  const notes = [];
  let taken = 0;

  for (const [w, h] of SIZES) {
    const tag = `${w}x${h}`;
    const shoot = async (page, n, name) => {
      await page.screenshot({ path: path.join(outDir, `${tag}-${n}-${name}.png`) });
      taken++;
      const issues = await page.evaluate(layoutChecksInPage);
      issues.forEach((i) => notes.push(`${tag} ${name}: ${i}`));
    };
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const errors = collectErrors(page);
    await page.addInitScript(instrumentScript);

    // 1-2. Menu: plain page (the title menu opens), top and bottom.
    await page.goto(pageUrl({}));
    await page.waitForTimeout(2000);
    await shoot(page, 1, "menu");
    await page.evaluate(() => { const s = document.querySelector(".m5m-scroll") || document.scrollingElement; s.scrollTop = s.scrollHeight; });
    await page.waitForTimeout(400);
    await shoot(page, 2, "menu-bottom");

    // 3-6. A short bot match: play, pause, round-end card, match-end card.
    await page.goto(pageUrl({ demo: true, speed, rounds: 3, time: 20 }));
    if (await waitEvent(page, "roundStart", 30000)) {
      await page.waitForTimeout(Math.max(1500, 10000 / speed * 60 / 30)); // ~10 game seconds at ~30 fps
      await shoot(page, 3, "play");
      // Pause is only armed by the menu's Start; arm it by hand for ?demo.
      await page.evaluate(() => { if (TP.M5.Pause) TP.M5.Pause.enabled = true; });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      await shoot(page, 4, "pause");
      await page.keyboard.press("Escape");
    } else problems.push(`${tag}: round never started (no roundStart event in 30 s)`);

    if (await waitEvent(page, "roundEnd", 90000)) {
      await page.waitForTimeout(1200);   // the card follows the TIME! banner
      await shoot(page, 5, "roundend");
    } else problems.push(`${tag}: no roundEnd in 90 s`);
    if (await waitForState(page, (s) => s.phase === "matchEnd", 180000)) {
      await page.waitForTimeout(1500);
      await shoot(page, 6, "matchend");
    } else problems.push(`${tag}: never reached matchEnd`);

    if (errors.length) problems.push(`${tag}: ${errors.length} page/console error(s): ${errors.slice(0, 3).join(" | ")}`);
    await page.close();
  }

  await browser.close();
  console.log(`Saved ${taken}/${SIZES.length * STATES} screenshots to ${outDir}`);
  if (notes.length) console.log("\nLAYOUT NOTES (automatic, check the pictures):\n  " + notes.join("\n  "));
  if (problems.length) console.log("\nPROBLEMS:\n  " + problems.join("\n  "));
  const ok = !problems.length && taken === SIZES.length * STATES;
  console.log(ok ? "\nRESULT: PASS" : "\nRESULT: FAIL");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("TOOL CRASHED: " + (e && e.stack || e)); process.exit(1); });
