/* =====================================================================
   arenas.js — the arenas as plain data, plus the rules for moving
   around in them (floor height, ramps, walls, pillars).

   Each arena is described by:
     id, name    — for menus / the HUD
     half        — the floor runs from -half to +half on X and Z
     pillars     — solid round columns: { x, z, r }
     ramps       — wedges you can drive up and launch off:
                   { x, z, fx, fz, L, W, h }
                   (x, z) is the centre of the footprint, (fx, fz) the
                   unit direction it climbs toward, L its length along
                   that direction, W its width, h the height of the lip.
     spawns      — four start spots { x, z, heading }; each gets a pad
                   of paint in that player's colour at the start.

   The Arena class wraps that data with the queries the rest of the mode
   needs. Art and UI's world.js reads the same data to build the scene,
   so a new arena is just a new entry in TP.M5.ARENAS.

   Coordinates match shared/js/car.js: Y is up, heading 0 faces +Z.
   ===================================================================== */
window.TP = window.TP || {};
TP.M5 = TP.M5 || {};

(function () {
  "use strict";

  /* Ramps that climb sideways onto the lip: a car can roll up a small step
     (the low end of a ramp, or onto its side right next to the low end),
     but anything taller acts as a wall. */
  const STEP_UP = 0.6;
  // When rolling off a gentle downhill, stay glued to the slope if the
  // floor is only this far below (stops the car "hopping" down a ramp).
  const SNAP_DOWN = 0.35;
  const PILLAR_H = 8; // pillars are too tall to jump over

  /* ---------- Plaza: the learn-the-game map ----------
     An open square with a pillar in the middle and four ramps laid out
     as a pinwheel near the corners. Each ramp runs along a wall and
     launches you along it, so a ramp jump is a choice: big landing
     splat, but no paint while you're in the air. */
  const PLAZA_RAMP = { x: -26, z: -36, fx: 1, fz: 0, L: 12, W: 7, h: 3.5 };
  // Rotate a point/direction 90° about the centre: (x, z) → (-z, x).
  const rot90 = (r) => ({ ...r, x: -r.z, z: r.x, fx: -r.fz, fz: r.fx });

  const plazaRamps = [PLAZA_RAMP];
  for (let i = 1; i < 4; i++) plazaRamps.push(rot90(plazaRamps[i - 1]));

  // Start spots in the four quadrants, each car facing the middle.
  const quadrantSpawns = (d) => [[-d, -d], [d, -d], [-d, d], [d, d]].map(([x, z]) => ({
    x, z, heading: Math.atan2(-x, -z),
  }));

  TP.M5.ARENAS = [
    {
      id: "plaza",
      name: "Plaza",
      half: 48,
      pillars: [{ x: 0, z: 0, r: 5 }],
      ramps: plazaRamps,
      spawns: quadrantSpawns(22),
    },
  ];

  /* =====================================================================
     Arena — physics queries on top of one arena's data.
     ===================================================================== */
  class Arena {
    constructor(data) {
      this.data = data;
      this.id = data.id;
      this.name = data.name;
      this.half = data.half;
      this.size = data.half * 2;
      this.pillars = data.pillars || [];
      this.ramps = data.ramps || [];
      this.spawns = data.spawns;
    }

    /* Where a point sits on a ramp, in the ramp's own coordinates:
       u runs along the climb (-L/2 at the bottom, +L/2 at the lip),
       v runs across it. */
    _rampLocal(r, x, z) {
      const dx = x - r.x, dz = z - r.z;
      return { u: dx * r.fx + dz * r.fz, v: dx * -r.fz + dz * r.fx };
    }

    // The ramp under (x, z), or null.
    rampAt(x, z) {
      for (const r of this.ramps) {
        const { u, v } = this._rampLocal(r, x, z);
        if (Math.abs(u) <= r.L / 2 && Math.abs(v) <= r.W / 2) return r;
      }
      return null;
    }

    /* Floor height at (x, z). The car physics calls this every step.
       Flat floor is 0; on a ramp the height rises evenly from 0 at the
       bottom to h at the lip, then drops straight back to 0 (that drop
       is what launches you). We never return null here: the arena has
       walls, not pits. */
    groundHeightAt(x, z) {
      for (const r of this.ramps) {
        const { u, v } = this._rampLocal(r, x, z);
        if (Math.abs(u) <= r.L / 2 && Math.abs(v) <= r.W / 2) return r.h * (u + r.L / 2) / r.L;
      }
      return 0;
    }

    // Uphill direction × steepness at (x, z): how much height you gain
    // per unit moved along X and along Z. Zero on flat floor.
    slopeAt(x, z) {
      const r = this.rampAt(x, z);
      if (!r) return { gx: 0, gz: 0 };
      const k = r.h / r.L;
      return { gx: r.fx * k, gz: r.fz * k };
    }

    /* Can't be painted: pillars, ramps (the floor texture doesn't reach
       up onto them) and anything outside the walls. The paint grid asks
       this once per cell when a round starts. */
    cellBlocked(x, z) {
      if (Math.abs(x) > this.half || Math.abs(z) > this.half) return true;
      for (const p of this.pillars) if (Math.hypot(x - p.x, z - p.z) < p.r + 0.4) return true;
      return !!this.rampAt(x, z);
    }

    /* For bot look-ahead: is (x, z) somewhere a car shouldn't try to
       drive, keeping `margin` units of clearance? Walls, pillars and
       ramps all count (bots drive around ramps rather than up them). */
    solidAt(x, z, margin = 0) {
      const lim = this.half - margin;
      if (Math.abs(x) > lim || Math.abs(z) > lim) return true;
      for (const p of this.pillars) if (Math.hypot(x - p.x, z - p.z) < p.r + margin) return true;
      for (const r of this.ramps) {
        const { u, v } = this._rampLocal(r, x, z);
        if (Math.abs(u) <= r.L / 2 + margin && Math.abs(v) <= r.W / 2 + margin) return true;
      }
      return false;
    }

    /* Called right after car.update() each physics step, with where the
       car was before the step (`prev` = { x, y, z, onGround, surfVy }).
       Handles everything the shared car doesn't know about this arena:
       walls, pillars, climbing onto ramps, sticking to slopes, and the
       upward kick when you drive off a ramp's lip. */
    resolveCar(car, prev) {
      /* 1) Outer walls: stop at the wall and bounce back a little. */
      const lim = this.half - car.radius;
      if (car.pos.x > lim) { car.pos.x = lim; car.vel.x = -Math.abs(car.vel.x) * 0.4; }
      if (car.pos.x < -lim) { car.pos.x = -lim; car.vel.x = Math.abs(car.vel.x) * 0.4; }
      if (car.pos.z > lim) { car.pos.z = lim; car.vel.z = -Math.abs(car.vel.z) * 0.4; }
      if (car.pos.z < -lim) { car.pos.z = -lim; car.vel.z = Math.abs(car.vel.z) * 0.4; }

      /* 2) Pillars: push the car back out to the surface, and cancel
         (and slightly reverse) the part of its speed going into it. */
      for (const p of this.pillars) {
        if (car.pos.y > PILLAR_H) continue;
        const dx = car.pos.x - p.x, dz = car.pos.z - p.z;
        const d = Math.hypot(dx, dz) || 1e-4;
        const min = p.r + car.radius * 0.8;
        if (d < min) {
          const nx = dx / d, nz = dz / d;
          car.pos.x = p.x + nx * min;
          car.pos.z = p.z + nz * min;
          const vn = car.vel.x * nx + car.vel.z * nz; // negative = moving into the pillar
          if (vn < 0) { car.vel.x -= nx * vn * 1.4; car.vel.z -= nz * vn * 1.4; }
        }
      }

      /* 3) Ramps. The shared car only "lands" when it falls down onto a
         floor, so a car rolling uphill would sink into the ramp. We fix
         that here: a small step up is climbed, a tall one is a wall. */
      const g = this.groundHeightAt(car.pos.x, car.pos.z);
      if (car.pos.y < g - 0.01) {
        if (g - prev.y <= STEP_UP) {
          car.pos.y = g;
          if (car.vel.y < 0) car.vel.y = 0;
          car.onGround = true;
        } else {
          // Ran into the tall side or back of a ramp: undo the move.
          car.pos.x = prev.x;
          car.pos.z = prev.z;
          car.vel.x *= -0.3;
          car.vel.z *= -0.3;
        }
      } else if (prev.onGround && !car.onGround && car.vel.y <= 0 && car.pos.y - g < SNAP_DOWN) {
        /* 4) Rolling down a slope: stay on it instead of floating. */
        car.pos.y = g;
        car.vel.y = 0;
        car.onGround = true;
      }

      /* Never end a step below the floor. (Falling past the tall side of
         a ramp, the "wall" case above puts us back beside the ramp, but
         the fall may already have taken us below floor level there, and
         the shared car only lands when it was above the floor a step
         earlier. Without this the car would sink forever.) */
      const gEnd = this.groundHeightAt(car.pos.x, car.pos.z);
      if (car.pos.y < gEnd - 0.01) {
        car.pos.y = gEnd;
        if (car.vel.y < 0) car.vel.y = 0;
        car.onGround = true;
      }

      /* 5) Leaving the ground this step (off a lip, or jumping on a ramp):
         keep the upward speed the slope was giving us. Without this a
         ramp would just drop you off its end. */
      if (prev.onGround && !car.onGround) car.vel.y += Math.max(0, prev.surfVy);

      // Remember how fast the floor under us is rising, for next step.
      if (car.onGround) {
        const s = this.slopeAt(car.pos.x, car.pos.z);
        car._surfVy = s.gx * car.vel.x + s.gz * car.vel.z;
      } else {
        car._surfVy = 0;
      }

      // car.update() already placed the model; move it to where we ended up.
      car.mesh.position.copy(car.pos);
    }
  }

  TP.M5.Arena = Arena;
  // Build the Arena for round n (arenas rotate each round).
  TP.M5.arenaFor = (n) => new Arena(TP.M5.ARENAS[((n % TP.M5.ARENAS.length) + TP.M5.ARENAS.length) % TP.M5.ARENAS.length]);
})();
