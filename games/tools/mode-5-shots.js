/* =====================================================================
   mode-5-shots.js — takes screenshots of Mode 5 at phone, tablet and
   desktop sizes, so layout problems (cut-off HUD, overlapping text,
   unreadable floor) show up without a real device.

   Usage (from the games folder):
     node tools/mode-5-shots.js [outDir] [speed]
     node tools/mode-5-shots.js /tmp/m5-shots 6

   For each size (390x844 phone portrait, 844x390 phone landscape,
   1024x768 tablet, 1920x1080 desktop) it saves three pictures:
     <size>-1-menu.png       the menu (page opened with no test flags)
     <size>-2-midround.png   a bot match a few seconds into play
     <size>-3-roundend.png   the end-of-round / end-of-match screen
   The pictures go to a scratch folder (default: <system temp>/mode-5-shots).
   NEVER commit them, and never show them outside the Surprise team.

   Exit code 0 = all 12 pictures taken with no page errors.
   ===================================================================== */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch, pageUrl, collectErrors, instrumentScript, readStateInPage } = require("./mode-5-lib");

const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mode-5-shots"));
const speed = Number(process.argv[3] || 6);
const SIZES = [[390, 844], [844, 390], [1024, 768], [1920, 1080]];

// Waits (polling the match state) until test(state) is true, or gives up.
async function waitForState(page, test, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await page.evaluate(readStateInPage);
    if (s.ready && test(s)) return s;
    await page.waitForTimeout(250);
  }
  return null;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  const problems = [];
  let taken = 0;

  for (const [w, h] of SIZES) {
    const tag = `${w}x${h}`;
    // Fresh page per size so the layout is computed from scratch.
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const errors = collectErrors(page);
    await page.addInitScript(instrumentScript);

    // 1. Menu: plain page, no test flags. Give it a moment to draw.
    await page.goto(pageUrl({}));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, `${tag}-1-menu.png`) });
    taken++;

    // 2. Mid-round: a bot demo, after the countdown and a few seconds of
    //    painting (so there's paint on the floor and trails out).
    //    "In play" = a roundStart event fired and the phase isn't an end.
    await page.goto(pageUrl({ demo: true, speed, rounds: 1, time: 40 }));
    const started = await page.waitForFunction(() => (window.__m5log || []).some((e) => e.name === "roundStart"), null, { timeout: 30000 }).then(() => true, () => false);
    if (started) {
      await page.waitForTimeout(Math.max(1500, 12000 / speed)); // ~12 game seconds of paint
      await page.screenshot({ path: path.join(outDir, `${tag}-2-midround.png`) });
      taken++;
    } else problems.push(`${tag}: round never started (no roundStart event in 30 s)`);

    // 3. Round end: wait for a phase that looks like an end screen, then
    //    let the end animation (camera swoop, bars) play for a bit.
    const ended = await waitForState(page, (s) => /end/i.test(String(s.phase)), 90000);
    if (ended) {
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(outDir, `${tag}-3-roundend.png`) });
      taken++;
    } else problems.push(`${tag}: never reached a round/match end phase in 90 s`);

    if (errors.length) problems.push(`${tag}: ${errors.length} page/console error(s): ${errors.slice(0, 3).join(" | ")}`);
    await page.close();
  }

  await browser.close();
  console.log(`Saved ${taken}/${SIZES.length * 3} screenshots to ${outDir}`);
  for (const f of fs.readdirSync(outDir).filter((f) => f.endsWith(".png")).sort()) console.log("  " + f);
  if (problems.length) console.log("\nPROBLEMS:\n" + problems.join("\n"));
  const ok = !problems.length && taken === SIZES.length * 3;
  console.log(ok ? "\nRESULT: PASS" : "\nRESULT: FAIL");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("TOOL CRASHED: " + (e && e.stack || e)); process.exit(1); });
