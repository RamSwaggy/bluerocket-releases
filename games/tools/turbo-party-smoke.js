/* =====================================================================
   turbo-party-smoke.js — plays a whole Turbo Party match with 4 bots in
   a headless browser and reports what happened.

   Usage (from the games folder):
     node tools/turbo-party-smoke.js [turns] [speed] [maxSeconds]
     node tools/turbo-party-smoke.js 3 8 240

   Prints a status line every few seconds and the final standings.
   Exit code 0 = match finished with no page errors, 1 = errors or it
   never reached the final standings.

   Needs Playwright (pre-installed in cloud sessions; on Windows run
   `npm i -g playwright` then `npx playwright install chromium` once).
   ===================================================================== */
const path = require("path");
const { chromium } = require("playwright");

const turns = Number(process.argv[2] || 3);
const speed = Number(process.argv[3] || 8);
const maxSeconds = Number(process.argv[4] || 240);

(async () => {
  // SwiftShader = software WebGL, so this works on machines with no GPU.
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE ERROR: " + m.text()); });

  const file = "file:///" + path.resolve(__dirname, "../turbo-party/index.html").replace(/\\/g, "/");
  await page.goto(`${file}?demo&turns=${turns}&speed=${speed}`);

  let finished = false;
  for (let t = 0; t < maxSeconds && !finished; t += 3) {
    await page.waitForTimeout(3000);
    const s = await page.evaluate(() => ({
      view: TP.game ? TP.game.view.constructor.name : "menu",
      card: document.getElementById("overlay").classList.contains("show") ? document.getElementById("card").innerText.split("\n")[0] : "",
      players: TP.game ? TP.game.players.map((p) => `${p.name} ${p.trophies}🏆 ${p.coins}🪙`).join(" | ") : "",
    }));
    console.log(`${String(t + 3).padStart(4)}s  ${s.view.padEnd(14)} ${s.players}`);
    if (s.card.startsWith("FINAL STANDINGS")) finished = true;
  }

  if (finished) {
    const text = await page.evaluate(() => document.getElementById("card").innerText);
    console.log("\n" + text.replace(/\n+/g, "\n"));
  }
  console.log(errors.length ? "\nERRORS:\n" + errors.join("\n") : "\nNo page errors.");
  console.log(finished ? "RESULT: PASS (match finished)" : "RESULT: FAIL (no final standings within time limit)");
  await browser.close();
  process.exit(finished && !errors.length ? 0 : 1);
})();
