/* =====================================================================
   bots.js — TP.M5.Bot: the CPU drivers.

   A bot outputs exactly the controls a human would (throttle, steer,
   boost, jump), so it plays by the same rules and the same car feel.

   Every so often (its "reaction time") the bot re-thinks what to do,
   picking one of these jobs:

     loop  — drive out of its turf in a rectangle and come back, so the
             loop fills. It scores possible rectangles by how much new
             (or rival) floor they'd grab for the distance driven, and
             skips any that would run into a wall, pillar or ramp.
     home  — get back to its own colour by the shortest way: the trail
             is getting old (it would dry with no fill) or a rival is
             close enough to pop it.
     hunt  — a rival's wet trail is reachable before that rival can get
             home: drive across it to pop it.
     grab  — a pickup is close: go get it.

   Steering uses look-ahead: it checks a few headings around the one it
   wants and takes the closest one with clear floor ahead, so bots bend
   around pillars, ramps and walls instead of driving into them.

   Difficulty changes reaction time, loop size (greed), how early it
   notices threats, how far it will go to hunt, and how much it boosts.
   ===================================================================== */
window.TP = window.TP || {};
TP.M5 = TP.M5 || {};

(function () {
  "use strict";
  const { clamp, dist2D, wrapAngle, rand } = TP.util;

  const LEVELS = {
    //        re-think  loop size  give up  threat  hunt   boost  grab
    //        every s   (units)    trail s  dist    range  use    range
    easy:   { think: 0.55, loopD: 11, maxTrail: 3.6, threat: 5, hunt: 14, boost: 0.35, grab: 10 },
    normal: { think: 0.3, loopD: 15, maxTrail: 4.4, threat: 8, hunt: 26, boost: 0.75, grab: 16 },
    hard:   { think: 0.18, loopD: 18, maxTrail: 4.9, threat: 11, hunt: 36, boost: 1.0, grab: 22 },
  };
  TP.M5.BOT_LEVELS = LEVELS;

  // Headings to try, in order, around the one we want (radians).
  const OFFSETS = [0, 0.35, -0.35, 0.7, -0.7, 1.1, -1.1, 1.6, -1.6, 2.2, -2.2];
  const ARRIVE = 3.5;   // waypoint reached when this close

  class Bot {
    constructor(match, car, level) {
      this.match = match;
      this.car = car;
      this.L = LEVELS[level] || LEVELS.normal;
      this.reset();
    }

    // Fresh brain for a new round.
    reset() {
      this.mode = "loop";
      this.waypoints = [];
      this.target = null;          // { x, z } we're steering toward
      this.thinkIn = rand(0, this.L.think); // stagger bots so they don't all think on one frame
      this.stuckT = 0;
      this.reverseT = 0;
      this.wpTime = 0;
      this.wasStunned = false;
      this.threat = Infinity;
      this.loopBoost = false;
    }

    /* Called every physics step by the match. */
    controls(dt) {
      const car = this.car;
      // Coming out of a spin-out: re-think straight away.
      if (this.wasStunned) { this.wasStunned = false; this.thinkIn = 0; }
      if (car.stun > 0) this.wasStunned = true;

      this.thinkIn -= dt;
      if (this.thinkIn <= 0) {
        this.thinkIn = this.L.think;
        this.think();
      }

      // Waypoint bookkeeping for loops.
      if (this.mode === "loop" && this.waypoints.length) {
        this.wpTime += dt;
        const w = this.waypoints[0];
        // Reached it, or it's taking far too long (blocked): next corner.
        if (dist2D(car.pos.x, car.pos.z, w.x, w.z) < ARRIVE || this.wpTime > 3.5) {
          this.waypoints.shift();
          this.wpTime = 0;
          if (!this.waypoints.length) { this.mode = "home"; this._aimHome(); }
        }
        if (this.waypoints.length) this.target = this.waypoints[0];
      }

      // Stuck against something? Back up for a moment.
      if (this.reverseT > 0) {
        this.reverseT -= dt;
        return { throttle: -1, steer: this._unstickSteer, boost: false, jump: false };
      }
      const speed = car.speed2D();
      if (speed < 1.5) this.stuckT += dt; else this.stuckT = 0;
      if (this.stuckT > 0.8) {
        this.stuckT = 0;
        this.reverseT = 0.7;
        this._unstickSteer = Math.random() < 0.5 ? -1 : 1;
        this.thinkIn = 0.7; // re-plan once we're free
        return { throttle: -1, steer: this._unstickSteer, boost: false, jump: false };
      }

      if (!this.target) return { throttle: 0, steer: 0, boost: false, jump: false };
      const boost = this._wantsBoost();
      return this._steerTo(this.target.x, this.target.z, boost);
    }

    /* ------------------------------------------------------------------
       Deciding what to do
       ------------------------------------------------------------------ */
    think() {
      const m = this.match, g = m.grid, car = this.car, p = car.index, L = this.L;
      const trail = g.hasTrail(p);
      const age = m.trailAge[p];
      // Remembered until the next think, so driving code can use it cheaply.
      this.threat = trail ? this._threatToMyTrail() : Infinity;

      // 1) My trail is in danger or about to dry: go home.
      if (trail && (age > L.maxTrail || this.threat < L.threat)) {
        this.mode = "home";
        this._aimHome();
        return;
      }

      // 2) A rival's trail I can cut before they get home: hunt it.
      //    (Only if I'm not already carrying a long trail myself.)
      if (!trail || age < 1.5) {
        const h = this._findHunt();
        if (h) { this.mode = "hunt"; this.target = h; return; }
      }

      // 3) A pickup nearby: grab it (unless my trail is getting long).
      if (!trail || age < 2.5) {
        const pk = this._findPickup();
        if (pk) { this.mode = "grab"; this.target = pk; return; }
      }

      // 4) Keep following a loop that's already under way.
      if (this.mode === "loop" && this.waypoints.length) { this.target = this.waypoints[0]; return; }

      // 5) Out with a trail but no plan (after a hunt or a grab): go home.
      if (trail) { this.mode = "home"; this._aimHome(); return; }

      // 6) Safe at home: plan the next loop.
      this._planLoop();
    }

    // Steer for the nearest cell of my own dry turf.
    _aimHome() {
      const g = this.match.grid, car = this.car, p = car.index;
      const c = g.nearest(car.pos.x, car.pos.z, (k) => g.isOwnDry(k, p));
      if (c < 0) {
        // No turf left at all! Just keep painting; the trail will dry
        // into turf on its own and give us a new home.
        this._planLoop();
        return;
      }
      const t = g.centerOf(c);
      // Aim a little past the cell's centre so we end up inside, not on the edge.
      const dx = t.x - car.pos.x, dz = t.z - car.pos.z, d = Math.hypot(dx, dz) || 1;
      this.target = { x: t.x + (dx / d) * 1.2, z: t.z + (dz / d) * 1.2 };
    }

    // How close is the nearest (un-stunned) rival to any cell of my trail?
    _threatToMyTrail() {
      const m = this.match, g = m.grid, p = this.car.index, code = p + 1;
      const tr = g.trail[p];
      let best = Infinity;
      for (const o of m.cars) {
        if (o === this.car || o.stun > 0) continue;
        for (let k = 0; k < tr.length; k += 2) {
          const c = tr[k];
          if (g.wet[c] !== code) continue;
          const pt = g.centerOf(c);
          const d = dist2D(o.pos.x, o.pos.z, pt.x, pt.z);
          if (d < best) best = d;
        }
      }
      return best;
    }

    /* Find a rival trail cell I can reach before its owner gets home.
       Returns a target point or null. */
    _findHunt() {
      const m = this.match, g = m.grid, car = this.car, L = this.L;
      const mySpeed = Math.max(14, car.speed2D());
      let best = null, bestD = Infinity;
      for (const o of m.cars) {
        const q = o.index;
        if (o === car || g.wetCount[q] < 12 || o.mega > 0 || o.grace > 0) continue;
        if (m.trailAge[q] > 5.4) continue; // about to dry anyway
        // Nearest wet cell of theirs to me.
        const code = q + 1, tr = g.trail[q];
        let cd = Infinity, cell = -1;
        for (let k = 0; k < tr.length; k++) {
          const c = tr[k];
          if (g.wet[c] !== code) continue;
          const pt = g.centerOf(c);
          const d = dist2D(car.pos.x, car.pos.z, pt.x, pt.z);
          if (d < cd) { cd = d; cell = c; }
        }
        if (cell < 0 || cd > L.hunt || cd >= bestD) continue;
        // How long until they're home? (Straight-line guess.)
        const hc = g.nearest(o.pos.x, o.pos.z, (k) => g.isOwnDry(k, q), 40);
        const homeD = hc < 0 ? 99 : (() => { const h = g.centerOf(hc); return dist2D(o.pos.x, o.pos.z, h.x, h.z); })();
        const theirT = homeD / Math.max(10, o.speed2D());
        const myT = cd / mySpeed;
        if (myT > theirT + 0.35) continue;
        const pt = g.centerOf(cell);
        if (this.match.arena.solidAt(pt.x, pt.z, 1)) continue;
        best = pt;
        bestD = cd;
      }
      return best;
    }

    _findPickup() {
      const car = this.car;
      let best = null, bestD = this.L.grab;
      for (const pk of this.match.pickups) {
        const d = dist2D(car.pos.x, car.pos.z, pk.x, pk.z);
        // Someone else is clearly closer: don't bother.
        const rivalCloser = this.match.cars.some((o) => o !== car && dist2D(o.pos.x, o.pos.z, pk.x, pk.z) < d * 0.6);
        if (d < bestD && !rivalCloser) { bestD = d; best = { x: pk.x, z: pk.z }; }
      }
      return best;
    }

    /* ------------------------------------------------------------------
       Loop planning
       ------------------------------------------------------------------ */
    _planLoop() {
      const m = this.match, g = m.grid, A = m.arena, car = this.car, p = car.index;
      const x0 = car.pos.x, z0 = car.pos.z;

      // Loop size: bigger in overdrive (greedier), smaller with rivals near.
      const rivalNear = m.cars.some((o) => o !== car && dist2D(o.pos.x, o.pos.z, x0, z0) < 14);
      const base = this.L.loopD * (m.overdrive ? 1.3 : 1) * (rivalNear ? 0.7 : 1);

      let best = null, bestScore = -Infinity;
      const jitter = rand(0, Math.PI / 4); // vary the directions tried each time
      for (let k = 0; k < 8; k++) {
        const a = jitter + (k * Math.PI) / 4;
        const dx = Math.sin(a), dz = Math.cos(a);
        for (const side of [1, -1]) {
          // Perpendicular to the out leg (side picks left or right).
          const px = -dz * side, pz = dx * side;
          for (const D of [base, base * 1.4]) {
            const W = D * 0.75;
            const P1 = { x: x0 + dx * D, z: z0 + dz * D };
            const P2 = { x: P1.x + px * W, z: P1.z + pz * W };
            const P3 = { x: x0 + px * W, z: z0 + pz * W };
            if (!this._pathClear(x0, z0, P1) || !this._pathClear(P1.x, P1.z, P2) ||
                !this._pathClear(P2.x, P2.z, P3) || !this._pathClear(P3.x, P3.z, { x: x0, z: z0 })) continue;

            // What would this rectangle grab? Sample its inside.
            let gain = 0;
            const step = 1.6;
            for (let u = step / 2; u < D; u += step) {
              for (let v = step / 2; v < W; v += step) {
                const c = g.cellAt(x0 + dx * u + px * v, z0 + dz * u + pz * v);
                if (c < 0 || g.blocked[c] || g.owner[c] === p + 1) continue;
                gain += g.owner[c] ? 1.3 : 1; // stealing rival floor is worth a bit more
              }
            }
            // Cost: distance driven, plus turning to face the first leg.
            const turn = Math.abs(wrapAngle(a - car.heading));
            const cost = 2 * (D + W) + 10 + turn * 6;
            const score = gain / cost;
            if (score > bestScore) { bestScore = score; best = [P1, P2, P3]; }
          }
        }
      }

      if (!best || bestScore <= 0) {
        // Nothing worth looping here (boxed in, or everything nearby is
        // ours already): head toward open, unowned floor instead.
        const c = g.nearest(x0, z0, (k) => !g.blocked[k] && g.owner[k] !== p + 1);
        const t = c >= 0 ? g.centerOf(c) : { x: rand(-30, 30), z: rand(-30, 30) };
        best = [t];
      }
      this.mode = "loop";
      this.loopBoost = Math.random() < this.L.boost * 0.8;
      this.waypoints = best;
      this.wpTime = 0;
      this.target = best[0];
    }

    // Is the straight line from (x, z) to point b clear of walls/obstacles?
    _pathClear(x, z, b) {
      const A = this.match.arena;
      const len = dist2D(x, z, b.x, b.z);
      const n = Math.max(1, Math.ceil(len / 2));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        if (A.solidAt(x + (b.x - x) * t, z + (b.z - z) * t, 3.5)) return false;
      }
      return true;
    }

    /* ------------------------------------------------------------------
       Driving
       ------------------------------------------------------------------ */
    _wantsBoost() {
      const m = this.match, car = this.car;
      if (car.boost < 20) return false;
      if (this.mode === "home") return m.trailAge[car.index] > 2 || this.threat < this.L.threat * 1.4;
      if (this.mode === "hunt") return true;
      // On a loop: boosting paints wider, but uses the meter. Whether to
      // boost this loop is decided once when it's planned (higher levels
      // say yes more often), and we keep some meter for a dash home.
      if (this.mode === "loop") return this.loopBoost && car.boost > 40;
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

      const diff = wrapAngle(chosen - car.heading);   // + = target is to our left
      const dist = dist2D(car.pos.x, car.pos.z, tx, tz);
      let steer = clamp(-diff * 2.5, -1, 1);
      let throttle = 1;
      // Sharp corner: ease off so the turn is tighter (turn rate is fixed,
      // so slower = smaller circle).
      if (Math.abs(diff) > 1.2) throttle = 0.35;
      // Target right behind us and close: reverse instead of circling.
      if (Math.abs(diff) > 2.5 && dist < 7) { throttle = -1; steer = -steer; }
      const boost = wantBoost && Math.abs(diff) < 0.25 && speed > 8 && dist > 6;
      return { throttle, steer, boost, jump: false };
    }

    /* Is the floor clear along heading a for `look` units?
       We want 1.8 units of clearance, but if the car is already closer
       than that to something (hugging a pillar or wall), every probe
       would fail and it would just push into it. So in that case we only
       ask for a little clearance, which lets it slide around the edge. */
    _clear(a, look) {
      const A = this.match.arena, car = this.car;
      const margin = A.solidAt(car.pos.x, car.pos.z, 1.8) ? 0.4 : 1.8;
      const sx = Math.sin(a), sz = Math.cos(a);
      for (const t of [0.35, 0.7, 1]) {
        if (A.solidAt(car.pos.x + sx * look * t, car.pos.z + sz * look * t, margin)) return false;
      }
      return true;
    }
  }

  TP.M5.Bot = Bot;
})();
