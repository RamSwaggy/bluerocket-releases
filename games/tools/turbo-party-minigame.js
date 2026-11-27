/* =====================================================================
   turbo-party-minigame.js — runs ONE Turbo Party minigame many times
   with 4 bots, stepping the physics directly (much faster than real
   time), and reports winners, lengths and errors. Good for balance
   checks and for catching crashes after a change.

   Usage (from the games folder):
     node tools/turbo-party-minigame.js <minigame-id> [runs]
     node tools/turbo-party-minigame.js ring-race 10
     node tools/turbo-party-minigame.js all 3

   Minigame ids: coin-rush, sumo-ring, goal-frenzy, bomb-tag,
   king-of-the-hill, ring-race (or "all").
   Exit code 0 = every run finished with no errors.
   ===================================================================== */
const path = require("path");
const { chromium } = require("playwright");

const which = process.argv[2] || "all";
const runs = Number(process.argv[3] || 5);

(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"] });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));

  const file = "file:///" + path.resolve(__dirname, "../turbo-party/index.html").replace(/\\/g, "/");
  await page.goto(`${file}?demo&turns=1`);
  await page.waitForFunction(() => window.TP && TP.game, null, { timeout: 30000 });

  const report = await page.evaluate(({ which, runs }) => {
    // Freeze the real match so only our test arenas run.
    TP.game.update = () => {};
    TP.UI.toast = () => {};
    const defs = which === "all" ? TP.MINIGAMES : TP.MINIGAMES.filter((m) => m.id === which);
    if (!defs.length) return { error: `Unknown minigame "${which}". Known: ${TP.MINIGAMES.map((m) => m.id).join(", ")}` };
    const out = [];
    for (const def of defs) {
      const wins = [0, 0, 0, 0];
      const lengths = [];
      for (let r = 0; r < runs; r++) {
        const a = new def.cls(TP.game);
        a.state = "play";
        let frames = 0;
        // 1/60 s steps; stop at the mode's own end or 3 minutes as a safety net.
        while (a.state === "play" && frames < 60 * 180) { a.update(1 / 60); frames++; }
        const ranking = TP.util.rankByScore(a.scores());
        ranking[0].forEach((i) => wins[i]++);
        lengths.push(a.elapsed);
        a.dispose();
      }
      out.push({ id: def.id, wins, avgSeconds: lengths.reduce((s, x) => s + x, 0) / lengths.length, maxSeconds: Math.max(...lengths) });
    }
    return { out };
  }, { which, runs });

  if (report.error) { console.log(report.error); process.exit(1); }
  for (const r of report.out) {
    console.log(`${r.id.padEnd(18)} wins by player [Blue, Orange, Green, Pink]: ${r.wins.join(", ")}   avg ${r.avgSeconds.toFixed(1)}s, longest ${r.maxSeconds.toFixed(1)}s`);
  }
  console.log(errors.length ? "\nERRORS:\n" + errors.join("\n") : "\nNo page errors.");
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
