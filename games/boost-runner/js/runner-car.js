/* =====================================================================
   runner-car.js — the shared rocket car, stuck on a side-on track.

   Plain English: it's the same car as every other Rocket Rumble mode —
   same acceleration, top speed, boost and jump — but it lives on a 2D
   track (x along, y up) instead of a flat floor. This file only adds
   the side-on movement layer the Director approved:
     • slope following (short downward rays against the course),
     • air tilt (ctrl.pitch at the shared airTurnRate),
     • a double jump (the same 10.5 as the shared jump),
     • the Hit-dash (an instant 10.5 burst along the nose),
     • the bad-landing tumble,
     • 2D car-vs-car bumps (the shared collideAll maths, in x/y).

   EVERY car number is read, while the game runs, from the tuning object
   the game hands to step() — TP.modeTuning({ bumpScale: 1.3 }). There
   are no copies of accel/jump/gravity/boost numbers in this file. The
   few numbers below (RULES) are mode rules, not car numbers.

   Conventions:
     car.pos.x, car.pos.y — the point under the middle of the wheels
     car.angle            — nose angle, radians; 0 = level facing +x, + = nose up
   ===================================================================== */
window.TP = window.TP || {};
TP.BR = TP.BR || {};

(function () {
  "use strict";
  const { clamp, damp, wrapAngle } = TP.util;

  /* Mode-only rules (approved by the Director, 2026-11-27). Timing and
     geometry only: none of these change how fast the car goes. */
  const RULES = {
    coyote: 0.1,          // you can still jump this long after rolling off an edge
    jumpBuffer: 0.1,      // a jump pressed this long before landing still happens
    dashCooldown: 1.0,    // Hit-dash cooldown on the ground (one per airtime in the air)
    dashTime: 0.25,       // how long the dash counts as "dashing" (trail, bumps)
    dashBoostCost: 20,    // boost meter a Hit-dash uses (PROPOSED, needs sign-off: without
                          // it, dashing every 1 s cooldown sustains ~24 vs 17 on gas)
    badLanding: (50 * Math.PI) / 180, // landing more than this far off the surface angle = tumble
    tumbleTime: 0.6,      // seconds without control after a bad landing
    tumbleKeep: 0.35,     // fraction of speed kept after a bad landing
    stepUp: 0.45,         // tiny ledges you roll straight up (higher ones are walls)
    halfLength: 1.5,      // half the car's length, for the "leave the ground on a crest" rule
    bodyRadius: 1.2,      // car-vs-car bump circle, centred 0.6 above the wheels
    bodyLift: 0.6,
    maxFall: 45,          // terminal fall speed, so very long falls stay sane
    padBoost: 35,         // boost meter a pad gives back
    embedLift: 0.6,       // wheels this far into a top while falling get lifted onto it
  };
  TP.BR.CAR_RULES = RULES;

  class RunnerCar extends TP.Car {
    constructor(scene, player) {
      super(scene, player);
      this.seat = player.index;
      this.name = player.name || TP.DEFAULT_NAMES[player.index];
      this.color = player.color;
      this.isBot = !!player.isBot;
      this.manualBodyPose = true;   // we pose the body ourselves (air tilt)
      this.radius = RULES.bodyRadius;
      this.reset(0, 0);
    }

    // Short names for position/velocity (README contract).
    get x() { return this.pos.x; }
    get y() { return this.pos.y; }
    get vx() { return this.vel.x; }
    get vy() { return this.vel.y; }
    get alive() { return !this.out; }

    // Put the car back at the start of a round.
    reset(x, y) {
      this.pos.set(x, y, 0);
      this.vel.set(0, 0, 0);
      this.angle = 0;
      this.heading = Math.PI / 2;   // shared field; the model faces +x
      this.onGround = true;
      this.groundAngle = 0;
      this.boost = 100;
      this.boosting = false;
      this.out = false;
      this.koTime = null;
      this.koCause = null;
      this.offScreen = 0;
      this.inDanger = false;
      this.offTop = false;
      this.tumbling = 0;
      this.dashing = 0;
      this.dashCool = 0;
      this.airDashUsed = false;
      this.doubleUsed = false;
      this.sinceGround = 0;      // seconds since last on the ground (coyote time)
      this.jumpBufferT = 0;      // seconds since jump was pressed (buffer)
      this._jumpHeld = false;
      this._hitHeld = false;
      this.regenBonus = 0;       // catch-up: extra boost regen as a fraction of the shared regen
      this.chunkIndex = 0;
      this.lastPad = null;
      this.mesh.visible = true;
      this.syncMesh(0);
    }

    forward2() {
      return { x: Math.cos(this.angle), y: Math.sin(this.angle) };
    }

    /* One fixed physics step.
       dt     — 1/60 s
       input  — { drive -1..1, pitch -1..1, jump, boost, hit } (held)
       course — TP.BR.Course
       T      — the mode tuning object (TP.modeTuning({bumpScale:1.3}))
       emit   — function(type, fields) for events */
    step(dt, input, course, T, emit) {
      if (this.out) return;

      /* ---------- Buttons: turn "held" into "just pressed" ---------- */
      const controllable = this.tumbling <= 0;
      const jumpPressed = !!input.jump && !this._jumpHeld;
      const hitPressed = !!input.hit && !this._hitHeld;
      this._jumpHeld = !!input.jump;
      this._hitHeld = !!input.hit;
      if (jumpPressed && controllable) this.jumpBufferT = RULES.jumpBuffer;
      else this.jumpBufferT = Math.max(0, this.jumpBufferT - dt);

      this.tumbling = Math.max(0, this.tumbling - dt);
      this.dashing = Math.max(0, this.dashing - dt);
      this.dashCool = Math.max(0, this.dashCool - dt);

      /* ---------- Boost meter (same rule as the shared car) ---------- */
      this.boosting = controllable && !!input.boost && this.boost > 0;
      if (this.boosting) this.boost = Math.max(0, this.boost - T.boostDrain * dt);
      else this.boost = Math.min(100, this.boost + T.boostRegen * (1 + this.regenBonus) * dt);

      const drive = controllable ? clamp(input.drive || 0, -1, 1) : 0;

      if (this.onGround) this.stepGround(dt, drive, jumpPressed, hitPressed, controllable, course, T, emit);
      else this.stepAir(dt, input, jumpPressed, hitPressed, controllable, course, T, emit);

      this.syncMesh(dt);
    }

    /* ---------- On the ground ---------- */
    stepGround(dt, drive, jumpPressed, hitPressed, controllable, course, T, emit) {
      const th = this.groundAngle;
      const tx = Math.cos(th), ty = Math.sin(th);
      this.angle = th;
      this.sinceGround = 0;

      // Speed along the surface (signed: + = rolling toward +x).
      const s0 = this.vel.x * tx + this.vel.y * ty;
      let s = s0;

      // Throttle / brake, exactly like the shared car's forward axis.
      if (drive > 0) s += drive * T.accel * dt;
      else if (drive < 0) s += drive * (s > 0.5 ? T.brake : T.accel * 0.6) * dt;
      else s *= Math.exp(-T.drag * dt);

      // Gravity pulls along slopes (28·sinθ): uphill slows you, downhill speeds you up.
      s -= T.gravity * ty * dt;

      if (this.boosting) s += T.boostAccel * dt;

      // Speed caps — the shared rule (fixed 2026-11-27): gas tops out at
      // maxSpeed, boost at boostMax; speed you already had above the cap
      // (a pad, a bump, a dash) is kept and bled off smoothly.
      s = this.capSpeed(s, s0, dt, T);

      // Boost pad: a burst to boost speed and some meter back.
      const pad = course.padAt(this.pos.x, this.pos.y);
      if (pad && pad !== this.lastPad) {
        s = Math.max(s, T.boostMax);
        this.boost = Math.min(100, this.boost + RULES.padBoost);
        emit("pad", { seat: this.seat, x: this.pos.x, y: this.pos.y });
      }
      this.lastPad = pad;

      // Hit-dash on the ground: an instant jump-sized burst along the nose.
      if (hitPressed && controllable && this.dashCool <= 0 && this.boost >= RULES.dashBoostCost) {
        s += T.jump;
        this.boost -= RULES.dashBoostCost;
        this.dashCool = RULES.dashCooldown;
        this.dashing = RULES.dashTime;
        emit("dash", { seat: this.seat, x: this.pos.x, y: this.pos.y });
      }

      this.vel.set(s * tx, s * ty, 0);

      // Jump (or a buffered jump pressed just before landing).
      if (this.jumpBufferT > 0 && controllable) {
        this.jumpBufferT = 0;
        this.doJump(T, emit, false);
        this.moveAir(dt, course, T, emit);
        return;
      }

      /* Move along the surface, then follow it with a downward ray. */
      const nx = this.pos.x + this.vel.x * dt;
      const ny = this.pos.y + this.vel.y * dt;

      // Walls: a solid face in front of the wheels (or the nose) stops you.
      if (course.insideSolid(nx, ny + 0.3) || course.insideSolid(nx, ny + 1.0)) {
        // Allow tiny ledges: if the ground just ahead is only a little
        // higher, roll up onto it.
        const h = course.heightAt(nx);
        if (h !== null && h - this.pos.y <= RULES.stepUp && !course.insideSolid(nx, h + 1.0)) {
          this.pos.set(nx, h, 0);
          this.groundAngle = 0;
        } else {
          this.vel.set(0, 0, 0); // bonk
        }
        return;
      }

      const ground = course.surfaceBelow(nx, ny + RULES.stepUp);
      const snap = 0.35 + Math.abs(s) * dt * 0.4;
      if (ground && ground.y >= ny - snap) {
        /* Crest rule: on a downward bend, the track can only hold you if
           gravity can bend your path that much. A bend of Δθ over half a
           car length needs v²·Δθ/L ≤ g·cosθ, so fast cars launch off
           crests and ramp lips, slow cars roll over them. */
        const bend = wrapAngle(th - ground.angle); // + = track bends down
        const v2 = s * s;
        const allowed = v2 > 1e-6 ? (T.gravity * Math.cos(th) * RULES.halfLength) / v2 : Infinity;
        if (bend > 0.02 && bend > allowed) {
          this.leaveGround(nx, ny);
          return;
        }
        // Stay on: keep the speed along the new direction.
        const tx2 = Math.cos(ground.angle), ty2 = Math.sin(ground.angle);
        this.pos.set(nx, ground.y, 0);
        this.groundAngle = ground.angle;
        this.vel.set(s * tx2, s * ty2, 0);
      } else {
        // Rolled off an edge.
        this.leaveGround(nx, ny);
      }
    }

    leaveGround(nx, ny) {
      this.pos.set(nx, ny, 0);
      this.onGround = false;
      this.sinceGround = 0;
    }

    doJump(T, emit, isDouble) {
      if (isDouble) {
        this.vel.y = T.jump;          // the same 10.5, from wherever you are
        this.doubleUsed = true;
      } else {
        this.vel.y += T.jump;         // off the ground: added to any ramp lift
      }
      this.onGround = false;
      this.sinceGround = RULES.coyote + 1; // no coyote jump after a real jump
      emit("jump", { seat: this.seat, double: isDouble, x: this.pos.x, y: this.pos.y });
    }

    /* ---------- In the air ---------- */
    stepAir(dt, input, jumpPressed, hitPressed, controllable, course, T, emit) {
      this.sinceGround += dt;

      // Air tilt on ctrl.pitch, at the shared airTurnRate.
      if (controllable) this.angle = wrapAngle(this.angle + clamp(input.pitch || 0, -1, 1) * T.airTurnRate * dt);

      // Coyote time: a late press just after rolling off an edge is still a
      // normal jump. After that, the next press is the double jump.
      if (this.jumpBufferT > 0 && controllable) {
        if (this.sinceGround <= RULES.coyote) {
          this.jumpBufferT = 0;
          this.vel.y = Math.max(this.vel.y, 0);
          this.doJump(T, emit, false);
        } else if (!this.doubleUsed && jumpPressed) {
          this.jumpBufferT = 0;
          this.doJump(T, emit, true);
        }
      }

      // Hit-dash in the air: once per airtime, along the nose.
      if (hitPressed && controllable && !this.airDashUsed && this.boost >= RULES.dashBoostCost) {
        this.boost -= RULES.dashBoostCost;
        const f = this.forward2();
        this.vel.x += f.x * T.jump;
        this.vel.y += f.y * T.jump;
        this.airDashUsed = true;
        this.dashing = RULES.dashTime;
        emit("dash", { seat: this.seat, x: this.pos.x, y: this.pos.y });
      }

      this.moveAir(dt, course, T, emit);
    }

    // Gravity, boost thrust, speed caps, then move and check for landing/walls.
    moveAir(dt, course, T, emit) {
      const vx0 = this.vel.x;
      this.vel.y -= T.gravity * dt;
      if (this.boosting) {
        const f = this.forward2();
        this.vel.x += f.x * T.boostAccel * dt;
        this.vel.y += f.y * T.boostAccel * dt;
      }
      // The shared caps apply to forward (x) speed in the air too.
      this.vel.x = this.capSpeed(this.vel.x, vx0, dt, T);
      if (this.vel.y < -RULES.maxFall) this.vel.y = -RULES.maxFall;

      const ox = this.pos.x, oy = this.pos.y;
      let nx = ox + this.vel.x * dt;
      const ny = oy + this.vel.y * dt;

      // Landing: did we cross down through a surface? We also catch wheels
      // that are a little way INTO a top (a bump can push a car there):
      // they get lifted onto it instead of sinking through the ground.
      if (this.vel.y <= 0) {
        const hit = course.surfaceCrossed(nx, oy + RULES.embedLift, ny);
        if (hit) {
          this.land(nx, hit, T, emit);
          return;
        }
      }

      // Walls: moving sideways into solid ground (the far side of a gap you
      // didn't clear, or a step face). Stop against it and slide down it,
      // landing on whatever is below where we actually are.
      if (course.insideSolid(nx, ny + 0.3)) {
        nx = ox;
        this.vel.x = 0;
        if (this.vel.y <= 0) {
          const hit = course.surfaceCrossed(nx, oy + RULES.embedLift, ny);
          if (hit) {
            this.land(nx, hit, T, emit);
            return;
          }
        }
      }
      this.pos.set(nx, ny, 0);
    }

    land(nx, hit, T, emit) {
      const tx = Math.cos(hit.angle), ty = Math.sin(hit.angle);
      let s = this.vel.x * tx + this.vel.y * ty;
      const off = Math.abs(wrapAngle(this.angle - hit.angle));
      const bad = off > RULES.badLanding;
      if (bad) {
        s *= RULES.tumbleKeep;
        this.tumbling = RULES.tumbleTime;
      }
      this.pos.set(nx, hit.y, 0);
      this.vel.set(s * tx, s * ty, 0);
      this.angle = hit.angle;
      this.groundAngle = hit.angle;
      this.onGround = true;
      this.sinceGround = 0;
      this.doubleUsed = false;
      this.airDashUsed = false;
      emit("land", { seat: this.seat, x: nx, y: hit.y, speed: Math.abs(s), bad });
      // A jump pressed just before touching down happens now (jump buffer).
      if (this.jumpBufferT > 0 && !bad) {
        this.jumpBufferT = 0;
        this.doJump(T, emit, false);
      }
    }

    /* The shared speed-cap rule on one axis. s0 = speed before this step. */
    capSpeed(s, s0, dt, T) {
      const cap = this.boosting ? T.boostMax : T.maxSpeed;
      const hi = Math.max(cap, Math.min(s0, T.boostMax));
      const lo = Math.min(-T.reverseMax, Math.max(s0, -T.boostMax));
      s = clamp(s, lo, hi);
      if (!this.boosting && s > T.maxSpeed) s = damp(s, T.maxSpeed, 1.5, dt);
      return s;
    }

    /* ---------- Model pose (cosmetic only; no randomness) ---------- */
    syncMesh(dt) {
      const m = this.mesh;
      m.position.set(this.pos.x, this.pos.y, 0);
      m.rotation.set(0, Math.PI / 2, 0);        // the shared model's nose (+Z) points along +x
      const { body, flame, marker } = m.userData;
      // In the model's own frame, +rotation.x tips the nose DOWN, so nose-up = -angle.
      body.rotation.set(-this.angle, 0, 0);
      flame.visible = this.boosting;
      if (this.boosting) {
        this._flick = (this._flick || 0) + 1;
        flame.scale.set(1, 0.85 + 0.3 * Math.abs(Math.sin(this._flick * 1.7 + this.seat)), 1);
      }
      if (marker) marker.position.y = 2.6;
    }

    /* =====================================================================
       Car-vs-car bumps in 2D: the shared collideAll maths (equal masses,
       restitution 0.9 × bumpScale, the same 7-unit "pop" cap), on circles
       in the x/y plane. Returns the hits for events.
       ===================================================================== */
    static collide2D(cars, T, course) {
      const hits = [];
      for (let i = 0; i < cars.length; i++) {
        for (let j = i + 1; j < cars.length; j++) {
          const a = cars[i], b = cars[j];
          if (a.out || b.out) continue;
          const ax = a.pos.x, ay = a.pos.y + RULES.bodyLift;
          const bx = b.pos.x, by = b.pos.y + RULES.bodyLift;
          const dx = bx - ax, dy = by - ay;
          const dist = Math.hypot(dx, dy);
          const minDist = a.radius + b.radius;
          if (dist >= minDist || dist < 1e-4) continue;
          const nx = dx / dist, ny = dy / dist;

          // 1) Push apart (but never into a wall).
          const push = (minDist - dist) / 2;
          RunnerCar.nudge(a, -nx * push, -ny * push, course);
          RunnerCar.nudge(b, nx * push, ny * push, course);

          // 2) Bounce, only if moving toward each other.
          const aN = a.vel.x * nx + a.vel.y * ny;
          const bN = b.vel.x * nx + b.vel.y * ny;
          const closing = aN - bN;
          if (closing <= 0) continue;
          const restitution = 0.9;
          const impulse = ((closing * (1 + restitution)) / 2) * T.bumpScale;
          a.vel.x -= nx * impulse; a.vel.y -= ny * impulse;
          b.vel.x += nx * impulse; b.vel.y += ny * impulse;

          // Big hits pop the slower car into the air (shared rule).
          const victim = Math.abs(aN) < Math.abs(bN) ? a : b;
          const attacker = victim === a ? b : a;
          if (closing > 8 && victim.onGround) {
            victim.vel.y = Math.max(victim.vel.y, Math.min(7, closing * 0.3));
            victim.onGround = false;
            victim.sinceGround = RULES.coyote + 1;
          }
          hits.push({ a: a.seat, b: b.seat, victim: victim.seat, attacker: attacker.seat, impact: closing, x: (ax + bx) / 2, y: (ay + by) / 2 });
        }
      }
      return hits;
    }

    // Move a car a little, unless that would put it inside solid ground.
    static nudge(car, dx, dy, course) {
      const x = car.pos.x + dx;
      let y = car.pos.y + (car.onGround ? 0 : dy);
      if (course.insideSolid(x, y + 0.05)) return;
      car.pos.x = x;
      car.pos.y = y;
    }
  }
  TP.BR.RunnerCar = RunnerCar;
})();
