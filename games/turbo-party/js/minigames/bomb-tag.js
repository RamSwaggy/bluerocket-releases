/* =====================================================================
   Bomb Tag — hot potato with cars.
   One car carries a ticking bomb. Bump into another car to pass it on.
   When the fuse runs out, whoever's holding it is blown out of the
   game and a fresh bomb appears on someone else. Last car left wins.

   The fuse length is secret (9–14 seconds) but the bomb flashes faster
   and faster as it gets close. The carrier gets unlimited boost so they
   can chase people down.
   ===================================================================== */
(function () {
  "use strict";
  const { rand, pick, clamp, dist2D } = TP.util;

  const HALF = 18;            // arena is 36 × 36
  const PASS_COOLDOWN = 0.7;  // seconds before a bomb can be passed back

  class BombTag extends TP.Arena {
    constructor(game) {
      super(game, { title: "Bomb Tag", duration: 0, size: HALF, camera: { y: 36, z: 30, lookZ: 2 } });
      this.outOrder = [];   // player indices in the order they were blown up
      this.holder = null;   // car currently carrying the bomb
      this.fuse = 0;        // seconds left until boom
      this.passCooldown = 0;
      this.respawnDelay = 0;
      this.lastHolder = null; // who just passed it (can't get it straight back)
      this.giveBomb(pick(this.cars));
    }

    build() {
      this.buildBoxArena(HALF, 0x3b2a1e, 0x5a2a2a);

      // The bomb: black ball, short fuse, glowing spark on the end.
      const g = new THREE.Group();
      this.bombBody = new THREE.Mesh(
        new THREE.SphereGeometry(0.7, 20, 14),
        new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4, emissive: 0x000000 })
      );
      g.add(this.bombBody);
      const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.5, 6), new THREE.MeshStandardMaterial({ color: 0x8a6a3a }));
      fuse.position.y = 0.85;
      g.add(fuse);
      this.spark = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd24d }));
      this.spark.position.y = 1.15;
      g.add(this.spark);
      g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this.bomb = g;
      this.scene.add(g);
    }

    spawn(i) {
      const c = [[-1, -1], [1, -1], [-1, 1], [1, 1]][i];
      const x = c[0] * 10, z = c[1] * 10;
      return { x, z, heading: Math.atan2(-x, -z) };
    }

    clampCar(car) { this.clampToBox(car, HALF); }

    giveBomb(car) {
      this.holder = car;
      this.fuse = rand(9, 14);
      this.passCooldown = PASS_COOLDOWN;
      TP.UI.toast(`💣 ${car.player.name} has the bomb!`);
    }

    // Passing happens through bumps: if the carrier touches anyone, it moves.
    onBump(hit) {
      if (!this.holder || this.passCooldown > 0) return;
      const other = hit.a === this.holder ? hit.b : hit.b === this.holder ? hit.a : null;
      if (!other || other.out || other === this.lastHolder) return;
      this.lastHolder = this.holder;
      this.holder = other;
      this.passCooldown = PASS_COOLDOWN;
      TP.sfx.play("count");
      this.fx.burst(other.pos.clone().setY(1.5), [0xffd24d, 0xff5a1a], { count: 12, speed: 5 });
    }

    tick(dt) {
      this.passCooldown = Math.max(0, this.passCooldown - dt);
      if (this.passCooldown === 0) this.lastHolder = null;

      // Waiting to hand out a fresh bomb after an explosion.
      if (!this.holder) {
        this.respawnDelay -= dt;
        if (this.respawnDelay <= 0 && !this.isOver()) this.giveBomb(pick(this.cars.filter((c) => !c.out)));
        return;
      }

      // The carrier never runs out of boost.
      this.holder.boost = 100;

      this.fuse -= dt;
      if (this.fuse <= 0) {
        const car = this.holder;
        this.fx.explosion(car.pos.clone().setY(1));
        TP.sfx.play("ko");
        car.out = true;
        car.hide();
        this.outOrder.push(car.index);
        TP.UI.toast(`💥 ${car.player.name} blew up!`);
        this.holder = null;
        this.lastHolder = null;
        this.respawnDelay = 1.5;
        // Knock nearby cars away from the blast.
        for (const o of this.cars) {
          if (o.out) continue;
          const dx = o.pos.x - car.pos.x, dz = o.pos.z - car.pos.z;
          const d = Math.hypot(dx, dz);
          if (d < 7 && d > 0.01) {
            const push = (7 - d) * 3;
            o.vel.x += (dx / d) * push; o.vel.z += (dz / d) * push;
            o.vel.y = 6; o.onGround = false;
          }
        }
      }
    }

    animate() {
      if (!this.holder) { this.bomb.visible = false; return; }
      this.bomb.visible = true;
      const p = this.holder.pos;
      this.bomb.position.set(p.x, p.y + 2.1, p.z);
      // Flash red faster as the fuse gets short.
      const rate = this.fuse < 3 ? 14 : this.fuse < 6 ? 7 : 3;
      const on = Math.sin(performance.now() * 0.001 * rate * Math.PI) > 0;
      this.bombBody.material.emissive.setHex(on ? 0xaa1100 : 0x000000);
      this.spark.scale.setScalar(0.7 + Math.random() * 0.6);
      this.bomb.rotation.y += 0.05;
      // Hide the carrier's floating marker so the bomb is clear.
      this.cars.forEach((c) => { c.mesh.userData.marker.visible = c !== this.holder; });
    }

    isOver() {
      return this.cars.filter((c) => !c.out).length <= 1;
    }

    scores() {
      return this.players.map((p, i) => {
        const idx = this.outOrder.indexOf(i);
        return idx === -1 ? 100 : idx;
      });
    }

    chips() {
      return this.players.map((p, i) => ({
        name: p.name, css: p.css,
        value: this.cars[i].out ? "💥" : this.cars[i] === this.holder ? "💣" : "OK",
        out: this.cars[i].out,
      }));
    }

    botControls(car) {
      const alive = this.cars.filter((c) => !c.out && c !== car);
      if (!alive.length) return TP.Input.NEUTRAL;

      if (car === this.holder) {
        // CHASE: go after the nearest car that can take the bomb.
        const targets = alive.filter((c) => c !== this.lastHolder);
        const list = targets.length ? targets : alive;
        let t = list[0], best = Infinity;
        for (const c of list) {
          const d = dist2D(car.pos.x, car.pos.z, c.pos.x, c.pos.z);
          if (d < best) { best = d; t = c; }
        }
        // Lead the target a little: aim where they're going to be.
        const lead = Math.min(0.5, best / 30);
        return TP.ai.driveTo(car, t.pos.x + t.vel.x * lead, t.pos.z + t.vel.z * lead, { boostDist: 4 });
      }

      if (!this.holder) return TP.ai.driveTo(car, 0, 0, { arrive: 8 });

      // FLEE: run directly away from the bomb carrier, but bend back
      // toward the middle near walls so we don't get cornered.
      const h = this.holder;
      let ax = car.pos.x - h.pos.x, az = car.pos.z - h.pos.z;
      const d = Math.hypot(ax, az) || 1;
      ax /= d; az /= d;
      let tx = car.pos.x + ax * 10, tz = car.pos.z + az * 10;
      const wallness = Math.max(Math.abs(car.pos.x), Math.abs(car.pos.z)) / HALF; // 0 middle → 1 wall
      tx = TP.util.lerp(tx, -car.pos.x * 0.5, clamp(wallness - 0.45, 0, 1) * 1.6);
      tz = TP.util.lerp(tz, -car.pos.z * 0.5, clamp(wallness - 0.45, 0, 1) * 1.6);
      tx = clamp(tx, -HALF + 3, HALF - 3);
      tz = clamp(tz, -HALF + 3, HALF - 3);
      const ctrl = TP.ai.driveTo(car, tx, tz, { boostDist: 0 });
      // Only boost away when the carrier is close.
      ctrl.boost = d < 9 && car.boost > 20;
      // Last-second hop over a charging carrier.
      ctrl.jump = d < 3.2 && h.speed2D() > 10 && Math.random() < 0.5;
      return ctrl;
    }
  }

  TP.MINIGAMES.push({
    id: "bomb-tag",
    name: "Bomb Tag",
    cls: BombTag,
    blurb: "Someone's carrying a ticking bomb — bump into a rival to pass it on! When it blows, the holder is out. The bomb flashes faster as it's about to go. Last car left wins.",
  });
})();
