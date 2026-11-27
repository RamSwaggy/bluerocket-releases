/* =====================================================================
   mode-5-probe.js — plays Mode 5 as a HUMAN would: real key presses on
   keyboard 1 (WASD + Space + Shift), sent through Playwright, against
   three bots. Checks the things a bot-only smoke test can't:

     A. a human can drive out of their turf (a wet trail starts),
        loop back in, and get a `fill` (the signature mechanic works
        from real input, not just from bot controls);
     B. bots actually go for a human's trail: the human parks outside
        their turf with a wet trail, and a bot should pop it.

   Usage (from the games folder):
     node tools/mode-5-probe.js [maxPopWaitSeconds] [side]
     node tools/mode-5-probe.js 45 10

   `side` is the size of the square loop the human drives, in world
   units (default 10, about 7–8 paint cells).

   How the human seat is set up: the saved Rocket Rumble setup is
   written into localStorage before the page loads (seat 1 = "kb1",
   seats 2–4 = "bot"), then the page is opened with
   ?demo&human=1&speed=1&rounds=1&time=90. `human=1` asks main.js to
   skip the menu but keep seat 1 human (test hook requested from
   Gameplay). If the page ignores it and shows the menu, the probe tries
   to start the match itself (clicks a Start/Play button or presses
   Space/Enter).

   Assumption from DESIGN.md: event payload `player` / `victim` / `by`
   is the index into TP.M5.match.players (0 = seat 1).

   Exit code 0 = A and B both passed with no page errors.
   ===================================================================== */
const { launch, pageUrl, collectErrors, instrumentScript, readStateInPage } = require("./mode-5-lib");

const maxPopWait = Number(process.argv[2] || 45);
const SIDE = Number(process.argv[3] || 10);
const SETUP_KEY = "rocketRumble.setup.v1"; // see shared/js/rumble.js

const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = collectErrors(page);
  await page.addInitScript(instrumentScript);
  // Seat 1 human on keyboard 1, the rest bots. Runs before the game loads.
  await page.addInitScript(({ key }) => {
    try {
      localStorage.setItem(key, JSON.stringify({ slots: [
        { name: "Probe", controller: "kb1" }, { name: "Orange", controller: "bot" },
        { name: "Green", controller: "bot" }, { name: "Pink", controller: "bot" }] }));
    } catch (e) { /* storage blocked: the game falls back to its default, which is also kb1 + bots */ }
  }, { key: SETUP_KEY });

  await page.goto(pageUrl({ demo: true, human: 1, speed: 1, rounds: 1, time: 90 }));

  /* ---------- Keyboard helper ----------
     Keeps track of which keys are held so we only send real changes,
     exactly like a person pressing and releasing keys. */
  const held = new Set();
  async function setKeys(want) {
    for (const k of [...held]) if (!want.includes(k)) { await page.keyboard.up(k); held.delete(k); }
    for (const k of want) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
  }
  const state = () => page.evaluate(readStateInPage);
  const events = () => page.evaluate(() => window.__m5log);

  /* ---------- Get into a round ---------- */
  let inRound = await page.waitForFunction(() => (window.__m5log || []).some((e) => e.name === "roundStart"), null, { timeout: 15000 }).then(() => true, () => false);
  if (!inRound) {
    // Menu fallback: click anything that looks like a start button, else press confirm keys.
    console.log("No round after 15 s (hook ?human=1 not supported?). Trying to start from the menu...");
    const btn = page.locator("button, [role=button], .btn").filter({ hasText: /start|play|go/i }).first();
    if (await btn.count()) await btn.click().catch(() => {});
    else { await page.keyboard.press("Enter"); await page.keyboard.press("Space"); }
    inRound = await page.waitForFunction(() => (window.__m5log || []).some((e) => e.name === "roundStart"), null, { timeout: 20000 }).then(() => true, () => false);
  }

  const results = [];
  const result = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`); };

  if (!inRound) {
    result("setup", false, "could not get into a round (no roundStart event)");
  } else {
    let s = await state();
    // Which seat is the human? The one on kb1, else seat 1.
    let hi = s.players.findIndex((p) => p.controller === "kb1");
    if (hi < 0) hi = 0;
    const me = () => s.players[hi];
    console.log(`Human is player index ${hi} (${me().name || "?"}) at (${me().x.toFixed(1)}, ${me().z.toFixed(1)}), heading ${me().heading.toFixed(2)}`);
    if (!Number.isFinite(me().x) || !Number.isFinite(me().heading)) {
      result("setup", false, "can't read the human car's pos/heading from TP.M5.match.players[i].car");
    } else {
      /* ---------- A. Drive out, loop back, fill ----------
         Drive a square: forward SIDE, then right SIDE, then back past the
         start into our own pad. Steering is closed-loop on the car's real
         position, but only ever through W/A/D key presses. */
      const p0 = { x: me().x, z: me().z };
      const h0 = me().heading;
      const f = { x: Math.sin(h0), z: Math.cos(h0) };   // car forward (see car.js)
      const r = { x: -f.z, z: f.x };                     // car right-hand side
      const pt = (a, b) => ({ x: p0.x + f.x * a + r.x * b, z: p0.z + f.z * a + r.z * b });
      // The last two points run back over the spawn spot and a bit past it, so the
      // car ends up well inside its own starting pad (where the loop closes).
      const waypoints = [pt(SIDE, 0), pt(SIDE, SIDE), pt(0, SIDE), pt(0, 0), pt(-2, 0)];
      let fills = [];
      let maxDist = 0;
      for (let attempt = 1; attempt <= 3 && !fills.length; attempt++) {
        const tStart = Date.now();
        let wi = 0;
        while (wi < waypoints.length && Date.now() - tStart < 25000) {
          s = await state();
          const c = me();
          maxDist = Math.max(maxDist, Math.hypot(c.x - p0.x, c.z - p0.z));
          const w = waypoints[wi];
          const dx = w.x - c.x, dz = w.z - c.z;
          if (Math.hypot(dx, dz) < 2.5) { wi++; continue; }
          // steer +1 (D) lowers heading in car.js, so a positive error needs A.
          const err = wrap(Math.atan2(dx, dz) - c.heading);
          const keys = ["KeyW"];
          if (err > 0.12) keys.push("KeyA"); else if (err < -0.12) keys.push("KeyD");
          await setKeys(keys);
          await page.waitForTimeout(40);
        }
        await setKeys([]);
        await page.waitForTimeout(800); // let the fill resolve
        const log = await events();
        fills = log.filter((e) => e.name === "fill" && e.data && e.data.player === hi);
        const trails = log.filter((e) => e.name === "trailStart" && e.data && e.data.player === hi);
        console.log(`  attempt ${attempt}: reached ${wi}/${waypoints.length} waypoints, max ${maxDist.toFixed(1)} units from spawn, trailStart ${trails.length}, fills ${fills.length}`);
        if (!fills.length) {
          // Drive back to the spawn pad before trying again.
          waypoints.unshift(pt(0, 0));
        }
      }
      const log = await events();
      result("A1 human can drive out (wet trail starts)", log.some((e) => e.name === "trailStart" && e.data && e.data.player === hi) && maxDist > 5,
        `max ${maxDist.toFixed(1)} units from spawn; trailStart from human: ${log.filter((e) => e.name === "trailStart" && e.data && e.data.player === hi).length}`);
      result("A2 human loop back gives a fill", fills.length > 0,
        fills.length ? `fill ${JSON.stringify(fills[0].data)}` : `no fill for player ${hi}; fill players seen: ${[...new Set(log.filter((e) => e.name === "fill").map((e) => e.data && e.data.player))].join(",") || "none"}`);

      /* ---------- B. Park outside turf, wait for a bot to pop us ----------
         Drive straight out ~2 s, brake to a stop, then sit still. Trails
         dry after 6 s, so every 4.5 s we creep forward briefly to keep a
         fresh wet trail out (otherwise there'd be nothing to pop). */
      const popsBefore = (await events()).filter((e) => e.name === "pop" && e.data && e.data.victim === hi).length;
      await setKeys(["KeyW"]); await page.waitForTimeout(1800);
      await setKeys(["KeyS"]); await page.waitForTimeout(350);
      await setKeys([]);
      const tPark = Date.now();
      let lastCreep = Date.now();
      let pop = null;
      while (!pop && (Date.now() - tPark) / 1000 < maxPopWait) {
        await page.waitForTimeout(250);
        const myPops = (await events()).filter((e) => e.name === "pop" && e.data && e.data.victim === hi);
        if (myPops.length > popsBefore) pop = myPops[myPops.length - 1];
        if (Date.now() - lastCreep > 4500) {
          await setKeys(["KeyW"]); await page.waitForTimeout(400);
          await setKeys(["KeyS"]); await page.waitForTimeout(200);
          await setKeys([]);
          lastCreep = Date.now();
        }
        s = await state();
        if (/end/i.test(String(s.phase))) break; // round over
      }
      const waited = (Date.now() - tPark) / 1000;
      result("B  a bot pops a parked human's trail", !!pop,
        pop ? `popped by player ${pop.data.by} after ${waited.toFixed(1)} s` : `no pop on player ${hi} in ${waited.toFixed(1)} s (phase ${s.phase})`);
    }
  }

  await setKeys([]);
  result("no page/console errors", !errors.length, errors.length ? `${errors.length}:\n  ` + errors.slice(0, 20).join("\n  ") : "clean");
  const ok = results.every((x) => x.ok);
  console.log(ok ? "\nRESULT: PASS" : "\nRESULT: FAIL");
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("TOOL CRASHED: " + (e && e.stack || e)); process.exit(1); });
