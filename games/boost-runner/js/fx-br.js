/* =====================================================================
   fx-br.js — Boost Runner's particle effects, built on the shared TP.FX.

   TP.FX (shared/js/fx.js) gives pooled little boxes that fly, spin and
   shrink away. Two things don't suit a side-on course, so this file
   extends it rather than changing the shared file:

     • TP.FX bounces every particle off a floor at y = 0.1. Our track goes
       up and down (and there are pits below 0), so BRFX's update() has
       no built-in floor. A particle can be given its own floor height
       instead (landing dust uses this to settle on the track).
     • We add new effects:
         trail(car, css)   boost trail in the car's colour (call each frame
                           while boosting). Lingers about half a second so
                           you can follow fast cars.
         dust(x, y)        puff when a car lands
         spark(x, y, k)    car-vs-car bump, k = 0..1 strength
         ko(x, y, color)   the knock-out blast: chunky explosion plus an
                           expanding shock ring in the player's colour
   ===================================================================== */
(function () {
  "use strict";
  const { rand } = TP.util;

  class BRFX extends TP.FX {
    constructor(scene) {
      super(scene);
      this.rings = [];  // expanding KO shock rings
      this.ringGeo = new THREE.RingGeometry(0.8, 1, 40);
      this.trailClock = new Map(); // car → time since its last trail puff
    }

    // Same as TP.FX.spawn, plus an optional floor height and drag.
    spawnBR(pos, color, vel, life, size, gravity, spin, floor = null, drag = 1.2) {
      this.spawn(pos, color, vel, life, size, gravity, spin);
      const p = this.live[this.live.length - 1];
      p.floor = floor;
      p.drag = drag;
    }

    /* Boost trail. Puffs come out of the rocket nozzle (behind the car,
       along its nose angle), drift backwards and shrink away. Emitted on
       a timer, not per frame, so it looks the same at any frame rate. */
    trail(car, color, dt) {
      let t = (this.trailClock.get(car) || 0) + dt;
      const angle = car.angle || 0;
      const back = new THREE.Vector3(-Math.cos(angle), -Math.sin(angle), 0);
      while (t > 0.016) {
        t -= 0.016;
        const pos = new THREE.Vector3(car.x, car.y + 0.65, 0).addScaledVector(back, 2.0);
        pos.z += rand(-0.3, 0.3);
        const vel = back.clone().multiplyScalar(rand(3, 6));
        vel.y += rand(-0.6, 0.6);
        // Two-tone: mostly the player's colour, with hot white-yellow sparks.
        const c = Math.random() < 0.75 ? color : 0xfff1b8;
        this.spawnBR(pos, c, vel, rand(0.35, 0.55), rand(0.28, 0.42), 0, 4, null, 3);
      }
      this.trailClock.set(car, t);
    }

    // Grey-violet dust kicked out sideways when a car lands.
    dust(x, y) {
      for (let i = 0; i < 14; i++) {
        const dir = i % 2 ? 1 : -1;
        const vel = new THREE.Vector3(dir * rand(2, 6), rand(0.5, 2.5), rand(-2, 2));
        this.spawnBR(new THREE.Vector3(x + dir * rand(0.6, 1.4), y + 0.15, rand(-1, 1)),
          i % 3 ? 0x8b8399 : 0xb7aec4, vel, rand(0.35, 0.6), rand(0.2, 0.34), 6, 3, y + 0.08, 2.5);
      }
    }

    // Bright sparks where two cars bump.
    spark(x, y, k = 0.5) {
      const pos = new THREE.Vector3(x, y, 0);
      for (let i = 0; i < 8 + k * 14; i++) {
        const a = rand(0, Math.PI * 2), s = rand(4, 10) * (0.6 + k);
        this.spawnBR(pos, i % 2 ? 0xfff1b8 : 0xffffff, new THREE.Vector3(Math.cos(a) * s, Math.sin(a) * s + 2, rand(-2, 2)),
          rand(0.2, 0.4), 0.16, 18, 8);
      }
    }

    /* Knock-out blast at the spot the car left the screen. A chunky
       explosion (player colour, fire, smoke) plus a flat shock ring that
       grows and fades, also in the player's colour. */
    ko(x, y, color) {
      const pos = new THREE.Vector3(x, y + 0.6, 0);
      const cols = [color, 0xffe14d, 0xff7a1a, 0x2a2a35, 0xffffff];
      for (let i = 0; i < 46; i++) {
        const a = rand(0, Math.PI * 2), s = rand(5, 17);
        this.spawnBR(pos, cols[i % cols.length], new THREE.Vector3(Math.cos(a) * s, Math.sin(a) * s + 3, rand(-4, 4)),
          rand(0.7, 1.2), rand(0.3, 0.6), 14, 6);
      }
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
      const ring = new THREE.Mesh(this.ringGeo, mat);
      ring.position.set(x, y + 0.6, 0.5);
      this.scene.add(ring);
      this.rings.push({ ring, life: 0.5, maxLife: 0.5 });
    }

    /* Same idea as TP.FX.update, minus the fixed floor: gravity, drag,
       spin, and shrink away over the last 40% of life. */
    update(dt) {
      for (let i = this.live.length - 1; i >= 0; i--) {
        const p = this.live[i];
        p.life -= dt;
        if (p.life <= 0) {
          p.mesh.visible = false;
          this.scene.remove(p.mesh);
          this.pool.push(p.mesh);
          this.live.splice(i, 1);
          continue;
        }
        p.vel.y -= p.gravity * dt;
        p.vel.multiplyScalar(Math.exp(-(p.drag ?? 1.2) * dt));
        p.mesh.position.addScaledVector(p.vel, dt);
        if (p.floor != null && p.mesh.position.y < p.floor) {
          p.mesh.position.y = p.floor;
          p.vel.y = Math.abs(p.vel.y) * 0.2;
        }
        p.mesh.rotation.x += p.spin * dt;
        p.mesh.rotation.y += p.spin * 0.7 * dt;
        const k = Math.min(1, p.life / (p.maxLife * 0.4));
        p.mesh.scale.setScalar(p.size * k);
      }
      // Shock rings: grow fast, fade out.
      for (let i = this.rings.length - 1; i >= 0; i--) {
        const r = this.rings[i];
        r.life -= dt;
        const t = 1 - r.life / r.maxLife;
        r.ring.scale.setScalar(1 + t * 9);
        r.ring.material.opacity = 0.9 * (1 - t);
        if (r.life <= 0) {
          this.scene.remove(r.ring);
          r.ring.material.dispose();
          this.rings.splice(i, 1);
        }
      }
    }

    // Clear everything at once (between rounds).
    clear() {
      for (const p of this.live) { p.mesh.visible = false; this.scene.remove(p.mesh); this.pool.push(p.mesh); }
      this.live.length = 0;
      for (const r of this.rings) { this.scene.remove(r.ring); r.ring.material.dispose(); }
      this.rings.length = 0;
    }

    dispose() {
      this.clear();
      this.ringGeo.dispose();
      super.dispose();
    }
  }

  TP.BRFX = BRFX;
})();
