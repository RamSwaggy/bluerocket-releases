/* =====================================================================
   course.js — Boost Runner's track: the seeded random-number generator,
   the hand-made chunks (plain data), and the seeded "chainer" that
   strings chunks together into one long course, getting harder as the
   round goes on.

   Coordinates: x runs along the track (screen right), y is up, play is
   on the z = 0 plane. Units are the shared car's units (the car is 3
   long). See js/README.md for the shapes Art and UI build against.

   How the ground works, in plain English:
     • Every drivable piece is a "surface": a polyline (a list of points,
       left to right).
     • A SOLID surface is the top of a block of ground that goes all the
       way down (to floorY). You can't drive or fall into it from the
       side: its edges are walls.
     • A ONE-WAY surface is a thin platform. You can jump up through it
       from below and land on it from above.
     • A gap is just a stretch of x with no solid surface. Fall in and
       you drop off the bottom of the screen.
   ===================================================================== */
window.TP = window.TP || {};
TP.BR = TP.BR || {};

(function () {
  "use strict";

  /* =====================================================================
     Seeded random numbers. Game logic must never call Math.random(): the
     same seed has to give the same course, the same bot choices and the
     same winner, so QC can replay any match exactly.
     ===================================================================== */

  // Turn any mix of numbers/strings into one 32-bit seed (FNV-1a hash).
  function hashSeed(...parts) {
    let h = 2166136261 >>> 0;
    const s = parts.join("|");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // mulberry32: tiny, fast and good enough for games.
  class RNG {
    constructor(seed) {
      this.seed = seed >>> 0;
      this.state = this.seed || 1;
    }
    // A float in [0, 1).
    next() {
      let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    range(lo, hi) { return lo + this.next() * (hi - lo); }
    int(lo, hi) { return Math.floor(lo + this.next() * (hi - lo + 1)); } // inclusive
    chance(p) { return this.next() < p; }
    // A separate stream for one purpose (course, bots, ...). Forks are
    // independent, so adding a bot decision never changes the course.
    fork(label) { return new RNG(hashSeed(this.seed, label)); }
    // Pick from [{item, w}, ...] by weight.
    weighted(list) {
      let total = 0;
      for (const e of list) total += e.w;
      let r = this.next() * total;
      for (const e of list) {
        r -= e.w;
        if (r < 0) return e.item;
      }
      return list[list.length - 1].item;
    }
  }
  TP.BR.RNG = RNG;
  TP.BR.hashSeed = hashSeed;

  /* =====================================================================
     The numbers every chunk is sized from. They come from the SHARED car
     tuning (read when the course is built), so if the Director ever
     changes jump or speed, the gaps follow automatically.
     ===================================================================== */
  function jumpNumbers() {
    const T = TP.CAR_TUNING;
    const airTime = (2 * T.jump) / T.gravity;          // flat ground → flat ground, one jump
    const apex = (T.jump * T.jump) / (2 * T.gravity);  // how high the wheels get
    // Double jump pressed at the top of the first jump: a second full jump
    // from apex height. Time from that press to touching y = 0 again:
    const tSecond = (T.jump + Math.sqrt(T.jump * T.jump + 2 * T.gravity * apex)) / T.gravity;
    const doubleAir = T.jump / T.gravity + tSecond;
    /* Jump reach right after a boost pad. The pad sets you to boostMax, but
       the shared speed cap (fixed 2026-11-27) bleeds anything above
       maxSpeed back down (damp rate 1.5/s, in car.js) — in the air too. So
       integrate the real speed: ~0.12 s pad→edge, then 0.75 s in the air. */
    let v = T.boostMax, reach = 0;
    const h = 1 / 240;
    const bleed = (dt) => { v = T.maxSpeed + (v - T.maxSpeed) * Math.exp(-1.5 * dt); };
    for (let t = 0; t < 0.12; t += h) bleed(h);
    for (let t = 0; t < airTime; t += h) { reach += v * h; bleed(h); }
    return {
      jumpAfterPad: reach,                      // ~16.6 units (not 20.25: speed bleeds off)
      airTime,                                  // 0.75 s with the shared numbers
      apex,                                     // ~1.97
      doubleAir,                                // ~1.28 s
      doubleApex: apex * 2,                     // ~3.9 (wheel height at the second apex)
      jumpAtMax: T.maxSpeed * airTime,          // ~12.75 units at 17
      jumpAtBoost: T.boostMax * airTime,        // ~20.25 units at 27
      doubleAtMax: T.maxSpeed * doubleAir,      // ~21.8 units at 17
    };
  }
  TP.BR.jumpNumbers = jumpNumbers;

  /* =====================================================================
     The chunks. Each `build(J)` returns plain data in LOCAL coordinates:
     the chunk starts at x = 0 at height y = 0, and ends at x = length,
     height exitY. Every chunk starts and ends with some flat track so
     two chunks always join fairly.

       surfaces: [{ pts: [[x,y],...], oneway }]
       pads:     [{ x0, x1, y }]                    boost pads (on flat track)
       markers:  [{ x, action, ... }]              bot hints:
                   jump   — press jump here (on the ground)
                   double — press jump again here (in the air)
                   boost  — hold boost from x to x2, nose at `aim` radians

     Gap and step sizes are fractions of the jump numbers above, with a
     safety margin, so a car at full gas (17) can make them when it jumps
     at the right moment. Comments show the values with today's numbers.
     ===================================================================== */
  const r1 = (v) => Math.round(v * 10) / 10;

  const CHUNKS = {
    // The starting straight. Cars line up here; it's never chosen again.
    start: {
      name: "Start straight", difficulty: 0, pick: false,
      build: () => ({
        length: 44, exitY: 0,
        surfaces: [{ pts: [[0, 0], [44, 0]] }],
      }),
    },

    // A breather: just flat track.
    flat: {
      name: "Flat", difficulty: 0,
      build: () => ({
        length: 30, exitY: 0,
        surfaces: [{ pts: [[0, 0], [30, 0]] }],
      }),
    },

    // One gap, 70% of a full-speed jump (~8.9 units). One jump clears it.
    gap: {
      name: "Gap", difficulty: 1,
      build: (J) => {
        const g = r1(J.jumpAtMax * 0.7);
        const a = 12, b = a + g;
        return {
          length: b + 14, exitY: 0, gap: g,
          surfaces: [{ pts: [[0, 0], [a, 0]] }, { pts: [[b, 0], [b + 14, 0]] }],
          markers: [{ x: a - 1.2, action: "jump" }],
        };
      },
    },

    // A wide gap, 75% of a full-speed double jump (~16.4 units). Needs a
    // double jump (or a boost hop).
    gap_wide: {
      name: "Wide gap", difficulty: 2,
      build: (J) => {
        const g = r1(J.doubleAtMax * 0.75);
        const a = 12, b = a + g;
        const T = TP.CAR_TUNING;
        return {
          length: b + 14, exitY: 0, gap: g,
          surfaces: [{ pts: [[0, 0], [a, 0]] }, { pts: [[b, 0], [b + 14, 0]] }],
          markers: [
            { x: a - 1.0, action: "jump" },
            // Second press near the top of the first jump.
            { x: a - 1.0 + T.maxSpeed * (T.jump / T.gravity) * 0.9, action: "double" },
          ],
        };
      },
    },

    // A 20° ramp. Its lip launches you over a gap to a lower landing.
    // Rolling off the lip at 17 carries ~12 units, and jumping at the lip
    // carries ~22, so the 14-unit gap needs that jump (or a double jump).
    ramp: {
      name: "Ramp jump", difficulty: 1,
      build: () => {
        const ang = (20 * Math.PI) / 180;
        const x0 = 8, x1 = 16;                       // the ramp itself
        const top = r1((x1 - x0) * Math.tan(ang));   // ~2.9 high
        const land = 30, drop = -1.5;                // gap of 14, landing 1.5 lower
        return {
          length: land + 16, exitY: drop,
          surfaces: [
            { pts: [[0, 0], [x0 - 1.5, 0], [x0, 0.12], [x1, top]] },  // a little curve into the slope
            { pts: [[land, drop], [land + 16, drop]] },
          ],
          markers: [{ x: x1 - 0.8, action: "jump" }],
        };
      },
    },

    // Two step-ups. Each step is 70% of jump height (~1.4); hit the face
    // without jumping and you stop dead.
    step: {
      name: "Step-ups", difficulty: 1,
      build: (J) => {
        const h = r1(J.apex * 0.7);
        return {
          length: 38, exitY: h * 2,
          surfaces: [
            { pts: [[0, 0], [10, 0]] },
            { pts: [[10, h], [24, h]] },
            { pts: [[24, h * 2], [38, h * 2]] },
          ],
          // Jump ~5 units before each face (the window at 17 is ~3–9.5). Walls are
          // tested at the car's centre point. JOB 3 tried earlier jumps (6.6 out):
          // they did worse in races (more cars landing short in a crowd), so 5 stays.
          markers: [{ x: 5, action: "jump" }, { x: 19, action: "jump" }],
        };
      },
    },

    // A pit too wide to jump (~26 units), with a one-way platform in the
    // middle at 70% of jump height. Hop onto it, then hop off the end.
    oneway: {
      name: "Platform hop", difficulty: 2,
      build: (J) => {
        const h = r1(J.apex * 0.7);              // ~1.4
        const edge = 10, far = edge + 26;
        const p0 = edge + 7, p1 = p0 + 12;
        return {
          length: far + 14, exitY: 0, gap: far - edge,
          surfaces: [
            { pts: [[0, 0], [edge, 0]] },
            { pts: [[p0, h], [p1, h]], oneway: true },
            { pts: [[far, 0], [far + 14, 0]] },
          ],
          markers: [{ x: edge - 1.5, action: "jump" }, { x: p1 - 1.2, action: "jump" }],
        };
      },
    },

    // A gold boost pad, then a gap of 85% of a jump taken just after the
    // pad (~14.1; the pad's extra speed bleeds off, see jumpNumbers). Too
    // wide for one jump at 17 (12.75), so: use the pad, or double jump.
    boost: {
      name: "Boost pad", difficulty: 1,
      build: (J) => {
        const g = r1(J.jumpAfterPad * 0.85);
        const padA = 7, padB = 14, edge = 17, far = edge + g;
        return {
          length: far + 16, exitY: 0, gap: g,
          surfaces: [{ pts: [[0, 0], [edge, 0]] }, { pts: [[far, 0], [far + 16, 0]] }],
          pads: [{ x0: padA, x1: padB, y: 0 }],
          markers: [{ x: edge - 1.0, action: "jump" }],
        };
      },
    },
  };
  TP.BR.CHUNKS = CHUNKS;
  TP.BR.CHUNK_IDS = Object.keys(CHUNKS).filter((id) => CHUNKS[id].pick !== false);

  /* =====================================================================
     Course: placed chunks in world coordinates, plus fast lookups.
     ===================================================================== */
  const FLOOR_Y = -60;

  class Course {
    /* seed        — number; the same seed always builds the same course
       opts.chunk  — a chunk id to repeat on its own (testing), or null */
    constructor(seed, opts = {}) {
      this.seed = seed >>> 0;
      this.rng = new RNG(hashSeed(this.seed, "course"));
      this.loopChunk = opts.chunk && CHUNKS[opts.chunk] ? opts.chunk : null;
      this.J = jumpNumbers();
      this.floorY = FLOOR_Y;
      this.version = 0;
      this.chunks = [];
      this.surfaces = [];
      this.pads = [];
      this.markers = [];
      this.endX = 0;
      this.endY = 0;
      this.lastId = null;
      this.onChunkAdded = null; // set by the game to emit chunk_added events
      this.addChunk("start");
    }

    /* ---------- The chainer ----------
       Picks the next chunk. Early chunks are easy; harder chunks get more
       likely the further into the round we are (by chunk count, so it's
       the same for a given seed whatever the speed). No chunk twice in a
       row, and the height is kept in a sensible band. */
    pickNext() {
      if (this.loopChunk) return this.chunks.length % 2 === 1 ? this.loopChunk : "flat";
      const k = this.chunks.length; // 1 = first chunk after the start
      const tier = k <= 3 ? 0 : k <= 8 ? 1 : 2;
      const weights = {
        0: { flat: 3, gap: 3, ramp: 2, step: 2, boost: 2, oneway: 0, gap_wide: 0 },
        1: { flat: 1.5, gap: 3, ramp: 2.5, step: 2.5, boost: 2, oneway: 2, gap_wide: 1.5 },
        2: { flat: 0.6, gap: 2.5, ramp: 2.5, step: 2.5, boost: 1.5, oneway: 3, gap_wide: 3 },
      }[tier];
      const list = [];
      for (const id of TP.BR.CHUNK_IDS) {
        let w = weights[id] || 0;
        if (id === this.lastId) w = 0;                 // never the same twice in a row
        if (id === "step" && this.endY > 6) w = 0;      // don't climb forever
        if (id === "ramp" && this.endY < -6) w = 0;     // or sink forever
        if (w > 0) list.push({ item: id, w });
      }
      return this.rng.weighted(list);
    }

    // Append one chunk at the current end of the course.
    addChunk(id) {
      const def = CHUNKS[id];
      const data = def.build(this.J);
      const ox = this.endX, oy = this.endY, index = this.chunks.length;
      const chunk = {
        index, id, name: def.name, difficulty: def.difficulty,
        x0: ox, x1: ox + data.length, y0: oy, y1: oy + data.exitY,
        gap: data.gap || 0,
        surfaces: [],
      };
      for (const s of data.surfaces) {
        const surf = {
          chunk: index,
          pts: s.pts.map(([x, y]) => [x + ox, y + oy]),
          oneway: !!s.oneway,
          thickness: s.oneway ? 0.6 : 0,
        };
        chunk.surfaces.push(surf);
        this.surfaces.push(surf);
      }
      for (const p of data.pads || []) this.pads.push({ chunk: index, x0: p.x0 + ox, x1: p.x1 + ox, y: p.y + oy });
      for (const m of data.markers || []) {
        const mk = Object.assign({}, m, { chunk: index, x: m.x + ox });
        if (m.x2 !== undefined) mk.x2 = m.x2 + ox;
        this.markers.push(mk);
      }
      this.chunks.push(chunk);
      this.endX = chunk.x1;
      this.endY = chunk.y1;
      this.lastId = id;
      this.version++;
      if (this.onChunkAdded) this.onChunkAdded(chunk);
      return chunk;
    }

    // Keep building until the course reaches at least x.
    ensure(x) {
      let guard = 0;
      while (this.endX < x && guard++ < 50) this.addChunk(this.pickNext());
    }

    /* ---------- Lookups ---------- */

    // Index of the placed chunk containing x (binary search), or -1.
    chunkIndexAt(x) {
      const c = this.chunks;
      if (!c.length || x < c[0].x0) return -1;
      let lo = 0, hi = c.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (c[mid].x0 <= x) lo = mid; else hi = mid - 1;
      }
      return x <= c[lo].x1 ? lo : -1;
    }
    chunkAt(x) {
      const i = this.chunkIndexAt(x);
      return i < 0 ? null : this.chunks[i];
    }

    // Calls fn(surface) for every surface that might cover x (the chunk
    // at x and its neighbours, since surfaces end exactly on chunk edges).
    forSurfacesNear(x, fn) {
      const i = this.chunkIndexAt(x);
      if (i < 0) return;
      for (let k = Math.max(0, i - 1); k <= Math.min(this.chunks.length - 1, i + 1); k++) {
        for (const s of this.chunks[k].surfaces) fn(s);
      }
    }

    // Height and angle of one surface at x, or null if it doesn't cover x.
    static sampleSurface(s, x) {
      const p = s.pts;
      if (x < p[0][0] || x > p[p.length - 1][0]) return null;
      for (let i = 0; i < p.length - 1; i++) {
        const [ax, ay] = p[i], [bx, by] = p[i + 1];
        if (x >= ax && x <= bx && bx > ax) {
          const t = (x - ax) / (bx - ax);
          return { y: ay + (by - ay) * t, angle: Math.atan2(by - ay, bx - ax) };
        }
      }
      return null;
    }

    /* Downward ray from (x, y): the highest surface at or below y.
       Returns { y, angle, oneway, surface } or null (nothing below). */
    surfaceBelow(x, y) {
      let best = null;
      this.forSurfacesNear(x, (s) => {
        const h = Course.sampleSurface(s, x);
        if (h && h.y <= y && (!best || h.y > best.y)) best = { y: h.y, angle: h.angle, oneway: s.oneway, surface: s };
      });
      return best;
    }

    /* A surface crossed while moving down from yFrom to yTo at x (used for
       landing). The highest one wins. */
    surfaceCrossed(x, yFrom, yTo) {
      let best = null;
      this.forSurfacesNear(x, (s) => {
        const h = Course.sampleSurface(s, x);
        if (h && h.y <= yFrom + 0.05 && h.y >= yTo && (!best || h.y > best.y)) {
          best = { y: h.y, angle: h.angle, oneway: s.oneway, surface: s };
        }
      });
      return best;
    }

    // Top of the solid ground at x, or null over a gap.
    heightAt(x) {
      let best = null;
      this.forSurfacesNear(x, (s) => {
        if (s.oneway) return;
        const h = Course.sampleSurface(s, x);
        if (h && (best === null || h.y > best)) best = h.y;
      });
      return best;
    }

    // Is the point (x, y) inside solid ground? (Below a solid top by more
    // than a hair.) Used for walls: step faces and the far side of gaps.
    insideSolid(x, y) {
      const h = this.heightAt(x);
      return h !== null && y < h - 0.02;
    }

    // A smooth "where the track roughly is" height, for the camera: a
    // straight line from each chunk's entry height to its exit height.
    refHeight(x) {
      const c = this.chunkAt(x);
      if (!c) return x < 0 ? 0 : this.endY;
      const t = (x - c.x0) / Math.max(1e-6, c.x1 - c.x0);
      return c.y0 + (c.y1 - c.y0) * t;
    }

    // Boost pad under (x, y), if any.
    padAt(x, y) {
      for (const p of this.pads) if (x >= p.x0 && x <= p.x1 && Math.abs(y - p.y) < 0.3) return p;
      return null;
    }
  }
  TP.BR.Course = Course;
})();
