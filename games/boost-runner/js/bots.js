/* =====================================================================
   bots.js — computer drivers for Boost Runner.

   A bot outputs exactly the controls a human would ({ drive, pitch,
   jump, boost, hit }, all "held"), so the car can't tell them apart.

   How a bot thinks, in plain English:
     1. Gas on, always.
     2. Chunk hints ("markers") say where to jump, double jump or boost.
        Each bot is a little early or late on each marker (jitter), more
        so on easy.
     3. A safety net, the short "raycast" look-ahead: if there's a gap or
        a wall coming up and it hasn't jumped yet, jump at the edge.
     4. In the air it predicts where it will land (a quick ballistic
        trace against the course). It tilts the nose to match the landing
        slope, so it doesn't tumble. If the trace says "no landing" (it's
        going to fall in), it tries to save itself: double jump, then a
        nose-up dash, then a nose-up boost hop.
     5. When a rival is just ahead, it may Hit-dash into them.
     6. It boosts on the ground when it's falling behind, or now and then
        when its meter is full (keeping some back for rescues).

   All randomness comes from the bot's own seeded RNG, so the same seed
   gives the same race.
   ===================================================================== */
window.TP = window.TP || {};
TP.BR = TP.BR || {};

(function () {
  "use strict";
  const { clamp, wrapAngle } = TP.util;

  /* Skill levels. "Hard chunks" are the tricky ones (wide gap, platform
     hop, ramp jump): lower levels make more mistakes there.
       jitter    marker timing error (units)
       miss      chance to skip a marker (missHard: on hard chunks)
       net       chance the look-ahead safety net is "awake" for a chunk
                 (netHard: on hard chunks). Asleep = it trusts the markers.
       late      safety-net lateness (units)
       rescue    chance to try to save a fall (double jump / dash / boost)
       aggro     Hit-dash eagerness at a rival just ahead (per s)
       chase     eagerness to boost after a rival a little ahead (per s)
       boostFull boost now and then just because the meter is full (hard only) */
  const LEVELS = {
    easy:   { jitter: 1.6, miss: 0.08, missHard: 0.25, net: 0.9, netHard: 0.6, late: 0.9, rescue: 0.3, aggro: 0.25, chase: 0.1, boostFull: 0 },
    normal: { jitter: 0.9, miss: 0.03, missHard: 0.12, net: 0.97, netHard: 0.82, late: 0.4, rescue: 0.55, aggro: 0.6, chase: 0.35, boostFull: 0 },
    hard:   { jitter: 0.3, miss: 0.0, missHard: 0.0, net: 1, netHard: 1, late: 0.1, rescue: 1.0, aggro: 1.2, chase: 0.8, boostFull: 0.6 },
  };
  const HARD_CHUNKS = new Set(["gap_wide", "oneway", "ramp"]);
  TP.BR.HARD_CHUNKS = HARD_CHUNKS;
  TP.BR.BOT_LEVELS = LEVELS;

  class Bot {
    constructor(car, rng, difficulty = "normal") {
      this.car = car;
      this.rng = rng;
      this.level = LEVELS[difficulty] ? difficulty : "normal";
      this.L = LEVELS[this.level];
      this.jumpT = 0;          // seconds left holding jump
      this.releaseT = 0;       // seconds left with jump released (so the next press counts)
      this.hitT = 0;
      this.markerOffsets = new Map(); // marker → this bot's timing error for it
      this.usedMarkers = new Set();
      this.boostHold = false;
      this.airId = 0;          // counts airtimes, so each one rolls its own rescue skill
      this.rescueRoll = null;
      this.lastJumpT = -Infinity;   // round time of the last ground jump this bot asked for
      this.wasGround = true;
      this.backOffT = 0;       // seconds left reversing away from a wall
      this.lastBackOff = -Infinity;
      this.netAwake = new Map(); // chunk index → is the safety net on for it
      this.chaseHold = false;
    }

    isHard(course, chunkIndex) {
      const c = course.chunks[chunkIndex];
      return !!c && HARD_CHUNKS.has(c.id);
    }

    // Is the look-ahead safety net awake for this chunk? (Rolled once per chunk.)
    netFor(course, chunkIndex) {
      if (!this.netAwake.has(chunkIndex)) {
        const p = this.isHard(course, chunkIndex) ? this.L.netHard : this.L.net;
        this.netAwake.set(chunkIndex, this.rng.chance(p));
      }
      return this.netAwake.get(chunkIndex);
    }

    // Ask for a jump press (handles releasing first so it registers as new).
    pressJump() {
      if (this.jumpT > 0 || this.releaseT > 0) return;
      this.jumpT = 0.1;
    }
    pressHit() {
      if (this.hitT > 0) return;
      this.hitT = 0.08;
    }

    offsetFor(m, course) {
      if (!this.markerOffsets.has(m)) {
        const skip = this.rng.chance(this.isHard(course, m.chunk) ? this.L.missHard : this.L.miss);
        this.markerOffsets.set(m, skip ? null : this.rng.range(-this.L.jitter, this.L.jitter * 0.6));
      }
      return this.markerOffsets.get(m);
    }

    /* Work out this step's controls.
       ctx = { course, view, cars, dt, T } */
    think(ctx) {
      const car = this.car, { course, view, cars, dt } = ctx;
      const out = { drive: 1, pitch: 0, jump: false, boost: false, hit: false };
      if (!car.alive) return out;

      if (car.onGround && !this.wasGround) this.rescueRoll = null;
      if (!car.onGround && this.wasGround) { this.airId++; this.rescueRoll = null; }
      this.wasGround = car.onGround;

      const speed = Math.hypot(car.vx, car.vy);

      /* ---------- Markers (chunk hints) ---------- */
      for (const m of this.markersNear(course, car.x)) {
        if (this.usedMarkers.has(m)) continue;
        const off = this.offsetFor(m, course);
        if (off === null) { if (car.x > m.x + 2) this.usedMarkers.add(m); continue; }
        if (car.x >= m.x + off) {
          this.usedMarkers.add(m);
          if (m.action === "jump" && car.onGround) { this.pressJump(); this.lastJumpT = ctx.time; }
          else if (m.action === "double" && !car.onGround && !car.doubleUsed) this.pressJump();
        }
      }

      if (car.onGround) {
        const look = this.lookAhead(course, car);
        const ci = course.chunkIndexAt(car.x + 4); // the chunk we're heading into
        const netOn = this.netFor(course, ci < 0 ? car.chunkIndex : ci);

        /* ---------- Bumped back or stopped at a step face? ----------
           Back off to get a run-up (~6 units), then go again: the normal
           wall-jump rule below fires once we're back up to speed. If the
           camera edge is too close for that, hop and boost over instead. */
        const nearFace = look.wall !== null && look.wall < 3.5 && car.vx < 8;
        const edgeClose = car.x < view.left + view.width * 0.2;
        if (nearFace && this.backOffT <= 0 && ctx.time - this.lastBackOff > 1.5) {
          if (edgeClose && car.boost > 15) {
            if (ctx.time - this.lastJumpT > 0.35) { this.pressJump(); this.lastJumpT = ctx.time; }
          } else {
            this.backOffT = 1.2;
            this.lastBackOff = ctx.time;
          }
        }
        const backingOff = this.backOffT > 0 && !(look.wall === null || look.wall >= 6);
        if (this.backOffT > 0) this.backOffT = backingOff ? this.backOffT - dt : 0;
        if (backingOff) out.drive = -1;

        /* ---------- Safety net: look ahead for gaps and walls ---------- */
        if (netOn && look.edge !== null) {
          // Jump right at the edge (a little late on easy).
          const at = Math.max(0.3, speed * dt * 1.5 + 0.35 - this.L.late * 0.2);
          if (look.edge <= at && ctx.time - this.lastJumpT > 0.35) { this.pressJump(); this.lastJumpT = ctx.time; }
        }
        if (look.wall !== null && !backingOff) {
          // The best take-off window for a ~1.4 step at 17 is ~3–9.5 units out.
          const fast = car.vx > 9;
          if ((fast && look.wall <= 5.2 + this.L.late * 0.5 && look.wall >= 2.2) || (!fast && look.wall <= 1.6)) {
            if (ctx.time - this.lastJumpT > 0.35) { this.pressJump(); this.lastJumpT = ctx.time; }
          }
        }

        /* ---------- Ground boost: only with a reason ----------
           1) the camera edge is catching us, 2) a wide gap is coming,
           3) chasing a rival a little ahead, 4) hard bots only: now and
           then on a full meter. */
        if (!backingOff) {
          if (car.x < view.left + view.width * 0.25 && car.boost > 8) out.boost = true;
          const ch = ci >= 0 ? course.chunks[ci] : null;
          if (look.edge !== null && look.edge < 6 && ch && ch.gap >= 14 && car.boost > 40) out.boost = true;
          let rivalAhead = false;
          for (const r of cars) if (r !== car && r.alive && r.x - car.x > 3 && r.x - car.x < 10) rivalAhead = true;
          if (!this.chaseHold && rivalAhead && car.boost > 60 && this.rng.chance(this.L.chase * dt)) this.chaseHold = true;
          if (this.chaseHold && (!rivalAhead || car.boost < 40)) this.chaseHold = false;
          if (this.chaseHold) out.boost = true;
          if (!this.boostHold && car.boost >= 99 && this.rng.chance(this.L.boostFull * dt)) this.boostHold = true;
          if (this.boostHold && car.boost < 55) this.boostHold = false;
          if (this.boostHold) out.boost = true;
        }
      } else {
        this.boostHold = false;
        this.chaseHold = false;
        /* ---------- In the air: predict the landing ---------- */
        const land = this.predictLanding(course, view, car, ctx.T);
        // Hopping up a wall with no forward speed: boost, nose a little up.
        const hWall = course.heightAt(car.x + 1.6);
        const atWall = hWall !== null && hWall > car.y - 0.2 && car.vx < 6;
        if (atWall && car.boost > 2) {
          out.boost = true;
          out.pitch = clamp(wrapAngle(0.25 - car.angle) * 4, -1, 1);
        } else if (land) {
          // Line the nose up with where we'll land.
          out.pitch = clamp(wrapAngle(land.angle - car.angle) * 4, -1, 1);
        } else {
          // Going to fall in. Try to save it (once per airtime, rolled by skill).
          if (this.rescueRoll === null) this.rescueRoll = this.rng.chance(this.L.rescue);
          if (this.rescueRoll) {
            const aim = 0.75; // nose ~43° up: thrust carries you forward and up
            out.pitch = clamp(wrapAngle(aim - car.angle) * 4, -1, 1);
            if (!car.doubleUsed && car.vy < 3) this.pressJump();
            else if (!car.airDashUsed && car.angle > 0.4 && car.vy < 2 && car.boost >= TP.BR.CAR_RULES.dashBoostCost) this.pressHit();
            else if (car.boost > 2) out.boost = true;
          }
        }
      }

      /* ---------- Hit-dash a rival just ahead ---------- */
      for (const r of cars) {
        if (r === car || !r.alive) continue;
        const dx = r.x - car.x, dy = r.y - car.y;
        if (dx > 0.5 && dx < 4.5 && Math.abs(dy) < 1.5) {
          const ready = (car.onGround ? car.dashCool <= 0 : !car.airDashUsed) && car.boost >= 45;
          if (ready && this.rng.chance(this.L.aggro * dt * 6)) this.pressHit();
        }
      }

      /* ---------- Turn presses into held buttons ---------- */
      if (this.jumpT > 0) {
        out.jump = true;
        this.jumpT -= dt;
        if (this.jumpT <= 0) this.releaseT = 0.05;
      } else if (this.releaseT > 0) {
        this.releaseT -= dt;
      }
      if (this.hitT > 0) { out.hit = true; this.hitT -= dt; }
      return out;
    }

    // Markers in the chunks around x (cheap: markers are stored in order).
    markersNear(course, x) {
      const i = course.chunkIndexAt(x);
      if (i < 0) return [];
      const res = [];
      for (const m of course.markers) if (m.chunk === i || m.chunk === i + 1) res.push(m);
      return res;
    }

    /* The look-ahead "raycast": step forward along the track and find the
       first gap edge (no ground under the wheels, or a big drop) and the
       first wall (ground more than a small ledge higher). Distances in
       units, or null. */
    lookAhead(course, car) {
      const res = { edge: null, wall: null };
      // Walk forward along the ground, following slopes (so a ramp isn't
      // mistaken for a wall, and the drop past a ramp's top isn't missed).
      let refY = car.y;
      for (let d = 0.25; d <= 12; d += 0.25) {
        const xx = car.x + d;
        const h = course.heightAt(xx);
        // A wall is a sudden rise (a step face), not a slope.
        if (h !== null && h > refY + 0.45) { res.wall = d; break; }
        const s = course.surfaceBelow(xx, refY + 0.45);
        if (!s || s.y < refY - 3) { res.edge = d; break; }
        refY = s.y;
      }
      return res;
    }

    /* Quick ballistic trace (no boost): where will we land, if anywhere?
       Returns { x, y, angle } or null if we'd fall off the bottom or hit a
       wall face first. */
    predictLanding(course, view, car, T) {
      let x = car.x, y = car.y, vx = car.vx, vy = car.vy;
      const h = 1 / 30;
      for (let i = 0; i < 75; i++) {
        vy -= T.gravity * h;
        const nx = x + vx * h, ny = y + vy * h;
        if (vy <= 0) {
          const hit = course.surfaceCrossed(nx, y, ny);
          if (hit) {
            // Only trust a landing with some track behind it: one right on
            // the corner of a ledge is a near-miss, so treat it as "no landing".
            const back = course.surfaceBelow(nx - 1.2, hit.y + 0.3);
            if (back && back.y > hit.y - 0.4) return { x: nx, y: hit.y, angle: hit.angle };
            return null;
          }
        }
        if (course.insideSolid(nx, ny + 0.3)) return null;
        x = nx; y = ny;
        if (y < view.bottom - 1) return null;
      }
      return null;
    }
  }
  TP.BR.Bot = Bot;
})();
