/* =====================================================================
   King of the Hill — 40 seconds.
   A glowing zone sits somewhere in the arena. Score a point for every
   second you're the ONLY car inside it. If two or more cars are in the
   zone, nobody scores — so shove them out! The zone jumps to a new spot
   every 8 seconds. Most points wins.

   Bots play different roles so they don't all pile into the zone and
   cancel each other out (which is what used to happen: the zone was
   empty or contested most of the time and scores stayed very low):
     holder  — alone in the zone: sits near the middle and turns to face
               anyone charging in (a car hit on the nose is pushed less)
     rammer  — charges the holder to knock them out, then takes over
     lurker  — waits just outside the rim, out of the scrum, and darts in
               when the zone empties
   Roles are re-rolled every few seconds and whenever the zone moves.
   ===================================================================== */
(function () {
  "use strict";
  const { rand, dist2D } = TP.util;

  const HALF = 20;
  const ZONE_R = 4.5;
  const MOVE_EVERY = 8;   // seconds between zone moves
  const RAM_CHANCE = 0.25; // chance a bot outside the zone picks "rammer"
  const LURK_GAP = 2.5;   // how far outside the rim lurkers wait

  class KingOfTheHill extends TP.Arena {
    constructor(game) {
      super(game, { title: "King of the Hill", duration: 40, size: HALF, camera: { y: 38, z: 32, lookZ: 2 }, tuning: { bumpScale: 1.2 } });
      this.score = this.players.map(() => 0);
      this.moveTimer = MOVE_EVERY;
      this.inZone = [];
      this.placeZone(0, 0);
      // Per-bot state: role ("ram" or "lurk" while outside the zone),
      // seconds until the role is re-rolled, how close before a rammer
      // commits its boost, and where it lurks (an angle round the rim).
      this.minds = this.cars.map(() => ({}));
      this.minds.forEach((m) => this.rollRole(m));
    }

    rollRole(m) {
      m.role = Math.random() < RAM_CHANCE ? "ram" : "lurk";
      m.timer = rand(3, 6);
      m.chargeDist = rand(5, 8);
      m.lurkAngle = rand(0, Math.PI * 2);
    }

    build() {
      this.buildBoxArena(HALF, 0x24304f, 0x3b3f7a);

      // The zone: a flat glowing disc, a rim, and a tall light column.
      const g = new THREE.Group();
      this.zoneMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false });
      const disc = new THREE.Mesh(new THREE.CircleGeometry(ZONE_R, 48), this.zoneMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.03;
      g.add(disc);
      this.rimMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const rim = new THREE.Mesh(new THREE.TorusGeometry(ZONE_R, 0.15, 8, 48), this.rimMat);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 0.1;
      g.add(rim);
      this.beamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(ZONE_R, ZONE_R, 14, 32, 1, true), this.beamMat);
      beam.position.y = 7;
      g.add(beam);
      this.zone = g;
      this.scene.add(g);
    }

    spawn(i) {
      const c = [[-1, -1], [1, -1], [-1, 1], [1, 1]][i];
      const x = c[0] * 13, z = c[1] * 13;
      return { x, z, heading: Math.atan2(-x, -z) };
    }

    clampCar(car) { this.clampToBox(car, HALF); }

    placeZone(x, z) {
      this.zx = x; this.zz = z;
      this.zone.position.set(x, 0, z);
      this.fx.burst(new THREE.Vector3(x, 0.5, z), 0xffffff, { count: 20, speed: 7 });
    }

    tick(dt) {
      // Move the zone on a timer, always a decent distance away.
      this.moveTimer -= dt;
      if (this.moveTimer <= 0) {
        let x, z, tries = 0;
        do {
          x = rand(-HALF + 6, HALF - 6);
          z = rand(-HALF + 6, HALF - 6);
        } while (dist2D(x, z, this.zx, this.zz) < 16 && ++tries < 30);
        this.placeZone(x, z);
        this.moveTimer = MOVE_EVERY;
        this.minds.forEach((m) => this.rollRole(m)); // new zone, new plans
        TP.UI.toast("The zone moved!");
        TP.sfx.play("go");
      }

      // Bots re-think their role every few seconds.
      for (const m of this.minds) {
        m.timer -= dt;
        if (m.timer <= 0) this.rollRole(m);
      }

      // Who's inside? (Airborne cars over the zone still count.)
      this.inZone = this.cars.filter((c) => dist2D(c.pos.x, c.pos.z, this.zx, this.zz) < ZONE_R);
      if (this.inZone.length === 1) {
        const c = this.inZone[0];
        const before = Math.floor(this.score[c.index]);
        this.score[c.index] += dt;
        if (Math.floor(this.score[c.index]) > before && c.player.controller !== "bot") TP.sfx.play("tick");
      }
    }

    animate() {
      // Zone colour: white when empty, the owner's colour when held,
      // flickering red when contested.
      let color = 0xffffff;
      if (this.inZone.length === 1) color = this.inZone[0].player.color;
      else if (this.inZone.length > 1) color = Math.sin(performance.now() * 0.02) > 0 ? 0xff3b3b : 0x661111;
      this.zoneMat.color.setHex(color);
      this.rimMat.color.setHex(color);
      this.beamMat.color.setHex(color);
      // Pulse faster just before it moves.
      const warn = this.moveTimer < 2 ? 0.5 + 0.5 * Math.sin(performance.now() * 0.03) : 1;
      this.zoneMat.opacity = 0.25 * warn + 0.05;
    }

    /* Drive to (x, z) and STOP there. TP.ai.driveTo's "arrive" only eases
       off the gas, and cars carry a lot of speed, so bots used to shoot
       straight through the zone and out the other side. Here we pick a
       target speed that falls as we get closer (about 2.2 units/s per
       unit of distance, capped at 14) and brake whenever we're faster
       than that. */
    arriveAt(car, x, z) {
      const ctrl = TP.ai.driveTo(car, x, z, { boostDist: 999 });
      const dist = dist2D(car.pos.x, car.pos.z, x, z);
      const f = car.forward();
      const vF = car.vel.x * f.x + car.vel.z * f.z; // speed along the nose
      const want = Math.min(14, dist * 2.2);
      if (ctrl.throttle > 0) ctrl.throttle = vF > want + 1 ? -1 : vF < want ? 1 : 0;
      ctrl.boost = false;
      return ctrl;
    }

    /* Drive so as to shove `target` straight away from point (fx, fz):
       aim a few units beyond them on the far side, so the hit carries
       them outward instead of glancing off. Boost in when close and
       lined up. */
    shove(car, target, fx, fz, chargeDist) {
      let dx = target.pos.x - fx, dz = target.pos.z - fz;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      const tx = target.pos.x + dx * 3, tz = target.pos.z + dz * 3;
      const ctrl = TP.ai.driveTo(car, tx, tz, { boostDist: 0 });
      const d = dist2D(car.pos.x, car.pos.z, target.pos.x, target.pos.z);
      ctrl.boost = d < chargeDist && Math.abs(TP.ai.angleTo(car, tx, tz)) < 0.4 && car.boost > 20;
      return ctrl;
    }

    botControls(car) {
      const m = this.minds[car.index];
      const me = dist2D(car.pos.x, car.pos.z, this.zx, this.zz);
      const inside = me < ZONE_R;
      const others = this.cars.filter((c) => c !== car);
      const nearest = (list) => {
        let best = null, bd = Infinity;
        for (const o of list) {
          const d = dist2D(car.pos.x, car.pos.z, o.pos.x, o.pos.z);
          if (d < bd) { bd = d; best = o; }
        }
        return { car: best, dist: bd };
      };

      /* ---------- Inside the zone ---------- */
      if (inside) {
        const rivals = this.inZone.filter((c) => c !== car);
        // Contested: shove the nearest rival out, pushing them away from
        // the zone's centre so they end up outside it.
        if (rivals.length) return this.shove(car, nearest(rivals).car, this.zx, this.zz, 6);
        // Holding alone. If someone's charging in, turn to face them
        // (head-on hits push less than side-on ones), creeping only
        // slightly so we stay inside. Otherwise settle near the middle.
        const threat = nearest(others);
        if (threat.car && threat.dist < 9 && me < ZONE_R * 0.6) {
          const ctrl = TP.ai.driveTo(car, threat.car.pos.x, threat.car.pos.z, { boostDist: 999 });
          ctrl.throttle = Math.abs(TP.ai.angleTo(car, threat.car.pos.x, threat.car.pos.z)) > 0.5 ? 0.3 : 0;
          return ctrl;
        }
        return this.arriveAt(car, this.zx, this.zz);
      }

      /* ---------- Outside the zone ---------- */
      // Zone empty: the bot closest to it (and any rammer) goes for it;
      // the rest hang back so they don't all arrive at once and cancel out.
      if (this.inZone.length === 0) {
        let closestCar = null, cd = Infinity;
        for (const c of this.cars) {
          const d = dist2D(c.pos.x, c.pos.z, this.zx, this.zz);
          if (d < cd) { cd = d; closestCar = c; }
        }
        if (closestCar === car || m.role === "ram") {
          // Boost while far away, then brake into the middle.
          if (cd > 12 && closestCar === car) return TP.ai.driveTo(car, this.zx, this.zz, { boostDist: 8 });
          return this.arriveAt(car, this.zx, this.zz);
        }
      } else if (this.inZone.length === 1 && m.role === "ram") {
        // One holder: rammers knock them out (away from the zone centre).
        return this.shove(car, this.inZone[0], this.zx, this.zz, m.chargeDist);
      }

      // Lurk just outside the rim (also what everyone does while the zone
      // is contested — no point joining the scrum and cancelling it out).
      const lx = this.zx + Math.cos(m.lurkAngle) * (ZONE_R + LURK_GAP);
      const lz = this.zz + Math.sin(m.lurkAngle) * (ZONE_R + LURK_GAP);
      return this.arriveAt(car, Math.max(-HALF + 2, Math.min(HALF - 2, lx)), Math.max(-HALF + 2, Math.min(HALF - 2, lz)));
    }

    // One decimal so near-ties still rank correctly but read cleanly.
    scores() { return this.score.map((s) => Math.round(s * 10) / 10); }
    chips() {
      return this.players.map((p, i) => ({ name: p.name, css: p.css, value: "👑 " + Math.floor(this.score[i]) }));
    }
  }

  TP.MINIGAMES.push({
    id: "king-of-the-hill",
    name: "King of the Hill",
    cls: KingOfTheHill,
    blurb: "Score a point every second you're the ONLY car in the glowing zone. Two or more inside? Nobody scores — shove them out! The zone moves every 8 seconds.",
  });
})();
