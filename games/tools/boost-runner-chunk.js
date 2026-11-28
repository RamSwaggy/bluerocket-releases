/* =====================================================================
   boost-runner-chunk.js — can a bot clear every course chunk on its own?

   The balance tool measures whole races, where a KO in a chunk can be the
   camera squeeze or a rival's bump, not the chunk itself. This tool asks
   the plain question: put ONE bot on ONE chunk, with no rivals and no
   squeeze, and see how often it gets through.

   Usage (from the games folder):
     node tools/boost-runner-chunk.js [tries] [difficulties] [chunks]
     node tools/boost-runner-chunk.js                 # 200 tries, easy,normal,hard, every chunk
     node tools/boost-runner-chunk.js 500 normal,hard
     node tools/boost-runner-chunk.js 300 hard step,gap_wide

   tries         attempts per chunk per difficulty (default 200). Each try
                 uses its own seed, so the bot's timing errors differ.
   difficulties  comma list (default easy,normal,hard)
   chunks        comma list of chunk ids (default: every pickable chunk)

   How one try works, in plain English:
     • Build a course that loops that one chunk (the `chunk` option:
       start straight, the chunk, flat, the chunk, ...). We only judge
       the FIRST copy.
     • A single bot drives from the start line. The "view" it sees is a
       roomy rectangle that just follows it, so the camera never pushes.
     • CLEARED: the car's centre gets past the chunk's far end.
       FELL:    it drops 6 units below the chunk's lowest track.
       STUCK:   no forward progress for 4 s (trapped by geometry or a bot bug).
       Every 1 in 4 tries the bot enters on boost (a full meter and the
       boost held for the run-up), because in a real race bots arrive at
       24+ when the squeeze is on, and the chunk has to work then too.

   PASS bars (JOB 3): every chunk cleared at least 80% by normal and 95%
   by hard, and no STUCK on any difficulty. Easy is reported, not judged.
   Exit code 0 = PASS, 1 = FAIL.
   ===================================================================== */
const path = require("path");
const { chromium } = require("playwright");

const tries = Number(process.argv[2] || 200);
const diffs = (process.argv[3] || "easy,normal,hard").split(",");
const only = process.argv[4] ? process.argv[4].split(",") : null;
const BARS = { normal: 80, hard: 95 };

(async () => {
  const browser = await chromium.launch({ args: ["--mute-audio"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE ERROR: " + m.text()); });
  await page.goto("file:///" + path.resolve(__dirname, "../boost-runner/sim.html").replace(/\\/g, "/"));
  await page.waitForFunction(() => window.TP && TP.BR && TP.BR.Course && TP.BR.Bot, null, { timeout: 30000 });

  const ids = only || (await page.evaluate(() => TP.BR.CHUNK_IDS.slice()));
  console.log(`Boost Runner chunk test: ${tries} tries per chunk, ${diffs.join("/")}, chunks: ${ids.join(", ")}\n`);

  const results = await page.evaluate(({ ids, diffs, tries }) => {
    const { Course, Bot, RunnerCar, RNG, hashSeed } = TP.BR;
    const T = TP.modeTuning({ bumpScale: 1.3 });
    const scene = { add() {}, remove() {} };
    const emit = () => {};
    const STEP = 1 / 60;
    const out = {};
    for (const id of ids) {
      out[id] = {};
      for (const diff of diffs) {
        const r = { cleared: 0, fell: 0, stuck: 0, examples: [] };
        for (let k = 0; k < tries; k++) {
          const seed = hashSeed("chunk-test", id, diff, k);
          const course = new Course(seed, { chunk: id });
          course.ensure(400);
          const ch = course.chunks[1];               // the first copy of the chunk
          let lowest = Infinity;
          for (const s of course.surfaces) if (s.chunk === 1) for (const p of s.pts) lowest = Math.min(lowest, p[1]);
          if (!isFinite(lowest)) lowest = Math.min(ch.y0, ch.y1);
          const car = new RunnerCar(scene, { index: 0, name: "test", color: 0xffffff, isBot: true });
          car.reset(6, 0);
          car.chunkIndex = 0;
          const bot = new Bot(car, new RNG(hashSeed(seed, "bot")), diff);
          const boosted = k % 4 === 3;                // every 4th try enters on boost
          if (boosted) car.boost = 100;
          // A roomy view that follows the car: never pushes, never KOs.
          const view = { left: -20, width: 60, dangerX: -14, bottom: lowest - 30, top: 40, right: 40, minSpeed: 0 };
          let time = 0, best = car.x, bestT = 0, result = null;
          while (!result && time < 30) {
            view.left = Math.max(view.left, car.x - 30);
            view.right = view.left + view.width;
            view.dangerX = view.left + view.width * 0.1;
            const ctx = { course, view, cars: [car], dt: STEP, T, time };
            const input = bot.think(ctx);
            // The boosted run-up: hold boost from the start line to the chunk.
            if (boosted && car.x < ch.x0) input.boost = true;
            car.step(STEP, input, course, T, emit);
            time += STEP;
            if (car.x > best + 0.5) { best = car.x; bestT = time; }
            if (car.x > ch.x1) result = "cleared";
            else if (car.y < lowest - 6) result = "fell";
            else if (time - bestT > 4) result = "stuck";
          }
          if (!result) result = "stuck";
          r[result]++;
          if (result !== "cleared" && r.examples.length < 3) {
            r.examples.push({ k, boosted, x: Math.round((car.x - ch.x0) * 10) / 10, y: Math.round(car.y * 10) / 10, result });
          }
        }
        out[id][diff] = r;
      }
    }
    return out;
  }, { ids, diffs, tries });

  // Report.
  let ok = true;
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  ${pad("chunk", 12)}` + diffs.map((d) => pad(d, 26)).join(""));
  for (const id of ids) {
    let line = `  ${pad(id, 12)}`;
    const notes = [];
    for (const d of diffs) {
      const r = results[id][d];
      const pct = (100 * r.cleared) / tries;
      const bar = BARS[d];
      let flag = "";
      if (bar !== undefined && pct < bar) { flag = " !"; ok = false; notes.push(`${d} under ${bar}%`); }
      if (r.stuck) { flag = " !"; ok = false; notes.push(`${d} STUCK x${r.stuck}`); }
      line += pad(`${pct.toFixed(1)}% (fell ${r.fell}, stuck ${r.stuck})${flag}`, 26);
      for (const e of r.examples) if (e.result === "stuck") notes.push(`${d} try ${e.k}${e.boosted ? " (boosted)" : ""}: stuck at local x=${e.x}, y=${e.y}`);
    }
    console.log(line);
    for (const n of notes) console.log(`      - ${n}`);
  }
  console.log(errors.length ? "\nERRORS:\n" + [...new Set(errors)].map((e) => "  - " + e).join("\n") : "\nNo page errors.");
  if (errors.length) ok = false;
  console.log(ok ? "RESULT: PASS (every chunk clears the bar; nothing stuck)" : "RESULT: FAIL (see above)");
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
