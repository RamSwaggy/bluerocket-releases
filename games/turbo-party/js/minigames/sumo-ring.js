/* =====================================================================
   Sumo Ring — last car standing.
   Everyone starts on a round platform floating in space. Bump rivals off
   the edge. After 12 seconds the platform starts shrinking, down to a
   tiny disc by 31 seconds, so rounds rarely go the distance. Fall off
   and you're out. Survivors at the 45-second mark share first place — but
   a car that's already gone over the edge when the time runs out counts
   as having fallen, not as a survivor.

   Every round is shuffled a little (start spots, the angle of the
   starting circle, and each bot's "personality"), because the physics
   and bots are otherwise fully deterministic: with nothing random, the
   same car won every single round in exactly the same time.
   ===================================================================== */
(function () {
  "use strict";
  const { dist2D, clamp, rand, shuffle } = TP.util;

  const START_R = 17;   // platform radius at the start

  /* Tuning knobs, gathered in one place (and exposed as SumoRing.CONFIG
     so balance scripts can try other values without editing the file).
       tuning       — car settings for this mode, via TP.modeTuning
       minR         — the smallest radius the platform shrinks to
       shrinkFrom / shrinkTo — seconds when shrinking starts / reaches minR */
  /* Tuned for the shared car feel as of the Director's speed-cap fix
     (held gas caps at 17, boost 27, head-on knockback carries past
     reverse top speed). Measured over 40 bot rounds: average 28.3 s, none
     under 12 s, none reaching 45 s. Why each value:
       • bumpScale 0.8 (was 1.15) and grip 10 (was 8): with the harder
         head-on hits, the old values turned the opening seconds into a
         pile-up that knocked out 2–3 cars before the ring even shrank.
       • maxSpeed 14 / boostMax 20 unchanged: lower top speeds than other
         modes so one ram doesn't launch both cars off.
       • minR 5 (was 8), shrinking 12 s → 31 s (was 15 → 35): the old
         16-unit disc left room for the last two cars to circle each
         other until time ran out (about half of all rounds).
       • shrinkTo is effectively the round-length dial: almost every
         round ends 2–3 s before the shrink finishes, as the last cars
         are squeezed off the small disc (measured: 38 → ~34 s average,
         34 → ~30.5 s, 32 → ~29.5 s, 31 → ~28.3 s).
       (A "calm start" — no boost and capped gas for the first 2–3 s —
       was also tried; it didn't help once bumps were softer, so it's out.) */
  const CONFIG = {
    tuning: { bumpScale: 0.8, grip: 10, maxSpeed: 14, boostMax: 20 },
    minR: 5,
    shrinkFrom: 12,
    shrinkTo: 31,
  };

  class SumoRing extends TP.Arena {
    constructor(game) {
      super(game, {
        title: "Sumo Ring",
        duration: 45,
        size: START_R,
        camera: { y: 36, z: 30, lookZ: 1 },
        tuning: SumoRing.CONFIG.tuning,
      });
      this.radius = START_R;
      this.outOrder = []; // player indices in the order they fell
      this.judged = false; // has the end-of-time edge check run yet?
      this.minds = this.cars.map(() => this.newMind());
    }

    /* A bot's "personality" for this round, rolled fresh every time so
       the four bots don't play out the same fight each round:
         chargeDist — how close a rival must be before we commit a boost
         edgeFrac   — how far out (fraction of the radius) we drift before
                      heading back to the middle; low = cautious
         aim        — sideways offset (units) on our aim point, re-rolled
                      every so often, so charges come in at varied angles
         aimTimer   — seconds until the next aim re-roll */
    newMind() {
      return { chargeDist: rand(5, 9), edgeFrac: rand(0.5, 0.7), aim: rand(-1.5, 1.5), aimTimer: rand(0.5, 1.5) };
    }

    build() {
      // Platform: a thick disc with a glowing rim. We scale it as it shrinks.
      this.platform = new THREE.Group();
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(START_R, START_R * 0.85, 2, 64),
        new THREE.MeshStandardMaterial({ color: 0x7c3aed, roughness: 0.6 })
      );
      disc.position.y = -1;
      disc.receiveShadow = true;
      this.platform.add(disc);

      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(START_R, 0.25, 8, 64),
        new THREE.MeshBasicMaterial({ color: 0xffcc33 })
      );
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 0.05;
      this.platform.add(rim);

      // Centre target rings so it reads as a sumo circle.
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 });
      for (const r of [4, 9]) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.25, 48), ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.02;
        this.platform.add(ring);
      }
      this.scene.add(this.platform);

      // A scatter of "stars" far below to sell the height.
      const starGeo = new THREE.BufferGeometry();
      const pts = [];
      for (let i = 0; i < 400; i++) pts.push((Math.random() - 0.5) * 300, -20 - Math.random() * 80, (Math.random() - 0.5) * 300);
      starGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      this.scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.6 })));
      this.scene.fog = null;
      this.scene.background = new THREE.Color(0x070a1a);
    }

    spawn(i) {
      // Evenly round the circle, roughly facing the middle. Which slot
      // each player gets, the angle of the whole circle, and a small
      // nose wobble are random each round. (spawn() runs inside the base
      // constructor, before ours, so the shuffle is set up lazily.)
      if (!this.slots) {
        this.slots = shuffle([0, 1, 2, 3]);
        this.spin = rand(0, Math.PI * 2);
      }
      const a = (this.slots[i] / 4) * Math.PI * 2 + this.spin;
      const x = Math.sin(a) * 10, z = Math.cos(a) * 10;
      return { x, z, heading: Math.atan2(-x, -z) + rand(-0.15, 0.15) };
    }

    // Knock a car out of the round: hide it, record the order, puff of
    // colour at the spot where it went over the edge.
    eliminate(car) {
      car.out = true;
      car.hide();
      this.outOrder.push(car.index);
      const edge = car.pos.clone().setY(0);
      edge.setLength(Math.min(edge.length(), this.radius));
      this.fx.burst(edge, car.player.color, { count: 24, speed: 9 });
      TP.sfx.play("fall");
      TP.UI.toast(`${car.player.name} is out!`);
    }

    // The only floor is the disc. Outside it there's nothing → cars fall.
    groundHeightAt(x, z) {
      return x * x + z * z < this.radius * this.radius ? 0 : null;
    }

    tick(dt) {
      // Shrink the platform over time.
      const C = SumoRing.CONFIG;
      const k = clamp((this.elapsed - C.shrinkFrom) / (C.shrinkTo - C.shrinkFrom), 0, 1);
      this.radius = START_R + (C.minR - START_R) * k;
      const s = this.radius / START_R;
      this.platform.scale.set(s, 1, s);

      // Anyone who has fallen far enough is out.
      for (const car of this.cars) {
        if (!car.out && car.pos.y < -14) this.eliminate(car);
      }

      // Time's up (the arena counts timeLeft down just before calling
      // tick, so this runs on the round's very last physics step). Any
      // car that is already over the edge — no floor under it, or dropped
      // below the platform's surface — is doomed, so it's out now rather
      // than sharing 1st with the cars still standing. The lowest car
      // went over first, so it's eliminated first (= ranks lower).
      if (!this.judged && this.timeLeft <= 0) {
        this.judged = true;
        const doomed = this.cars
          .filter((c) => !c.out && (this.groundHeightAt(c.pos.x, c.pos.z) === null || c.pos.y < -0.5))
          .sort((a, b) => a.pos.y - b.pos.y);
        doomed.forEach((c) => this.eliminate(c));
      }

      // Bots re-roll their aim offset now and then.
      for (const m of this.minds) {
        m.aimTimer -= dt;
        if (m.aimTimer <= 0) { m.aim = rand(-1.5, 1.5); m.aimTimer = rand(0.5, 1.5); }
      }
    }

    // End early once only one (or zero) cars remain.
    isOver() {
      return this.cars.filter((c) => !c.out).length <= 1;
    }

    // Survivors share top score; the earlier you fell, the lower your score.
    scores() {
      return this.players.map((p, i) => {
        const idx = this.outOrder.indexOf(i);
        return idx === -1 ? 100 : idx;
      });
    }

    chips() {
      return this.players.map((p, i) => ({
        name: p.name, css: p.css,
        value: this.cars[i].out ? "OUT" : "IN",
        out: this.cars[i].out,
      }));
    }

    botControls(car) {
      const d = Math.hypot(car.pos.x, car.pos.z) || 1;
      // How fast we're sliding outward (toward the edge). Positive = bad.
      const outward = (car.vel.x * car.pos.x + car.vel.z * car.pos.z) / d;
      // Distance we'd need to stop: roughly v² / (2 × braking). Add margin.
      const stopDist = (outward * outward) / (2 * 30) + 2;

      // Safety first: if we'd overshoot the edge, slam the brakes while
      // steering for the middle. Turning alone is too slow at speed.
      if (outward > 3 && d + stopDist > this.radius - 1) {
        const ctrl = TP.ai.driveTo(car, 0, 0, { boostDist: 999 });
        const facingOut = Math.abs(TP.ai.angleTo(car, 0, 0)) > Math.PI / 2;
        ctrl.throttle = facingOut ? -1 : 1; // reverse if pointing at the edge
        ctrl.boost = false;
        return ctrl;
      }
      const mind = this.minds[car.index];
      // Near the edge: calmly head back toward the middle. (How near
      // counts as "near" depends on this bot's caution this round.)
      if (d > this.radius * mind.edgeFrac) {
        const ctrl = TP.ai.driveTo(car, 0, 0, { boostDist: 999 });
        ctrl.throttle = 0.6;
        return ctrl;
      }
      // Otherwise charge the nearest rival, aiming a bit past them so the
      // hit pushes them toward the edge rather than just touching.
      let target = null, best = Infinity;
      for (const o of this.cars) {
        if (o === car || o.out) continue;
        const dd = dist2D(car.pos.x, car.pos.z, o.pos.x, o.pos.z);
        if (dd < best) { best = dd; target = o; }
      }
      if (!target) return TP.ai.driveTo(car, 0, 0, { arrive: 3 });
      const len = Math.hypot(target.pos.x, target.pos.z) || 1;
      // Aim 2 units past them (outward), shifted sideways by this bot's
      // current aim offset so it doesn't always hit dead-centre.
      const ox = target.pos.x / len, oz = target.pos.z / len;
      const tx = target.pos.x + ox * 2 - oz * mind.aim;
      const tz = target.pos.z + oz * 2 + ox * mind.aim;
      const ctrl = TP.ai.driveTo(car, tx, tz, { boostDist: 0 });
      // Only commit a boost when lined up, close, and the rival is nearer
      // the edge than we are (so the hit pushes them out, not us).
      const rivalEdge = Math.hypot(target.pos.x, target.pos.z);
      ctrl.boost = best < mind.chargeDist && rivalEdge > d && Math.abs(TP.ai.angleTo(car, tx, tz)) < 0.3 && car.boost > 20;
      // Don't floor it across the whole ring — keep some control.
      if (best > 8) ctrl.throttle = 0.7;
      if (car.speed2D() > 13 && !ctrl.boost) ctrl.throttle = 0;
      return ctrl;
    }
  }

  SumoRing.CONFIG = CONFIG;

  TP.MINIGAMES.push({
    id: "sumo-ring",
    name: "Sumo Ring",
    cls: SumoRing,
    // One-line rule and format tags for the intro card (see game.js).
    rule: "Knock everyone off the shrinking ring.",
    format: "Free-for-all",
    length: "45 s max",
    kind: "Survival",
    blurb: "Bump everyone off the floating ring. It shrinks after 12 seconds. Last car standing wins!",
  });
})();
