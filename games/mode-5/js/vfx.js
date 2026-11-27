/* =====================================================================
   vfx.js — Mode 5 particles and flashes, all driven by game events.

   Art & UI owns this file. Nothing here affects the rules.

   Usage:
     const vfx = new TP.M5.Vfx(scene, world);   // listens to TP.M5 events itself
     vfx.update(dt, cars);                      // once per frame

   What you see:
     • Droplets   — little paint blobs flicked off the roller behind every
                    car that's driving on the ground (more when boosting).
     • Splats     — a flat disc that bursts outward and fades, plus a spray
                    of droplets (landing splats, paint bombs, bump splats).
     • Fill burst — a shockwave ring + a column of sparks + confetti in the
                    filler's colour at the centre of the filled area.
     • Pop splash — a sharp ring and spray in the popper's colour where a
                    trail got popped, plus a spin of white sparks.
     • Overdrive  — hot sparks shooting up from the perimeter walls.

   Two kinds of particles:
     - TP.FX (shared) for chunky sparks/confetti (boxes that fly and fall).
     - Our own pool of "blobs" (small spheres, soft and round = paint) and
       "rings" / "discs" (flat shapes on the floor that expand and fade).
     Everything is pooled: meshes are reused, so effects make no garbage.
   ===================================================================== */
(function () {
  "use strict";
  TP.M5 = TP.M5 || {};
  const rand = (a, b) => a + Math.random() * (b - a);
  const NEON = () => TP.M5.NEON || TP.PLAYER_COLORS;
  const colorOf = (p) => NEON()[TP.M5.pi(p) % 4];

  class Vfx {
    constructor(scene, world) {
      this.scene = scene;
      this.world = world || null;
      this.cellSize = world ? world.cell : 96 / 72;
      this.half = world ? world.size / 2 : 48;
      this.fx = new TP.FX(scene);          // shared sparks / confetti
      this.time = 0;
      this.overdrive = false;

      // Shared geometry; one material per colour per kind (materials are cheap
      // to share because each live particle changes only scale and opacity...
      // except opacity is per-material, so flat shapes get their own material).
      this.blobGeo = new THREE.IcosahedronGeometry(1, 1);
      this.ringGeo = new THREE.RingGeometry(0.82, 1, 48);
      this.thinGeo = new THREE.RingGeometry(0.96, 1, 96);   // for very big rings (stays a line, not a band)
      this.discGeo = new THREE.CircleGeometry(1, 40);
      this.blobMats = {};

      this.blobs = []; this.blobPool = [];
      this.flats = []; this.flatPool = [];
      this.dropletTimers = new Map();      // car → seconds until next droplet

      this.listen();
    }

    blobMat(color) {
      if (!this.blobMats[color]) {
        this.blobMats[color] = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.25 });
      }
      return this.blobMats[color];
    }

    /* ---------- Blobs: round paint drops that arc and land ---------- */
    blob(pos, vel, color, size, life = 0.7) {
      const m = this.blobPool.pop() || new THREE.Mesh(this.blobGeo);
      m.material = this.blobMat(color);
      m.position.copy(pos);
      m.scale.setScalar(size);
      m.visible = true;
      this.scene.add(m);
      this.blobs.push({ m, vel, life, max: life, size });
    }

    /* ---------- Flat shapes on the floor: rings and discs ----------
       grow from r0 to r1 over `life` seconds while fading out. */
    flat(kind, x, z, color, r0, r1, life, opacity = 0.9, y = 0.12) {
      let item = this.flatPool.pop();
      if (!item) {
        const mat = new THREE.MeshBasicMaterial({
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        });
        item = { m: new THREE.Mesh(this.ringGeo, mat) };
        item.m.rotation.x = -Math.PI / 2;
      }
      item.m.geometry = kind === "disc" ? this.discGeo : r1 > 14 ? this.thinGeo : this.ringGeo;
      item.m.material.color.setHex(color);
      item.m.position.set(x, y, z);
      item.m.visible = true;
      Object.assign(item, { r0, r1, life, max: life, opacity });
      this.scene.add(item.m);
      this.flats.push(item);
    }

    /* =================================================================
       Effects (public, so Gameplay or the preview can call them directly)
       ================================================================= */

    // A paint splat of radius r (world units) at x,z.
    splat(x, z, r, color) {
      this.flat("disc", x, z, color, r * 0.3, r * 1.15, 0.45, 0.75);
      this.flat("ring", x, z, 0xffffff, r * 0.5, r * 1.4, 0.35, 0.8);
      const n = Math.round(10 + r * 3);
      const p = new THREE.Vector3(x, 0.4, z);
      for (let k = 0; k < n; k++) {
        const a = rand(0, Math.PI * 2), s = rand(3, 7 + r * 1.5);
        this.blob(p, new THREE.Vector3(Math.cos(a) * s, rand(3, 8), Math.sin(a) * s), color, rand(0.14, 0.3), rand(0.5, 0.9));
      }
    }

    // A loop closed: big celebratory burst. `big` (0..1) scales it with the fill size.
    fillBurst(x, z, color, big = 0.5) {
      const r = 6 + big * 18;
      this.flat("ring", x, z, color, 1, r, 0.7, 1);
      this.flat("ring", x, z, 0xffffff, 0.5, r * 0.7, 0.5, 0.7);
      this.flat("disc", x, z, color, 1, r * 0.8, 0.5, 0.35);
      const p = new THREE.Vector3(x, 0.5, z);
      this.fx.burst(p, [color, 0xffffff, color], { count: Math.round(24 + big * 36), speed: 9 + big * 6, up: 12, gravity: 16, size: 0.3, life: 1.2 });
      this.fx.confetti(p, { count: Math.round(20 + big * 40) });
    }

    // A wet trail got popped (or a car got splatted off in a bump).
    popSplash(x, z, color) {
      this.flat("ring", x, z, color, 0.5, 7, 0.4, 1);
      this.flat("ring", x, z, 0xffffff, 0.3, 4, 0.25, 1);
      const p = new THREE.Vector3(x, 0.6, z);
      for (let k = 0; k < 18; k++) {
        const a = rand(0, Math.PI * 2), s = rand(5, 12);
        this.blob(p, new THREE.Vector3(Math.cos(a) * s, rand(4, 10), Math.sin(a) * s), color, rand(0.16, 0.32), rand(0.5, 0.8));
      }
      this.fx.burst(p, 0xffffff, { count: 14, speed: 12, up: 4, size: 0.18, life: 0.5 });
    }

    // Small ring when a car lands (the splat itself comes with the "splat" event).
    landRing(x, z, color, airtime) {
      this.flat("ring", x, z, color, 1, 3 + airtime * 4, 0.35, 0.8);
    }

    pickupFlash(x, z) {
      this.flat("ring", x, z, 0xffffff, 0.5, 5, 0.35, 1);
      this.fx.burst(new THREE.Vector3(x, 1.5, z), [0xffffff, 0xffe14d], { count: 18, speed: 7, up: 6, size: 0.2 });
    }

    pickupSpawnFx(x, z) {
      this.flat("ring", x, z, 0xffffff, 6, 1.2, 0.5, 0.7);
    }

    /* =================================================================
       Events → effects
       ================================================================= */
    listen() {
      if (!TP.M5.on || this.listening) return;
      this.listening = true;
      const cs = () => this.cellSize;
      TP.M5.on("splat", (e) => this.splat(e.x, e.z, (e.r || 3) * cs(), colorOf(e.player)));
      TP.M5.on("fill", (e) => {
        // Bigger fills, bigger party. pct is the % of the floor gained.
        const big = Math.min(1, (e.pct || 0) / 12);
        this.fillBurst(e.cx || 0, e.cz || 0, colorOf(e.player), big);
      });
      TP.M5.on("pop", (e) => this.popSplash(e.x || 0, e.z || 0, colorOf(e.by)));
      TP.M5.on("land", (e) => {
        if (!this.cars) return;
        const car = this.cars.find((c) => (c.index ?? (c.player && c.player.index)) === TP.M5.pi(e.player));
        if (car) this.landRing(car.pos.x, car.pos.z, colorOf(e.player), e.airtime || 0.3);
      });
      TP.M5.on("pickupSpawn", (e) => this.pickupSpawnFx(e.x, e.z));
      TP.M5.on("pickup", (e) => {
        const car = this.cars && this.cars.find((c) => (c.index ?? (c.player && c.player.index)) === TP.M5.pi(e.player));
        if (car) this.pickupFlash(car.pos.x, car.pos.z);
      });
      TP.M5.on("overdrive", () => { this.overdrive = true; });
      TP.M5.on("roundCountdown", () => { this.overdrive = false; });
      TP.M5.on("roundEnd", (e) => {
        this.overdrive = false;
        // Confetti over the whole floor for the round winner.
        if (e && e.winner != null && e.winner >= 0) {
          const c = colorOf(e.winner);
          for (let k = 0; k < 6; k++) {
            this.fx.confetti(new THREE.Vector3(rand(-this.half, this.half) * 0.6, 1, rand(-this.half, this.half) * 0.6), { count: 40 });
          }
          this.flat("ring", 0, 0, c, 2, this.half * 1.3, 1.2, 0.8);
        }
      });
    }

    /* =================================================================
       Per frame
       ================================================================= */
    update(dt, cars) {
      this.time += dt;
      this.cars = cars || this.cars;

      // Droplets flicked off each roller.
      for (const car of this.cars || []) {
        if (!car || car.out || car.onGround === false || car.stunned) continue;
        const v = car.vel ? Math.hypot(car.vel.x, car.vel.z) : 0;
        if (v < 3) continue;
        let t = (this.dropletTimers.get(car) || 0) - dt;
        // More droplets, faster, when boosting (the brush is wider).
        const every = car.boosting ? 0.025 : 0.06;
        const color = colorOf(car.index ?? (car.player ? car.player.index : 0));
        while (t <= 0) {
          t += every;
          const h = car.heading || 0, fx = Math.sin(h), fz = Math.cos(h);
          // Spawn at the roller (nose of the car), across its width.
          const side = rand(-0.9, 0.9) * (car.boosting ? 1.5 : 1);
          const p = new THREE.Vector3(car.pos.x + fx * 2.3 + fz * side, 0.35, car.pos.z + fz * 2.3 - fx * side);
          // Thrown up and slightly sideways, keeping some of the car's motion.
          const vel = new THREE.Vector3(car.vel.x * 0.25 + fz * side * 2 + rand(-1, 1), rand(2, 5), car.vel.z * 0.25 - fx * side * 2 + rand(-1, 1));
          this.blob(p, vel, color, rand(0.1, 0.2), rand(0.35, 0.55));
        }
        this.dropletTimers.set(car, t);
      }

      // Overdrive: sparks spitting up along the walls.
      if (this.overdrive) {
        const n = Math.random() < dt * 30 ? 1 : 0;
        for (let k = 0; k < n; k++) {
          const side = (Math.random() * 4) | 0, along = rand(-this.half, this.half);
          const x = side === 0 ? -this.half : side === 1 ? this.half : along;
          const z = side === 2 ? -this.half : side === 3 ? this.half : along;
          this.fx.burst(new THREE.Vector3(x, 0.6, z), [0xff3d9a, 0xffd23f, 0xffffff], { count: 5, speed: 4, up: 9, size: 0.18, life: 0.7, gravity: 14 });
        }
      }

      // Move blobs: gravity, then "land" (squash flat and fade) on the floor.
      for (let i = this.blobs.length - 1; i >= 0; i--) {
        const b = this.blobs[i];
        b.life -= dt;
        if (b.life <= 0) {
          b.m.visible = false; this.scene.remove(b.m); this.blobPool.push(b.m);
          this.blobs.splice(i, 1);
          continue;
        }
        b.vel.y -= 22 * dt;
        b.m.position.addScaledVector(b.vel, dt);
        if (b.m.position.y < 0.08) {
          // Hit the floor: stop, flatten into a puddle.
          b.m.position.y = 0.08;
          b.vel.set(0, 0, 0);
          b.flat = true;
        }
        const k = Math.min(1, b.life / (b.max * 0.5));
        if (b.flat) b.m.scale.set(b.size * 1.6 * k, b.size * 0.25, b.size * 1.6 * k);
        else b.m.scale.setScalar(b.size * (0.6 + 0.4 * k));
      }
      // Grow + fade the flat shapes.
      for (let i = this.flats.length - 1; i >= 0; i--) {
        const f = this.flats[i];
        f.life -= dt;
        if (f.life <= 0) {
          f.m.visible = false; this.scene.remove(f.m); this.flatPool.push(f);
          this.flats.splice(i, 1);
          continue;
        }
        const u = 1 - f.life / f.max;                  // 0 → 1 over the life
        const ease = 1 - Math.pow(1 - u, 3);           // fast start, gentle stop
        const r = f.r0 + (f.r1 - f.r0) * ease;
        f.m.scale.set(r, r, r);
        f.m.material.opacity = f.opacity * (1 - u);
      }
      this.fx.update(dt);
    }

    dispose() {
      this.fx.dispose();
      [this.blobGeo, this.ringGeo, this.thinGeo, this.discGeo].forEach((g) => g.dispose());
      Object.values(this.blobMats).forEach((m) => m.dispose());
      this.flats.concat(this.flatPool).forEach((f) => f.m.material.dispose());
    }
  }

  TP.M5.Vfx = Vfx;
})();
