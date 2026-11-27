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
    }

    placeAt(x, z, heading, y = 0) {
      this.pos.set(x, y, z);
      this.vel.set(0, 0, 0);
      this.heading = heading;
      this.onGround = true;
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
      const f = this.forward();

      // Split velocity into "along the nose" and "sideways" parts. Cars
      // feel like cars because we treat these two very differently.
      const right = new THREE.Vector3(-f.z, 0, f.x);          // car's right-hand side (f × up)
      let vF = this.vel.x * f.x + this.vel.z * f.z;           // forward speed (signed)
      let vS = this.vel.x * right.x + this.vel.z * right.z;   // sideways speed

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

      // Speed caps (boost raises the cap).
      const cap = this.boosting ? T.boostMax : T.maxSpeed;
      vF = clamp(vF, -T.reverseMax, Math.max(cap, Math.min(vF, T.boostMax)));
      // ^ the max() keeps speed you already had from a boost or a bump
      //   instead of snapping it down the moment boost ends; drag bleeds it off.
      if (!this.boosting && vF > T.maxSpeed) vF = TP.util.damp(vF, T.maxSpeed, 1.5, dt);

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

      this.syncMesh(dt, vF);
    }

    /* Copy physics state onto the 3D model, plus purely cosmetic touches
       (body tilt, flame flicker, bobbing marker). */
    syncMesh(dt, vF = 0) {
      const m = this.mesh;
      m.position.copy(this.pos);
      m.rotation.y = this.heading;
      const { body, flame, marker } = m.userData;

      // Nose up when climbing, nose down when falling; lean on hard turns.
      const targetPitch = this.onGround ? 0 : clamp(-this.vel.y * 0.04, -0.5, 0.5);
      this.pitch = TP.util.damp(this.pitch, targetPitch, 8, dt || 1);
      body.rotation.x = this.pitch;

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
  };
})();
