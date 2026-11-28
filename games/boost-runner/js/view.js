/* =====================================================================
   view.js — the "rule camera". Plain maths, no Three.js.

   Every physics step this works out the rectangle of the world that is
   on screen (left, right, top, bottom at z = 0). KOs are judged against
   it, and js/camera.js (Art and UI) places the real camera so exactly
   this rectangle fills the screen. So what you see is the rule.

   The rules, in plain English:
     • Follow the leader, holding them at 65% of the screen width, so
       you can see what's coming.
     • Never move backwards.
     • Zoom out as the pack spreads, up to a maximum width. That maximum
       tightens as the round goes on.
     • The trailing edge is also pushed right at a minimum speed that
       rises over time, so slow or stuck cars get caught.
     • After 120 s of racing: sudden death. The minimum speed climbs
       fast, so the round ends within a few seconds.
     • Height follows the course smoothly (lagging a little, so jumps
       don't shake the screen).
   ===================================================================== */
window.TP = window.TP || {};
TP.BR = TP.BR || {};

(function () {
  "use strict";
  const { clamp, damp } = TP.util;

  // All the follow/zoom numbers in one place (Art and UI can ask the boss
  // to change them).
  const VIEW_RULES = {
    leaderAt: 0.65,         // leader held at this fraction of the width
    dangerFrac: 0.10,       // trailing 10% of the screen is the danger zone
    baseWidth: 44,          // narrowest view (units). The car is 3 long.
    maxWidthStart: 64,      // widest view at the start of a round...
    maxWidthEnd: 48,        // ...tightening to this...
    maxWidthTime: 90,       // ...by this many seconds of racing
    zoomRate: 1.2,          // how fast the zoom eases (bigger = snappier)
    followRate: 5,          // how fast the view catches up with the leader
    heightRate: 1.8,        // how fast the view follows the course height
    groundFrac: 0.14,       // the course's reference height sits this far below the middle
    // Minimum speed of the trailing edge (units/s), by race time:
    minSpeedDelay: 2,       // nothing for the first 2 s after GO
    minSpeedStart: 6,
    minSpeedEnd: 22,        // above gas (17) and above what a pack holds without boosting
    minSpeedTime: 90,       // reaches minSpeedEnd at this race time (passes 17 at ~62 s)
    suddenDeathAt: 120,     // the hard backstop
    suddenDeathRamp: 6,     // after it, the minimum speed climbs this much per second
    aspectMin: 4 / 3,
    aspectMax: 21 / 9,
  };
  TP.BR.VIEW_RULES = VIEW_RULES;

  class View {
    constructor(aspect = 16 / 9) {
      this.rules = VIEW_RULES;
      this.setAspect(aspect);
      this.left = 0;
      this.width = VIEW_RULES.baseWidth;
      this.centerY = 0;
      this.minSpeed = 0;
      this.suddenDeath = false;
      this.compute();
    }

    setAspect(a) {
      this.aspect = clamp(Number(a) || 16 / 9, VIEW_RULES.aspectMin, VIEW_RULES.aspectMax);
      if (this.left !== undefined) this.compute();
    }

    // Start of a round: frame the starting grid.
    reset(leaderX, course) {
      const R = VIEW_RULES;
      this.width = R.baseWidth;
      this.left = leaderX - R.leaderAt * this.width;
      this.centerY = course.refHeight(this.left + this.width / 2) + R.groundFrac * this.heightFor(this.width);
      this.minSpeed = 0;
      this.suddenDeath = false;
      this.compute();
    }

    // Height in world units (the width over the screen aspect).
    heightFor(w) { return w / this.aspect; }

    // The widest the view may be at this race time.
    maxWidth(raceTime) {
      const R = VIEW_RULES;
      const k = clamp(raceTime / R.maxWidthTime, 0, 1);
      return R.maxWidthStart + (R.maxWidthEnd - R.maxWidthStart) * k;
    }

    // How fast the trailing edge is pushed right at this race time.
    minSpeedAt(raceTime) {
      const R = VIEW_RULES;
      if (raceTime < R.minSpeedDelay) return 0;
      if (raceTime >= R.suddenDeathAt) return R.minSpeedEnd + (raceTime - R.suddenDeathAt) * R.suddenDeathRamp;
      const k = clamp((raceTime - R.minSpeedDelay) / (R.minSpeedTime - R.minSpeedDelay), 0, 1);
      return R.minSpeedStart + (R.minSpeedEnd - R.minSpeedStart) * k;
    }

    /* One step.
       cars     — the cars still racing (need .x, .y)
       raceTime — seconds since GO
       course   — for the reference height */
    update(dt, cars, raceTime, course) {
      const R = VIEW_RULES;
      if (!cars.length) { this.compute(); return; }
      let leadX = -Infinity, lastX = Infinity, leadY = 0;
      for (const c of cars) {
        if (c.x > leadX) { leadX = c.x; leadY = c.y; }
        if (c.x < lastX) lastX = c.x;
      }

      // Zoom: wide enough to show the pack between ~10% and 65%, within limits.
      const spread = leadX - lastX;
      const wanted = clamp(spread / (R.leaderAt - 0.12) , R.baseWidth, this.maxWidth(raceTime));
      this.width = damp(this.width, wanted, R.zoomRate, dt);
      // The maximum can tighten under us; respect it straight away.
      this.width = Math.min(this.width, this.maxWidth(raceTime));

      // Follow: ease toward holding the leader at 65%, but never backwards,
      // and never slower than the minimum speed.
      this.minSpeed = this.minSpeedAt(raceTime);
      this.suddenDeath = raceTime >= R.suddenDeathAt;
      const target = leadX - R.leaderAt * this.width;
      const eased = damp(this.left, target, R.followRate, dt);
      this.left = Math.max(this.left + this.minSpeed * dt, eased, this.left);

      // Height: follow the course's reference height, lagging a little.
      // If the leader climbs high (a big jump), lift so they stay on screen.
      const h = this.heightFor(this.width);
      let targetY = course.refHeight(this.left + this.width * 0.5) + R.groundFrac * h;
      const leaderTopRoom = targetY + h / 2 - 3;
      if (leadY > leaderTopRoom) targetY += (leadY - leaderTopRoom) * 0.5;
      this.centerY = damp(this.centerY, targetY, R.heightRate, dt);
      this.compute();
    }

    // Fill in the plain fields main.js and the KO check read.
    compute() {
      const w = this.width, h = this.heightFor(w);
      this.height = h;
      this.right = this.left + w;
      this.top = this.centerY + h / 2;
      this.bottom = this.centerY - h / 2;
      this.centerX = this.left + w / 2;
      this.dangerX = this.left + w * VIEW_RULES.dangerFrac;
    }

    // A plain copy (for snapshots and QC).
    rect() {
      return {
        left: this.left, right: this.right, top: this.top, bottom: this.bottom,
        width: this.width, height: this.height, centerX: this.centerX, centerY: this.centerY,
        aspect: this.aspect, dangerX: this.dangerX, minSpeed: this.minSpeed, suddenDeath: this.suddenDeath,
      };
    }
  }
  TP.BR.View = View;
})();
