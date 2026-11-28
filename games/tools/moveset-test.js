/* =====================================================================
   moveset-test.js — checks the shared car's ROCKET MOVESET with numbers,
   headless, in plain Node (no browser needed: it loads three.min.js,
   util.js and car.js into a sandbox and drives the car with scripted
   controls at a fixed 1/60 s step, exactly like the arenas do).

   Usage (from the games folder):
     node tools/moveset-test.js
     node tools/moveset-test.js --ref=<git commit>   compare the classic car
                                                     against car.js at that commit
     node tools/moveset-test.js -v                   print every measured number

   What it checks (each line prints PASS/FAIL with the measured value):
     1. Single jump height        ≈ jump² / (2·gravity) ≈ 1.97
     2. Double jump               early second press goes much higher, and
                                  matches TP.ai.jumpApex(); late second press
                                  still adds a full jump
     3. Second-jump window        a press after 1.25 s does nothing
     4. Front flip                +8 u/s along the nose, 360° in 0.6 s,
                                  car.flipping / flipDir set during it, and a
                                  flip straight off the ground lands clean
     5. Side flip                 +6 u/s sideways, rolls 360°
     6. Air control               pitch rate follows the stick, and stops
                                  quickly when released (angular damping)
     7. Aerial                    nose up + boost climbs far above a double
                                  jump, with gravity still acting
     8. Clean landing             tilted < 45°: lands driving, keeps speed
     9. Bad landing               upside down: tumbles, loses speed, upright
                                  within 0.8 s, then drives again
    10. Ceiling and wall planes   roof never passes the ceiling, the car
                                  bounces off a wall plane and stays inside
    11. Deterministic + sub-steps the same run twice gives identical bits;
                                  1/120 s steps land near the 1/60 s result
    12. Bot helpers               TP.ai.flipAt flips toward a target point,
                                  TP.ai.aerialTo climbs to a high target
    13. Moveset OFF unchanged     a long random 4-car classic run (driving,
                                  jumps, boost, bumps, a pit, a ledge) gives
                                  bit-identical results to the car.js before
                                  the moveset existed (commit be9570b, read
                                  with git), and to a stored fingerprint
    14. Flip reset                wheels-first onto a ball restores the air
                                  move (TP.Car.sphereContact + resetAirMoves);
                                  nose-first, side-first, nose-tip and
                                  bumper touches don't

   Exit code 0 = every check passed, 1 = something failed.
   ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");          // the games folder
const VERBOSE = process.argv.includes("-v");
const refArg = (process.argv.find((a) => a.startsWith("--ref=")) || "").slice(6);
// The last commit whose car.js had no moveset. The classic car must still
// behave bit-for-bit like that one.
const CLASSIC_REF = refArg || "be9570bbbc2e5623e57486b6b8df01d771c83ac3";
// Fingerprint of the classic run (test 13) with that car.js, recorded on
// 2026-11-28 with Node 22. Used if git isn't available.
const CLASSIC_FINGERPRINT = "2a594ee00094a1de";

const DT = 1 / 60;

/* ---------- Load the shared engine into a fresh sandbox ----------
   carSource lets test 13 load an older car.js next to the current one. */
function loadEngine(carSource) {
  const sandbox = {
    console: { log() {}, warn() {}, error: console.error, info() {} }, // three.min.js warns on load
    performance: { now: () => 0 }, // only used for the cosmetic marker bob
    Math, // shared, but nothing here depends on Math.random
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
  vm.runInContext(read("shared/vendor/three.min.js"), sandbox, { filename: "three.min.js" });
  vm.runInContext(read("shared/js/util.js"), sandbox, { filename: "util.js" });
  vm.runInContext(carSource || read("shared/js/car.js"), sandbox, { filename: "car.js" });
  return sandbox;
}

const E = loadEngine();
const { TP, THREE } = E;
const R = TP.ROCKET_MOVES;
const T = TP.CAR_TUNING;
const RT = TP.modeTuning({}, { moveset: "rocket" }); // rocket tuning, as a mode would make it

const FLAT = { groundHeightAt: () => 0 };
const scene = { add() {} };
let playerIndex = 0;
function newCar(env = E, opts = {}) {
  const car = new env.TP.Car(scene, { index: playerIndex++ % 4, color: 0x3b82f6 });
  car.placeAt(opts.x || 0, opts.z || 0, opts.heading || 0);
  if (opts.rocket !== false) car.moveset = "rocket";
  return car;
}
// Build a control object (everything off unless given).
const C = (o = {}) => Object.assign({ throttle: 0, steer: 0, pitch: 0, boost: false, jump: false }, o);

// Run `frames` steps; ctrlAt(frame, car) returns the controls for that step.
function run(car, frames, ctrlAt, world = FLAT, tuning = RT, dt = DT, each) {
  for (let i = 0; i < frames; i++) {
    car.update(dt, ctrlAt(i, car), world, tuning);
    if (each) each(i, car);
  }
}

const AXIS = (x, y, z) => new THREE.Vector3(x, y, z);

// Angle (radians) between two quaternions.
function quatAngle(a, b) {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, d));
}

/* ---------- Tiny reporting helpers ---------- */
let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `   (${detail})` : ""}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const f2 = (x) => Number(x).toFixed(2);
function info(...a) { if (VERBOSE) console.log("      ", ...a); }

/* =====================================================================
   1. Single jump height
   ===================================================================== */
{
  const car = newCar();
  let maxY = 0, airFrames = 0;
  run(car, 90, (i) => C({ jump: i < 3 }), FLAT, RT, DT, (i, c) => {
    maxY = Math.max(maxY, c.pos.y);
    if (!c.onGround) airFrames++;
  });
  const ideal = TP.ai.jumpApex(null, RT);
  check("1. single jump height", near(maxY, ideal, 0.1) && car.onGround,
    `apex ${f2(maxY)} vs ideal ${f2(ideal)}, airtime ${f2(airFrames * DT)} s`);

  // Same jump with the classic car (moveset off): the first jump must be identical.
  const classic = newCar(E, { rocket: false });
  let maxC = 0;
  run(classic, 90, (i) => C({ jump: i < 3 }), FLAT, T, DT, (i, c) => { maxC = Math.max(maxC, c.pos.y); });
  check("1b. rocket first jump == classic jump", maxC === maxY, `classic ${f2(maxC)}, rocket ${f2(maxY)}`);
}

/* =====================================================================
   2. Double jump (early and late second press)
   ===================================================================== */
function doubleJump(secondAtFrame) {
  const car = newCar();
  let maxY = 0, firedAt = -1;
  run(car, 200, (i) => C({ jump: i === 0 || i === secondAtFrame }), FLAT, RT, DT, (i, c) => {
    maxY = Math.max(maxY, c.pos.y);
    if (firedAt < 0 && c.doubleJumped) firedAt = i;
  });
  return { car, maxY, firedAt };
}
{
  const single = TP.ai.jumpApex(null, RT);
  const early = doubleJump(7);           // second press ~0.12 s after take-off
  const earlyIdeal = TP.ai.jumpApex(7 * DT, RT);
  check("2. double jump (early press) height", early.car.doubleJumped && near(early.maxY, earlyIdeal, 0.2),
    `apex ${f2(early.maxY)} vs ideal ${f2(earlyIdeal)}; single is ${f2(single)}`);
  // Second press at 0.5 s, already falling: it cancels the fall and adds
  // a full jump from wherever the car is.
  const probe = newCar();
  run(probe, 31, (i) => C({ jump: i === 0 }));
  const late = doubleJump(30);
  check("2b. double jump (late press) adds a full jump", late.car.doubleJumped && late.maxY > probe.pos.y + 0.9 * single,
    `apex ${f2(late.maxY)}, pressed at height ${f2(probe.pos.y)}`);
  // A held jump button must not double jump on its own.
  const held = newCar();
  run(held, 60, () => C({ jump: true }));
  check("2c. holding jump doesn't trigger the second jump", !held.doubleJumped && !held.flipping);
}

/* =====================================================================
   3. Second-jump window
   ===================================================================== */
{
  // Drive off a ledge high enough to stay airborne > 1.25 s, then press.
  const tall = { groundHeightAt: (x, z) => (z < 5 ? 30 : 0) };
  const car = newCar();
  car.placeAt(0, 0, 0, 30);
  car.vel.set(0, 0, 10);
  let afterWindow = null, used = false;
  run(car, 140, (i, c) => C({ jump: c.airTime > R.airJumpWindow + 0.05 && i % 2 === 0 }), tall, RT, DT, (i, c) => {
    if (c.airTime > R.airJumpWindow + 0.05 && afterWindow === null) afterWindow = c.airTime;
    if (c.airJumpUsed) used = true;
  });
  check("3. no second jump after the 1.25 s window", afterWindow !== null && !used,
    `pressed from ${f2(afterWindow)} s airtime, used: ${used}`);
  // And inside the window, driving off a ledge still gives you one air jump.
  const car2 = newCar();
  car2.placeAt(0, 0, 0, 30);
  car2.vel.set(0, 0, 10);
  run(car2, 60, (i, c) => C({ jump: !c.onGround && c.airTime > 0.3 }), tall, RT);
  check("3b. driving off a ledge still gives one air jump", car2.doubleJumped);
}

/* =====================================================================
   4. Front flip
   ===================================================================== */
function flipRun(pitch, steer, startSpeed = 10, secondAt = 7) {
  const car = newCar();
  car.vel.set(0, 0, startSpeed); // heading 0 = nose along +Z
  let before = null, after = null, flipFrames = 0, minRoofY = 1, q0 = null, dirSeen = null;
  run(car, 70, (i) => C({ jump: i === 0 || i === secondAt, pitch: i === secondAt ? pitch : 0, steer: i === secondAt ? steer : 0 }),
    FLAT, RT, DT, (i, c) => {
      if (i === secondAt - 1) { before = c.vel.clone(); q0 = c.quat.clone(); }
      if (i === secondAt) { after = c.vel.clone(); dirSeen = c.flipDir.clone(); }
      if (c.flipping) { flipFrames++; minRoofY = Math.min(minRoofY, c.roof().y); }
      if (i === secondAt + Math.round(R.flipDuration / DT)) c._qEnd = c.quat.clone();
    });
  return { car, before, after, flipFrames, minRoofY, q0, dirSeen };
}
{
  const r = flipRun(1, 0);
  const gain = r.after.z - r.before.z; // forward is +Z
  check("4. front flip: forward speed burst", near(gain, R.flipForward, 0.05) && near(r.after.x - r.before.x, 0, 1e-9),
    `+${f2(gain)} u/s forward (target ${R.flipForward})`);
  check("4b. front flip: car.flipping lasts ~0.6 s", near(r.flipFrames * DT, R.flipDuration, 2 * DT),
    `${r.flipFrames} frames = ${f2(r.flipFrames * DT)} s`);
  check("4c. front flip: goes upside down mid-flip", r.minRoofY < -0.95, `lowest roof.y ${f2(r.minRoofY)}`);
  // After exactly one flip duration the orientation is back where it started (a full 360°).
  check("4d. front flip: full 360° (back to start orientation)", quatAngle(r.car._qEnd || r.car.quat, r.q0) < 0.01,
    `${(quatAngle(r.car._qEnd || r.car.quat, r.q0) * 180 / Math.PI).toFixed(3)}° off`);
  check("4e. front flip: flipDir points along the nose", near(r.dirSeen.z, 1, 1e-6),
    `flipDir (${f2(r.dirSeen.x)}, ${f2(r.dirSeen.z)})`);
  check("4f. front flip: lands clean and keeps driving", r.car.onGround && !r.car.tumbling && r.car.lastLanding && r.car.lastLanding.clean,
    `speed after landing ${f2(r.car.speed2D())}`);
  // A human-speed double tap (second press 0.2 s after take-off) must
  // still finish the flip and land clean, not tumble.
  const slow = flipRun(1, 0, 10, 12);
  check("4f2. front flip pressed at 0.2 s still lands clean", slow.car.lastLanding && slow.car.lastLanding.clean,
    slow.car.lastLanding ? `landed ${slow.car.lastLanding.clean ? "clean" : "tumbling"}` : "never landed");
  // Back flip: weaker burst backwards.
  const b = flipRun(-1, 0);
  check("4g. back flip: backwards burst", near(b.after.z - b.before.z, -R.flipBackward, 0.05),
    `${f2(b.after.z - b.before.z)} u/s`);
}

/* =====================================================================
   5. Side flip
   ===================================================================== */
{
  const r = flipRun(0, 1, 0);
  // Steering right = car's right-hand side. With heading 0 that's -X.
  const side = -(r.after.x - r.before.x);
  check("5. side flip: sideways speed burst to the right", near(side, R.flipSide, 0.05) && near(r.after.z - r.before.z, 0, 1e-9),
    `+${f2(side)} u/s to the right (target ${R.flipSide})`);
  check("5b. side flip: rolls through upside down and back", r.minRoofY < -0.95 && quatAngle(r.car._qEnd, r.q0) < 0.01,
    `lowest roof.y ${f2(r.minRoofY)}`);
  // Diagonal: both, scaled by the unit direction.
  const d = flipRun(1, 1, 0);
  const k = Math.SQRT1_2;
  check("5c. diagonal flip mixes both bursts",
    near(d.after.z - d.before.z, R.flipForward * k, 0.05) && near(-(d.after.x - d.before.x), R.flipSide * k, 0.05),
    `fwd +${f2(d.after.z - d.before.z)}, side +${f2(-(d.after.x - d.before.x))}`);
}

/* =====================================================================
   6. Air control: pitch follows the stick, stops when released
   ===================================================================== */
{
  const car = newCar();
  car.placeAt(0, 0, 0, 50); // high up, so there's lots of time in the air
  const world = { groundHeightAt: () => 0 };
  let rateHeld = 0, rateAfter = 0, pitchAtRelease = 0, pitchLater = 0;
  const noseUp = (c) => Math.asin(Math.max(-1, Math.min(1, c.nose().y)));
  run(car, 60, (i) => C({ pitch: i < 20 ? 1 : 0 }), world, RT, DT, (i, c) => {
    if (i === 19) { rateHeld = c.angVel.x; pitchAtRelease = noseUp(c); }
    if (i === 39) rateAfter = c.angVel.x;
    if (i === 59) pitchLater = noseUp(c);
  });
  check("6. air pitch reaches its top rate with the stick held", near(rateHeld, R.airPitchRate, 0.6),
    `${f2(rateHeld)} rad/s after 0.33 s (top ${R.airPitchRate})`);
  check("6b. air spin stops quickly on release (damping)", Math.abs(rateAfter) < 0.05 * R.airPitchRate,
    `${f2(rateAfter)} rad/s 0.33 s after release`);
  check("6c. pitch held 1/3 s tips the nose up, then it stays put", pitchAtRelease > 0.5 && Math.abs(pitchLater - pitchAtRelease) < 0.45,
    `nose ${f2(pitchAtRelease * 57.3)}° at release, ${f2(pitchLater * 57.3)}° 0.67 s later`);
  // Yaw in the air changes the heading the same way as steering does.
  const y = newCar();
  y.placeAt(0, 0, 0, 50);
  run(y, 20, () => C({ steer: 1 }), world);
  check("6d. air yaw right lowers the heading (same as steering right)", y.heading < -0.3, `heading ${f2(y.heading)}`);
}

/* =====================================================================
   7. Aerial: nose up + boost climbs
   ===================================================================== */
{
  const car = newCar();
  let maxY = 0, climbing = false;
  // Jump, double jump, pitch up until the nose is near vertical, then boost.
  run(car, 240, (i, c) => {
    const up = c.nose().y;
    return C({ jump: i === 0 || i === 7, pitch: !c.onGround && i > 8 && up < 0.95 ? 1 : 0, boost: !c.onGround && i > 8 });
  }, FLAT, RT, DT, (i, c) => {
    maxY = Math.max(maxY, c.pos.y);
    if (i === 100 && c.vel.y > 0) climbing = true;
  });
  const dj = TP.ai.jumpApex(7 * DT, RT);
  check("7. aerial: nose-up boost flies far above a double jump", maxY > dj + 3,
    `max height ${f2(maxY)} (double jump alone ${f2(dj)})`);
  check("7b. aerial: still climbing 1.6 s in (boost beats gravity)", climbing);
  // Boost must drain at the normal rate in the air.
  const b = newCar();
  b.placeAt(0, 0, 0, 50);
  run(b, 30, () => C({ boost: true }));
  check("7c. aerial boost drains at the shared rate", near(100 - b.boost, T.boostDrain * 0.5, 0.01),
    `used ${f2(100 - b.boost)} in 0.5 s`);
  // Boost along the nose: nose level → mostly horizontal thrust.
  const h = newCar();
  h.placeAt(0, 0, 0, 50);
  run(h, 30, () => C({ boost: true }));
  check("7d. aerial boost pushes along the nose (level nose → forward)", near(h.vel.z, T.boostAccel * 0.5, 0.05),
    `forward speed ${f2(h.vel.z)} after 0.5 s`);
}

/* =====================================================================
   8. Clean landing (tilted under 45°)
   ===================================================================== */
{
  const car = newCar();
  car.placeAt(0, 0, 0, 3);
  car.onGround = false;
  car.vel.set(0, -2, 14);
  // Tip the nose up 30°.
  car.quat.setFromAxisAngle(new THREE.Vector3(-1, 0, 0), 30 * Math.PI / 180);
  let speedBefore = 0, landedFrame = -1;
  run(car, 60, () => C({ throttle: 1 }), FLAT, RT, DT, (i, c) => {
    if (landedFrame < 0 && c.onGround) { landedFrame = i; }
    if (landedFrame < 0) speedBefore = c.speed2D();
  });
  check("8. clean landing: driving again, no tumble", car.lastLanding && car.lastLanding.clean && !car.tumbling && car.onGround);
  check("8b. clean landing: speed kept", car.lastLanding && near(car.lastLanding.speed, speedBefore, 0.01),
    `${f2(speedBefore)} u/s before touchdown, ${f2(car.speed2D())} u/s 0.5 s later with gas held`);
  check("8c. clean landing: physics upright at once, body eased flat", quatAngle(car.quat, new THREE.Quaternion()) < 1e-6 &&
    quatAngle(car._visQuat, car.quat) < 0.01, `body ${(quatAngle(car._visQuat, car.quat) * 57.3).toFixed(2)}° from flat`);
}

/* =====================================================================
   9. Bad landing (upside down): tumble, lose speed, upright in 0.8 s
   ===================================================================== */
{
  const car = newCar();
  car.placeAt(0, 0, 0, 3);
  car.onGround = false;
  car.vel.set(0, -2, 14);
  car.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI); // on its roof
  let speedBefore = 0, landed = -1, upright = -1, speedAfterHit = 0, steered = false, headingAtLanding = 0;
  run(car, 120, () => C({ throttle: 1, steer: 1 }), FLAT, RT, DT, (i, c) => {
    if (landed < 0 && c.onGround) { landed = i; speedAfterHit = c.speed2D(); headingAtLanding = c.heading; }
    if (landed < 0) speedBefore = c.speed2D();
    if (landed >= 0 && upright < 0 && !c.tumbling) upright = i;
    // Steer is held the whole time: the heading must not move while tumbling.
    if (c.tumbling && c.heading !== headingAtLanding) steered = true;
  });
  check("9. bad landing: tumbles", car.lastLanding && !car.lastLanding.clean);
  check("9b. bad landing: loses speed", speedAfterHit < speedBefore * 0.7,
    `${f2(speedBefore)} → ${f2(speedAfterHit)} u/s`);
  const t = (upright - landed) * DT;
  check("9c. bad landing: upright and driving within ~0.8 s", upright > 0 && t <= R.tumbleTime + 2 * DT &&
    car.roof().y > 0.999, `${f2(t)} s`);
  check("9d. no control while tumbling", !steered);
}

/* =====================================================================
   10. Ceiling and wall planes
   ===================================================================== */
{
  const world = {
    groundHeightAt: () => 0,
    ceilingHeight: 6,
    // A 40 × 40 box centred on the origin. Normals point inwards.
    wallPlanes: [
      { nx: 1, nz: 0, d: -20 }, { nx: -1, nz: 0, d: -20 },
      { nx: 0, nz: 1, d: -20 }, { nx: 0, nz: -1, d: -20 },
    ],
  };
  const car = newCar();
  let maxRoof = 0, hit = false;
  run(car, 200, (i, c) => C({ jump: i === 0 || i === 7, pitch: !c.onGround && i > 8 && c.nose().y < 0.95 ? 1 : 0, boost: i > 8 }),
    world, RT, DT, (i, c) => { maxRoof = Math.max(maxRoof, c.pos.y + R.carHeight); if (c.hitCeiling) hit = true; });
  check("10. ceiling: roof never goes above ceilingHeight", hit && maxRoof <= world.ceilingHeight + 1e-9,
    `highest roof ${f2(maxRoof)}, ceiling ${world.ceilingHeight}`);
  // Drive flat out into the +Z wall.
  const w = newCar();
  w.placeAt(0, 10, 0);
  let maxZ = -Infinity, bounced = false;
  run(w, 120, () => C({ throttle: 1, boost: true }), world, RT, DT, (i, c) => {
    maxZ = Math.max(maxZ, c.pos.z);
    if (c.vel.z < -1) bounced = true;
  });
  check("10b. wall plane: car stays inside and bounces back", maxZ <= 20 - w.radius + 1e-9 && bounced,
    `deepest z ${f2(maxZ)} (wall at 20, radius ${w.radius})`);
}

/* =====================================================================
   11. Deterministic, and sub-step safe
   ===================================================================== */
function aerialScript(dt) {
  const car = newCar();
  car.vel.set(0, 0, 8);
  const frames = Math.round(1.5 / dt);
  const at = (t) => Math.round(t / dt);
  run(car, frames, (i, c) => C({
    jump: i === 0 || i === at(0.15),
    pitch: i > at(0.15) && i < at(0.6) ? 1 : 0,
    steer: i > at(0.3) && i < at(0.5) ? 0.5 : 0,
    boost: i > at(0.4),
  }), FLAT, RT, dt);
  return car;
}
{
  const a = aerialScript(DT), b = aerialScript(DT);
  const same = a.pos.equals(b.pos) && a.vel.equals(b.vel) && a.quat.equals(b.quat);
  check("11. deterministic: same inputs, identical bits", same);
  const c = aerialScript(DT / 2);
  const dp = a.pos.distanceTo(c.pos);
  check("11b. sub-step safe: 1/120 s lands near the 1/60 s result", dp < 0.6,
    `positions differ by ${f2(dp)} units after 1.5 s of aerial`);
}

/* =====================================================================
   12. Bot helpers
   ===================================================================== */
{
  // flipAt: a target 10 units ahead and to the right. The burst must go that way.
  const car = newCar();
  car.vel.set(0, 0, 6);
  let flipped = false, dir = null;
  const tx = -8, tz = 8; // right of a heading-0 car is -X
  run(car, 40, (i, c) => TP.ai.flipAt(c, tx, tz), FLAT, RT, DT, (i, c) => {
    if (c.flipping && !flipped) { flipped = true; dir = c.flipDir.clone(); }
  });
  const want = new THREE.Vector3(tx, 0, tz).normalize();
  check("12. TP.ai.flipAt: flips toward the target", flipped && dir.dot(want) > 0.9,
    dir ? `flipDir·target = ${f2(dir.dot(want))}` : "never flipped");

  // aerialTo: a point 9 units up and 14 ahead. Get within 2.5 units of it.
  const ac = newCar();
  const target = { x: 0, y: 9, z: 14 };
  let best = Infinity;
  run(ac, 200, (i, c) => TP.ai.aerialTo(c, target.x, target.y, target.z), FLAT, RT, DT, (i, c) => {
    best = Math.min(best, Math.hypot(c.pos.x - target.x, c.pos.y + 0.65 - target.y, c.pos.z - target.z));
  });
  check("12b. TP.ai.aerialTo: reaches a target 9 units up", best < 2.5, `closest ${f2(best)} units`);

  const plan = TP.ai.planJump(3, RT);
  check("12c. TP.ai.planJump picks the right move", TP.ai.planJump(1.5, RT).kind === "single" &&
    plan.kind === "double" && TP.ai.planJump(12, RT).kind === "aerial", `3 units → ${plan.kind} in ${f2(plan.t)} s`);
  const ip = TP.ai.interceptPoint(ac, { x: 0, y: 1, z: 30 }, { x: 0, y: 0, z: -10 });
  check("12d. TP.ai.interceptPoint finds a meeting point", ip && ip.t > 0 && ip.t < 3, ip ? `t ${f2(ip.t)} s at z ${f2(ip.z)}` : "none");
}

/* =====================================================================
   13. Moveset OFF: bit-identical to the classic car
   ===================================================================== */
function classicRun(env) {
  // Deterministic pseudo-random controls (own generator: no Math.random).
  let s = 987654321;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  // A world with a raised ledge and a pit, so landings, drops and falls happen.
  const world = {
    groundHeightAt(x, z) {
      if (Math.hypot(x, z) > 32) return null;       // off the edge
      if (x > 8 && x < 16 && z > -6 && z < 6) return 1.5; // a ledge
      return 0;
    },
    ceilingHeight: 3,   // classic cars must IGNORE these two
    wallPlanes: [{ nx: 1, nz: 0, d: -5 }],
  };
  const cars = [];
  for (let i = 0; i < 4; i++) {
    const c = new env.TP.Car(scene, { index: i, color: 0xffffff });
    c.placeAt(Math.cos(i * 1.6) * 10, Math.sin(i * 1.6) * 10, i * 1.3);
    cars.push(c);
  }
  const tunings = [undefined, env.TP.CAR_TUNING, env.TP.modeTuning({ bumpScale: 1.4, pivot: 0.8 }), env.TP.modeTuning({ grip: 6, maxSpeed: 19 })];
  const ctrls = cars.map(() => C());
  const buf = Buffer.alloc(8);
  let h = 0xcbf29ce484222325n;
  const mix = (x) => { buf.writeDoubleLE(x); for (const byte of buf) { h ^= BigInt(byte); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; } };
  for (let f = 0; f < 3600; f++) {
    cars.forEach((c, i) => {
      if (f % 20 === i * 5) {
        const k = ctrls[i];
        k.throttle = rnd() * 2.4 - 0.7; k.throttle = Math.max(-1, Math.min(1, k.throttle));
        k.steer = rnd() * 2 - 1;
        k.pitch = rnd() * 2 - 1;
        k.boost = rnd() < 0.3;
        k.jump = rnd() < 0.25;
      }
      // Respawn a car that fell into the void, like the arenas do.
      if (c.pos.y < -20) c.placeAt(0, i * 3, 0);
      c.update(DT, ctrls[i], world, tunings[i]);
    });
    env.TP.Car.collideAll(cars, tunings[2]);
    for (const c of cars) { mix(c.pos.x); mix(c.pos.y); mix(c.pos.z); mix(c.vel.x); mix(c.vel.y); mix(c.vel.z); mix(c.heading); mix(c.boost); mix(c.onGround ? 1 : 0); }
  }
  return h.toString(16);
}
{
  const now = classicRun(E);
  let oldSrc = null;
  try {
    oldSrc = execFileSync("git", ["show", `${CLASSIC_REF}:games/shared/js/car.js`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) { /* no git, or the commit isn't in this clone */ }
  if (oldSrc) {
    const before = classicRun(loadEngine(oldSrc));
    check("13. moveset OFF: bit-identical to car.js before the moveset", now === before,
      `fingerprint ${now} vs ${before} @ ${CLASSIC_REF.slice(0, 7)}`);
  } else {
    console.log(`note  13. git commit ${CLASSIC_REF.slice(0, 7)} not available, using the stored fingerprint`);
  }
  check("13b. moveset OFF: matches the stored fingerprint", now === CLASSIC_FINGERPRINT, `fingerprint ${now}`);
  // Opting in must not leak into other cars: a classic car next to a rocket car is unchanged.
  const probe = newCar(E, { rocket: false });
  check("13c. classic car never runs the rocket step", !probe.usesRocket(T) && !probe.usesRocket(TP.modeTuning({ pivot: 0.8 })) &&
    probe.usesRocket(RT));
}


/* =====================================================================
   14. Flip reset: wheels on the ball give the air move back
   ===================================================================== */
// Drop a car onto a still ball (centre (0, 5, 0), radius 1.2) with its air
// move already spent. Stop at the first touch and report what it was.
function dropOnBall(setup) {
  const ball = { x: 0, y: 5, z: 0 }, radius = 1.2;
  const car = newCar();
  car.placeAt(0, 0, 0, 9);
  car.onGround = false;
  setup(car);
  car.update(DT, C(), FLAT, RT);    // first airborne step starts the airtime...
  car.airJumpUsed = true;          // ...then mark the second jump as spent
  for (let i = 0; i < 120; i++) {
    car.update(DT, C(), FLAT, RT);
    const hit = TP.Car.sphereContact(car, ball, radius);
    if (hit) {
      const reset = hit.wheels ? car.resetAirMoves() : false;
      return { car, hit, reset };
    }
  }
  return { car, hit: null, reset: false };
}
{
  const flat = dropOnBall(() => {});
  check("14. flip reset: wheels-first onto the ball restores the air move",
    flat.hit && flat.hit.wheels && flat.reset && flat.car.canAirJump && flat.car.airTime === 0,
    flat.hit ? `down·normal ok, canAirJump ${flat.car.canAirJump}` : "never touched");
  // ...and the restored move really works: press jump with a direction = flip.
  let flipped = false;
  flat.car.update(DT, C(), FLAT, RT);
  flat.car.update(DT, C({ jump: true, pitch: 1 }), FLAT, RT);
  flipped = flat.car.flipping && flat.car.flipStarted;
  check("14b. flip reset: a flip works after the reset (flipStarted fires)", flipped);

  const nose = dropOnBall((c) => c.quat.setFromAxisAngle(AXIS(1, 0, 0), Math.PI / 2)); // nose straight down
  check("14c. nose-first onto the ball: no reset", nose.hit && !nose.hit.wheels && !nose.car.canAirJump,
    nose.hit ? "touched, wheels: false" : "never touched");
  const side = dropOnBall((c) => c.quat.setFromAxisAngle(AXIS(0, 0, 1), Math.PI / 2)); // on its side
  check("14d. side-first onto the ball: no reset", side.hit && !side.hit.wheels && !side.car.canAirJump);
  const tip = dropOnBall((c) => { c.pos.z = -1.45; });  // flat, but the ball is under the very nose
  check("14e. wheels-down but ball under the nose tip (outside the wheelbase): no reset",
    tip.hit && !tip.hit.wheels, tip.hit ? `contact z ${f2(tip.hit.point.z - tip.car.pos.z)} from centre` : "never touched");
  // Driving into the ball side-on, upright: a bumper hit, not a wheels hit.
  const bump = TP.Car.sphereContact(Object.assign(newCar(), {}), { x: 0, y: 1, z: 2.3 }, 1.2);
  check("14f. bumper touch on the ground is not a wheels contact", bump && !bump.wheels);
  const g = newCar();
  check("14g. resetAirMoves does nothing on the ground", g.resetAirMoves() === false && g.onGround);
  check("14h. car.airborne mirrors onGround", g.airborne === false && flat.car.airborne === true);
}

console.log(failures ? `\nRESULT: FAIL (${failures} check${failures > 1 ? "s" : ""} failed)` : "\nRESULT: PASS (all moveset checks)");
process.exit(failures ? 1 : 0);
