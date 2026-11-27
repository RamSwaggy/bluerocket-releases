/* =====================================================================
   Coin Rush — 30 seconds, free-for-all.
   Drive over coins to grab them. Slam into a rival hard enough and they
   spill 2 coins you can steal. Most coins when time's up wins.
   ===================================================================== */
(function () {
  "use strict";
  const { rand, dist2D } = TP.util;

  const HALF = 20;          // arena is 40 × 40
  const MAX_COINS = 14;     // how many loose coins on the field at once
  const SPILL_IMPACT = 9;   // how hard a hit must be to knock coins loose

  class CoinRush extends TP.Arena {
    constructor(game) {
      super(game, { title: "Coin Rush", duration: 30, size: HALF, camera: { y: 38, z: 32, lookZ: 2 } });
      this.score = this.players.map(() => 0);
      this.coins = [];          // { mesh, x, z, vx, vz, cooldown }
      this.spawnTimer = 0;
      this.hitCooldown = this.players.map(() => 0); // stops one crash counting many times
      for (let i = 0; i < 8; i++) this.spawnCoin();
    }

    build() {
      this.buildBoxArena(HALF, 0x2b5d8c, 0x3a2f6b);
      this.coinGeo = new THREE.CylinderGeometry(0.85, 0.85, 0.2, 24);
      this.coinGeo.rotateX(Math.PI / 2); // stand the coin on its edge
      this.coinMat = new THREE.MeshStandardMaterial({ color: 0xffcc33, metalness: 0.8, roughness: 0.25, emissive: 0xb07800, emissiveIntensity: 0.9 });
    }

    spawn(i) {
      // One car near each corner, facing the middle.
      const c = [[-1, -1], [1, -1], [-1, 1], [1, 1]][i];
      const x = c[0] * 12, z = c[1] * 12;
      return { x, z, heading: Math.atan2(-x, -z) };
    }

    clampCar(car) { this.clampToBox(car, HALF); }

    // Add a coin. With no position given it appears at a random free spot.
    spawnCoin(x, z, vx = 0, vz = 0, cooldown = 0) {
      const mesh = new THREE.Mesh(this.coinGeo, this.coinMat);
      mesh.castShadow = true;
      if (x === undefined) { x = rand(-HALF + 3, HALF - 3); z = rand(-HALF + 3, HALF - 3); }
      mesh.position.set(x, 1, z);
      this.scene.add(mesh);
      this.coins.push({ mesh, x, z, vx, vz, cooldown });
    }

    onBump(hit) {
      const v = hit.victim;
      if (hit.impact < SPILL_IMPACT || this.hitCooldown[v.index] > 0) return;
      this.hitCooldown[v.index] = 1.0;
      const lost = Math.min(2, this.score[v.index]);
      this.score[v.index] -= lost;
      // Fling the spilled coins outward in random directions.
      for (let k = 0; k < lost; k++) {
        const a = rand(0, Math.PI * 2), s = rand(6, 11);
        this.spawnCoin(v.pos.x, v.pos.z, Math.sin(a) * s, Math.cos(a) * s, 0.6);
      }
      if (lost) TP.sfx.play("lose");
    }

    tick(dt) {
      this.hitCooldown = this.hitCooldown.map((t) => Math.max(0, t - dt));

      // Keep the field topped up.
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 && this.coins.length < MAX_COINS) {
        this.spawnCoin();
        this.spawnTimer = 0.45;
      }

      // Move sliding (spilled) coins and check pickups.
      for (let i = this.coins.length - 1; i >= 0; i--) {
        const c = this.coins[i];
        c.cooldown = Math.max(0, c.cooldown - dt);
        if (c.vx || c.vz) {
          c.x += c.vx * dt; c.z += c.vz * dt;
          const fr = Math.exp(-2.5 * dt); c.vx *= fr; c.vz *= fr;
          // Bounce off the walls.
          const lim = HALF - 1;
          if (Math.abs(c.x) > lim) { c.x = Math.sign(c.x) * lim; c.vx *= -0.6; }
          if (Math.abs(c.z) > lim) { c.z = Math.sign(c.z) * lim; c.vz *= -0.6; }
          if (Math.hypot(c.vx, c.vz) < 0.2) c.vx = c.vz = 0;
        }
        if (c.cooldown > 0) continue;

        for (const car of this.cars) {
          if (car.pos.y < 2.2 && dist2D(car.pos.x, car.pos.z, c.x, c.z) < 1.8) {
            this.score[car.index]++;
            this.fx.burst(c.mesh.position, 0xffcc33, { count: 8, speed: 5, size: 0.2 });
            this.scene.remove(c.mesh);
            this.coins.splice(i, 1);
            if (car.player.controller !== "bot") TP.sfx.play("coin");
            break;
          }
        }
      }
    }

    animate(dt) {
      // Spin and bob every coin.
      const t = performance.now() * 0.001;
      for (const c of this.coins) {
        c.mesh.position.set(c.x, 1 + Math.sin(t * 3 + c.x) * 0.15, c.z);
        c.mesh.rotation.y += dt * 3;
      }
    }

    botControls(car) {
      // Head for the closest coin that can be picked up. Small bias toward
      // coins in front of the car so bots don't constantly U-turn.
      let best = null, bestCost = Infinity;
      for (const c of this.coins) {
        if (c.cooldown > 0.2) continue;
        const d = dist2D(car.pos.x, car.pos.z, c.x, c.z);
        const turn = Math.abs(TP.ai.angleTo(car, c.x, c.z));
        const cost = d + turn * 4;
        if (cost < bestCost) { bestCost = cost; best = c; }
      }
      if (!best) return TP.ai.driveTo(car, 0, 0, { arrive: 4 });
      return TP.ai.driveTo(car, best.x, best.z, { boostDist: 12 });
    }

    scores() { return this.score.slice(); }
    chips() {
      return this.players.map((p, i) => ({ name: p.name, css: p.css, value: "🪙 " + this.score[i] }));
    }
  }

  TP.MINIGAMES.push({
    id: "coin-rush",
    name: "Coin Rush",
    cls: CoinRush,
    blurb: "Grab as many coins as you can in 30 seconds. Ram rivals hard to knock 2 of their coins loose — then steal them!",
  });
})();
