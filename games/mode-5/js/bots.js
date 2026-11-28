/* =====================================================================
   bots.js — TP.M5.Bot: the CPU drivers.

   A bot outputs exactly the controls a human would (throttle, steer,
   boost, jump), so it plays by the same rules and the same car feel.

   Every so often (its "reaction time") the bot re-thinks, in this order
   of priority:

     home  — DEFEND: a rival could reach my wet trail before I get home,
             or the trail is about to dry. Race home (boosting).
     ram   — a rival with a wet trail is close and roughly in front of
             me: hit them hard (a hard bump pops their trail).
     hunt  — a rival is out with a wet trail: drive across a trail cell I
             can reach before they get home, or, if I'm too late for the
             trail, cut in on their predicted path home and ram them.
     grab  — a pickup nobody else is closer to.
     loop  — at home: plan the next loop. Rectangles in eight directions
             and a few sizes are scored by a quick flood-fill estimate of
             how much floor they'd actually win (stroke + everything it
             would enclose, rival floor worth more), per second of
             driving, scaled down when a rival is close enough to cut it.
             Overdrive makes bots greedier.
     ramp  — like a loop, but a ramp jump: up the ramp, fly, splat a blob
             where we land, then come home.

   Getting around: bots steer for their target but look ahead and take
   the nearest heading with clear floor (walls, pillars, and steps too
   tall to climb all count), so they bend around obstacles. If the target
   is up on a deck, they route via the best ramp. If they get stuck, they
   back up, and if that doesn't free them they pick an escape point.

   Difficulty (easy / normal / hard) changes: reaction time, loop greed
   and size, how early they spot threats (and how often they ignore
   them), hunting range, ramming, ramp use, boost discipline, steering
   wobble, and how often they simply pick a worse plan.
   ===================================================================== */
window.TP = window.TP || {};
TP.M5 = TP.M5 || {};

(function () {
  "use strict";
  const { clamp, dist2D, wrapAngle, rand } = TP.util;

  const LEVELS = {
    easy: {
      think: 0.6,            // seconds between re-thinks (reaction time)
      sizes: [10, 14],       // loop out-leg lengths tried (units)
      greed: 0.55,           // how much cut-off risk it accepts
      maxTrail: 3.6,         // gives up and goes home after this long out
      defend: 0.5,           // chance it notices a threat at all
      margin: -0.3,          // extra seconds of safety it wants when defending
      hunt: 14,              // how far it will go to cut a trail
      ram: 0.2,              // chance it takes a ram chance
      ramp: 0,               // ramp-jump preference (0 = never)
      boostWaste: 0.5,       // chance per think it just boosts for fun
      reserve: 0,            // boost it keeps back for emergencies
      noise: 0.22,           // steering wobble (radians)
      mistake: 0.35,         // chance a plan is picked at random
    },
    normal: {
      think: 0.3, sizes: [13, 19, 26], greed: 0.85, maxTrail: 4.6, defend: 0.85, margin: 0.35,
      hunt: 26, ram: 0.6, ramp: 0.5, boostWaste: 0.1, reserve: 25, noise: 0.07, mistake: 0.1,
    },
    hard: {
      think: 0.15, sizes: [16, 24, 32], greed: 1.15, maxTrail: 5.1, defend: 1, margin: 0.75,
      hunt: 40, ram: 1, ramp: 0.8, boostWaste: 0, reserve: 35, noise: 0, mistake: 0,
    },
  };
  TP.M5.BOT_LEVELS = LEVELS;

  // Headings to try, in order, around the one we want (radians).
  const OFFSETS = [0, 0.35, -0.35, 0.7, -0.7, 1.1, -1.1, 1.6, -1.6, 2.2, -2.2, 2.8, -2.8];
  const ARRIVE = 3.5;   // waypoint reached when this close
  const SPEED = 16;     // planning speed estimate (units/s)

  class Bot {
    constructor(match, car, level) {
      this.match = match;
      this.car = car;
      this.levelName = LEVELS[level] ? level : "normal";
      this.L = LEVELS[this.levelName];
      this.reset();
    }

    // Fresh brain for a new round.
    reset() {
      this.mode = "loop";
      this.waypoints = [];      // the plan (loop corners, ramp approach...)
      this.route = [];          // detour points in front of the target (ramps up to decks)
      this.target = null;       // { x, z } we're steering toward
      this.thinkIn = rand(0, this.L.think); // stagger bots so they don't all think on one frame
      this.stuckT = 0;
      this.reverseT = 0;
      this.unsticks = [];       // times we recently had to back up
      this.wpTime = 0;
      this.wasStunned = false;
      this.threat = false;
      this.loopBoost = false;
      this.boostWhim = false;
      this.time = 0;
      this.seed = rand(0, 100);
    }

    /* ------------------------------------------------------------------
       Every physics step
       ------------------------------------------------------------------ */
    controls(dt) {
      const car = this.car;
      this.time += dt;
      // Coming out of a spin-out: re-think straight away.
      if (this.wasStunned) { this.wasStunned = false; this.thinkIn = 0; }
      if (car.stun > 0) this.wasStunned = true;

      this.thinkIn -= dt;
      if (this.thinkIn <= 0) {
        this.thinkIn = this.L.think;
        this.think();
      }

      // Detour points first (e.g. the foot and top of a ramp).
      if (this.route.length) {
        const r = this.route[0];
        if (dist2D(car.pos.x, car.pos.z, r.x, r.z) < ARRIVE) this.route.shift();
      }
      // Plan waypoints: next corner when we reach one (or it's taking far
      // too long, which means something's in the way).
      if ((this.mode === "loop" || this.mode === "ramp" || this.mode === "escape") && this.waypoints.length && !this.route.length) {
        this.wpTime += dt;
        const w = this.waypoints[0];
        if (dist2D(car.pos.x, car.pos.z, w.x, w.z) < ARRIVE || this.wpTime > 3.5) {
          this.waypoints.shift();
          this.wpTime = 0;
          if (this.waypoints.length) this._setTarget(this.waypoints[0]);
          else { this.mode = "home"; this._aimHome(); }
        }
      }

      // Stuck against something? Back up for a moment.
      if (this.reverseT > 0) {
        this.reverseT -= dt;
        return { throttle: -1, steer: this._unstickSteer, boost: false, jump: false };
      }
      if (car.speed2D() < 1.5 && car.onGround) this.stuckT += dt; else this.stuckT = 0;
      if (this.stuckT > 0.6) {
        this.stuckT = 0;
        this.reverseT = 0.6;
        this._unstickSteer = Math.random() < 0.5 ? -1 : 1;
        // Second time stuck in a few seconds: backing up isn't enough, so
        // pick a fresh escape point in the most open direction.
        this.unsticks = this.unsticks.filter((t) => this.time - t < 4);
        this.unsticks.push(this.time);
        if (this.unsticks.length >= 2) this._escape();
        this.thinkIn = Math.max(this.thinkIn, 0.6); // let the plan play out
        return { throttle: -1, steer: this._unstickSteer, boost: false, jump: false };
      }

      const t = this.route.length ? this.route[0] : this.target;
      if (!t) return { throttle: 0, steer: 0, boost: false, jump: false };
      return this._steerTo(t.x, t.z, this._wantsBoost());
    }

    /* ------------------------------------------------------------------
       Deciding what to do
       ------------------------------------------------------------------ */
    think() {
      const m = this.match, g = m.grid, car = this.car, p = car.index, L = this.L;
      const trail = g.hasTrail(p);
      const age = m.trailAge[p];
      // Re-check the way up to a raised target from where we actually are
      // (we may have been knocked off a ramp halfway up).
      if (this.target && m.arena.decks.length) this._setTarget(this.target);
      if (L.boostWaste && Math.random() < L.boostWaste) this.boostWhim = !this.boostWhim;

      // 1) DEFEND: my trail is in danger or about to dry → home.
      this.threat = trail && this._trailInDanger();
      if (trail && (age > L.maxTrail || this.threat)) {
        if (this.mode !== "home") { this.mode = "home"; this.waypoints = []; }
        this._aimHome();
        return;
      }

      /* Out on a planned loop with a trail? Then stick to the plan: a
         half-finished loop is worth nothing. Only danger (above) or a
         chance right on our path (very close) can pull us off it. */
      const committed = trail && (this.mode === "loop" || this.mode === "ramp") && this.waypoints.length;
      const reach = committed ? 7 : Infinity;
      const near = (t) => t && dist2D(car.pos.x, car.pos.z, t.x, t.z) < reach;

      // 2) RAM a rival with a trail who's close and in front.
      if (Math.random() < L.ram && (!trail || age < 2 || committed)) {
        const r = this._findRam();
        if (near(r)) { this.mode = "ram"; this.waypoints = []; this._setTarget(r); return; }
      }

      // 3) HUNT a rival trail I can reach in time (or cut them off).
      if (!trail || age < 1.5 || committed) {
        const h = this._findHunt();
        if (near(h)) { this.mode = "hunt"; this.waypoints = []; this._setTarget(h); return; }
      }

      // 4) GRAB a pickup nearby.
      if (!trail || age < 2.5 || committed) {
        const pk = this._findPickup();
        if (near(pk)) { this.mode = "grab"; this.waypoints = []; this._setTarget(pk); return; }
      }

      // 5) Keep following a plan that's under way.
      if ((this.mode === "loop" || this.mode === "ramp" || this.mode === "escape") && this.waypoints.length) return;

      // 6) Out with a trail but no plan (after a hunt or a grab): go home.
      if (trail) { this.mode = "home"; this._aimHome(); return; }

      // 7) Safe at home: plan the next loop (or ramp jump).
      this._plan();
    }

    // Rivals (not me, not my teammate, not spinning out).
    _rivals() {
      const m = this.match, me = this.car.index;
      return m.cars.filter((o) => !m.sameSide(o.index, me) && o.stun <= 0);
    }

    // Wet cells of player q (skipping every `step`-th for speed).
    _wetCells(q, step = 1) {
      const g = this.match.grid, code = q + 1, out = [];
      const tr = g.trail[q];
      for (let k = 0; k < tr.length; k += step) if (g.wet[tr[k]] === code) out.push(tr[k]);
      return out;
    }

    /* Could a rival reach my trail before I get home (plus my safety
       margin)? Easy bots don't always notice. */
    _trailInDanger() {
      if (Math.random() > this.L.defend) return false;
      const g = this.match.grid, car = this.car;
      const home = this._homePoint();
      const myT = home ? dist2D(car.pos.x, car.pos.z, home.x, home.z) / SPEED : 3;
      const cells = this._wetCells(car.index, 2);
      for (const o of this._rivals()) {
        let best = Infinity;
        for (const c of cells) {
          const pt = g.centerOf(c);
          best = Math.min(best, dist2D(o.pos.x, o.pos.z, pt.x, pt.z));
        }
        const theirT = best / Math.max(14, o.speed2D() + 4);
        if (theirT < myT + this.L.margin) return true;
      }
      return false;
    }

    // Nearest home cell (own or teammate dry turf) as a world point.
    _homePoint() {
      const g = this.match.grid, car = this.car, p = car.index;
      const c = g.nearest(car.pos.x, car.pos.z, (k) => g.isHome(k, p));
      return c < 0 ? null : g.centerOf(c);
    }

    // Steer for the nearest home cell.
    _aimHome() {
      const car = this.car;
      const t = this._homePoint();
      if (!t) {
        // No turf left at all! Keep painting; the trail will dry into turf
        // on its own and give us a new home.
        this._plan();
        return;
      }
      // Aim a little past the cell's centre so we end up inside, not on the edge.
      // (Not if that would put the aim point up on a deck or into a wall:
      // then the cell's centre it is.)
      const A = this.match.arena;
      const dx = t.x - car.pos.x, dz = t.z - car.pos.z, d = Math.hypot(dx, dz) || 1;
      const past = { x: t.x + (dx / d) * 1.2, z: t.z + (dz / d) * 1.2 };
      const same = Math.abs(A.groundHeightAt(past.x, past.z) - A.groundHeightAt(t.x, t.z)) < 0.3 && !A.solidAt(past.x, past.z, 0.5);
      this._setTarget(same ? past : t);
    }

    /* A rival with a decent wet trail, close, roughly in front of us:
       aim where they'll be (lead them by their speed). */
    _findRam() {
      const g = this.match.grid, car = this.car;
      if (car.speed2D() < 8) return null;
      for (const o of this._rivals()) {
        if (g.wetCount[o.index] < 8 || o.grace > 0 || o.mega > 0) continue;
        const d = dist2D(car.pos.x, car.pos.z, o.pos.x, o.pos.z);
        if (d > 13) continue;
        const t = d / (car.speed2D() + 6);
        const tx = o.pos.x + o.vel.x * t, tz = o.pos.z + o.vel.z * t;
        if (Math.abs(TP.ai.angleTo(car, tx, tz)) > 0.6) continue;
        return { x: tx, z: tz };
      }
      return null;
    }

    /* Hunting a rival who's out with a wet trail:
       1) the trail cell I can reach soonest, if I get there before they
          get home (every trail cell stays wet until then), or
       2) if I'm too late for the trail, a point on their straight path
          home that I can reach first, so I can cut in and ram them. */
    _findHunt() {
      const m = this.match, g = m.grid, car = this.car, L = this.L;
      const mySpeed = Math.max(15, car.speed2D());
      let best = null, bestT = Infinity;
      for (const o of this._rivals()) {
        const q = o.index;
        if (g.wetCount[q] < 10 || o.mega > 0 || o.grace > 0 || m.trailAge[q] > 5.3) continue;
        // How long until they're home? (Straight-line guess.)
        const hc = g.nearest(o.pos.x, o.pos.z, (k) => g.isHome(k, q), 40);
        const home = hc < 0 ? null : g.centerOf(hc);
        const theirT = home ? dist2D(o.pos.x, o.pos.z, home.x, home.z) / Math.max(12, o.speed2D()) : 4;

        // 1) Nearest reachable trail cell.
        for (const c of this._wetCells(q, 2)) {
          const pt = g.centerOf(c);
          const d = dist2D(car.pos.x, car.pos.z, pt.x, pt.z);
          if (d > L.hunt) continue;
          const myT = d / mySpeed;
          if (myT < theirT + 0.3 && myT < bestT && !m.arena.solidAt(pt.x, pt.z, 1)) { best = pt; bestT = myT; }
        }
        // 2) Cut-off point on their way home.
        if (!best && home && L.ram > 0.5) {
          for (let k = 1; k <= 5; k++) {
            const t = k / 6;
            const x = o.pos.x + (home.x - o.pos.x) * t, z = o.pos.z + (home.z - o.pos.z) * t;
            const myT = dist2D(car.pos.x, car.pos.z, x, z) / mySpeed;
            const theirArrive = dist2D(o.pos.x, o.pos.z, x, z) / Math.max(12, o.speed2D());
            if (dist2D(car.pos.x, car.pos.z, x, z) < L.hunt && myT < theirArrive - 0.2 && myT < bestT) { best = { x, z }; bestT = myT; break; }
          }
        }
      }
      return best;
    }

    _findPickup() {
      const car = this.car;
      let best = null, bestD = this.levelName === "easy" ? 10 : this.levelName === "hard" ? 22 : 16;
      for (const pk of this.match.pickups) {
        const d = dist2D(car.pos.x, car.pos.z, pk.x, pk.z);
        // Someone else is clearly closer: don't bother.
        const rivalCloser = this.match.cars.some((o) => o !== car && dist2D(o.pos.x, o.pos.z, pk.x, pk.z) < d * 0.6);
        if (d < bestD && !rivalCloser) { bestD = d; best = { x: pk.x, z: pk.z }; }
      }
      return best;
    }

    /* ------------------------------------------------------------------
       Planning: loops and ramp jumps
       ------------------------------------------------------------------ */
    _plan() {
      const m = this.match, g = m.grid, A = m.arena, car = this.car, p = car.index, L = this.L;
      const x0 = car.pos.x, z0 = car.pos.z;
      const greed = L.greed + (m.overdrive ? 0.45 : 0);
      const sizeMul = m.overdrive ? 1.25 : 1;
      const rivals = this._rivals();

      /* Pass 1: list loop shapes that fit, with a cheap first guess of
         their value (sampling the floor inside the rectangle).
         Two shapes per direction / side / size:
           "box": out, across, back, and home to where we started;
           "U":   out, across, then straight to the nearest home cell from
                  that corner. Once our turf is big, its edge becomes one
                  side of the loop, which is how the big fills happen.
         A loop has to fit inside the time before a trail dries, at the
         speed we'll drive it (boosting, for bots that boost on loops). */
      const cands = [];
      const homeNear = (pt) => {
        const c = g.nearest(pt.x, pt.z, (k) => g.isHome(k, p), 30);
        return c < 0 ? null : g.centerOf(c);
      };
      const maxLen = L.maxTrail * (L.reserve ? 19 : 15);

      /* Where can a loop start? Right here, or (when we're deep inside our
         own colour, so a loop from here would just repaint our own floor)
         at the edge of our turf: march out in 8 directions to the first
         floor that isn't ours, and start just inside it. Driving there
         costs time, which the score accounts for. */
      const origins = [{ x: x0, z: z0, pre: 0 }];
      const chords = [];      // cut-across paths from one bit of our turf to another
      const allEdges = [];
      if (g.isHome(g.cellAt(x0, z0), p)) {
        const edges = [];
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4, sx = Math.sin(a), sz = Math.cos(a);
          for (let d = 2; d < 60; d += 1.5) {
            const x = x0 + sx * d, z = z0 + sz * d;
            if (A.outside(x, z, 2)) break;
            const c = g.cellAt(x, z);
            if (c < 0 || g.blocked[c] || g.isHome(c, p)) continue;
            const edge = { x: x - sx * 1.5, z: z - sz * 1.5, pre: Math.max(0, d - 1.5), a };
            if (d > 5) edges.push(edge);
            allEdges.push(edge);
            // Keep marching: where do we come back into our colour? A
            // straight cut from the exit to that re-entry point walls off
            // everything between (a "chord").
            for (let d2 = d + 3; d2 < d + 45; d2 += 1.5) {
              const x2 = x0 + sx * d2, z2 = z0 + sz * d2;
              if (A.outside(x2, z2, 2)) break;
              if (g.isHome(g.cellAt(x2, z2), p)) { chords.push([edge, { x: x2 + sx * 1.5, z: z2 + sz * 1.5 }]); break; }
            }
            break;
          }
        }
        // Chords between two exits from our turf, straight or bowed out.
        for (let i = 0; i < allEdges.length; i++) for (let j = i + 1; j < allEdges.length; j++) {
          const e1 = allEdges[i], e2 = allEdges[j];
          if (Math.abs(wrapAngle(e1.a - e2.a)) < Math.PI / 2 - 0.01) continue;
          chords.push([e1, e2]);
          const mx = (e1.x + e2.x) / 2, mz = (e1.z + e2.z) / 2;
          const ox = mx - x0, oz = mz - z0, ol = Math.hypot(ox, oz) || 1;
          chords.push([e1, { x: mx + (ox / ol) * 10, z: mz + (oz / ol) * 10 }, e2]);
        }
        edges.sort((a, b) => a.pre - b.pre);
        for (const e of edges.slice(0, 3)) if (!A.pathBlocked(x0, z0, e.x, e.z, 2)) origins.push(e);
      }

      const jitter = rand(0, Math.PI / 4);
      for (const O of origins) {
      for (let k = 0; k < 8; k++) {
        const a = jitter + (k * Math.PI) / 4;
        const dx = Math.sin(a), dz = Math.cos(a);
        for (const side of [1, -1]) {
          const px = -dz * side, pz = dx * side;   // perpendicular: left or right
          for (const size of L.sizes) {
            const D = size * sizeMul, W = D * rand(0.6, 1.0);
            const P0 = { x: O.x, z: O.z };
            const P1 = { x: O.x + dx * D, z: O.z + dz * D };
            const P2 = { x: P1.x + px * W, z: P1.z + pz * W };
            const P3 = { x: O.x + px * W, z: O.z + pz * W };
            let quick = 0;
            for (let u = 0.8; u < D; u += 1.6) for (let v = 0.8; v < W; v += 1.6) {
              const c = g.cellAt(O.x + dx * u + px * v, O.z + dz * u + pz * v);
              if (c >= 0 && !g.blocked[c] && !g.friendly(g.owner[c], p)) quick += g.owner[c] ? 1.4 : 1;
            }
            if (quick < 4) continue; // nothing to win out there
            const turn = Math.abs(wrapAngle(a - car.heading));
            // Paths start where the car is (the leg to the origin is in our turf).
            const lead = O.pre ? [{ x: x0, z: z0 }] : [];
            const box = [...lead, P0, P1, P2, P3, P0];
            if (this._pathOk(box)) cands.push({ pts: box, len: 2 * (D + W), pre: O.pre, quick, turn, kind: "loop" });
            const H = homeNear(P2);
            if (H && dist2D(H.x, H.z, P0.x, P0.z) > 6) {
              const u = [...lead, P0, P1, P2, H];
              const len = D + W + dist2D(P2.x, P2.z, H.x, H.z);
              if (this._pathOk(u)) cands.push({ pts: u, len, pre: O.pre, quick: quick * 1.1, turn, kind: "loop" });
            }
          }
        }
      }
      }
      // Chord candidates. Their value is all in what they enclose, so the
      // quick guess can't judge them: give every one the real estimate.
      for (const ch of chords) {
        const pts = [{ x: x0, z: z0 }, ...ch];
        let len = 0;
        for (let k = 2; k < pts.length; k++) len += dist2D(pts[k - 1].x, pts[k - 1].z, pts[k].x, pts[k].z);
        if (len < 8 || len > maxLen || !this._pathOk(pts)) continue;
        const gain = g.estimateLoop(p, pts);
        if (gain < 20) continue;
        cands.push({ pts: [...pts, pts[pts.length - 1]], len, pre: ch[0].pre, quick: gain, gain, turn: 0, kind: "loop", exact: true });
      }

      // Too long to finish before the trail dries? Drop it.
      for (let k = cands.length - 1; k >= 0; k--) if (cands[k].len > maxLen) cands.splice(k, 1);

      /* Ramp jumps: foot of the ramp → lip → landing → home. Only launch
         ramps (nothing past the lip), with a clear landing spot. */
      if (L.ramp > 0) {
        for (const r of A.ramps) {
          const past = A.groundHeightAt(r.x + r.fx * (r.L / 2 + 1), r.z + r.fz * (r.L / 2 + 1));
          if (past > 0.5) continue; // leads up onto a deck: not a jump
          const foot = { x: r.x - r.fx * (r.L / 2 + 5), z: r.z - r.fz * (r.L / 2 + 5) };
          const lip = { x: r.x + r.fx * (r.L / 2 - 1), z: r.z + r.fz * (r.L / 2 - 1) };
          const land = { x: r.x + r.fx * (r.L / 2 + 13), z: r.z + r.fz * (r.L / 2 + 13) };
          if (dist2D(x0, z0, foot.x, foot.z) > 30 || A.solidAt(land.x, land.z, 3) || A.solidAt(foot.x, foot.z, 2)) continue;
          if (A.pathBlocked(x0, z0, foot.x, foot.z, 2)) continue;
          // What would the landing splat (radius ~3 cells) take?
          let quick = 0;
          const R = 3 * g.cs;
          for (let u = -R; u <= R; u += g.cs) for (let v = -R; v <= R; v += g.cs) {
            if (u * u + v * v > R * R) continue;
            const c = g.cellAt(land.x + u, land.z + v);
            if (c >= 0 && !g.blocked[c] && !g.friendly(g.owner[c], p)) quick += g.owner[c] ? 1.4 : 1;
          }
          const len = dist2D(x0, z0, foot.x, foot.z) + r.L + 13 + dist2D(land.x, land.z, x0, z0);
          cands.push({ pts: [{ x: x0, z: z0 }, foot, lip, land, { x: x0, z: z0 }], len, quick: quick * 1.3 * L.ramp, turn: 0, kind: "ramp" });
        }
      }

      if (!cands.length) {
        // Boxed in, or nothing worth looping here: head for the nearest
        // floor that isn't ours yet.
        const c = g.nearest(x0, z0, (k) => !g.blocked[k] && !g.friendly(g.owner[k], p));
        const t = c >= 0 ? g.centerOf(c) : { x: rand(-30, 30), z: rand(-30, 30) };
        this._startPlan([t], "loop");
        return;
      }

      // Risk: how soon could the nearest rival reach this loop, compared
      // with how long our trail would be out? Greedier bots accept more.
      const riskFactor = (cd) => {
        const cx = cd.pts.reduce((s, q) => s + q.x, 0) / cd.pts.length, cz = cd.pts.reduce((s, q) => s + q.z, 0) / cd.pts.length;
        let tE = Infinity;
        for (const o of rivals) tE = Math.min(tE, Math.max(0.3, dist2D(o.pos.x, o.pos.z, cx, cz) - cd.len / 8) / 20);
        const ratio = (cd.len / SPEED) * 0.8 / tE;
        return ratio <= greed ? 1 : Math.pow(greed / ratio, 2);
      };
      // Time: the loop itself, the drive to its start, corners and turning.
      const timeOf = (cd) => (cd.len + (cd.pre || 0)) / SPEED + 1.0 + cd.turn * 0.35;

      // Pass 2: the best few by quick guess get the real flood estimate.
      cands.forEach((cd) => { cd.score = (cd.quick * riskFactor(cd)) / timeOf(cd); });
      cands.sort((a, b) => b.score - a.score);
      let best = cands[0], bestScore = -Infinity;
      const shortlist = cands.slice(0, 6).concat(cands.filter((cd) => cd.exact));
      for (const cd of shortlist) {
        const gain = cd.exact ? cd.gain : cd.kind === "ramp" ? cd.quick + g.estimateLoop(p, cd.pts.slice(-2)) : g.estimateLoop(p, cd.pts);
        cd.gain = gain;
        const s = (gain * riskFactor(cd)) / timeOf(cd);
        if (s > bestScore) { bestScore = s; best = cd; }
      }
      // Weaker bots sometimes just pick something.
      if (Math.random() < L.mistake) best = cands[Math.floor(Math.random() * cands.length)];

      // Drive the corners (the start point is where we already are). The
      // last leg home is left to "home" mode, which aims at whatever home
      // cell is nearest by then.
      this._startPlan(best.pts.slice(1, best.pts.length - 1), best.kind);
    }

    _startPlan(points, kind) {
      this.mode = kind;
      this.waypoints = points;
      this.wpTime = 0;
      this.loopBoost = Math.random() < (this.levelName === "easy" ? 0.3 : this.levelName === "hard" ? 0.8 : 0.6);
      this._setTarget(points[0]);
    }

    /* Every leg of a path is drivable (no walls, pillars or tall steps),
       and no corner is tight against a wall or pillar (cars need room to
       turn: a corner hard by the wall means crawling round it)? */
    _pathOk(pts) {
      const A = this.match.arena;
      for (let k = 1; k < pts.length - 1; k++) if (A.solidAt(pts[k].x, pts[k].z, 4)) return false;
      for (let k = 1; k < pts.length; k++) {
        if (A.pathBlocked(pts[k - 1].x, pts[k - 1].z, pts[k].x, pts[k].z, 3, 2)) return false;
      }
      return true;
    }

    /* Escape: stuck twice in a few seconds. Pick the most open direction
       and drive 12 units that way before re-planning. */
    _escape() {
      const A = this.match.arena, car = this.car;
      let best = null, bestD = -1;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        let d = 0;
        while (d < 14 && !A.pathBlocked(car.pos.x, car.pos.z, car.pos.x + Math.sin(a) * (d + 2), car.pos.z + Math.cos(a) * (d + 2), 1.5)) d += 2;
        if (d > bestD) { bestD = d; best = a; }
      }
      const t = { x: car.pos.x + Math.sin(best) * Math.max(4, bestD), z: car.pos.z + Math.cos(best) * Math.max(4, bestD) };
      this.mode = "escape";
      this.waypoints = [t];
      this.wpTime = 0;
      this.route = [];
      this.target = t;
      this.unsticks = [];
    }

    /* Set where we're heading. If it's up on a deck (higher than we can
       drive straight to), route via the best ramp up: its foot, then just
       past its lip. */
    _setTarget(t) {
      this.target = t;
      this.route = [];
      const A = this.match.arena, car = this.car;
      if (!A.decks.length) return;
      const hMe = A.groundHeightAt(car.pos.x, car.pos.z), hT = A.groundHeightAt(t.x, t.z);
      if (hT <= hMe + TP.M5.STEP_UP || !A.pathBlocked(car.pos.x, car.pos.z, t.x, t.z, 0.5)) return;
      // Already on a ramp up to that level: just finish the climb.
      const on = A.rampAt(car.pos.x, car.pos.z);
      if (on && Math.abs(on.h - hT) < 0.6) {
        this.route = [{ x: on.x + on.fx * (on.L / 2 + 3), z: on.z + on.fz * (on.L / 2 + 3) }];
        return;
      }
      let best = null, bestCost = Infinity;
      for (const r of A.ramps) {
        if (Math.abs(r.h - hT) > 0.6) continue;
        const foot = { x: r.x - r.fx * (r.L / 2 + 4), z: r.z - r.fz * (r.L / 2 + 4) };
        const top = { x: r.x + r.fx * (r.L / 2 + 3), z: r.z + r.fz * (r.L / 2 + 3) };
        const cost = dist2D(car.pos.x, car.pos.z, foot.x, foot.z) + dist2D(top.x, top.z, t.x, t.z);
        if (cost < bestCost) { bestCost = cost; best = [foot, top]; }
      }
      if (best) this.route = best;
    }

    /* ------------------------------------------------------------------
       Driving
       ------------------------------------------------------------------ */
    _wantsBoost() {
      const m = this.match, car = this.car, L = this.L;
      if (car.boost <= 5) return false;
      if (this.mode === "home") return this.threat || m.trailAge[car.index] > 2.5;
      if (this.mode === "hunt" || this.mode === "ram") return true;
      if (this.boostWhim) return true; // easy bots burn boost for no reason
      // On a loop or ramp run: boosting paints wider and launches further,
      // but keep `reserve` for a dash home.
      if (this.mode === "loop" || this.mode === "ramp") return this.loopBoost && car.boost > L.reserve + 10;
      return false;
    }

    /* Drive toward (tx, tz), picking a nearby heading with clear floor
       ahead if the direct one would hit something. */
    _steerTo(tx, tz, wantBoost) {
      const car = this.car;
      const speed = car.speed2D();
      const desired = Math.atan2(tx - car.pos.x, tz - car.pos.z);
      const look = 4 + speed * 0.55;

      let chosen = desired;
      for (const off of OFFSETS) {
        if (this._clear(desired + off, look)) { chosen = desired + off; break; }
      }
      // Weaker bots wobble a little.
      if (this.L.noise) chosen += this.L.noise * Math.sin(this.time * 2.3 + this.seed);

      const diff = wrapAngle(chosen - car.heading);   // + = target is to our left
      const dist = dist2D(car.pos.x, car.pos.z, tx, tz);
      let steer = clamp(-diff * 2.5, -1, 1);
      let throttle = 1;
      // Sharp corner: ease off so the turn is tighter (turn rate is fixed,
      // so slower = smaller circle).
      if (Math.abs(diff) > 1.2) throttle = 0.35;
      // Coming up to a loop corner: brake a little so we can turn into
      // the next leg instead of overshooting into the wall.
      if (dist < 6 && speed > 14 && (this.mode === "loop" || this.mode === "ramp") && this.waypoints.length > 1) throttle = 0;
      // Target right behind us and close: reverse instead of circling.
      if (Math.abs(diff) > 2.5 && dist < 7) { throttle = -1; steer = -steer; }
      const boost = wantBoost && Math.abs(diff) < 0.3 && speed > 8 && dist > 6;
      return { throttle, steer, boost, jump: false };
    }

    /* Is the way clear along heading a for `look` units? We want 1.8 units
       of clearance, but if the car is already closer than that to
       something (hugging a pillar or wall), every probe would fail and it
       would push into it, so then we only ask for a little. Steps up that
       are too tall to climb count as blocked. */
    _clear(a, look) {
      const A = this.match.arena, car = this.car;
      const margin = A.solidAt(car.pos.x, car.pos.z, 1.8) ? 0.4 : 1.8;
      return !A.pathBlocked(car.pos.x, car.pos.z, car.pos.x + Math.sin(a) * look, car.pos.z + Math.cos(a) * look, margin, 1.2);
    }
  }

  TP.M5.Bot = Bot;
})();
