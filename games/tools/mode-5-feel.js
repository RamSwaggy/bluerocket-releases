/* =====================================================================
   mode-5-feel.js — plays Mode 5 as a human (real key presses on
   keyboard 1, in real time) and measures how the core loop FEELS:
   risk versus reward of going out, the dry timer, pop fairness.

   Usage (from the games folder):
     node tools/mode-5-feel.js [bot] [loopsPerSize] [sizes]
     node tools/mode-5-feel.js hard 3 8,14,20,28

   What it does, in one real-time match (?demo&human=1, 240 s round):
     1. Loops: for each size S, drive a rectangle out of the home pad
        (12 units forward × S units to the side) and back, loopsPerSize
        times. Per loop it records: seconds out, trail cells, the fill
        (cells and %), score change, and whether a bot popped us (who,
        how many trail cells, minor or a real stun).
     2. Dry timer: drive out ~1.5 s, park, and time how long until the
        trail dries by itself (`dry` event), versus CFG.trailDry.
     3. Tiny-trail pop: does a pop on a trail under CFG.minPop cells
        come with minor:true and no stun, and a big one with a stun?
   Prints a table plus a short summary. It measures; you judge. There is
   no PASS/FAIL except for page errors and "no human seat".
   ===================================================================== */
const { launch, pageUrl, collectErrors, instrumentScript, readStateInPage } = require("./mode-5-lib");

const bot = process.argv[2] || "hard";
const perSize = Number(process.argv[3] || 3);
const SIZES = (process.argv[4] || "8,14,20,28").split(",").map(Number);
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = collectErrors(page);
  await page.addInitScript(instrumentScript);
  await page.addInitScript(() => {
    try { localStorage.setItem("rocketRumble.setup.v1", JSON.stringify({ slots: [
      { name: "Probe", controller: "kb1" }, { name: "Orange", controller: "bot" },
      { name: "Green", controller: "bot" }, { name: "Pink", controller: "bot" }] })); } catch (e) { /* ignore */ }
  });
  await page.goto(pageUrl({ demo: true, human: 1, rounds: 1, time: 240, bot }));
  await page.waitForFunction(() => window.TP && TP.M5.match && TP.M5.match.phase === "play", null, { timeout: 30000 });

  const held = new Set();
  const setKeys = async (want) => {
    for (const k of [...held]) if (!want.includes(k)) { await page.keyboard.up(k); held.delete(k); }
    for (const k of want) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
  };
  const state = () => page.evaluate(readStateInPage);
  const cfg = await page.evaluate(() => ({ dry: TP.M5.CFG.trailDry, minPop: TP.M5.CFG.minPop, minFill: TP.M5.CFG.minFill, stun: TP.M5.CFG.stunTime }));
  let s = await state();
  const hi = s.players.findIndex((p) => p.controller === "kb1");
  if (hi < 0) { console.log("FAIL  no seat on kb1: not a human game"); await browser.close(); process.exit(1); }
  const home = { x: s.players[hi].x, z: s.players[hi].z, h: s.players[hi].heading };
  const f = { x: Math.sin(home.h), z: Math.cos(home.h) }, r = { x: -f.z, z: f.x };
  const pt = (a, b) => ({ x: home.x + f.x * a + r.x * b, z: home.z + f.z * a + r.z * b });
  const logLen = () => page.evaluate(() => window.__m5log.length);
  const logFrom = (n) => page.evaluate((n) => window.__m5log.slice(n), n);
  const ex = () => page.evaluate((hi) => { const m = TP.M5.match; return { wet: m.grid.wetCount ? m.grid.wetCount[hi] : null, stun: m.cars[hi].stun || 0, phase: m.phase }; }, hi);
  console.log(`Human seat ${hi}, bots ${bot}. CFG: trailDry ${cfg.dry}s, minPop ${cfg.minPop}, minFill ${cfg.minFill}, stun ${cfg.stun}s`);

  // Drive through waypoints with W + A/D; returns { secs, maxWet, reached }.
  async function drive(points, timeoutMs) {
    const t0 = Date.now();
    let wi = 0, maxWet = 0;
    while (wi < points.length && Date.now() - t0 < timeoutMs) {
      s = await state();
      if (s.phase !== "play") break;
      const c = s.players[hi];
      const w = points[wi];
      const dx = w.x - c.x, dz = w.z - c.z;
      if (Math.hypot(dx, dz) < 2.5) { wi++; continue; }
      const err = wrap(Math.atan2(dx, dz) - c.heading);
      await setKeys(["KeyW", ...(err > 0.12 ? ["KeyA"] : err < -0.12 ? ["KeyD"] : [])]);
      const e = await ex(); maxWet = Math.max(maxWet, e.wet || 0);
      await page.waitForTimeout(40);
    }
    await setKeys([]);
    return { secs: (Date.now() - t0) / 1000, maxWet, reached: wi };
  }

  /* ---------- 1. Loops of growing size ---------- */
  const rows = [];
  outer: for (const S of SIZES) {
    for (let k = 0; k < perSize; k++) {
      const n0 = await logLen();
      const pct0 = (await state()).scores[hi];
      const d = await drive([pt(12, 0), pt(12, S), pt(0, S), pt(0, 0), pt(-2, 0)], 30000);
      await page.waitForTimeout(400);
      const ev = await logFrom(n0);
      const pct1 = (await state()).scores[hi];
      const fills = ev.filter((e) => e.name === "fill" && e.data.player === hi && !e.data.small);
      const pops = ev.filter((e) => e.name === "pop" && e.data.victim === hi);
      const row = { S, secs: +d.secs.toFixed(1), reached: `${d.reached}/5`, trail: d.maxWet,
        fill: fills.length ? `${fills.reduce((a, e) => a + e.data.cells, 0)} cells +${fills.reduce((a, e) => a + e.data.pct, 0).toFixed(1)}%` : "-",
        score: `${pct0.toFixed(1)}→${pct1.toFixed(1)}`,
        popped: pops.map((e) => `by ${e.data.by} (${e.data.cells} cells${e.data.minor ? ", minor" : ""})`).join("; ") || "-" };
      rows.push(row);
      console.log(`  loop S=${String(S).padStart(2)}  ${row.secs}s out  reached ${row.reached}  trail ${row.trail}  fill ${row.fill}  score ${row.score}  popped ${row.popped}`);
      if ((await ex()).phase !== "play") break outer;
    }
  }

  /* ---------- 2. Dry timer ---------- */
  // Head out away from home into open floor, park, wait.
  const n0 = await logLen();
  await drive([pt(0, 0)], 8000);
  await setKeys(["KeyW"]); await page.waitForTimeout(900); await setKeys(["KeyS"]); await page.waitForTimeout(300); await setKeys([]);
  const tPark = Date.now();
  const wetAtPark = (await ex()).wet;
  let dry = null, popped = null;
  while (Date.now() - tPark < (cfg.dry + 4) * 1000) {
    const ev = await logFrom(n0);
    dry = ev.find((e) => e.name === "dry" && e.data.player === hi);
    popped = ev.find((e) => e.name === "pop" && e.data.victim === hi && e.t > 0);
    if (dry || popped) break;
    await page.waitForTimeout(100);
  }
  const waited = (Date.now() - tPark) / 1000;
  console.log(`  dry test: parked with ${wetAtPark} wet cells; ` + (dry ? `dried by itself after ${waited.toFixed(1)} s (CFG ${cfg.dry} s; trail age counts from when it started, so a bit less is expected)`
    : popped ? `popped by ${popped.data.by} after ${waited.toFixed(1)} s before it could dry` : `no dry event within ${waited.toFixed(1)} s`));

  /* ---------- 3. Pop fairness, from everything that happened ---------- */
  const all = await page.evaluate(() => window.__m5log);
  const myPops = all.filter((e) => e.name === "pop" && e.data.victim === hi);
  const minorBad = myPops.filter((e) => (e.data.cells < cfg.minPop) !== !!e.data.minor);
  console.log(`  pops on the human: ${myPops.length} (${myPops.filter((e) => e.data.minor).length} minor). ` +
    `Trail sizes: ${myPops.map((e) => e.data.cells + (e.data.minor ? "m" : "")).join(", ") || "-"}` +
    (minorBad.length ? `  MISMATCH minor flag vs minPop on ${minorBad.length}` : ""));
  const allPops = all.filter((e) => e.name === "pop");
  console.log(`  all pops in the match: ${allPops.length}, minor ${allPops.filter((e) => e.data.minor).length}; sizes ${allPops.map((e) => e.data.cells).join(",")}`);

  /* ---------- Summary per size ---------- */
  console.log("\nPer loop size (12 × S units):");
  for (const S of SIZES) {
    const rs = rows.filter((x) => x.S === S);
    if (!rs.length) continue;
    const gains = rs.map((x) => { const [a, b] = x.score.split("→").map(Number); return b - a; });
    console.log(`  S=${String(S).padStart(2)}: ${rs.length} loops, avg ${(rs.reduce((a, x) => a + x.secs, 0) / rs.length).toFixed(1)} s out, ` +
      `avg score gain ${(gains.reduce((a, b) => a + b, 0) / gains.length).toFixed(1)} pts, popped ${rs.filter((x) => x.popped !== "-").length}/${rs.length}`);
  }
  await setKeys([]);
  console.log(errors.length ? "\nERRORS:\n" + errors.join("\n") : "\nNo page errors.");
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error("TOOL CRASHED: " + (e && e.stack || e)); process.exit(1); });
