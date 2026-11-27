/* =====================================================================
   Sumo Ring — last car standing.
   Everyone starts on a round platform floating in space. Bump rivals off
   the edge. After 15 seconds the platform starts shrinking. Fall off and
   you're out. Survivors at the 45-second mark share first place.
   ===================================================================== */
(function () {
  "use strict";
  const { dist2D, clamp } = TP.util;

  const START_R = 17;   // platform radius at the start
  const MIN_R = 8;      // smallest it shrinks to
  const SHRINK_FROM = 15, SHRINK_TO = 35; // seconds

  class SumoRing extends TP.Arena {
    constructor(game) {
      super(game, {
        title: "Sumo Ring",
        duration: 45,
        size: START_R,
        camera: { y: 36, z: 30, lookZ: 1 },
        // Slightly harder hits and less grip than normal = more knockbacks,
        // but lower top speeds so one ram doesn't launch both cars off.
        tuning: { bumpScale: 1.15, grip: 8, maxSpeed: 14, boostMax: 20 },
      });
      this.radius = START_R;
      this.outOrder = []; // player indices in the order they fell
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
      // Evenly round the circle, facing the middle.
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const x = Math.sin(a) * 10, z = Math.cos(a) * 10;
      return { x, z, heading: Math.atan2(-x, -z) };
    }

    // The only floor is the disc. Outside it there's nothing → cars fall.
    groundHeightAt(x, z) {
      return x * x + z * z < this.radius * this.radius ? 0 : null;
    }

    tick() {
      // Shrink the platform over time.
      const k = clamp((this.elapsed - SHRINK_FROM) / (SHRINK_TO - SHRINK_FROM), 0, 1);
      this.radius = START_R + (MIN_R - START_R) * k;
      const s = this.radius / START_R;
      this.platform.scale.set(s, 1, s);

      // Anyone who has fallen far enough is out.
      for (const car of this.cars) {
        if (!car.out && car.pos.y < -14) {
          car.out = true;
          car.hide();
          this.outOrder.push(car.index);
          // Puff of the player's colour at the spot they went over the edge.
          const edge = car.pos.clone().setY(0);
          edge.setLength(Math.min(edge.length(), this.radius));
          this.fx.burst(edge, car.player.color, { count: 24, speed: 9 });
          TP.sfx.play("fall");
          TP.UI.toast(`${car.player.name} is out!`);
        }
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
      // Near the edge: calmly head back toward the middle.
      if (d > this.radius * 0.6) {
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
      const tx = target.pos.x + (target.pos.x / len) * 2;
      const tz = target.pos.z + (target.pos.z / len) * 2;
      const ctrl = TP.ai.driveTo(car, tx, tz, { boostDist: 0 });
      // Only commit a boost when lined up, close, and the rival is nearer
      // the edge than we are (so the hit pushes them out, not us).
      const rivalEdge = Math.hypot(target.pos.x, target.pos.z);
      ctrl.boost = best < 7 && rivalEdge > d && Math.abs(TP.ai.angleTo(car, tx, tz)) < 0.3 && car.boost > 20;
      // Don't floor it across the whole ring — keep some control.
      if (best > 8) ctrl.throttle = 0.7;
      if (car.speed2D() > 13 && !ctrl.boost) ctrl.throttle = 0;
      return ctrl;
    }
  }

  TP.MINIGAMES.push({
    id: "sumo-ring",
    name: "Sumo Ring",
    cls: SumoRing,
    blurb: "Bump everyone off the floating ring. It shrinks after 15 seconds. Last car standing wins!",
  });
})();
