/* =====================================================================
   turbo-party-minigame.js — runs Turbo Party minigames many times with
   4 bots, stepping the physics directly (much faster than real time),
   and reports winners, ties, lengths and errors. Good for balance
   checks and for catching crashes after a change.

   Usage (from the games folder):
     node tools/turbo-party-minigame.js <minigame-id|all> [runs] [seed]
     node tools/turbo-party-minigame.js all 10
     node tools/turbo-party-minigame.js sumo-ring 20 42

   Minigame ids: coin-rush, sumo-ring, goal-frenzy, bomb-tag,
   king-of-the-hill, ring-race (or "all").

   What it reports, per minigame:
     solo wins   runs each player won outright   [Blue, Orange, Green, Pink]
     1st ties    runs where 2–3 players tied for 1st (each counts as a
                 win in the real game, but they're shown apart here so a
                 tie doesn't look like a clean win)
     all-tie     runs where all 4 tied (the game pays 3 each, no winner)
     length      average / shortest / longest run, in game seconds
     cap hits    runs that never ended by themselves and hit the 180 s
                 safety cap (a minigame that can't finish is a bug)
     outcomes    how many different finishing orders came up. If this is
                 1 over many runs, the minigame plays out identically
                 every time (no randomness), which hides seat bias.

   Seeds: every run replaces Math.random with a small seeded generator,
   so a run can be repeated exactly. Run r of minigame m uses seed
   (seed + m*1000 + r). The seed for any odd result is printed so it can
   be replayed with a single run.

   Errors: page errors AND console.error messages are both caught.
   Exit code 0 = no errors and no cap hits.
   ===================================================================== */
const path = require("path");
const { chromium } = require("playwright");
const { BROWSER_ARGS } = require("./lib/turbo-party-checks");

const which = process.argv[2] || "all";
const runs = Number(process.argv[3] || 5);
const baseSeed = Number(process.argv[4] || 1);
const CAP_SECONDS = 180;

(async () => {
  const browser = await chromium.launch({ args: BROWSER_ARGS });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE ERROR: " + m.text()); });

  const file = "file:///" + path.resolve(__dirname, "../turbo-party/index.html").replace(/\\/g, "/");
  await page.goto(`${file}?demo&turns=1`);
  await page.waitForFunction(() => window.TP && TP.game, null, { timeout: 30000 });

  const report = await page.evaluate(({ which, runs, baseSeed, CAP_SECONDS }) => {
    // Freeze the real match so only our test arenas run.
    TP.game.update = () => {};
    TP.UI.toast = () => {};

    // mulberry32: a tiny, well-known seeded random generator. Same seed →
    // same sequence, so a run can be replayed exactly.
    const realRandom = Math.random;
    function seeded(seed) {
      let a = seed >>> 0;
      return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const defs = which === "all" ? TP.MINIGAMES : TP.MINIGAMES.filter((m) => m.id === which);
    if (!defs.length) return { error: `Unknown minigame "${which}". Known: ${TP.MINIGAMES.map((m) => m.id).join(", ")}` };
    const out = [];
    defs.forEach((def, m) => {
      const solo = [0, 0, 0, 0];
      let firstTies = 0, allTies = 0;
      const lengths = [], capHits = [], outcomes = new Set(), oddSeeds = [];
      for (let r = 0; r < runs; r++) {
        const seed = baseSeed + m * 1000 + r;
        Math.random = seeded(seed);
        let a;
        try {
          a = new def.cls(TP.game);
          a.state = "play"; // skip the countdown
          let frames = 0;
          // 1/60 s steps; stop at the mode's own end or the safety cap.
          while (a.state === "play" && frames < 60 * CAP_SECONDS) { a.update(1 / 60); frames++; }
          if (a.state === "play") capHits.push(seed);
          const ranking = TP.util.rankByScore(a.scores());
          outcomes.add(JSON.stringify(ranking));
          if (ranking.length === 1) { allTies++; oddSeeds.push(`all-tie@${seed}`); }
          else if (ranking[0].length > 1) { firstTies++; oddSeeds.push(`1st-tie@${seed}`); }
          else solo[ranking[0][0]]++;
          lengths.push(a.elapsed);
        } catch (e) {
          // Re-throw as a console error so the Node side records it, then carry on.
          console.error(`${def.id} seed ${seed}: ${e && e.stack || e}`);
        } finally {
          if (a) a.dispose();
          Math.random = realRandom;
        }
      }
      out.push({
        id: def.id, solo, firstTies, allTies, capHits, oddSeeds,
        outcomes: outcomes.size,
        avg: lengths.reduce((s, x) => s + x, 0) / (lengths.length || 1),
        min: Math.min(...lengths), max: Math.max(...lengths),
        seeds: `${baseSeed + m * 1000}–${baseSeed + m * 1000 + runs - 1}`,
      });
    });
    return { out };
  }, { which, runs, baseSeed, CAP_SECONDS });

  if (report.error) { console.log(report.error); await browser.close(); process.exit(1); }

  console.log(`Turbo Party minigames: ${runs} runs each, seeds from ${baseSeed}\n`);
  console.log("minigame           solo wins [B,O,G,P]  1st ties  all-tie  length avg/min/max (s)   cap hits  outcomes");
  console.log("-----------------  -------------------  --------  -------  -----------------------  --------  --------");
  for (const r of report.out) {
    console.log([
      r.id.padEnd(17),
      r.solo.join(", ").padEnd(19),
      String(r.firstTies).padEnd(8),
      String(r.allTies).padEnd(7),
      `${r.avg.toFixed(1)} / ${r.min.toFixed(1)} / ${r.max.toFixed(1)}`.padEnd(23),
      String(r.capHits.length).padEnd(8),
      `${r.outcomes}/${runs}`,
    ].join("  "));
  }
  // Seeds worth replaying: cap hits, ties, and fully deterministic modes.
  const notes = [];
  for (const r of report.out) {
    if (r.capHits.length) notes.push(`${r.id}: hit the ${CAP_SECONDS}s cap with seeds ${r.capHits.join(", ")}`);
    if (r.oddSeeds.length) notes.push(`${r.id}: ${r.oddSeeds.join(" ")}`);
    if (runs > 1 && r.outcomes === 1) notes.push(`${r.id}: same finishing order every run (seeds ${r.seeds}): randomness isn't reaching it`);
  }
  if (notes.length) console.log("\nNOTES (replay with: node tools/turbo-party-minigame.js <id> 1 <seed>)\n  " + notes.join("\n  "));

  const capped = report.out.some((r) => r.capHits.length);
  console.log(errors.length ? "\nERRORS:\n" + errors.join("\n") : "\nNo page or console errors.");
  console.log(!errors.length && !capped ? "RESULT: PASS" : "RESULT: FAIL");
  await browser.close();
  process.exit(errors.length || capped ? 1 : 0);
})();
