/* =====================================================================
   car.js — the rocket car: its 3D model, its arcade physics, car-vs-car
   bumping, and steering helpers the bots use.

   This is the shared core every mode builds on (board pieces, every
   minigame, and later the other game modes), so the handling only has
   to be tuned in one place.

   Coordinate conventions (used everywhere):
     • Y is up. The ground is the X/Z plane.
     • `heading` is the car's yaw in radians. heading 0 faces +Z.
       The forward direction is (sin(heading), 0, cos(heading)).
     • Increasing heading turns the car LEFT, so steering right
       (steer = +1) lowers the heading.
   ===================================================================== */
(function () {
  "use strict";
  const { clamp, wrapAngle } = TP.util;

  /* Handling numbers. Minigames can override any of these by passing a
     `tuning` object to update() (e.g. Sumo makes bumps stronger). */
  const DEFAULT_TUNING = {
    accel: 28,          // forward acceleration from the throttle (units/s²)
    brake: 40,          // deceleration when holding reverse while still rolling forward
    reverseMax: 9,      // top speed backwards
    maxSpeed: 17,       // top speed without boost
    boostAccel: 34,     // extra acceleration while boosting
    boostMax: 27,       // top speed while boosting
    boostDrain: 38,     // boost meter used per second
    boostRegen: 14,     // boost meter refilled per second when not boosting
    turnRate: 2.8,      // radians/second at full lock
    airTurnRate: 2.2,   // turning while airborne (air control)
    grip: 10,           // how hard tyres kill sideways sliding (higher = less drift)
    drag: 0.7,          // rolling resistance when coasting
    jump: 10.5,         // upward speed given by a jump
    gravity: 28,
    bumpScale: 1.0,     // multiplier for car-vs-car bump strength
    pivot: 0.25,        // turning allowed when stopped (fraction of full lock)
  };
  TP.CAR_TUNING = DEFAULT_TUNING;

  /* ---------- One car feel across Rocket Rumble ----------
     Every mode drives the same car, so skills carry over from mode to
     mode. A mode may only adjust the settings listed here (for example,
     Sumo Ring's harder bumps). Anything else (acceleration, turning,
     jump height, gravity, boost drain) is fixed. Changing it is a
     Director decision, and it changes the car in every mode.

     Usage in a mode: const tuning = TP.modeTuning({ bumpScale: 1.2 });
     Settings that aren't allowed are ignored, with a console warning, so
     a mistake shows up in testing. */
  const MODE_TUNABLE = ["bumpScale", "grip", "maxSpeed", "boostMax", "pivot"];
  TP.MODE_TUNABLE = MODE_TUNABLE;
  /* The optional second argument switches on extra movement layers that
     are shared by every mode that wants them (it is NOT a way to change
     the car feel numbers):
       TP.modeTuning({ pivot: 0.8 }, { moveset: "rocket" })
     turns on the rocket moveset (double jump, dodge flips, full 3D air
     control, aerial boost; see "Rocket moveset" below). Leave it out
     and the car behaves exactly as it always has. */
  const MOVESETS = ["rocket"];
  TP.MOVESETS = MOVESETS;
  TP.modeTuning = function (overrides = {}, opts) {
    const t = Object.assign({}, DEFAULT_TUNING);
    for (const [k, v] of Object.entries(overrides)) {
      if (MODE_TUNABLE.includes(k)) t[k] = v;
      else console.warn(`[Rocket Rumble] "${k}" is part of the shared car feel and can't be changed per mode. Ignored.`);
    }
    if (opts && opts.moveset) {
      if (MOVESETS.includes(opts.moveset)) t.moveset = opts.moveset;
      else console.warn(`[Rocket Rumble] Unknown moveset "${opts.moveset}". Known: ${MOVESETS.join(", ")}. Ignored.`);
    }
    return t;
  };

  /* ---------- Rocket moveset: the shared numbers ----------
     These belong to the car feel, exactly like DEFAULT_TUNING: one set of
     numbers for every mode that uses the rocket moveset, so a flip feels
     the same in Deflect Duel as anywhere else. Changing one is a Director
     decision. The moveset reuses the normal car numbers for everything
     else (jump 10.5, gravity 28, boostAccel 34, boostMax 27, drain/regen).

     Spin directions, used everywhere below and in car.angVel:
       pitch  + = nose up        (ctrl.pitch +1, keyboard W / stick up)
       yaw    + = turn right     (ctrl.steer +1), same sense as driving
       roll   + = roll right     (right side goes down)                 */
  const ROCKET_MOVES = {
    // --- Second jump / flip ---
    airJumpWindow: 1.25,  // seconds after leaving the ground that the second jump (or flip) is allowed
    flipDeadzone: 0.35,   // direction held (|pitch, steer|) below this = plain double jump, above = flip
    flipForward: 8,       // speed added along the car's nose by a front flip (units/s)
    flipBackward: 7,      // speed added backwards by a back flip (a touch weaker, so retreating costs)
    flipSide: 6,          // speed added sideways by a side flip
    flipDuration: 0.6,    // seconds for the flip's full 360° turn

    // --- Air control (when not flipping) ---
    airPitchRate: 3.6,    // top pitch speed with the stick held (radians/s, ~206°/s)
    airYawRate: 2.8,      // top yaw speed in the air (radians/s, ~160°/s)
    airRotResponse: 10,   // how fast the spin follows the stick, AND how fast it stops when you let
                          // go (1/s). High = precise and "locked", low = floaty. 10 ≈ 0.1 s to settle.

    // --- Landing ---
    landUprightDeg: 45,   // wheels within this angle of the ground on touchdown = clean landing
    landSettleRate: 14,   // how fast the body visually snaps flat after a clean landing (1/s)
    tumbleTime: 0.8,      // a bad landing tumbles for this long, then the car is upright again
    tumbleSpeedKeep: 0.6, // fraction of horizontal speed kept when a bad landing starts
    tumbleFriction: 2.5,  // sliding friction while tumbling (1/s)

    // --- World limits (only when the world supplies them) ---
    carHeight: 1.3,       // roof height above car.pos.y, for ceiling contact
    ceilingBounce: 0.3,   // fraction of upward speed returned (downwards) when the roof hits the ceiling
    wallBounce: 0.5,      // fraction of into-the-wall speed returned when hitting a wall plane

    // --- Bots ---
    aiSecondJumpDelay: 0.12, // bots press the second jump this long after leaving the ground
  };
  TP.ROCKET_MOVES = ROCKET_MOVES;

  // Scratch objects reused by the rocket maths, so the physics step
  // creates no garbage (it runs for every car, every sub-step).
  const AXIS_X = new THREE.Vector3(1, 0, 0);
  const AXIS_Y = new THREE.Vector3(0, 1, 0);
  const AXIS_Z = new THREE.Vector3(0, 0, 1);
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _q1 = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const BODY_PIVOT = new THREE.Vector3(0, 0.65, 0); // the body spins around its middle, not its wheels

  // Quaternion for "wheels down, nose along `heading`" (pure yaw).
  function yawQuat(out, heading) {
    return out.setFromAxisAngle(AXIS_Y, heading);
  }

  /* The heading (yaw) of any 3D orientation. Normally it's just where the
     nose points, flattened onto the ground. When the nose points almost
     straight up or down that flattened direction is meaningless, so we
     use the roof instead: nose up means the roof faces backwards, nose
     down means the roof faces forwards. */
  function headingOf(q, fallback) {
    const nose = _v1.copy(AXIS_Z).applyQuaternion(q);
    if (Math.hypot(nose.x, nose.z) > 0.2) return Math.atan2(nose.x, nose.z);
    const up = _v2.copy(AXIS_Y).applyQuaternion(q);
    const s = nose.y > 0 ? -1 : 1;
    if (Math.hypot(up.x, up.z) < 1e-6) return fallback;
    return Math.atan2(s * up.x, s * up.z);
  }

  /* ---------- 3D model ---------- */
  // Built from simple boxes/cylinders so we need no model files.
  // The car's nose points toward +Z in model space.
  function buildCarMesh(color) {
    const g = new THREE.Group();

    const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1f2e, metalness: 0.2, roughness: 0.7 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x9fd3ff, metalness: 0.6, roughness: 0.1, emissive: 0x10263f });

    // Body is in its own group so it can tilt (pitch/roll) without
    // tilting the floating player marker.
    const body = new THREE.Group();
    g.add(body);

    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 3.0), paint);
    chassis.position.y = 0.62;
    body.add(chassis);

    // A sloped nose: a thinner box angled down at the front.
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.3, 0.9), paint);
    nose.position.set(0, 0.55, 1.55);
    nose.rotation.x = 0.25;
    body.add(nose);

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 1.3), glass);
    cabin.position.set(0, 1.12, -0.25);
    body.add(cabin);

    // Rear spoiler: two posts plus a wing.
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.08, 0.45), dark);
    wing.position.set(0, 1.25, -1.35);
    body.add(wing);
    for (const sx of [-0.6, 0.6]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.35, 0.1), dark);
      post.position.set(sx, 1.05, -1.35);
      body.add(post);
    }

    // Racing stripe down the middle, in white.
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.02, 3.02), stripeMat);
    stripe.position.set(0, 0.905, 0);
    body.add(stripe);

    // Headlights (glowing, front) and tail lights (red, back).
    const headMat = new THREE.MeshBasicMaterial({ color: 0xfff6d5 });
    const tailMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
    for (const sx of [-0.6, 0.6]) {
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.16, 0.06), headMat);
      head.position.set(sx, 0.62, 1.99);
      body.add(head);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, 0.06), tailMat);
      tail.position.set(sx, 0.7, -1.52);
      body.add(tail);
    }

    // Rocket nozzle at the back — the boost flame comes out of here.
    const nozzle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.36, 0.5, 14, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x9aa3b8, metalness: 0.8, roughness: 0.3, side: THREE.DoubleSide })
    );
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(0, 0.65, -1.7);
    body.add(nozzle);

    // Four wheels.
    const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.36, 16);
    wheelGeo.rotateZ(Math.PI / 2); // cylinders stand upright by default; lay them on their side
    for (const [x, z] of [[-0.95, 1.0], [0.95, 1.0], [-0.95, -1.05], [0.95, -1.05]]) {
      const w = new THREE.Mesh(wheelGeo, dark);
      w.position.set(x, 0.42, z);
      body.add(w);
    }

    // Boost flame out the back. Hidden unless boosting.
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.32, 1.4, 10),
      new THREE.MeshBasicMaterial({ color: 0xffa62b, transparent: true, opacity: 0.9 })
    );
    flame.rotation.x = -Math.PI / 2; // point the cone's tip backwards (-Z)
    flame.position.set(0, 0.65, -2.2);
    flame.visible = false;
    body.add(flame);

    // Floating arrow in the player's colour so you can always find your car.
    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.4, 0.7, 4),
      new THREE.MeshBasicMaterial({ color })
    );
    marker.rotation.x = Math.PI; // tip points down at the car
    marker.position.y = 2.6;
    g.add(marker);

    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
    marker.castShadow = false;
    flame.castShadow = false;

    g.userData = { body, flame, marker };
    return g;
  }
  TP.buildCarMesh = buildCarMesh;

  /* =====================================================================
     Car — position, velocity and handling for one player.
     ===================================================================== */
  class Car {
    constructor(scene, player) {
      this.player = player;
      this.index = player.index;
      this.mesh = buildCarMesh(player.color);
      scene.add(this.mesh);

      this.pos = new THREE.Vector3();
      this.vel = new THREE.Vector3();
      this.heading = 0;
      this.boost = 100;        // boost meter 0..100
      this.boosting = false;
      this.onGround = true;
      this.radius = 1.35;      // collision circle size (top-down)
      this.out = false;        // eliminated / fell off — skip updates
      this.pitch = 0;          // visual tilt only
      this.roll = 0;

      /* ---- Rocket moveset state (only used when the moveset is on) ----
         Turn it on per car with `car.moveset = "rocket"`, or for every
         car at once with TP.modeTuning({...}, { moveset: "rocket" }). */
      this.moveset = null;
      this.quat = new THREE.Quaternion();  // full 3D body orientation (wheels-down + yaw while driving)
      this.angVel = new THREE.Vector3();   // air spin rates, car's own axes: x = pitch, y = yaw, z = roll (see ROCKET_MOVES)
      this.airTime = 0;        // seconds since the wheels left the ground
      this.jumped = false;     // left the ground by jumping (not by driving off an edge or being bumped)
      this.airJumpUsed = false;// the second jump / flip has been spent for this airtime
      this.doubleJumped = false;
      this.flipping = false;   // true for the whole 0.6 s of a dodge flip: modes may treat contact as a hard hit
      this.flipDir = new THREE.Vector3(); // world-space horizontal unit vector the flip is throwing the car along
      this.flipProgress = 0;   // 0..1 through the current flip
      this.tumbling = false;   // recovering from a bad landing (no control until upright)
      this.lastLanding = null; // { clean: bool, speed } for the most recent touchdown (handy for sounds/fx)
      this.hitCeiling = false; // true on a step where the roof touched world.ceilingHeight
      this._flipT = 0;
      this._flipQ0 = new THREE.Quaternion();
      this._flipAxis = new THREE.Vector3();
      this._tumbleT = 0;
      this._tumbleQ0 = new THREE.Quaternion();
      this._visQuat = new THREE.Quaternion(); // what the body LOOKS like (eases flat after landing)
      this._airLast = false;   // was airborne at the end of the last rocket step
      this._rocket = false;    // the last update ran the rocket moveset (syncMesh poses the body from quat)
    }

    // Is the rocket moveset on for this update?
    usesRocket(tuning) {
      return this.moveset === "rocket" || !!(tuning && tuning.moveset === "rocket");
    }

    // Unit vector the nose points along in 3D (rocket moveset; for the
    // classic car this is the same as forward()).
    nose() {
      return new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat);
    }

    // Unit vector out of the roof in 3D (rocket moveset).
    roof() {
      return new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
    }

    placeAt(x, z, heading, y = 0) {
      this.pos.set(x, y, z);
      this.vel.set(0, 0, 0);
      this.heading = heading;
      this.onGround = true;
      // Reset the rocket moveset too (harmless for the classic car).
      yawQuat(this.quat, heading);
      this._visQuat.copy(this.quat);
      this.angVel.set(0, 0, 0);
      this.flipping = false;
      this.flipProgress = 0;
      this.tumbling = false;
      this.airJumpUsed = false;
      this._airLast = false;
      this.syncMesh(0);
    }

    // Unit vector the nose points along.
    forward() {
      return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    }

    speed2D() {
      return Math.hypot(this.vel.x, this.vel.z);
    }

    /* One physics step.
       ctrl   — controls in the shape described in input.js
       world  — must provide groundHeightAt(x, z): a height, or null for
                "no floor here" (a pit / off the edge of a platform). */
    update(dt, ctrl, world, tuning) {
      if (this.out) return;
      const T = tuning || DEFAULT_TUNING;
      // Opted into the rocket moveset? It has its own step (which reuses
      // the classic driving step below while the wheels are down).
      if (this.moveset === "rocket" || T.moveset === "rocket") {
        this._rocketUpdate(dt, ctrl, world, T);
        return;
      }
      const vF = this._driveStep(dt, ctrl, world, T);
      this.syncMesh(dt, vF);
    }

    /* The classic arcade step: driving, steering, the single jump, a
       little air steering, gravity and landing. This is the car every mode
       has always had; the code is unchanged, only moved here so the rocket
       moveset can reuse it for driving. Returns the forward speed (vF),
       which syncMesh uses for cosmetic touches. */
    _driveStep(dt, ctrl, world, T) {
      const f = this.forward();

      // Split velocity into "along the nose" and "sideways" parts. Cars
      // feel like cars because we treat these two very differently.
      const right = new THREE.Vector3(-f.z, 0, f.x);          // car's right-hand side (f × up)
      let vF = this.vel.x * f.x + this.vel.z * f.z;           // forward speed (signed)
      let vS = this.vel.x * right.x + this.vel.z * right.z;   // sideways speed
      // Forward speed at the START of this step, before our own throttle or
      // boost. The speed caps below use it to tell "speed you already had"
      // (from a boost or a bump, allowed to bleed off) apart from speed
      // you're adding right now with the gas (hard-capped).
      const vF0 = vF;

      /* ---------- Boost meter ---------- */
      this.boosting = !!ctrl.boost && this.boost > 0;
      if (this.boosting) this.boost = Math.max(0, this.boost - T.boostDrain * dt);
      else this.boost = Math.min(100, this.boost + T.boostRegen * dt);

      if (this.onGround) {
        /* ---------- Steering ----------
           Real cars can't turn on the spot, so turning scales with speed
           (full turning from ~5 units/s). Sign of vF flips steering when
           reversing, like a real car. A little "minimum turn" keeps it
           from feeling stuck when stopped. */
        // `pivot` = how much you can turn while (nearly) stopped, 0..1.
        const speedFactor = clamp(Math.abs(vF) / 5, T.pivot, 1) * (vF < -0.5 ? -1 : 1);
        this.heading -= ctrl.steer * T.turnRate * speedFactor * dt;

        /* ---------- Throttle / brake ---------- */
        const th = ctrl.throttle;
        if (th > 0) vF += th * T.accel * dt;
        else if (th < 0) vF += th * (vF > 0.5 ? T.brake : T.accel * 0.6) * dt;
        else vF *= Math.exp(-T.drag * dt); // coasting

        // Tyre grip: remove most sideways speed every frame.
        vS *= Math.exp(-T.grip * dt);

        /* ---------- Jump ---------- */
        if (ctrl.jump && !this._jumpHeld) {
          this.vel.y = T.jump;
          this.onGround = false;
        }
      } else {
        // In the air you can still rotate (air control) but tyres don't grip.
        this.heading -= ctrl.steer * T.airTurnRate * dt;
        vS *= Math.exp(-0.6 * dt);
      }
      this._jumpHeld = !!ctrl.jump; // must release jump before jumping again

      if (this.boosting) vF += T.boostAccel * dt;

      /* ---------- Speed caps ----------
         Gas alone tops out at maxSpeed; boost raises that to boostMax.
         Speed you ALREADY had (vF0, from a boost that just ended or from
         being hit) may be above the cap: it's kept, then bled off
         smoothly, instead of snapping down. Throttle can't add to it.
         The same rule backwards: reversing yourself tops out at
         reverseMax, but a head-on ram can knock you back faster for a
         moment. (Measuring from vF instead of vF0 let held gas creep up
         to almost boost speed. Fixed 2026-11-27.) */
      const cap = this.boosting ? T.boostMax : T.maxSpeed;
      const hi = Math.max(cap, Math.min(vF0, T.boostMax));
      const lo = Math.min(-T.reverseMax, Math.max(vF0, -T.boostMax));
      vF = clamp(vF, lo, hi);
      if (!this.boosting && vF > T.maxSpeed) vF = TP.util.damp(vF, T.maxSpeed, 1.5, dt);
      if (vF < -T.reverseMax) vF = TP.util.damp(vF, -T.reverseMax, 1.5, dt);

      // Rebuild horizontal velocity using the (possibly new) heading.
      const f2 = this.forward();
      const r2 = new THREE.Vector3(-f2.z, 0, f2.x); // car's right after turning
      this.vel.x = f2.x * vF + r2.x * vS;
      this.vel.z = f2.z * vF + r2.z * vS;

      /* ---------- Gravity & ground ---------- */
      const prevY = this.pos.y;
      this.vel.y -= T.gravity * dt;
      this.pos.addScaledVector(this.vel, dt);

      const g = world.groundHeightAt(this.pos.x, this.pos.z);
      // Land only if there's a floor here AND we crossed down through it
      // during this step (we were at/above it last step, at/below it now).
      // A car that already dropped below a ledge stays below — it can't
      // pop back up onto the platform, and big steps can't tunnel through.
      if (g !== null && this.pos.y <= g && prevY >= g - 0.05 && this.vel.y <= 0) {
        this.pos.y = g;
        this.vel.y = 0;
        this.onGround = true;
      } else if (g === null || this.pos.y > g + 0.05) {
        this.onGround = false;
      }

      return vF;
    }

    /* =====================================================================
       Rocket moveset — one physics step.

       The car is in one of three states, and each step handles exactly one:

         DRIVING  (wheels down)   → the classic _driveStep, untouched. So
                                    acceleration, turning, grip, boost and
                                    the FIRST jump are identical to every
                                    other mode. The body stays wheels-down.
         AIRBORNE                 → full 3D air control, the second jump /
                                    dodge flip, boost along the nose.
         TUMBLING (bad landing)   → no control for up to 0.8 s while the car
                                    rights itself, then back to DRIVING.

       Everything is plain "integrate one step" maths with no timers based
       on wall-clock time, so it is deterministic and gives (near) the same
       result at 1/60 s or at smaller sub-steps.
       ===================================================================== */
    _rocketUpdate(dt, ctrl, world, T) {
      const R = ROCKET_MOVES;
      this._rocket = true;
      this.hitCeiling = false;
      // "Jump went down this step". The classic step uses the same rule
      // (_jumpHeld), so a held button never triggers two jumps.
      const jumpEdge = !!ctrl.jump && !this._jumpHeld;
      let vF = 0;

      if (this.tumbling) {
        this._tumbleStep(dt, ctrl, world, T);
      } else if (this.onGround) {
        /* ---------- DRIVING: the classic step, exactly ---------- */
        vF = this._driveStep(dt, ctrl, world, T);
        yawQuat(this.quat, this.heading); // wheels stay down while driving
        this.angVel.set(0, 0, 0);
        if (!this.onGround) {
          // We just left the ground: either the classic jump fired (it
          // fires exactly when jumpEdge is true on the ground), or we drove
          // off an edge. Start a fresh airtime either way.
          this._startAirtime(jumpEdge);
        }
        this._applyWorldLimits(world);
      } else {
        /* ---------- AIRBORNE ---------- */
        // Launched by something outside update() (a bump pop, a mode
        // setting vel.y)? Then this is a fresh airtime that didn't start
        // with our jump.
        if (!this._airLast) this._startAirtime(false);
        this._airStep(dt, ctrl, world, T, jumpEdge);
      }

      this._airLast = !this.onGround;
      this.syncMesh(dt, vF);
    }

    // Reset the per-airtime counters when the wheels leave the ground.
    _startAirtime(byJump) {
      this.airTime = 0;
      this.jumped = byJump;
      this.airJumpUsed = false;
      this.doubleJumped = false;
    }

    /* ---------- AIRBORNE step ---------- */
    _airStep(dt, ctrl, world, T, jumpEdge) {
      const R = ROCKET_MOVES;

      // Boost meter: same drain and regen as on the ground.
      this.boosting = !!ctrl.boost && this.boost > 0;
      if (this.boosting) this.boost = Math.max(0, this.boost - T.boostDrain * dt);
      else this.boost = Math.min(100, this.boost + T.boostRegen * dt);

      this.airTime += dt;

      /* ---------- Second jump: double jump or dodge flip ----------
         One per airtime, within airJumpWindow of leaving the ground.
         No direction held  → double jump: another full jump upwards (on
                              top of any upward speed you still have, and
                              it cancels a fall).
         A direction held   → dodge flip that way: a burst of horizontal
                              speed plus a 360° spin. Front flip = pitch +
                              (W / stick up, the same key as "drive"),
                              side flip = steer. Diagonals mix the two. */
      if (jumpEdge && !this.airJumpUsed && this.airTime <= R.airJumpWindow) {
        this.airJumpUsed = true;
        const fIn = ctrl.pitch || 0, sIn = ctrl.steer || 0;
        const mag = Math.hypot(fIn, sIn);
        if (mag >= R.flipDeadzone) this._startFlip(fIn / mag, sIn / mag);
        else {
          this.vel.y = Math.max(this.vel.y, 0) + T.jump;
          this.doubleJumped = true;
        }
      }
      this._jumpHeld = !!ctrl.jump;

      /* ---------- Orientation ---------- */
      if (this.flipping) {
        // The flip is a fixed animation of the PHYSICS orientation: the
        // angle is worked out from time-into-flip (not added up step by
        // step), so it ends at exactly 360° whatever the step size.
        this._flipT += dt;
        const k = Math.min(1, this._flipT / R.flipDuration);
        this.flipProgress = k;
        _q1.setFromAxisAngle(this._flipAxis, k * Math.PI * 2);
        this.quat.copy(this._flipQ0).multiply(_q1);
        if (k >= 1) {
          this.flipping = false;
          this.quat.copy(this._flipQ0); // a full turn lands back exactly where it started
          this.angVel.set(0, 0, 0);
        }
      } else {
        // Air control. Each spin rate eases toward "stick × top rate", and
        // back to zero when the stick is centred. That easing IS the
        // angular damping: let go and the car stops turning in ~0.1 s, so
        // aiming feels precise instead of floaty. Roll has no control (no
        // button for it), it only ever eases back to zero.
        const a = 1 - Math.exp(-R.airRotResponse * dt);
        this.angVel.x += ((ctrl.pitch || 0) * R.airPitchRate - this.angVel.x) * a;
        this.angVel.y += ((ctrl.steer || 0) * R.airYawRate - this.angVel.y) * a;
        this.angVel.z += (0 - this.angVel.z) * a;
        // Turn the rates into one small rotation about the car's OWN axes.
        // Model space: +X is the car's left, +Y the roof, +Z the nose.
        //   nose up    = rotate about -X,  yaw right = rotate about -Y,
        //   roll right = rotate about +Z.
        _v1.set(-this.angVel.x, -this.angVel.y, this.angVel.z);
        const ang = _v1.length() * dt;
        if (ang > 1e-9) {
          _q1.setFromAxisAngle(_v1.normalize(), ang);
          this.quat.multiply(_q1).normalize();
        }
      }
      this.heading = headingOf(this.quat, this.heading);

      /* ---------- Aerial boost ----------
         Thrust along wherever the nose points in 3D. Gravity still pulls,
         so boosting straight up climbs slowly (34 thrust vs 28 gravity),
         and pitching up then boosting is how you fly up to a ball.
         Boost can't push you past boostMax, but speed you already had
         (from a flip, a fall, a bump) is never cut by boosting. */
      if (this.boosting) {
        const s0 = this.vel.length();
        _v1.copy(AXIS_Z).applyQuaternion(this.quat);
        this.vel.addScaledVector(_v1, T.boostAccel * dt);
        const cap = Math.max(T.boostMax, s0);
        const s1 = this.vel.length();
        if (s1 > cap) this.vel.multiplyScalar(cap / s1);
      }

      // Horizontal speed above boostMax (a flip on top of full boost)
      // bleeds off smoothly, like the ground cap does.
      const h = Math.hypot(this.vel.x, this.vel.z);
      if (h > T.boostMax) {
        const k = TP.util.damp(h, T.boostMax, 1.5, dt) / h;
        this.vel.x *= k;
        this.vel.z *= k;
      }

      /* ---------- Gravity, move, world limits, landing ---------- */
      const prevY = this.pos.y;
      this.vel.y -= T.gravity * dt;
      this.pos.addScaledVector(this.vel, dt);
      this._applyWorldLimits(world);
      this._groundCheck(world, prevY, true);
    }

    // Start a dodge flip. (fu, su) is the held direction as a unit vector:
    // fu = forward (+) / back (-), su = right (+) / left (-).
    _startFlip(fu, su) {
      const R = ROCKET_MOVES;
      this.flipping = true;
      this.flipProgress = 0;
      this._flipT = 0;
      this._flipQ0.copy(this.quat);
      // Spin axis in the car's own frame. A front flip tips the nose down,
      // which is a rotation about +X (the car's left); a right side flip
      // rolls right, a rotation about +Z (the nose). Mix for diagonals.
      this._flipAxis.set(fu, 0, su).normalize();

      // The speed burst is horizontal, in the car's yaw frame, so a flip
      // from a tilted car still throws you along the ground direction.
      const f = this.forward();
      const r = new THREE.Vector3(-f.z, 0, f.x);
      const fwdBurst = fu * (fu >= 0 ? R.flipForward : R.flipBackward);
      const sideBurst = su * R.flipSide;
      const dx = f.x * fwdBurst + r.x * sideBurst;
      const dz = f.z * fwdBurst + r.z * sideBurst;
      this.vel.x += dx;
      this.vel.z += dz;
      const len = Math.hypot(dx, dz) || 1;
      this.flipDir.set(dx / len, 0, dz / len);
    }

    /* Ground contact, shared by the air and tumble steps. Same landing
       rule as the classic car: only land if there's a floor here and we
       crossed down through it this step (no tunnelling, no popping back up
       onto a ledge you already fell past). `fromAir` = this is a real
       touchdown, so judge the landing. */
    _groundCheck(world, prevY, fromAir) {
      const g = world.groundHeightAt(this.pos.x, this.pos.z);
      if (g !== null && this.pos.y <= g && prevY >= g - 0.05 && this.vel.y <= 0) {
        this.pos.y = g;
        this.vel.y = 0;
        this.onGround = true;
        if (fromAir) this._land();
      } else if (g === null || this.pos.y > g + 0.05) {
        this.onGround = false;
      }
    }

    /* Touchdown. Wheels within landUprightDeg of the ground → clean: the
       physics snaps upright at once (so driving starts straight away, with
       the speed kept) and the BODY eases flat over a few frames so it
       doesn't visibly pop. Anything worse (on the roof, on the nose, on a
       side) → a short tumble that costs some speed. */
    _land() {
      const R = ROCKET_MOVES;
      // Read the roof height as a plain number first: headingOf() below
      // reuses the same scratch vector.
      const roofY = _v1.copy(AXIS_Y).applyQuaternion(this.quat).y;
      const speed = Math.hypot(this.vel.x, this.vel.z);
      this.flipping = false;
      this.angVel.set(0, 0, 0);
      this.heading = headingOf(this.quat, this.heading);
      if (roofY >= Math.cos(R.landUprightDeg * Math.PI / 180)) {
        this._visQuat.copy(this.quat);  // the look starts from the tilted pose...
        yawQuat(this.quat, this.heading); // ...the physics is upright now
        this.lastLanding = { clean: true, speed };
      } else {
        this.tumbling = true;
        this._tumbleT = 0;
        this._tumbleQ0.copy(this.quat);
        this.vel.x *= R.tumbleSpeedKeep;
        this.vel.z *= R.tumbleSpeedKeep;
        this.lastLanding = { clean: false, speed };
      }
    }

    /* ---------- TUMBLING step ----------
       No driving, no boost, no jumping: the car slides, slows down and
       rolls back onto its wheels over tumbleTime. It can still fall off an
       edge (gravity and the ground check keep running). */
    _tumbleStep(dt, ctrl, world, T) {
      const R = ROCKET_MOVES;
      this.boosting = false;
      this.boost = Math.min(100, this.boost + T.boostRegen * dt);
      this._jumpHeld = !!ctrl.jump; // a jump held through the tumble must be re-pressed

      this._tumbleT += dt;
      const k = Math.min(1, this._tumbleT / R.tumbleTime);
      // Ease out: most of the righting happens early, then it settles.
      yawQuat(_q2, this.heading);
      this.quat.copy(this._tumbleQ0).slerp(_q2, TP.ease.outCubic(k));

      const fr = Math.exp(-R.tumbleFriction * dt);
      this.vel.x *= fr;
      this.vel.z *= fr;

      const prevY = this.pos.y;
      this.vel.y -= T.gravity * dt;
      this.pos.addScaledVector(this.vel, dt);
      this._applyWorldLimits(world);
      this._groundCheck(world, prevY, false);

      if (k >= 1) {
        this.tumbling = false;
        yawQuat(this.quat, this.heading);
        this._visQuat.copy(this.quat);
        // Fell off an edge mid-tumble? Then it's a fresh airtime (no
        // second jump banked from before the tumble).
        if (!this.onGround) { this._startAirtime(false); this.airJumpUsed = true; }
      }
    }

    /* ---------- Ceiling and walls (rocket moveset only) ----------
       The world may optionally provide:
         world.ceilingHeight   a number: the roof can't go above it. Hitting
                               it kills upward speed (with a small bounce).
         world.wallPlanes      a list of { nx, nz, d }: a vertical wall whose
                               unit normal (nx, nz) points INTO the play area;
                               the inside is where nx*x + nz*z >= d. The car
                               (a circle of car.radius) is pushed back inside
                               and bounces off with wallBounce.
       Example, a 60 × 40 box centred on the origin:
         wallPlanes: [ {nx: 1, nz: 0, d: -30}, {nx: -1, nz: 0, d: -30},
                       {nx: 0, nz: 1, d: -20}, {nx: 0, nz: -1, d: -20} ]
       Worlds that don't provide them simply have no ceiling and no walls
       here (modes can keep clamping cars themselves, as they do today).

       FUTURE (planned, not built): ramps and wall driving. The idea is an
       optional world.surfaceAt(x, y, z) → { height, normal } replacing
       groundHeightAt for rocket cars. "Wheels down" would then mean "roof
       along the surface normal" instead of "roof along +Y": the driving
       step would run in the surface's own frame (forward/right projected
       onto the surface), gravity would be split into along-surface and
       into-surface parts with a small stick force while driving, and the
       landing test would compare the roof with the surface normal instead
       of with +Y. Wall planes would become drivable surfaces with a normal.
       The quaternion body orientation added here is what makes that
       possible without touching the classic car. */
    _applyWorldLimits(world) {
      const R = ROCKET_MOVES;
      const ceil = world.ceilingHeight;
      if (typeof ceil === "number" && this.pos.y + R.carHeight > ceil) {
        this.pos.y = ceil - R.carHeight;
        if (this.vel.y > 0) this.vel.y = -this.vel.y * R.ceilingBounce;
        this.hitCeiling = true;
      }
      const walls = world.wallPlanes;
      if (walls) {
        for (const w of walls) {
          const depth = w.nx * this.pos.x + w.nz * this.pos.z - w.d - this.radius;
          if (depth >= 0) continue;
          this.pos.x -= w.nx * depth; // push back inside (depth is negative)
          this.pos.z -= w.nz * depth;
          const vn = this.vel.x * w.nx + this.vel.z * w.nz; // speed along the inward normal
          if (vn < 0) {
            this.vel.x -= (1 + R.wallBounce) * vn * w.nx;
            this.vel.z -= (1 + R.wallBounce) * vn * w.nz;
          }
        }
      }
    }

    /* Copy physics state onto the 3D model, plus purely cosmetic touches
       (body tilt, flame flicker, bobbing marker). */
    syncMesh(dt, vF = 0) {
      const m = this.mesh;
      m.position.copy(this.pos);
      m.rotation.y = this.heading;
      const { body, flame, marker } = m.userData;

      // Nose up when climbing, nose down when falling.
      // A mode that animates the body itself (Car Fighter's flips and
      // barrel rolls, a side-on runner's air tilt) sets
      // `car.manualBodyPose = true` and writes mesh.userData.body.rotation
      // on its own; we then leave the body's rotation alone.
      if (!this.manualBodyPose && this._rocket) {
        /* Rocket moveset: the body shows the full 3D orientation. The outer
           group already turns with `heading` (so the player marker stays
           upright above the car); the body gets the rest of the rotation,
           i.e. "undo the heading, then apply the orientation". In the air
           the look follows the physics exactly; on the ground it eases flat
           after a landing instead of popping. It spins around the middle
           of the car (BODY_PIVOT), not around the wheels. */
        if (this.onGround && !this.tumbling) {
          this._visQuat.slerp(this.quat, 1 - Math.exp(-ROCKET_MOVES.landSettleRate * (dt || 1)));
        } else {
          this._visQuat.copy(this.quat);
        }
        yawQuat(_q2, this.heading).invert();
        body.quaternion.copy(_q2).multiply(this._visQuat);
        body.position.copy(BODY_PIVOT).sub(_v1.copy(BODY_PIVOT).applyQuaternion(body.quaternion));
      } else if (!this.manualBodyPose) {
        const targetPitch = this.onGround ? 0 : clamp(-this.vel.y * 0.04, -0.5, 0.5);
        this.pitch = TP.util.damp(this.pitch, targetPitch, 8, dt || 1);
        body.rotation.x = this.pitch;
      }

      flame.visible = this.boosting;
      if (this.boosting) {
        const s = 0.8 + Math.random() * 0.5;
        flame.scale.set(1, s, 1);
      }
      marker.position.y = 2.6 + Math.sin(performance.now() * 0.005 + this.index) * 0.15;
    }

    hide() {
      this.mesh.visible = false;
    }

    /* =====================================================================
       Car-vs-car bumping. Treats cars as circles seen from above.
       Returns a list of hits so minigames can react (e.g. Coin Rush
       knocks coins loose on big hits).
       ===================================================================== */
    static collideAll(cars, tuning) {
      const T = tuning || DEFAULT_TUNING;
      const events = [];
      for (let i = 0; i < cars.length; i++) {
        for (let j = i + 1; j < cars.length; j++) {
          const a = cars[i], b = cars[j];
          if (a.out || b.out) continue;
          if (Math.abs(a.pos.y - b.pos.y) > 1.6) continue; // one is jumping over the other

          const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
          const dist = Math.hypot(dx, dz);
          const minDist = a.radius + b.radius;
          if (dist >= minDist || dist < 1e-4) continue;

          // n = unit direction from a to b.
          const nx = dx / dist, nz = dz / dist;

          // 1) Push them apart so they don't overlap.
          const push = (minDist - dist) / 2;
          a.pos.x -= nx * push; a.pos.z -= nz * push;
          b.pos.x += nx * push; b.pos.z += nz * push;

          // 2) Bounce: only if they're moving toward each other.
          const aN = a.vel.x * nx + a.vel.z * nz; // a's speed toward b
          const bN = b.vel.x * nx + b.vel.z * nz;
          const closing = aN - bN;
          if (closing <= 0) continue;

          // Equal masses, slightly bouncy, times the mode's bump multiplier.
          const restitution = 0.9;
          const impulse = (closing * (1 + restitution)) / 2 * T.bumpScale;
          a.vel.x -= nx * impulse; a.vel.z -= nz * impulse;
          b.vel.x += nx * impulse; b.vel.z += nz * impulse;

          // Big hits pop the victim (the slower car) into the air a bit.
          const victim = Math.abs(aN) < Math.abs(bN) ? a : b;
          const attacker = victim === a ? b : a;
          if (closing > 8 && victim.onGround) {
            victim.vel.y = Math.min(7, closing * 0.3);
            victim.onGround = false;
          }
          events.push({ a, b, victim, attacker, impact: closing });
        }
      }
      return events;
    }
  }
  TP.Car = Car;

  /* =====================================================================
     Bot steering helpers. Bots output the same controls a human would.
     ===================================================================== */
  TP.ai = {
    /* Angle the car must turn (radians, -PI..PI) to face point (tx, tz).
       Positive = target is to the car's left. */
    angleTo(car, tx, tz) {
      const desired = Math.atan2(tx - car.pos.x, tz - car.pos.z);
      return wrapAngle(desired - car.heading);
    },

    /* Basic "drive toward a point" controller.
       opts.boostDist — boost when farther than this and lined up
       opts.arrive    — slow down within this distance (0 = ram at full speed) */
    driveTo(car, tx, tz, opts = {}) {
      const diff = TP.ai.angleTo(car, tx, tz);
      const dist = TP.util.dist2D(car.pos.x, car.pos.z, tx, tz);
      const boostDist = opts.boostDist ?? 14;
      const arrive = opts.arrive ?? 0;

      // diff > 0 means turn left, and left is negative steer.
      let steer = clamp(-diff * 2.5, -1, 1);
      let throttle = 1;

      // Target almost directly behind and close: reverse out instead of
      // circling forever.
      if (Math.abs(diff) > 2.4 && dist < 6) {
        throttle = -1;
        steer = -steer; // steering flips in reverse
      }
      // Ease off when arriving at a spot (used for "guard this position").
      if (arrive > 0 && dist < arrive) throttle = dist / arrive - 0.2;

      const boost = dist > boostDist && Math.abs(diff) < 0.25 && car.boost > 25;
      return { throttle, steer, boost, jump: false };
    },

    /* =================================================================
       Rocket moveset helpers for bots. They return the same control
       object a human produces ({ throttle, steer, pitch, boost, jump }),
       so a bot using them obeys exactly the same rules as a player
       (including having to RELEASE jump between the two jumps).
       Call them every step while you want the move to happen; the car's
       own state (onGround, airTime, airJumpUsed, flipping) tells them
       which phase they're in, so they need no memory of their own.
       ================================================================= */

    /* How high (above the take-off ground) a car gets with:
         single jump          → TP.ai.jumpApex()
         double jump, with the second press `t2` seconds after take-off
                              → TP.ai.jumpApex(t2)
       Earlier second presses go higher (the two jumps' speeds add up). */
    jumpApex(t2, tuning) {
      const T = tuning || DEFAULT_TUNING;
      const g = T.gravity, j = T.jump;
      if (t2 === undefined || t2 === null) return (j * j) / (2 * g);
      const vy = j - g * t2;                       // upward speed when the second jump fires
      const y = j * t2 - 0.5 * g * t2 * t2;        // height when it fires
      const v2 = Math.max(vy, 0) + j;
      return y + (v2 * v2) / (2 * g);
    },

    /* Plan a jump to be at height `h` (above the ground) as early as
       possible. Returns
         { kind: "single", t }               one jump, at height h after t seconds
         { kind: "double", t, secondAt }     press jump, then again secondAt s later
         { kind: "aerial" }                  too high to jump to: use aerialTo()
       `t` is time from pressing jump to reaching h on the way up, so a bot
       can start the jump `t` seconds before the ball arrives. */
    planJump(h, tuning) {
      const T = tuning || DEFAULT_TUNING;
      const g = T.gravity, j = T.jump;
      if (h <= 0) return { kind: "single", t: 0 };
      if (h <= TP.ai.jumpApex(null, T)) {
        return { kind: "single", t: (j - Math.sqrt(j * j - 2 * g * h)) / g };
      }
      const t2 = ROCKET_MOVES.aiSecondJumpDelay;
      if (h <= TP.ai.jumpApex(t2, T)) {
        const y2 = j * t2 - 0.5 * g * t2 * t2;
        const v2 = Math.max(j - g * t2, 0) + j;
        const t = t2 + (v2 - Math.sqrt(v2 * v2 - 2 * g * (h - y2))) / g;
        return { kind: "double", t, secondAt: t2 };
      }
      return { kind: "aerial" };
    },

    /* The (pitch, steer) to hold for a flip TOWARD world point (tx, tz):
       pitch + = front flip, steer + = flip right. Always full strength. */
    flipInputToward(car, tx, tz) {
      const diff = TP.ai.angleTo(car, tx, tz); // + = target is on the left
      return { pitch: Math.cos(diff), steer: -Math.sin(diff) };
    },

    /* Jump and dodge-flip toward (tx, tz), e.g. to slam a ball or ram a
       car. Sequence: jump (on the ground) → release → after
       aiSecondJumpDelay press jump again with the direction held. While
       on the ground it also drives at the target. Once the flip is spent
       it just keeps driving at the target (air steer only). */
    flipAt(car, tx, tz, opts = {}) {
      const delay = opts.delay ?? ROCKET_MOVES.aiSecondJumpDelay;
      const drive = TP.ai.driveTo(car, tx, tz, { boostDist: opts.boostDist ?? 999 });
      const ctrl = { throttle: 1, steer: drive.steer, pitch: 0, boost: !!opts.boost && car.boost > 0, jump: false };
      if (car.tumbling) return ctrl;
      if (car.onGround) {
        ctrl.jump = !car._jumpHeld; // press (after a release if it was held)
        return ctrl;
      }
      if (!car.airJumpUsed && car.airTime >= delay && car.airTime <= ROCKET_MOVES.airJumpWindow) {
        const d = TP.ai.flipInputToward(car, tx, tz);
        ctrl.pitch = d.pitch;
        ctrl.steer = d.steer;
        ctrl.jump = !car._jumpHeld;
      } else {
        ctrl.steer = 0; // no air spin before the flip, so it goes where it's aimed
      }
      return ctrl;
    },

    /* Steer the nose toward a 3D point while airborne. Returns
       { pitch, steer, err } where err is the angle (radians) between the
       nose and the target. A simple "spring + brake" controller on the
       car's own pitch/yaw axes, braking with the current spin so it
       doesn't overshoot. */
    aimNose(car, tx, ty, tz) {
      _v1.set(tx - car.pos.x, ty - (car.pos.y + BODY_PIVOT.y), tz - car.pos.z);
      _q1.copy(car.quat).invert();
      _v1.applyQuaternion(_q1); // target in the car's own frame: +X left, +Y roof, +Z nose
      const yawErr = Math.atan2(_v1.x, _v1.z);                     // + = target to the left
      const pitchErr = Math.atan2(_v1.y, Math.hypot(_v1.x, _v1.z)); // + = target above the nose
      const len = _v1.length() || 1;
      const err = Math.acos(clamp(_v1.z / len, -1, 1));
      const pitch = clamp(3 * pitchErr - 0.35 * car.angVel.x, -1, 1);
      const steer = clamp(-3 * yawErr - 0.35 * car.angVel.y, -1, 1);
      return { pitch, steer, err };
    },

    /* Fly to a 3D point (an aerial). On the ground: drive at it, and take
       off once lined up (opts.takeoffDist: only take off within this
       horizontal distance, default always). In the air: a double jump
       early on if the target is high, then point the nose at the target
       and boost when roughly lined up. Aims a little above the target
       (opts.lift, default 10% of the distance) to make up for gravity. */
    aerialTo(car, tx, ty, tz, opts = {}) {
      const R = ROCKET_MOVES;
      const ctrl = { throttle: 1, steer: 0, pitch: 0, boost: false, jump: false };
      if (car.tumbling) return ctrl;
      const dist = Math.hypot(tx - car.pos.x, ty - car.pos.y, tz - car.pos.z);
      if (car.onGround) {
        const drive = TP.ai.driveTo(car, tx, tz, { boostDist: opts.boostDist ?? 999 });
        ctrl.steer = drive.steer;
        ctrl.throttle = drive.throttle;
        ctrl.boost = drive.boost;
        const lined = Math.abs(TP.ai.angleTo(car, tx, tz)) < (opts.takeoffAngle ?? 0.35);
        const near = TP.util.dist2D(car.pos.x, car.pos.z, tx, tz) <= (opts.takeoffDist ?? Infinity);
        if (lined && near) ctrl.jump = !car._jumpHeld;
        return ctrl;
      }
      // Second jump straight up, early, if the target is still well above us.
      if (!car.airJumpUsed && car.airTime >= R.aiSecondJumpDelay && car.airTime <= R.airJumpWindow &&
          ty - car.pos.y > (opts.doubleJumpAbove ?? 2.5) && opts.doubleJump !== false) {
        ctrl.jump = !car._jumpHeld; // pitch/steer stay 0 so it's a double jump, not a flip
        return ctrl;
      }
      const lift = opts.lift ?? dist * 0.1;
      const aim = TP.ai.aimNose(car, tx, ty + lift, tz);
      ctrl.pitch = aim.pitch;
      ctrl.steer = aim.steer;
      ctrl.boost = aim.err < (opts.boostAngle ?? 0.5) && car.boost > 0;
      return ctrl;
    },

    /* Where can this car meet a moving object (a ball)? Steps forward in
       time and returns the first point the car could plausibly reach in
       time, as { x, y, z, t }, or null within opts.maxT (default 3 s).
         pos, vel      the object's position and velocity now
         opts.gravity  the object's gravity (default 0: Deflect Duel's ball
                       flies flat; pass 28 for a car-like falling ball)
         opts.floorY   the object can't go below this height (default 0)
         opts.speed    the car's average travel speed (default 22 with
                       boost to spare, 15 without)
       Height costs extra time: anything above a single jump's reach adds
       roughly the time an aerial needs to climb to it. It's a rough
       estimate meant for bot decisions, not an exact solver. */
    interceptPoint(car, pos, vel, opts = {}) {
      const g = opts.gravity ?? 0;
      const floorY = opts.floorY ?? 0;
      const maxT = opts.maxT ?? 3;
      const speed = opts.speed ?? (car.boost > 20 ? 22 : 15);
      const reach = TP.ai.jumpApex();
      for (let t = 0.05; t <= maxT + 1e-9; t += 0.05) {
        const x = pos.x + vel.x * t;
        const z = pos.z + vel.z * t;
        const y = Math.max(floorY, pos.y + vel.y * t - 0.5 * g * t * t);
        const flat = TP.util.dist2D(car.pos.x, car.pos.z, x, z);
        const climb = Math.max(0, y - car.pos.y);
        const climbTime = climb <= reach ? 0 : 0.35 + (climb - reach) / 5;
        if (flat / speed + climbTime <= t) return { x, y, z, t };
      }
      return null;
    },
  };
})();
