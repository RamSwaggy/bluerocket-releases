/* =====================================================================
   arenas.js — the arenas as plain data, plus the rules for moving
   around in them (floor height, ramps, decks, walls, pillars).

   Each arena is described by:
     id, name    — for menus / the HUD
     half        — the floor grid covers -half..+half on X and Z
     shape       — "square" (walls at ±half) or "circle" (round wall at
                   `radius` from the centre)
     pillars     — solid round columns: { x, z, r }
     decks       — raised flat platforms you can paint on:
                   { x, z, w, d, h }  centre, width along X, depth along Z,
                   height. Their sides are walls from below (too tall to
                   roll up) and drops from above (drive off = big landing
                   splat). You get up onto a deck by a ramp.
     ramps       — wedges you can drive up: { x, z, fx, fz, L, W, h }
                   (x, z) is the centre of the footprint, (fx, fz) the
                   unit direction it climbs toward, L its length along
                   that direction, W its width, h the height of the lip.
                   A ramp whose lip touches a deck of the same height is
                   a smooth way up; a ramp with nothing past its lip is a
                   launch ramp.
     spawns      — four start spots { x, z, heading }; each gets a pad of
                   paint in that player's colour at the start. A spawn on
                   a deck starts at the deck's height.

   For Art and UI's world.js, every Arena also carries (read-only):
     size (= 2 × half), pads (= spawns, plus y), obstacles ([] for now:
     pillars are round, see `pillars`), and on each ramp w (= W),
     d (= L) and dir (the heading it rises toward, car convention).

   The Arena class wraps the data with the queries the rest of the mode
   needs. Coordinates match shared/js/car.js: Y up, heading 0 faces +Z.
   ===================================================================== */
window.TP = window.TP || {};
TP.M5 = TP.M5 || {};

(function () {
  "use strict";

  /* Climbing: a car can roll up a small step (the low end of a ramp, or
     onto a ramp's side right next to its low end), but anything taller
     acts as a wall. */
  const STEP_UP = 0.6;
  // Rolling down a slope: stay glued to it if the floor is only this far
  // below (stops the car "hopping" down a ramp).
  const SNAP_DOWN = 0.35;
  const PILLAR_H = 8; // pillars are too tall to jump over
  TP.M5.STEP_UP = STEP_UP;

  // Rotate a ramp / point 90° about the centre: (x, z) → (-z, x).
  const rot90 = (r) => ({ ...r, x: -r.z, z: r.x, fx: -r.fz, fz: r.fx });
  const pinwheel = (r) => { const out = [r]; for (let i = 1; i < 4; i++) out.push(rot90(out[i - 1])); return out; };
  /* Four spawns in the quadrants. Each car faces 35° off the middle
     (all turned the same way, like a pinwheel), so holding the gas from
     the start runs across open floor instead of into the centre pillar. */
  const SPAWN_TURN = (35 * Math.PI) / 180;
  const quadrantSpawns = (d) => [[-d, -d], [d, -d], [-d, d], [d, d]].map(([x, z]) => ({
    x, z, heading: Math.atan2(-x, -z) + SPAWN_TURN,
  }));

  TP.M5.ARENAS = [
    /* ---------- 1. Plaza: the learn-the-game map ----------
       An open square with a pillar in the middle and four launch ramps
       laid out as a pinwheel near the corners. Each runs along a wall and
       throws you along it: big landing splat, but no paint in the air. */
    {
      id: "plaza",
      name: "Plaza",
      half: 48,
      shape: "square",
      pillars: [{ x: 0, z: 0, r: 5 }],
      decks: [],
      ramps: pinwheel({ x: -26, z: -36, fx: 1, fz: 0, L: 12, W: 7, h: 3.5 }),
      spawns: quadrantSpawns(22),
    },

    /* ---------- 2. Split Level: two raised decks ----------
       A low middle street running north-south, with a raised deck on each
       side (west and east). Two ramps climb onto each deck from the
       street. Drive off a deck's edge anywhere for a big landing splat.
       The decks run to the side walls but stop short of the north and
       south walls, so there's a wide low lane at each end. Two players start up on each deck. */
    {
      id: "split",
      name: "Split Level",
      half: 48,
      shape: "square",
      pillars: [{ x: 0, z: -30, r: 3 }, { x: 0, z: 30, r: 3 }],
      decks: [
        // (They run right to the side walls: a thin lane between a deck and
        // the wall would just be a place to get stuck.)
        { x: -32, z: 0, w: 32, d: 60, h: 3 },  // west deck: x -48..-16, z -30..30
        { x: 32, z: 0, w: 32, d: 60, h: 3 },   // east deck: x 16..48
      ],
      ramps: [
        // From the street up onto the west deck (climbing toward -X)...
        { x: -10, z: -16, fx: -1, fz: 0, L: 12, W: 8, h: 3 },
        { x: -10, z: 16, fx: -1, fz: 0, L: 12, W: 8, h: 3 },
        // ...and onto the east deck (climbing toward +X).
        { x: 10, z: -16, fx: 1, fz: 0, L: 12, W: 8, h: 3 },
        { x: 10, z: 16, fx: 1, fz: 0, L: 12, W: 8, h: 3 },
      ],
      spawns: [
        { x: -30, z: -18, heading: 0 },          // west deck, south end, facing north
        { x: 30, z: -18, heading: 0 },           // east deck
        { x: -30, z: 18, heading: Math.PI },     // west deck, north end, facing south
        { x: 30, z: 18, heading: Math.PI },      // east deck
      ],
    },

    /* ---------- 3. Rings: a round arena ----------
       A circular wall with a ring of eight pillars halfway out. The
       pillars break up big loops and make good cut-off corners. */
    {
      id: "rings",
      name: "Rings",
      half: 48,
      shape: "circle",
      radius: 47,
      pillars: Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        return { x: Math.sin(a) * 22, z: Math.cos(a) * 22, r: 2.8 };
      }),
      decks: [],
      ramps: [],
      spawns: quadrantSpawns(25),
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
      this.shape = data.shape || "square";
      this.radius = data.radius || data.half;
      this.pillars = data.pillars || [];
      this.decks = data.decks || [];
      // Ramps get the extra field names world.js reads (w, d, dir).
      this.ramps = (data.ramps || []).map((r) => ({ ...r, w: r.W, d: r.L, dir: Math.atan2(r.fx, r.fz) }));
      this.obstacles = [];
      // Spawns sit on whatever floor is under them (a deck, maybe).
      this.spawns = data.spawns.map((s) => ({ ...s, y: this.groundHeightAt(s.x, s.z) }));
      this.pads = this.spawns;
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

    // The deck under (x, z), or null.
    deckAt(x, z) {
      for (const d of this.decks) {
        if (Math.abs(x - d.x) <= d.w / 2 && Math.abs(z - d.z) <= d.d / 2) return d;
      }
      return null;
    }

    /* Floor height at (x, z). The car physics calls this every step, so
       it's kept cheap: a couple of rectangle tests at most. Flat floor
       is 0; a ramp rises evenly from 0 at its bottom to h at its lip; a
       deck is flat at its height. We never return null: no pits. */
    groundHeightAt(x, z) {
      for (const r of this.ramps) {
        const { u, v } = this._rampLocal(r, x, z);
        if (Math.abs(u) <= r.L / 2 && Math.abs(v) <= r.W / 2) return r.h * (u + r.L / 2) / r.L;
      }
      for (const d of this.decks) {
        if (Math.abs(x - d.x) <= d.w / 2 && Math.abs(z - d.z) <= d.d / 2) return d.h;
      }
      return 0;
    }

    // Uphill direction × steepness at (x, z): height gained per unit
    // moved along X and Z. Zero on flat floor and decks.
    slopeAt(x, z) {
      const r = this.rampAt(x, z);
      if (!r) return { gx: 0, gz: 0 };
      const k = r.h / r.L;
      return { gx: r.fx * k, gz: r.fz * k };
    }

    // Is (x, z) outside the arena's wall, with `margin` units to spare?
    outside(x, z, margin = 0) {
      if (this.shape === "circle") return Math.hypot(x, z) > this.radius - margin;
      const lim = this.half - margin;
      return Math.abs(x) > lim || Math.abs(z) > lim;
    }

    /* Can't be painted: pillars, ramps (the floor texture doesn't reach
       up the slope) and anything outside the wall. Decks CAN be painted.
       The paint grid asks this once per cell when a round starts. */
    cellBlocked(x, z) {
      if (this.outside(x, z)) return true;
      for (const p of this.pillars) if (Math.hypot(x - p.x, z - p.z) < p.r + 0.4) return true;
      return !!this.rampAt(x, z);
    }

    /* For bots: is (x, z) a wall or pillar, keeping `margin` units of
       clearance? (Height changes are checked by pathBlocked, below.) */
    solidAt(x, z, margin = 0) {
      if (this.outside(x, z, margin)) return true;
      for (const p of this.pillars) if (Math.hypot(x - p.x, z - p.z) < p.r + margin) return true;
      return false;
    }

    /* For bots: would driving straight from (x0, z0) to (x1, z1) hit
       something? Walls and pillars (with `margin` clearance) block, and
       so does any step UP too tall to climb (a deck's side, a ramp's
       side). Stepping DOWN is fine: that's driving off a ledge. */
    pathBlocked(x0, z0, x1, z1, margin = 0, step = 1) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(1, Math.ceil(len / step));
      let h = this.groundHeightAt(x0, z0);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
        if (this.solidAt(x, z, margin)) return true;
        const g = this.groundHeightAt(x, z);
        if (g > h + STEP_UP) return true;
        h = g;
      }
      return false;
    }

    /* Called right after car.update() each physics step, with where the
       car was before the step (`prev` = { x, y, z, onGround, surfVy }).
       Handles everything the shared car doesn't know about this arena:
       walls, pillars, climbing ramps, deck sides, sticking to slopes,
       and the upward kick when you drive off a ramp's lip. */
    resolveCar(car, prev) {
      /* 1) Outer wall: stop at the wall and bounce back a little. */
      if (this.shape === "circle") {
        const d = Math.hypot(car.pos.x, car.pos.z) || 1e-4;
        const lim = this.radius - car.radius;
        if (d > lim) {
          const nx = car.pos.x / d, nz = car.pos.z / d;
          car.pos.x = nx * lim;
          car.pos.z = nz * lim;
          const vn = car.vel.x * nx + car.vel.z * nz; // positive = moving outward
          if (vn > 0) { car.vel.x -= nx * vn * 1.4; car.vel.z -= nz * vn * 1.4; }
        }
      } else {
        const lim = this.half - car.radius;
        if (car.pos.x > lim) { car.pos.x = lim; car.vel.x = -Math.abs(car.vel.x) * 0.4; }
        if (car.pos.x < -lim) { car.pos.x = -lim; car.vel.x = Math.abs(car.vel.x) * 0.4; }
        if (car.pos.z > lim) { car.pos.z = lim; car.vel.z = -Math.abs(car.vel.z) * 0.4; }
        if (car.pos.z < -lim) { car.pos.z = -lim; car.vel.z = Math.abs(car.vel.z) * 0.4; }
      }

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

      /* 3) Ramps and deck sides. The shared car only "lands" when it falls
         down onto a floor, so a car rolling uphill would sink into the
         ramp. We fix that here: a small step up is climbed, a tall one
         (a deck's side, a ramp's side) is a wall. */
      const g = this.groundHeightAt(car.pos.x, car.pos.z);
      if (car.pos.y < g - 0.01) {
        if (g - prev.y <= STEP_UP) {
          car.pos.y = g;
          if (car.vel.y < 0) car.vel.y = 0;
          car.onGround = true;
        } else {
          /* Ran into something too tall (a deck's side, a ramp's side).
             Slide along it rather than stopping dead: try undoing just
             the X part of the move, then just the Z part, and only undo
             both if neither works. Whichever direction was blocked loses
             its speed (with a small bounce). */
          const ok = (x, z) => this.groundHeightAt(x, z) <= prev.y + STEP_UP;
          if (ok(prev.x, car.pos.z)) {
            car.pos.x = prev.x;
            car.vel.x *= -0.3;
          } else if (ok(car.pos.x, prev.z)) {
            car.pos.z = prev.z;
            car.vel.z *= -0.3;
          } else {
            car.pos.x = prev.x;
            car.pos.z = prev.z;
            car.vel.x *= -0.3;
            car.vel.z *= -0.3;
          }
        }
      } else if (prev.onGround && !car.onGround && car.vel.y <= 0 && car.pos.y - g < SNAP_DOWN) {
        /* 4) Rolling down a slope: stay on it instead of floating. */
        car.pos.y = g;
        car.vel.y = 0;
        car.onGround = true;
      }

      /* Never end a step below the floor. (Falling past the tall side of
         a ramp or deck, the "wall" case above puts us back beside it, but
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
  TP.M5.arenaFor = (n) => {
    const list = TP.M5.ARENAS;
    return new Arena(list[((n % list.length) + list.length) % list.length]);
  };
})();
