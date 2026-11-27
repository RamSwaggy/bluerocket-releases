/* =====================================================================
   fx.js — lightweight particle effects (sparks, coin bursts, confetti,
   explosions). Shared by every mode.

   Usage:
     const fx = new TP.FX(scene);
     fx.burst(position, 0xffcc33, { count: 20 });   // sparks
     fx.confetti(position);                         // multi-colour, floaty
     fx.update(dt);                                 // once per frame

   Particles are tiny boxes that fly, spin, fall and shrink away. Their
   meshes are pooled (reused) so effects don't create garbage every frame.
   ===================================================================== */
(function () {
  "use strict";
  const { rand } = TP.util;

  const CONFETTI_COLORS = [0xffcc33, 0x3b82f6, 0xf97316, 0x22c55e, 0xec4899, 0xffffff];

  class FX {
    constructor(scene) {
      this.scene = scene;
      this.live = [];     // particles currently flying
      this.pool = [];     // spare meshes ready to reuse
      this.geo = new THREE.BoxGeometry(1, 1, 1);
      this.mats = {};     // one material per colour, shared between particles
    }

    material(color) {
      if (!this.mats[color]) this.mats[color] = new THREE.MeshBasicMaterial({ color });
      return this.mats[color];
    }

    // Grab a mesh from the pool (or make one) and set it up as a particle.
    spawn(pos, color, vel, life, size, gravity, spin) {
      const mesh = this.pool.pop() || new THREE.Mesh(this.geo);
      mesh.material = this.material(color);
      mesh.position.copy(pos);
      mesh.scale.setScalar(size);
      mesh.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6));
      mesh.visible = true;
      this.scene.add(mesh);
      this.live.push({ mesh, vel, life, maxLife: life, size, gravity, spin });
    }

    /* Sparks flying out in all directions (mostly upward).
       opts: count, speed, life, size, gravity, up (extra upward push) */
    burst(pos, color, opts = {}) {
      const count = opts.count ?? 16;
      const speed = opts.speed ?? 8;
      for (let i = 0; i < count; i++) {
        const a = rand(0, Math.PI * 2);
        const s = rand(0.3, 1) * speed;
        const vel = new THREE.Vector3(Math.cos(a) * s, rand(0.4, 1) * speed * 0.8 + (opts.up ?? 3), Math.sin(a) * s);
        const c = Array.isArray(color) ? color[i % color.length] : color;
        this.spawn(pos, c, vel, rand(0.6, 1) * (opts.life ?? 0.9), opts.size ?? 0.28, opts.gravity ?? 20, 6);
      }
    }

    // Slow, fluttering multi-coloured paper for celebrations.
    confetti(pos, opts = {}) {
      const count = opts.count ?? 60;
      for (let i = 0; i < count; i++) {
        const a = rand(0, Math.PI * 2);
        const s = rand(2, 8);
        const vel = new THREE.Vector3(Math.cos(a) * s, rand(8, 16), Math.sin(a) * s);
        this.spawn(pos, CONFETTI_COLORS[i % CONFETTI_COLORS.length], vel, rand(1.4, 2.4), 0.35, 9, 10);
      }
    }

    // Big chunky blast (e.g. a bomb going off, a car exploding).
    explosion(pos, color = 0xff7a1a) {
      this.burst(pos, [color, 0xffe14d, 0x333333], { count: 40, speed: 16, life: 1.1, size: 0.5, up: 6 });
    }

    update(dt) {
      for (let i = this.live.length - 1; i >= 0; i--) {
        const p = this.live[i];
        p.life -= dt;
        if (p.life <= 0) {
          // Retire: hide and return to the pool.
          p.mesh.visible = false;
          this.scene.remove(p.mesh);
          this.pool.push(p.mesh);
          this.live.splice(i, 1);
          continue;
        }
        p.vel.y -= p.gravity * dt;
        p.vel.multiplyScalar(Math.exp(-1.2 * dt)); // air drag
        p.mesh.position.addScaledVector(p.vel, dt);
        // Bounce lightly on the ground instead of sinking through it.
        if (p.mesh.position.y < 0.1) { p.mesh.position.y = 0.1; p.vel.y = Math.abs(p.vel.y) * 0.3; }
        p.mesh.rotation.x += p.spin * dt;
        p.mesh.rotation.y += p.spin * 0.7 * dt;
        // Shrink away over the last 40% of its life.
        const k = Math.min(1, p.life / (p.maxLife * 0.4));
        p.mesh.scale.setScalar(p.size * k);
      }
    }

    dispose() {
      this.geo.dispose();
      Object.values(this.mats).forEach((m) => m.dispose());
    }
  }

  TP.FX = FX;
})();
