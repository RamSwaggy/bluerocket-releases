/* =====================================================================
   deflect-duel-rules.js — scripted rule tests for Deflect Duel.

   Each test sets up an exact situation (cars and ball placed by hand,
   bots switched off, buttons pressed by the script), steps the game in
   fixed 1/60 s steps, and checks one rule with real numbers. Where the
   smoke test asks "does a whole match run without breaking?", these ask
   "does each rule do exactly what Reece decided?".

   Usage (from the games folder):
     node tools/deflect-duel-rules.js            run every test
     node tools/deflect-duel-rules.js ownership  run one (or a comma list)
     node tools/deflect-duel-rules.js list       show the test names

   Tests:
     ownership     hitter becomes owner; own ball is harmless; a touch
                   costs anyone else exactly 1 life; ball re-serves at
                   the centre; no second KO while invulnerable
     speed-steps   first hit = base speed; each later hit faster, never
                   over the cap; two cars hitting on one frame = one hit;
                   Smash adds more and costs boost; a miss starts a
                   cooldown; reach ~3.6; steering bends the hit ~25°
     hit-freeze    a hit pauses play; faster ball = longer pause; nothing
                   moves during it; pause stays short
     jump-dodge    an airborne car isn't KO'd by a ball passing under it
                   (and the same ball DOES KO a grounded car)
     ko-respawn    about 2 s invulnerability after respawn; 0 lives = out
                   and match over; double KO = last hitter wins
     stalemate     12 s without a hit = neutral serve, with no slowing
                   down first; a hit restarts the 12 s count
     pillars       with pillars on, the ball bounces off and never sits
                   inside one; with them off, it passes straight through
     car-feel      car tuning is TP.modeTuning({ pivot: 0.8 }) and
                   nothing else; cars top out at 17 (27 boosting)
     rocket-rumble the hub's saved setup fills the menu ("off" = empty
                   seat), Start saves it back, broken storage falls back
                   to defaults, "← All modes" goes to the hub, rematch
                   resets everything
     v2-*          PLANNED v2 checks (box, owned flight, bump, strike
                   angles, flip reset, clash, 3D dodge, tunnelling,
                   freeze vs stalemate): report SKIP with their plan
                   until v2 Stage A lands

   Test interface used (the real game's names; only needed with ?test):
     TP.duelTest.newMatch({players, lives, pillars})  (makes a NEW TP.duel)
     TP.duel.update(dt), .paused, .cfg (this match's DUEL_CFG copy),
     .setInput(i, ctrl), .setBot(i, on), .placeCar(i, {x,z}, heading),
     .setBall({pos, vel, owner}), .tuning (or players[i].tuning / .car.tuning)
     TP.duel.players[i] { lives, out, invuln, pos, airborne, kos, car }
     TP.duel.ball { pos, vel, speed, owner, neutral }, .freezeLeft,
     .state, .winner, .koLog[{ t, victim, owner, speed }]
     TP.DUEL_CFG numbers: baseSpeed, speedStep, maxSpeed, hitRange,
     swingTime, missCooldown, aimBendDeg, freezeMin/Max, stalemateTime,
     respawnDelay, respawnInvuln, jumpClear, ballR, pillarList (missing
     ones fall back to the design values and the report says so)
     Heading: 0 = nose along +Z, steer +1 lowers the heading (turns right),
     as in shared/js/car.js and duel.js _hit().

   Exit code 0 = every test passed (or was skipped with a reason),
   1 = something failed. Every failure line says what was expected and
   what actually happened.

   Test hooks: DEFLECT_DUEL_INDEX=/path/to/index.html tests another copy
   (e.g. tools/fixtures/deflect-duel-mock/index.html), and
   DEFLECT_DUEL_QUERY=mockbug=nocap adds URL parameters.
   ===================================================================== */
const fs = require("fs");
const path = require("path");
const { pathToFileURL, fileURLToPath } = require("url");
const { chromium } = require("playwright");

const GAMES_DIR = path.resolve(__dirname, "..");
const indexFile = path.resolve(process.env.DEFLECT_DUEL_INDEX || path.join(GAMES_DIR, "deflect-duel/index.html"));
const extraQuery = process.env.DEFLECT_DUEL_QUERY ? "&" + process.env.DEFLECT_DUEL_QUERY : "";
const HUB_FILE = path.join(GAMES_DIR, "index.html");
const SETUP_KEY = "rocketRumble.setup.v1";

/* =====================================================================
   In-page helpers. This string is added to the page as a script, so the
   test functions below can call window.QC.*. Everything here only uses
   the agreed interface.
   ===================================================================== */
const HELPERS = String.raw`
window.QC = (function () {
  const DT = 1 / 60;
  const d = () => TP.duel;
  // Agreed design values, used only when DUEL_CFG doesn't expose one.
  const DESIGN = { maxSpeed: null, baseSpeed: null, hitRange: 3.6, swingTime: 0.28, missCooldown: 0.5,
                   aimBendDeg: 25, stalemateTime: 12, respawnInvuln: 2, freezeMax: 0.3, jumpClear: 1.0, ballR: 0.8 };
  const notes = [];      // "used a fallback value" notes for the report

  // The real game's names come first; the names from QC's first plan
  // (and the QC mock) are accepted too.
  const ALIASES = { hitRange: ["hitReach"], swingTime: ["hitWindow"], missCooldown: ["hitCooldown"],
                    respawnInvuln: ["invulnTime"], ballR: ["ballRadius"], jumpClear: [] };
  function cfg(key) {
    const C = (d() && d().cfg) || TP.DUEL_CFG || {};   // the match's own copy if it has one
    for (const k of [key].concat(ALIASES[key] || [])) if (typeof C[k] === "number") return C[k];
    if (DESIGN[key] === null || DESIGN[key] === undefined) return undefined;
    const msg = "DUEL_CFG." + key + " not exposed, used design value " + DESIGN[key];
    if (!notes.includes(msg)) notes.push(msg);
    return DESIGN[key];
  }

  const HOOKS = ["update", "setInput", "setBot", "placeCar", "setBall"];
  // newMatch is TP.duelTest.newMatch in the real game (only in ?demo/?test).
  const newMatchFn = () => (window.TP.duelTest && typeof TP.duelTest.newMatch === "function" ? (o) => TP.duelTest.newMatch(o)
    : d() && typeof d().newMatch === "function" ? (o) => d().newMatch(o) : null);
  function missingHooks() {
    const m = HOOKS.filter((h) => typeof (d() && d()[h]) !== "function");
    if (!newMatchFn()) m.push("newMatch (TP.duelTest.newMatch)");
    return m;
  }

  const xz = (p) => (Array.isArray(p) ? { x: p[0], y: p[1] || 0, z: p[2] } : { x: p.x, y: p.y || 0, z: p.z });
  const dist2 = (a, b) => { a = xz(a); b = xz(b); return Math.hypot(a.x - b.x, a.z - b.z); };
  const fwd = (h) => ({ x: Math.sin(h), z: Math.cos(h) });           // car nose: +Z at heading 0
  const vlen = (v) => { v = xz(v); return Math.hypot(v.x, v.z); };
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const deg = (r) => r * 180 / Math.PI;

  // Who is this? koLog / owner / winner may be an index, a name or a player object.
  function idx(who) {
    if (who === null || who === undefined) return null;
    if (typeof who === "number") return who;
    const ps = d().players;
    if (typeof who === "string") return ps.findIndex((p) => p.name === who);
    if (typeof who === "object") return who.index !== undefined ? who.index : ps.indexOf(who) >= 0 ? ps.indexOf(who) : ps.findIndex((p) => p.name === who.name);
    return null;
  }
  const P = (i) => d().players[i];
  const heading = (i) => (P(i).car && typeof P(i).car.heading === "number" ? P(i).car.heading : P(i).heading);
  const owner = () => (d().ball.neutral ? null : idx(d().ball.owner));
  const ballSpeed = () => d().ball.speed;
  const boostOf = (i) => (P(i).car && typeof P(i).car.boost === "number" ? P(i).car.boost : undefined);

  function step(sec, each) { const n = Math.round(sec / DT); for (let k = 0; k < n; k++) { d().update(DT); if (each) each(k * DT); } }
  // Step until pred() is true. Returns seconds taken, or null if it never was.
  function stepUntil(pred, maxSec, each) {
    for (let t = 0; t <= maxSec + 1e-9; t += DT) { if (pred()) return t; d().update(DT); if (each) each(t); }
    return pred() ? maxSec : null;
  }

  // A clean, script-controlled match: bots off, no buttons held, cars parked
  // in the corners, the opening serve finished so the ball can be hit.
  const PARK = [{ x: -18, z: -11 }, { x: 18, z: 11 }, { x: -18, z: 11 }, { x: 18, z: -11 }];
  function fresh(opts) {
    const o = Object.assign({ players: 2, lives: 3, pillars: false }, opts || {});
    if (d()) d().paused = true;
    newMatchFn()(o);                // the real game makes a brand-new TP.duel here
    d().paused = true;
    d().players.forEach((p, i) => { d().setBot(i, false); d().setInput(i, {}); park(i); });
    stepUntil(() => d().state === "play", 10);   // 3-2-1 countdown, then the serve
    return d();
  }
  function park(i) { d().placeCar(i, PARK[i], 0); }
  function place(i, x, z, h) { d().placeCar(i, { x, z }, h); }
  // Put the ball a set distance in front of car i.
  function ballInFront(i, distance, vel, own) {
    const c = xz(P(i).pos), f = fwd(heading(i));
    d().setBall({ pos: { x: c.x + f.x * distance, y: 0, z: c.z + f.z * distance }, vel: vel || { x: 0, z: 0 }, owner: own === undefined ? null : own });
  }

  // Press the hit button for one frame (other controls in ctrl stay held
  // for that frame), then let go but keep ctrl's other controls.
  function press(i, ctrl) {
    ctrl = ctrl || {};
    d().setInput(i, Object.assign({}, ctrl, { hit: true, hitPressed: true }));
    d().update(DT);
    d().setInput(i, Object.assign({}, ctrl, { hit: false, hitPressed: false }));
  }

  /* Hit the ball with car i. Puts the ball 'distance' in front of the car,
     moving SIDEWAYS at its current speed (so a hit is easy to see: the
     ball turns to go forward), presses hit, then steps through the
     freeze. Returns { hit, speed, freeze, dirDeg } where dirDeg is the
     outgoing direction relative to the car's nose (negative = right). */
  function hit(i, opts) {
    opts = opts || {};
    const b = d().ball, sp = b.neutral ? 0 : ballSpeed(), own = b.neutral ? null : b.owner;
    if (opts.boost) { d().setInput(i, { boost: true }); step(3 * DT); }
    const h = heading(i), right = { x: -Math.cos(h), z: Math.sin(h) };   // sideways, to the car's right
    ballInFront(i, opts.distance || 2.0, { x: right.x * sp, z: right.z * sp }, own);
    const before = d().koLog.length;
    press(i, { steer: opts.steer || 0, boost: !!opts.boost });
    let freeze = d().freezeLeft || 0, sawFreeze = freeze > 0, hitSeen = false;
    const check = () => {
      if (d().freezeLeft > 0) sawFreeze = true;
      const v = xz(d().ball.vel), f = fwd(heading(i));
      const towardsNose = vlen(v) > 0.1 && (v.x * f.x + v.z * f.z) / vlen(v) > Math.cos(50 * Math.PI / 180);
      if (owner() === i && towardsNose) hitSeen = true;
      return hitSeen;
    };
    stepUntil(check, cfg("swingTime") + 0.1);
    stepUntil(() => !(d().freezeLeft > 0), 1);
    d().setInput(i, {});
    const v = xz(d().ball.vel);
    const dirDeg = deg(wrap(Math.atan2(v.x, v.z) - heading(i)));
    return { hit: hitSeen, speed: ballSpeed(), freeze, sawFreeze, dirDeg, koDuring: d().koLog.length - before };
  }

  // Fire car 'own's ball at car 'target' from 'from' units away.
  function shoot(own, target, speed, from, dir) {
    const t = xz(P(target).pos), u = dir || { x: 1, z: 0 };
    d().setBall({ pos: { x: t.x - u.x * from, y: 0, z: t.z - u.z * from }, vel: { x: u.x * speed, z: u.z * speed }, owner: own });
  }

  // Collect results.
  function result() {
    const r = { checks: [], skipped: "" };
    r.ok = (cond, msg) => { r.checks.push({ pass: !!cond, msg }); return !!cond; };
    r.skip = (why) => { r.skipped = why; };
    r.done = () => ({ checks: r.checks, skipped: r.skipped, notes: notes.slice() });
    return r;
  }

  // Real game: a KO'd car is off the field (dead > 0) for a moment, then respawns.
  const onField = (i) => !P(i).out && !(P(i).dead > 0);
  function waitRespawn(i, maxSec) { return stepUntil(() => onField(i), maxSec || 3); }

  return { DT, d, cfg, onField, waitRespawn, missingHooks, xz, dist2, fwd, vlen, wrap, deg, idx, P, heading, owner, ballSpeed, boostOf,
           step, stepUntil, fresh, park, place, ballInFront, press, hit, shoot, result };
})();
`;

/* =====================================================================
   The tests. Each runs inside the page and returns QC.result().done().
   They may only use window.QC and TP (they're sent into the page).
   ===================================================================== */
const TESTS = {
  /* ---------- Ownership ---------- */
  ownership: function () {
    const Q = window.QC, r = Q.result();
    let d = Q.fresh({ players: 2, lives: 3 });
    Q.place(0, -10, 0, Math.PI / 2);                   // A faces +x
    Q.ballInFront(0, 2.0);                             // neutral ball, at rest
    r.ok(d.ball.neutral, "ball starts neutral after the serve");
    const h = Q.hit(0);
    r.ok(h.hit && Q.owner() === 0, `A hits a neutral ball and owns it (owner=${JSON.stringify(d.ball.owner)}, neutral=${d.ball.neutral})`);

    // Own ball passes through A harmlessly.
    const livesA = Q.P(0).lives, kosBefore = d.koLog.length;
    Q.shoot(0, 0, 15, 4);
    Q.step(0.6);
    r.ok(Q.P(0).lives === livesA && d.koLog.length === kosBefore, `own ball passes through its owner (A lives ${livesA}→${Q.P(0).lives}, KOs logged ${kosBefore}→${d.koLog.length})`);

    // A's ball touches B: exactly 1 life.
    d = Q.fresh({ players: 2, lives: 3 });
    Q.place(0, -15, -10, Math.PI / 2); Q.place(1, 8, 0, -Math.PI / 2);
    Q.ballInFront(0, 2.0); Q.hit(0);
    const livesB = Q.P(1).lives, kosA = Q.P(0).kos || 0, logN = d.koLog.length;
    Q.shoot(0, 1, 15, 4);
    const tKO = Q.stepUntil(() => d.koLog.length > logN, 1.0);
    r.ok(tKO !== null, "A's ball touching B is a KO");
    r.ok(Q.P(1).lives === livesB - 1, `B loses exactly 1 life (${livesB}→${Q.P(1).lives})`);
    r.ok((Q.P(0).kos || 0) === kosA + 1, `A's KO count goes up by 1 (${kosA}→${Q.P(0).kos})`);
    const e = d.koLog[d.koLog.length - 1] || {};
    r.ok(d.koLog.length === logN + 1, `exactly 1 koLog entry added (got ${d.koLog.length - logN})`);
    r.ok(Q.idx(e.victim) === 1 && Q.idx(e.owner) === 0, `koLog entry is {victim: B, owner: A} (got ${JSON.stringify({ victim: e.victim, owner: e.owner })})`);
    r.ok(typeof e.speed === "number" && Number.isFinite(e.speed) && typeof e.t === "number", `koLog entry has numeric t and speed (got t=${e.t}, speed=${e.speed})`);

    // Straight away B can't be hit again: off the field waiting to respawn
    // (real game) or invulnerable (either way, no second KO).
    r.ok(Q.P(1).invuln > 0 || Q.P(1).dead > 0, `B can't be hit right after the KO (invuln=${Q.P(1).invuln}, dead=${Q.P(1).dead})`);
    Q.waitRespawn(1);
    r.ok(Q.P(1).invuln > 0, `B respawns invulnerable (invuln=${Q.P(1).invuln})`);
    const l2 = Q.P(1).lives, n2 = d.koLog.length;
    Q.shoot(0, 1, 15, 4);
    Q.step(0.4);
    r.ok(Q.P(1).lives === l2 && d.koLog.length === n2, `a ball through B while invulnerable is no KO (lives ${l2}→${Q.P(1).lives})`);

    // After a KO the ball goes back to a neutral serve in the middle.
    d = Q.fresh({ players: 2, lives: 3 });
    Q.place(0, -15, -10, Math.PI / 2); Q.place(1, 8, 0, -Math.PI / 2);
    Q.ballInFront(0, 2.0); Q.hit(0);
    Q.shoot(0, 1, 15, 4);
    const n0 = d.koLog.length;
    Q.stepUntil(() => d.koLog.length > n0, 1.0);
    const tServe = Q.stepUntil(() => d.ball.neutral && Q.dist2(d.ball.pos, { x: 0, z: 0 }) < 1.5, 3);
    r.ok(tServe !== null, `after the KO the ball is a neutral serve at the centre (neutral=${d.ball.neutral}, at ${JSON.stringify(Q.xz(d.ball.pos))})`);
    return r.done();
  },

  /* ---------- Speed steps, Smash, miss cooldown, aim ---------- */
  "speed-steps": function () {
    const Q = window.QC, r = Q.result();
    const max = Q.cfg("maxSpeed"), base = Q.cfg("baseSpeed");
    let d = Q.fresh();
    Q.place(0, -15, -6, Math.PI / 2);
    Q.ballInFront(0, 2.0);
    const speeds = [];
    let h = Q.hit(0);
    r.ok(h.hit, "first hit connects");
    speeds.push(h.speed);
    if (typeof base === "number") r.ok(Math.abs(h.speed - base) <= base * 0.05, `first hit from neutral goes at base speed ${base} (got ${h.speed.toFixed(2)})`);
    // Keep hitting until the cap, then 3 more.
    let atCap = 0;
    for (let k = 0; k < 40 && atCap < 4; k++) {
      Q.place(0, -15, -6, Math.PI / 2);
      Q.step(0.35);                                   // swing over, freeze over
      h = Q.hit(0);
      if (!h.hit) { r.ok(false, `hit #${k + 2} didn't connect`); break; }
      speeds.push(h.speed);
      if (h.speed >= max * 0.999) atCap++;
    }
    let rising = true, firstCap = speeds.findIndex((s) => s >= max * 0.999);
    for (let k = 1; k < speeds.length; k++) {
      if (firstCap < 0 || k <= firstCap) { if (!(speeds[k] > speeds[k - 1] + 1e-6)) rising = false; }
    }
    r.ok(rising, `every hit is faster than the last until the cap (speeds: ${speeds.map((s) => s.toFixed(1)).join(", ")})`);
    r.ok(firstCap >= 0, `the ball reaches maxSpeed ${max} after enough hits`);
    r.ok(speeds.every((s) => s <= max * 1.001), `speed never goes over maxSpeed ${max} (top ${Math.max(...speeds).toFixed(2)})`);
    if (firstCap >= 0) r.ok(speeds.slice(firstCap).every((s) => Math.abs(s - max) <= max * 0.005), `stays at maxSpeed once capped (${speeds.slice(firstCap).map((s) => s.toFixed(1)).join(", ")})`);

    // Two cars swinging at the same ball on the same frame: one hit, not two
    // stacked (stacking would launch a serve far faster than base speed).
    d = Q.fresh({ players: 2 });
    Q.place(0, -2.2, 0, Math.PI / 2); Q.place(1, 2.2, 0, -Math.PI / 2);   // nose to nose, ball between
    d.setBall({ pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, z: 0 }, owner: null });
    d.setInput(0, { hit: true, hitPressed: true }); d.setInput(1, { hit: true, hitPressed: true });
    d.update(Q.DT);
    d.setInput(0, {}); d.setInput(1, {});
    Q.stepUntil(() => !(d.freezeLeft > 0), 1);
    if (!d.ball.neutral) r.ok(typeof base !== "number" || Math.abs(d.ball.speed - base) <= base * 0.05,
      `two cars hitting a neutral ball on the same frame count as ONE hit (speed ${d.ball.speed.toFixed(2)}, base ${base})`);
    else r.ok(false, "set-up: neither car hit the ball when both swung at it");

    // Smash: hitting while boosting adds more than a normal hit and costs boost.
    const twoHits = (boost) => {
      Q.fresh(); Q.place(0, -15, -6, Math.PI / 2);
      Q.ballInFront(0, 2.0); const a = Q.hit(0);
      Q.place(0, -15, -6, Math.PI / 2); Q.step(0.35);
      const b0 = Q.boostOf(0);
      const b = Q.hit(0, { boost });
      return { delta: b.speed - a.speed, hit: a.hit && b.hit, boostUsed: b0 === undefined ? undefined : b0 - Q.boostOf(0) };
    };
    const normal = twoHits(false), smash = twoHits(true);
    r.ok(normal.hit && smash.hit, "normal and Smash hits both connect");
    r.ok(smash.delta > normal.delta + 0.5, `a Smash adds more speed than a normal hit (+${smash.delta.toFixed(2)} vs +${normal.delta.toFixed(2)})`);
    if (smash.boostUsed === undefined) r.ok(false, "car boost meter not exposed (players[i].car.boost), can't check the Smash costs boost");
    // Holding boost for 4 frames on its own drains about 2.5 of the 100 meter, so a Smash cost must clearly exceed that.
    else r.ok(smash.boostUsed > 5, `a Smash costs boost (meter dropped by ${smash.boostUsed.toFixed(1)} during the boosted hit)`);

    // A swing that misses starts a cooldown; after it, hitting works again.
    d = Q.fresh(); Q.place(0, -15, -6, Math.PI / 2);
    Q.ballInFront(0, 10);                              // well out of reach
    Q.press(0); Q.step(Q.cfg("swingTime") + 0.05);
    r.ok(d.ball.neutral, "a swing with the ball 10 units away doesn't hit it");
    Q.ballInFront(0, 2.0);                             // now in reach, but cooling down
    Q.press(0); Q.step(0.1);
    r.ok(d.ball.neutral, `pressing again during the miss cooldown does nothing (owner=${JSON.stringify(d.ball.owner)})`);
    Q.step(Q.cfg("missCooldown") + 0.1);
    Q.ballInFront(0, 2.0);
    h = Q.hit(0);
    r.ok(h.hit, `after the cooldown (${Q.cfg("missCooldown")} s) hitting works again`);

    // Reach: just inside hits, clearly outside doesn't.
    const reach = Q.cfg("hitRange");
    Q.fresh(); Q.place(0, -15, -6, Math.PI / 2); Q.ballInFront(0, reach - 0.3);
    r.ok(Q.hit(0, { distance: reach - 0.3 }).hit, `a ball ${(reach - 0.3).toFixed(1)} away (inside reach ${reach}) can be hit`);
    Q.fresh(); Q.place(0, -15, -6, Math.PI / 2);
    r.ok(!Q.hit(0, { distance: reach + 1.0 }).hit, `a ball ${(reach + 1).toFixed(1)} away (outside reach) can't be hit`);

    // Aim: no steer = straight; full right steer bends right by about aimBendDeg.
    const bend = Q.cfg("aimBendDeg");
    Q.fresh(); Q.place(0, -15, -6, Math.PI / 2); Q.ballInFront(0, 2.0);
    const straight = Q.hit(0, { steer: 0 });
    r.ok(Math.abs(straight.dirDeg) < 3, `no steering sends the ball straight ahead (${straight.dirDeg.toFixed(1)}° off the nose)`);
    Q.fresh(); Q.place(0, -15, -6, Math.PI / 2); Q.ballInFront(0, 2.0);
    const right = Q.hit(0, { steer: 1 });
    r.ok(right.dirDeg < 0, `steering right bends the hit to the right (${right.dirDeg.toFixed(1)}°, negative = right)`);
    r.ok(Math.abs(Math.abs(right.dirDeg) - bend) <= 6, `full steer bends it by about ${bend}° (got ${Math.abs(right.dirDeg).toFixed(1)}°)`);
    Q.fresh(); Q.place(0, -15, -6, Math.PI / 2); Q.ballInFront(0, 2.0);
    const left = Q.hit(0, { steer: -1 });
    r.ok(left.dirDeg > 0 && Math.abs(Math.abs(left.dirDeg) - bend) <= 6, `full left steer bends it about ${bend}° left (got ${left.dirDeg.toFixed(1)}°)`);
    return r.done();
  },

  /* ---------- Hit-freeze ---------- */
  "hit-freeze": function () {
    const Q = window.QC, r = Q.result();
    let d = Q.fresh();
    Q.place(0, -15, -6, Math.PI / 2); Q.place(1, 15, 6, -Math.PI / 2);
    Q.ballInFront(0, 2.0);
    // Press and look at the freeze straight away.
    Q.press(0);
    const f1 = d.freezeLeft;
    r.ok(f1 > 0, `a hit starts a hit-freeze (freezeLeft=${f1})`);
    if (f1 > Q.DT * 1.5) {
      const ball0 = Q.xz(d.ball.pos), car0 = Q.xz(Q.P(1).pos);
      d.setInput(1, { throttle: 1 });                 // even a car driving can't move
      d.update(Q.DT);
      const moved = Q.dist2(ball0, d.ball.pos) + Q.dist2(car0, Q.P(1).pos);
      r.ok(moved < 1e-6, `nothing moves during the freeze (ball+car moved ${moved.toFixed(4)})`);
      d.setInput(1, {});
    }
    const tEnd = Q.stepUntil(() => !(d.freezeLeft > 0), 1);
    r.ok(tEnd !== null, `the freeze ends (after ${tEnd === null ? "never" : tEnd.toFixed(3) + " s"})`);

    // Speed the ball up to near the cap, then compare the freeze.
    let fHigh = 0, sHigh = 0;
    for (let k = 0; k < 40; k++) {
      Q.place(0, -15, -6, Math.PI / 2); Q.step(0.35);
      const hh = Q.hit(0);
      if (!hh.hit) break;
      fHigh = hh.freeze; sHigh = hh.speed;
      if (hh.speed >= Q.cfg("maxSpeed") * 0.999) break;
    }
    r.ok(fHigh > f1, `a faster ball gives a longer freeze (${f1.toFixed(3)} s at base speed, ${fHigh.toFixed(3)} s at ${sHigh.toFixed(1)})`);
    const fmax = Q.cfg("freezeMax");
    r.ok(fHigh <= Math.max(0.35, fmax + 0.02), `the freeze stays short even at top speed (${fHigh.toFixed(3)} s, limit ${Math.max(0.35, fmax + 0.02).toFixed(2)} s)`);
    return r.done();
  },

  /* ---------- Jump-dodge ---------- */
  "jump-dodge": function () {
    const Q = window.QC, r = Q.result();
    const trial = (jump) => {
      const d = Q.fresh({ players: 2, lives: 3 });
      Q.place(0, -15, -10, Math.PI / 2); Q.place(1, 5, 0, -Math.PI / 2);
      Q.ballInFront(0, 2.0); Q.hit(0);
      Q.place(0, -15, -10, Math.PI / 2);
      if (jump) {
        d.setInput(1, { jump: true });
        const clear = Q.cfg("jumpClear") + 0.3;
        const up = Q.stepUntil(() => Q.P(1).airborne && Q.xz(Q.P(1).pos).y > clear, 1);
        d.setInput(1, {});
        if (up === null) return { error: `B never got airborne above ${clear.toFixed(1)} (y=${Q.xz(Q.P(1).pos).y.toFixed(2)}, airborne=${Q.P(1).airborne})` };
      }
      const lives = Q.P(1).lives, n = d.koLog.length;
      Q.shoot(0, 1, 25, 3);
      Q.step(0.3);
      return { lost: lives - Q.P(1).lives, kos: d.koLog.length - n, airborneAtPass: Q.P(1).airborne };
    };
    const grounded = trial(false), jumped = trial(true);
    r.ok(grounded.kos === 1 && grounded.lost === 1, `control: the same ball KOs B on the ground (lives lost ${grounded.lost}, KOs ${grounded.kos})`);
    if (jumped.error) r.ok(false, jumped.error);
    else r.ok(jumped.kos === 0 && jumped.lost === 0, `B jumping over the ball isn't KO'd (lives lost ${jumped.lost}, KOs ${jumped.kos})`);
    return r.done();
  },

  /* ---------- KO, respawn, out, double KO ---------- */
  "ko-respawn": function () {
    const Q = window.QC, r = Q.result();
    const inv = Q.cfg("respawnInvuln");
    const koB = (d) => {
      Q.place(0, -15, -10, Math.PI / 2); Q.place(1, 8, 0, -Math.PI / 2);
      Q.ballInFront(0, 2.0); Q.hit(0);
      const n = d.koLog.length;
      Q.shoot(0, 1, 15, 4);
      return Q.stepUntil(() => d.koLog.length > n, 1);
    };
    let d = Q.fresh({ players: 2, lives: 3 });
    r.ok(koB(d) !== null, "set-up: B is KO'd");
    const delay = (d.cfg && d.cfg.respawnDelay) || 0;
    const tBack = Q.waitRespawn(1, delay + 2);
    r.ok(tBack !== null, `B comes back after the respawn delay (${delay} s + KO pause; took ${tBack === null ? "forever" : tBack.toFixed(2) + " s"})`);
    const i0 = Q.P(1).invuln;
    r.ok(Math.abs(i0 - inv) <= 0.25, `B respawns with about ${inv} s of invulnerability (invuln=${Number(i0).toFixed(2)})`);
    r.ok(!Q.P(1).out && Q.P(1).lives > 0, "B is still in the match with lives left");
    const tOff = Q.stepUntil(() => !(Q.P(1).invuln > 0), inv + 1.5);
    r.ok(tOff !== null && Math.abs(tOff + (inv - i0) - inv) <= 0.25, `invulnerability wears off after about ${inv} s (took ${tOff === null ? "forever" : tOff.toFixed(2) + " s"})`);
    // Once it's gone, a hit counts again.
    Q.place(0, -15, -10, Math.PI / 2);
    Q.ballInFront(0, 2.0); Q.hit(0);
    const l = Q.P(1).lives, n = d.koLog.length;
    Q.shoot(0, 1, 15, 4); Q.stepUntil(() => d.koLog.length > n, 1);
    r.ok(Q.P(1).lives === l - 1, `after invulnerability ends, B can be KO'd again (lives ${l}→${Q.P(1).lives})`);

    // 0 lives: out, match over, last car standing wins.
    d = Q.fresh({ players: 2, lives: 1 });
    koB(d);
    Q.step(0.2);
    r.ok(Q.P(1).out === true && Q.P(1).lives <= 0, `at 0 lives B is out (lives=${Q.P(1).lives}, out=${Q.P(1).out})`);
    r.ok(d.state === "over", `the match is over when one car is left (state=${d.state})`);
    r.ok(Q.idx(d.winner) === 0, `A wins (winner=${JSON.stringify(d.winner)})`);

    // Double KO (Reece: the last hitter wins): A's ball hits B and C in the same frame.
    d = Q.fresh({ players: 3, lives: 1 });
    Q.place(0, -15, -10, Math.PI / 2);
    Q.place(1, 6, 0, -Math.PI / 2); Q.place(2, 6, 2.8, -Math.PI / 2);
    Q.ballInFront(0, 2.0); Q.hit(0);
    Q.place(0, -15, -10, Math.PI / 2);
    const n2 = d.koLog.length;
    d.setBall({ pos: { x: 1, y: 0, z: 1.4 }, vel: { x: 20, z: 0 }, owner: 0 });
    Q.stepUntil(() => d.state === "over" || d.koLog.length >= n2 + 2, 1);
    const ko = d.koLog.slice(n2);
    r.ok(ko.length === 2, `the ball KOs both B and C (${ko.length} KOs logged)`);
    if (ko.length === 2) r.ok(Math.abs(ko[0].t - ko[1].t) < 1e-6, `both KOs land on the same frame (t=${ko[0].t}, ${ko[1].t})`);
    r.ok(d.state === "over" && Q.idx(d.winner) === 0, `double KO: the last hitter (A) wins (state=${d.state}, winner=${JSON.stringify(d.winner)})`);
    return r.done();
  },

  /* ---------- Stalemate reset (v2) ----------
     In v2 an owned ball flies straight for ownedHold seconds, then cools
     back to a NEUTRAL ball (that's not a reset). The stalemate reset is a
     re-serve stalemateTime after the last strike, counted in d.stats. */
  stalemate: function () {
    const Q = window.QC, r = Q.result();
    const T = Q.cfg("stalemateTime");
    const hold = (TP.DUEL_CFG && TP.DUEL_CFG.ownedHold) || 3;
    // A's ball flies end to end along z = 10, away from both cars, so
    // nobody touches it.
    const setup = () => {
      const d = Q.fresh({ players: 2, lives: 3, pillars: false });
      Q.place(0, -15, -10, Math.PI / 2); Q.place(1, 15, -10, -Math.PI / 2);
      d.setBall({ pos: { x: -10, y: 3, z: 10 }, vel: { x: 15, z: 0 }, owner: 0 });
      return d;
    };
    let d = setup();
    let minSp = Infinity;
    const resets = () => (d.stats ? d.stats.stalemates : 0);
    // While the ball is still "owned" (flying straight), it must hold its speed.
    const tReset = Q.stepUntil(() => resets() > 0, T + 3, () => { if (d.ball.mode === "owned") minSp = Math.min(minSp, d.ball.speed); });
    r.ok(tReset !== null, `with no strikes, the ball is re-served (after ${tReset === null ? "never (waited " + (T + 3) + " s)" : tReset.toFixed(2) + " s"})`);
    if (tReset !== null) r.ok(Math.abs(tReset - T) <= 0.25, `the re-serve comes at ${T} s (got ${tReset.toFixed(2)} s)`);
    r.ok(minSp >= 15 * 0.99, `an owned ball holds its speed for ownedHold (${hold} s) (slowest ${minSp.toFixed(2)}, started 15)`);
    r.ok(d.koLog.length === 0, "nobody was KO'd during the stalemate run (the test set-up held)");

    // A strike at 11 s restarts the count.
    d = setup();
    Q.step(T - 1);
    const b = Q.xz(d.ball.pos);
    // Put A right behind the ball and swipe.
    Q.place(0, b.x - 1.5, b.z, Math.PI / 2);
    const before = d.stats.strikes;
    Q.press(0);
    const hitAt = Q.stepUntil(() => d.stats.strikes > before, 0.5);
    r.ok(hitAt !== null, "set-up: A strikes the ball at 11 s");
    Q.park(0);
    const r0 = resets();
    const t2 = Q.stepUntil(() => resets() > r0, T + 3);
    r.ok(t2 !== null && Math.abs(t2 - T) <= 0.5, `after a strike at 11 s, the re-serve waits a fresh ${T} s (came ${t2 === null ? "never" : t2.toFixed(2) + " s"} after the strike)`);
    return r.done();
  },

  /* ---------- Modes (round 3, phase 1) ----------
     Teams: a teammate's ball passes through you; the last TEAM standing
     wins. Time: no lives lost, KOs score, the clock ends it, a tie goes to
     overtime and the next KO wins. Sudden Death: one life. Practice: the
     launcher fires at you, you never run out of lives. Bot levels exist. */
  modes: function () {
    const Q = window.QC, r = Q.result();
    const bots4 = [0, 1, 2, 3].map((seat) => ({ seat, name: TP.DEFAULT_NAMES[seat], controller: "bot" }));

    // Teams: seat 0 (team 0) owns a ball that flies through seat 2 (team 0) and hits seat 1 (team 1).
    let d = Q.fresh({ players: bots4, lives: 3, mode: "teams" });
    r.ok(d.mode === "teams" && d.players[0].team === d.players[2].team && d.players[0].team !== d.players[1].team, `teams by seat: 1 & 3 vs 2 & 4 (teams ${d.players.map((p) => p.team).join(",")})`);
    Q.place(0, -18, -10, 0); Q.place(3, 18, -10, 0);
    Q.place(2, -5, 0, 0); Q.place(1, 6, 0, 0);
    d.setBall({ pos: { x: -10, y: 0.9, z: 0 }, vel: { x: 30, z: 0 }, owner: 0 });
    Q.stepUntil(() => d.koLog.length > 0, 1.5);
    r.ok(d.players[2].lives === 3, `a teammate's ball passes harmlessly through (Green lives ${d.players[2].lives})`);
    r.ok(d.koLog.length === 1 && d.koLog[0].victim === 1, `...and KOs the other team (KOs: ${JSON.stringify(d.koLog.map((k) => k.victim))})`);
    // Knock out both members of team 1 by hand: team 0 wins with two cars left.
    d.players[1].lives = 1; d.players[3].lives = 1;
    for (const v of [1, 3]) {
      Q.stepUntil(() => d.players[v].dead <= 0 && d.players[v].invuln <= 0 && d.state === "play", 6);
      const c = d.players[v].pos;
      d.setBall({ pos: { x: c.x - 4, y: 0.9, z: c.z }, vel: { x: 40, z: 0 }, owner: 0 });
      Q.stepUntil(() => d.players[v].out || d.state === "over", 1.5);
    }
    r.ok(d.state === "over" && d.result && d.result.winnerTeam === 0, `last team standing wins (state ${d.state}, team ${d.result && d.result.winnerTeam}, "${d.result && d.result.winnerTeamName}")`);

    // Time mode: KOs score and nobody runs out of lives; the clock ends it.
    d = Q.fresh({ players: 2, lives: 3, mode: "time", timeLimit: 6 });
    Q.place(0, -18, -10, 0); Q.place(1, 6, 0, 0);
    d.setBall({ pos: { x: -2, y: 0.9, z: 0 }, vel: { x: 30, z: 0 }, owner: 0 });
    Q.stepUntil(() => d.koLog.length > 0, 1.5);
    r.ok(d.players[1].lives === 3 && !d.players[1].out && d.players[0].score === 1, `time: a KO scores a point and costs no life (score ${d.players[0].score}, lives ${d.players[1].lives})`);
    Q.stepUntil(() => d.state === "over", 12);
    r.ok(d.state === "over" && d.winner === 0, `time: when the clock runs out, most KOs wins (state ${d.state}, winner ${d.winner})`);
    // A tie at the bell → overtime, and the next KO wins.
    d = Q.fresh({ players: 2, lives: 3, mode: "time", timeLimit: 2 });
    Q.place(0, -18, -10, 0); Q.place(1, 18, 10, 0);
    Q.stepUntil(() => d.overtime, 6);
    r.ok(d.overtime && d.state !== "over", `time: a tie at the bell goes to overtime (overtime ${d.overtime})`);
    Q.place(1, 6, 0, 0);
    d.setBall({ pos: { x: -2, y: 0.9, z: 0 }, vel: { x: 30, z: 0 }, owner: 0 });
    Q.stepUntil(() => d.state === "over", 2);
    r.ok(d.state === "over" && d.winner === 0, `time: the next KO wins overtime (winner ${d.winner})`);

    // Sudden death = one life.
    d = Q.fresh({ players: 2, lives: 1 });
    Q.place(0, -18, -10, 0); Q.place(1, 6, 0, 0);
    d.setBall({ pos: { x: -2, y: 0.9, z: 0 }, vel: { x: 30, z: 0 }, owner: 0 });
    Q.stepUntil(() => d.state === "over", 2);
    r.ok(d.state === "over" && d.winner === 0, `sudden death: one KO ends it (winner ${d.winner})`);

    // Practice: the launcher fires at the lone player; KOs never end it.
    d = Q.fresh({ players: [{ seat: 0, name: "Me", controller: "kb1" }], lives: 3, mode: "practice", practiceSpeed: 40 });
    const L = d.launcherIndex;
    r.ok(typeof L === "number" && d.players[L].launcher && d.players[L].out, `practice: a launcher "player" exists and isn't on the field`);
    Q.place(0, 0, 0, 0);
    Q.step(8);
    const launches = d.events.filter((e) => e.type === "launch").length;
    r.ok(launches >= 2, `practice: the launcher keeps firing (${launches} launches in 8 s)`);
    r.ok(d.state !== "over" && d.players[0].lives === 3 && (d.players[0].knockedOut || 0) >= 1, `practice: being hit never ends it (hit ${d.players[0].knockedOut || 0}×, lives ${d.players[0].lives}, state ${d.state})`);

    // Bot levels.
    for (const lv of ["easy", "normal", "hard"]) {
      d = Q.fresh({ players: 2, lives: 3, difficulty: lv });
      d.setBot(0, true);
      r.ok(d.difficulty === lv && d.bots[0] && d.bots[0].level === lv, `bots: ${lv} level is applied (${d.bots[0] && d.bots[0].level})`);
    }
    return r.done();
  },

  /* ---------- v2: hit-freeze doesn't count toward the stalemate clock ---------- */
  "v2-freeze-vs-stalemate": function () {
    const Q = window.QC, r = Q.result();
    const T = Q.cfg("stalemateTime");
    const d = Q.fresh({ players: 2, lives: 3, pillars: false });
    Q.place(0, -15, -10, Math.PI / 2); Q.place(1, 15, -10, -Math.PI / 2);
    d.setBall({ pos: { x: -10, y: 3, z: 10 }, vel: { x: 15, z: 0 }, owner: 0 });
    // Add a long freeze three times during the count (as if three max-speed strikes froze the game).
    let wall = 0, frozen = 0, k = 0;
    const r0 = d.stats.stalemates;
    while (d.stats.stalemates === r0 && wall < T + 8) {
      if (k === 240 || k === 600 || k === 960) d.freezeLeft = 1.2;
      if (d.freezeLeft > 0) frozen += 1 / 120;
      d.update(1 / 120); wall += 1 / 120; k++;
    }
    const unfrozen = wall - frozen;
    r.ok(d.stats.stalemates > r0, `the re-serve still happens (after ${wall.toFixed(2)} s, ${frozen.toFixed(2)} s of it frozen)`);
    r.ok(Math.abs(unfrozen - T) <= 0.15, `it comes after ${T} s of UNFROZEN time (got ${unfrozen.toFixed(2)} s)`);
    r.ok(wall > T + 3, `so the total is about ${T} s + the freezes (got ${wall.toFixed(2)} s)`);
    return r.done();
  },

  /* ---------- v2: no tunnelling at max speed ----------
     Fire an owned ball at maxSpeed at every wall, the ceiling, the floor
     (head-on, 45° and nearly grazing) and each pillar, and at a parked
     car from 8 directions. It must never end up outside the box or
     inside a pillar, and it must KO the car, never pass through it. */
  "v2-tunnelling": function () {
    const Q = window.QC, r = Q.result();
    const C = TP.DUEL_CFG, V = C.maxSpeed, R = C.ballR;
    const W = C.arenaW / 2, D = C.arenaD / 2, H = C.arenaH;
    const inside = (b) => b.x >= -W + R - 1e-3 && b.x <= W - R + 1e-3 && b.z >= -D + R - 1e-3 && b.z <= D - R + 1e-3 && b.y >= R - 1e-3 && b.y <= H - R + 1e-3;
    const inPillar = (b, pls) => pls.some((pl) => Math.hypot(b.x - pl.x, b.z - pl.z) < pl.r + R - 1e-3);
    const shoot = (dir, start, pillars, label) => {
      const d = Q.fresh({ players: 2, lives: 3, pillars });
      d.players.forEach((_, i) => Q.place(i, -W + 3 + i * 2, D - 2.5, 0)); // out of the way, in a corner
      const l = Math.hypot(dir.x, dir.y, dir.z);
      d.setBall({ pos: start, vel: { x: dir.x / l * V, y: dir.y / l * V, z: dir.z / l * V }, owner: 0 });
      let bad = null, bounced = false;
      const pls = pillars ? C.pillarList : [];
      for (let k = 0; k < 60 && !bad; k++) {
        d.update(1 / 120);
        const b = d.ball.pos;
        if (!inside(b)) bad = `left the box at (${b.x.toFixed(2)}, ${b.y.toFixed(2)}, ${b.z.toFixed(2)})`;
        else if (inPillar(b, pls)) bad = `ended up inside a pillar at (${b.x.toFixed(2)}, ${b.z.toFixed(2)})`;
        if (d.ball.vel.x * dir.x + d.ball.vel.y * dir.y + d.ball.vel.z * dir.z < 0) bounced = true;
      }
      r.ok(!bad && bounced, `${label}: ${bad || (bounced ? "bounced, stayed inside" : "never bounced back")}`);
    };
    const mid = { x: 0, y: 6, z: 0 };
    for (const a of [0, 45, 80]) {
      const s = Math.sin(a * Math.PI / 180), c = Math.cos(a * Math.PI / 180);
      shoot({ x: c, y: 0, z: s * 0.3 }, { x: 0, y: 6, z: -3 }, false, `+X wall at ${a}°`);
      shoot({ x: -c, y: 0, z: s * 0.3 }, { x: 0, y: 6, z: -3 }, false, `-X wall at ${a}°`);
      shoot({ x: s, y: 0, z: c }, mid, false, `+Z wall at ${a}°`);
      shoot({ x: s, y: 0, z: -c }, mid, false, `-Z wall at ${a}°`);
      shoot({ x: s, y: c, z: 0 }, mid, false, `ceiling at ${a}°`);
      shoot({ x: s, y: -c, z: 0 }, mid, false, `floor at ${a}°`);
    }
    for (const pl of C.pillarList) {
      shoot({ x: pl.x - 12, y: 0, z: pl.z - pl.z }, { x: 12, y: 3, z: pl.z }, true, `pillar (${pl.x}, ${pl.z}) head-on`);
      shoot({ x: pl.x - 12, y: 0, z: 0 }, { x: 12, y: 3, z: pl.z + pl.r * 0.7 }, true, `pillar (${pl.x}, ${pl.z}) off-centre`);
    }
    // A parked car, grounded, from 8 directions: the ball must KO it.
    for (let k = 0; k < 8; k++) {
      const d = Q.fresh({ players: 2, lives: 3, pillars: false });
      Q.place(0, -W + 3, D - 2.5, 0);
      Q.place(1, 0, 0, 0);
      const a = k * Math.PI / 4, sx = Math.sin(a) * 10, sz = Math.cos(a) * 10;
      d.setBall({ pos: { x: sx, y: 0.9, z: sz }, vel: { x: -Math.sin(a) * V, y: 0, z: -Math.cos(a) * V }, owner: 0 });
      const n0 = d.koLog.length;
      Q.stepUntil(() => d.koLog.length > n0, 0.3);
      r.ok(d.koLog.length > n0, `a ${V} ball from ${k * 45}° KOs a parked car (it didn't pass through)`);
    }
    return r.done();
  },

  /* ---------- Pillars ---------- */
  pillars: function () {
    const Q = window.QC, r = Q.result();
    const list = TP.DUEL_CFG && TP.DUEL_CFG.pillarList;
    if (!Array.isArray(list) || !list.length) { r.skip("DUEL_CFG.pillarList [{x, z, r}] isn't exposed, so the pillar positions are unknown"); return r.done(); }
    const radius = Q.cfg("ballR") || 0.5;
    for (const [k, pl] of list.entries()) {
      // Pillars on: fire the ball straight at it.
      let d = Q.fresh({ pillars: true });
      Q.place(0, -18, -11, Math.PI / 2);
      Q.ballInFront(0, 2.0); Q.hit(0); Q.park(0);
      d.setBall({ pos: { x: pl.x - 7, y: 0, z: pl.z }, vel: { x: 20, z: 0 }, owner: 0 });
      let deepest = Infinity;
      Q.step(0.6, () => { deepest = Math.min(deepest, Q.dist2(d.ball.pos, pl)); });
      r.ok(deepest >= pl.r - 0.05, `pillar ${k + 1}: the ball never gets inside it (closest centre-to-centre ${deepest.toFixed(2)}, pillar radius ${pl.r})`);
      r.ok(Q.xz(d.ball.vel).x < 0, `pillar ${k + 1}: the ball bounces back off it (vel.x=${Q.xz(d.ball.vel).x.toFixed(1)})`);
      // Pillars off: the same shot goes straight past.
      d = Q.fresh({ pillars: false });
      Q.place(0, -18, -11, Math.PI / 2);
      Q.ballInFront(0, 2.0); Q.hit(0); Q.park(0);
      d.setBall({ pos: { x: pl.x - 7, y: 0, z: pl.z }, vel: { x: 20, z: 0 }, owner: 0 });
      Q.step(0.5);
      r.ok(Q.xz(d.ball.pos).x > pl.x + pl.r + radius, `pillar ${k + 1} switched off: the ball goes straight through where it was (x=${Q.xz(d.ball.pos).x.toFixed(1)})`);
    }
    return r.done();
  },

  /* ---------- Car feel ---------- */
  "car-feel": function () {
    const Q = window.QC, r = Q.result();
    const d = Q.fresh({ players: 2 });
    const T = d.tuning || Q.P(0).tuning || (Q.P(0).car && Q.P(0).car.tuning);
    if (!T) r.ok(false, "no car tuning exposed (TP.duel.tuning, players[i].tuning or players[i].car.tuning)");
    else {
      r.ok(T.pivot === 0.8, `car tuning pivot is 0.8 (got ${T.pivot})`);
      const diffs = Object.keys(TP.CAR_TUNING).filter((k) => k !== "pivot" && T[k] !== TP.CAR_TUNING[k]).map((k) => `${k} ${TP.CAR_TUNING[k]}→${T[k]}`);
      r.ok(diffs.length === 0, `no other car settings changed from the shared defaults${diffs.length ? " (changed: " + diffs.join(", ") + ")" : ""}`);
    }
    const carMax = TP.CAR_TUNING.maxSpeed, boostMax = TP.CAR_TUNING.boostMax;
    const drive = (boost) => {
      const m = Q.fresh({ players: 2 });     // a NEW TP.duel: use it, not the old 'd'
      Q.place(0, 0, -3, Math.PI / 2);
      m.setInput(0, { throttle: 1, steer: 1, boost });
      let top = 0;
      Q.step(boost ? 2.2 : 3, () => { top = Math.max(top, Q.vlen(Q.P(0).car ? Q.P(0).car.vel : { x: 0, z: 0 })); });
      m.setInput(0, {});
      return top;
    };
    if (!Q.P(0).car || !Q.P(0).car.vel) r.ok(false, "players[i].car.vel not exposed, can't measure car speed");
    else {
      const gas = drive(false), boosted = drive(true);
      r.ok(gas <= carMax + 0.3, `on gas alone a car tops out at ${carMax} (got ${gas.toFixed(2)})`);
      r.ok(boosted <= boostMax + 0.3, `boosting, a car tops out at ${boostMax} (got ${boosted.toFixed(2)})`);
      r.ok(boosted > gas + 1, `boost actually makes the car faster (${gas.toFixed(1)} → ${boosted.toFixed(1)})`);
    }
    return r.done();
  },
};

/* =====================================================================
   v2 (DESIGN.md) checks: PLANNED, NOT BUILT YET. Each reports SKIP with
   the plan until Gameplay's v2 Stage A lands and its real field names can
   be read from duel.js (QC was stopped before Stage A arrived). They are
   listed here so they show up in every run and can't be forgotten.
   ===================================================================== */
const V2_PLANNED = {
  "v2-box": "ball stays inside the 3D box (0 <= y <= arenaH, allowing ballR) every step",
  "v2-owned-flight": "owned ball: no gravity, constant speed (±1%) between strikes until ownedHold, then fades over ownedFade to neutral",
  "v2-bump": "driving into an owned ball changes neither tier nor owner; bumping a neutral ball gives ownership at baseSpeed",
  "v2-strike-angles": "strike up ≈ +angleUpDeg, none ≈ 0°, down ≈ -angleDownDeg (floor bounce), sideways ≈ aimBendDeg",
  "v2-flip-reset": "underside contact pops the ball up at ≈ buntKeep×v, keeps/takes ownership, no hit-freeze, resets air moves; nose/side = plain bump; airborne Hit with no direction = normal straight strike",
  "v2-clash": "two strikes inside clashWindow: ball stays put, owner unchanged, nobody's tier rises, both cars pushed apart; just outside the window = normal tier-up",
  "v2-dodge-3d": "jumping over a ground ball and a high ball over a grounded car are both no-KO; meeting the ball at its height in the air IS a KO",
};
for (const [name, plan] of Object.entries(V2_PLANNED)) {
  if (TESTS[name]) continue;
  TESTS[name] = new Function(`return { checks: [], skipped: ${JSON.stringify("v2 test not built yet (waiting for Stage A field names). Plan: " + plan)}, notes: [] };`);
}

/* =====================================================================
   rocket-rumble: menu ↔ hub setup, hub link, rematch. Driven from Node
   because it loads several pages and clicks real buttons.
   ===================================================================== */
async function rocketRumble(browser) {
  const checks = [];
  const ok = (cond, msg) => { checks.push({ pass: !!cond, msg }); return !!cond; };
  const errorsOf = (page) => { const e = []; page.on("pageerror", (x) => e.push("PAGE ERROR: " + x.message)); page.on("console", (m) => { if (m.type() === "error") e.push("CONSOLE ERROR: " + m.text()); }); return e; };
  const base = pathToFileURL(indexFile).href;
  const hubPath = path.resolve(HUB_FILE);

  const open = async (storage, query = "") => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = errorsOf(page);
    await page.addInitScript(([key, value]) => {
      try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) { /* blocked */ }
    }, [SETUP_KEY, storage]);
    const params = [query.replace(/^\?/, ""), extraQuery.replace(/^&/, "")].filter(Boolean).join("&");
    await page.goto(base + (params ? "?" + params : ""));
    await page.waitForTimeout(1500);
    // Only seed storage on the first load; later navigations must see what the page saved.
    return { page, errors };
  };
  // Everything a person can read on the menu: text plus form field values.
  const menuText = (page) => page.evaluate(() => {
    const parts = [document.body.innerText];
    document.querySelectorAll("input").forEach((el) => parts.push(el.value));
    document.querySelectorAll("select").forEach((el) => parts.push(el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : ""));
    return parts.join("\n");
  });
  const findButton = (page, re) => page.evaluateHandle((src) => {
    const re = new RegExp(src, "i");
    return [...document.querySelectorAll("button, .btn, [role=button]")].find((el) => re.test(el.innerText) && el.offsetParent !== null) || null;
  }, re.source);
  const hubLinkPath = (page) => page.evaluate(() => {
    const a = [...document.querySelectorAll("a")].find((el) => /all modes/i.test(el.innerText));
    return a ? a.href : null;
  });

  // 1) Saved setup fills the menu; Start saves it back; "off" seat stays empty.
  const seed = { slots: [{ name: "Zed", controller: "bot" }, { name: "Yan", controller: "kb1" }, { name: "Xia", controller: "off" }, { name: "Wu", controller: "bot" }] };
  let { page, errors } = await open(JSON.stringify(seed));
  const text = await menuText(page);
  ok(["Zed", "Yan", "Wu"].every((n) => text.includes(n)), `the menu shows the hub's saved names Zed, Yan, Wu (menu text: ${JSON.stringify(text.slice(0, 160))})`);
  // Change the first name, if the menu has name boxes, to prove Start saves edits.
  const edited = await page.evaluate(() => {
    const el = [...document.querySelectorAll("input")].find((i) => i.value === "Zed");
    if (!el) return false;
    el.value = "Vee"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
  const start = await findButton(page, /^\s*(start|play|go)\b/);
  if (!(await start.evaluate((el) => !!el))) ok(false, "no Start button found on the menu");
  else {
    await start.click();
    await page.waitForTimeout(800);
    const saved = await page.evaluate((key) => { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return "unreadable"; } }, SETUP_KEY);
    const want = edited ? "Vee" : "Zed";
    ok(saved && saved.slots && saved.slots[0] && saved.slots[0].name === want, `Start saves the setup back (slot 1 saved as ${JSON.stringify(saved && saved.slots && saved.slots[0])}, expected name ${want})`);
    const back = await page.evaluate(() => TP.Rumble && TP.Rumble.loadSetup().slots.map((s) => s.name + ":" + s.controller).join(","));
    ok(back && back.includes("Xia:off"), `the hub reads the saved setup the same way, with Xia still "off" (${back})`);
    const names = await page.evaluate(() => TP.duel && TP.duel.players ? TP.duel.players.map((p) => p.name) : null);
    ok(names && !names.includes("Xia") && names.length === 3, `the match has 3 cars and the "off" seat is empty (cars: ${JSON.stringify(names)})`);
  }
  ok(errors.length === 0, `no errors on the menu → match path${errors.length ? ": " + errors.join(" | ") : ""}`);
  await page.close();

  // 2) Broken saved setup: falls back to defaults, no errors.
  ({ page, errors } = await open("{{not json"));
  const t2 = await menuText(page);
  ok((TP_DEFAULT_NAMES).some((n) => t2.includes(n)), `with broken storage the menu falls back to the default names (menu text: ${JSON.stringify(t2.slice(0, 120))})`);
  ok(errors.length === 0, `no errors with broken storage${errors.length ? ": " + errors.join(" | ") : ""}`);

  // 3) "← All modes" on the menu goes to the hub.
  const href = await hubLinkPath(page);
  if (!href) ok(false, 'no "← All modes" link on the menu');
  else {
    ok(href.startsWith("file:") && path.resolve(fileURLToPath(href)) === hubPath, `"← All modes" on the menu points at games/index.html (${href})`);
    await page.evaluate(() => [...document.querySelectorAll("a")].find((el) => /all modes/i.test(el.innerText)).click());
    await page.waitForTimeout(1500);
    const at = page.url().split("?")[0];
    ok(at.startsWith("file:") && path.resolve(fileURLToPath(at)) === hubPath, `clicking it loads the hub (now at ${at})`);
    ok(errors.length === 0, `no errors going to the hub${errors.length ? ": " + errors.join(" | ") : ""}`);
  }
  await page.close();

  // 4) Results card: hub link and a rematch that resets everything.
  ({ page, errors } = await open(null, "?demo&players=2&lives=1&speed=8"));
  const over = await page.waitForFunction(() => window.TP && TP.duel && TP.duel.state === "over", null, { timeout: 90000 }).then(() => true, () => false);
  if (!over) ok(false, "set-up: a 2-car, 1-life demo match didn't finish within 90 s");
  else {
    // The results card follows the "WINS!" moment after a short delay.
    await page.waitForFunction(() => [...document.querySelectorAll("button, .btn")].some((el) => /rematch|play again/i.test(el.innerText) && el.offsetParent !== null), null, { timeout: 8000 }).catch(() => {});
    const href2 = await hubLinkPath(page);
    ok(href2 && path.resolve(fileURLToPath(href2)) === hubPath, `the results screen has "← All modes" pointing at the hub (${href2})`);
    const re = await findButton(page, /rematch|play again/);
    if (!(await re.evaluate((el) => !!el))) ok(false, "no Rematch button on the results screen");
    else {
      await re.click();
      // Read the new match on its very first frame: at ×8 speed a 1-life
      // match between bots can be over again within a second.
      const s = await page.waitForFunction(() => {
        const d = window.TP && TP.duel;
        if (!d || d.state === "over") return null;
        return { state: d.state, winner: d.winner, ko: d.koLog.length, ps: d.players.map((p) => ({ lives: p.lives, out: p.out, kos: p.kos })) };
      }, null, { timeout: 3000, polling: "raf" }).then((h) => h.jsonValue(), () => ({ state: "over", winner: "unchanged after 3 s", ko: -1, ps: [] }));
      ok(s.state !== "over" && (s.winner === null || s.winner === undefined), `rematch starts a new match (state=${s.state}, winner=${JSON.stringify(s.winner)})`);
      ok(s.ps.every((p) => p.lives === 1 && !p.out), `rematch gives everyone their lives back (${JSON.stringify(s.ps)})`);
      ok(s.ko === 0 && s.ps.every((p) => !p.kos), `rematch clears the KO log and KO counts (koLog ${s.ko}, kos ${s.ps.map((p) => p.kos).join("/")})`);
    }
  }
  ok(errors.length === 0, `no errors through results and rematch${errors.length ? ": " + errors.join(" | ") : ""}`);
  await page.close();
  return { checks, skipped: "", notes: [] };
}
const TP_DEFAULT_NAMES = ["Blue", "Orange", "Green", "Pink"];

/* =====================================================================
   Runner
   ===================================================================== */
const ALL = [...Object.keys(TESTS), "rocket-rumble"];

(async () => {
  const arg = process.argv[2] || "all";
  if (arg === "list") { console.log(ALL.join("\n")); process.exit(0); }
  const wanted = arg === "all" ? ALL : arg.split(",");
  const unknown = wanted.filter((t) => !ALL.includes(t));
  if (unknown.length) { console.log(`Unknown test(s): ${unknown.join(", ")}. Known: ${ALL.join(", ")}`); console.log("RESULT: FAIL (bad arguments)"); process.exit(1); }

  const needed = process.env.DEFLECT_DUEL_INDEX ? [path.basename(indexFile)] : ["index.html", "js/duel.js", "js/main.js"];
  const missing = needed.filter((f) => !fs.existsSync(path.join(path.dirname(indexFile), f)));
  if (missing.length) {
    console.log(`Deflect Duel isn't playable yet: missing ${missing.map((f) => "deflect-duel/" + f).join(", ")}.`);
    console.log("RESULT: FAIL (game files missing; nothing to test)");
    process.exit(1);
  }

  let browser = null;
  const finish = async (code) => { if (browser) { try { await browser.close(); } catch (e) { /* gone */ } browser = null; } process.exit(code); };
  process.on("SIGINT", () => { console.log("\nInterrupted.\nRESULT: FAIL (interrupted)"); finish(1); });

  let failed = 0, passed = 0, skipped = 0;
  try {
    browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"] });
    for (const name of wanted) {
      let res;
      const t0 = Date.now();
      if (name === "rocket-rumble") {
        res = await rocketRumble(browser).catch((e) => ({ checks: [{ pass: false, msg: "test crashed: " + (e && e.message || e) }], skipped: "", notes: [] }));
      } else {
        // A fresh page per test, so one test can't leave state behind for the next.
        const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
        const errors = [];
        page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
        page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE ERROR: " + m.text()); });
        await page.goto(pathToFileURL(indexFile).href + "?demo&test&players=4&lives=3&speed=1" + extraQuery);
        const ready = await page.waitForFunction(() => window.TP && TP.duel && TP.DUEL_CFG, null, { timeout: 20000 }).then(() => true, () => false);
        if (!ready) res = { checks: [{ pass: false, msg: "TP.duel / TP.DUEL_CFG never appeared (is ?demo&test wired up?)" }], skipped: "", notes: [] };
        else {
          await page.addScriptTag({ content: HELPERS });
          const hooks = await page.evaluate(() => window.QC.missingHooks());
          if (hooks.length) res = { checks: [{ pass: false, msg: `test hooks missing on TP.duel: ${hooks.join(", ")}` }], skipped: "", notes: [] };
          else res = await page.evaluate(TESTS[name]).catch((e) => ({ checks: [{ pass: false, msg: "test crashed: " + String(e && e.message || e).split("\n")[0] }], skipped: "", notes: [] }));
        }
        if (errors.length) res.checks.push({ pass: false, msg: "page errors: " + errors.join(" | ") });
        await page.close();
      }

      const bad = res.checks.filter((c) => !c.pass);
      const verdict = res.skipped ? "SKIP" : bad.length ? "FAIL" : "PASS";
      if (verdict === "FAIL") failed++; else if (verdict === "SKIP") skipped++; else passed++;
      console.log(`\n${verdict.padEnd(4)}  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      if (res.skipped) console.log(`      skipped: ${res.skipped}`);
      for (const c of res.checks) console.log(`   ${c.pass ? "✓" : "✗"} ${c.msg}`);
      for (const n of res.notes || []) console.log(`   ℹ ${n}`);
    }
  } catch (e) {
    console.log("\nThe test script hit an error: " + (e && e.stack || e));
    console.log("RESULT: FAIL (test crashed)");
    return finish(1);
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
  return finish(failed ? 1 : 0);
})();
