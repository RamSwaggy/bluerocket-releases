/* =====================================================================
   Ring Race — 4 laps around a circular track.
   Race clockwise (as seen on screen) around a ring-shaped track.
   First across the line after 4 laps wins; everyone else has 8 seconds
   to finish after that. Boost pads on the track refill your boost.

   Progress is measured as the angle you've travelled around the centre,
   so driving backwards (or cutting across) never counts.
   ===================================================================== */
(function () {
  "use strict";
  const { clamp, wrapAngle } = TP.util;

  const INNER = 10;    // inner wall radius
  const OUTER = 25;    // outer wall radius
  const LAPS = 4;
  const FULL = Math.PI * 2;
  const GRACE = 8;     // seconds the field gets after the winner finishes
  const PAD_ANGLES = [Math.PI * 0.5, Math.PI * 1.0, Math.PI * 1.5]; // boost pad positions

  // Direction of travel at angle a: the direction of increasing
  // atan2(z, x). With the camera above and +Z toward the bottom of the
  // screen, that's clockwise on screen.
  const tangentHeading = (a) => Math.atan2(-Math.sin(a), Math.cos(a));

  class RingRace extends TP.Arena {
    constructor(game) {
      super(game, { title: "Ring Race", duration: 0, size: OUTER, camera: { y: 54, z: 42, lookZ: 2 } });
      // Per-car race state: unwrapped angle travelled, finish order.
      // `travelled` starts at the car's (negative) angle behind the line,
      // so laps count from the painted start line, not the grid spot.
      this.race = this.cars.map((c) => {
        const a = Math.atan2(c.pos.z, c.pos.x);
        return { last: a, travelled: a, finished: false, time: 0 };
      });
      this.finishOrder = [];
      this.graceLeft = null;
      // Each bot hugs a different line (shuffled, so the inside line —
      // the shortest way round — isn't always the same bot's).
      this.lines = TP.util.shuffle([14.5, 16.5, 18.5, 20.5]);
      this.lineTimer = 0;
    }

    build() {
      // Grass infield + outfield.
      const grass = new THREE.Mesh(new THREE.CircleGeometry(OUTER + 12, 64), new THREE.MeshStandardMaterial({ color: 0x1d5b3a }));
      grass.rotation.x = -Math.PI / 2;
      grass.position.y = -0.02;
      grass.receiveShadow = true;
      this.scene.add(grass);

      // Asphalt ring.
      const road = new THREE.Mesh(new THREE.RingGeometry(INNER, OUTER, 96), new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.95 }));
      road.rotation.x = -Math.PI / 2;
      road.receiveShadow = true;
      this.scene.add(road);

      // Dashed centre line.
      const dashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
      for (let k = 0; k < 36; k += 2) {
        const a0 = (k / 36) * FULL;
        const dash = new THREE.Mesh(new THREE.RingGeometry(17.5 - 0.12, 17.5 + 0.12, 6, 1, a0, FULL / 36), dashMat);
        dash.rotation.x = -Math.PI / 2;
        dash.position.y = 0.01;
        this.scene.add(dash);
      }

      // Checkered start/finish line along the +X axis (angle 0).
      for (let k = 0; k < OUTER - INNER; k++) {
        for (let row = 0; row < 2; row++) {
          const sq = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: (k + row) % 2 ? 0x111111 : 0xffffff }));
          sq.rotation.x = -Math.PI / 2;
          // Ring geometry's angle runs the other way to atan2(z, x) once
          // rotated flat, so the line sits at z ≈ 0 either way.
          sq.position.set(INNER + 0.5 + k, 0.02, (row - 0.5));
          this.scene.add(sq);
        }
      }

      // Walls: inner island and outer barrier.
      const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a2f6b, transparent: true, opacity: 0.9 });
      const island = new THREE.Mesh(new THREE.CylinderGeometry(INNER, INNER, 1.6, 64), new THREE.MeshStandardMaterial({ color: 0x2a7a4f }));
      island.position.y = 0.8;
      island.castShadow = true;
      this.scene.add(island);
      const outer = new THREE.Mesh(new THREE.CylinderGeometry(OUTER + 0.5, OUTER + 0.5, 1.8, 96, 1, true), wallMat);
      outer.material.side = THREE.DoubleSide;
      outer.position.y = 0.9;
      this.scene.add(outer);

      // Boost pads: glowing orange chevrons that refill boost.
      this.pads = PAD_ANGLES.map((a) => {
        const pad = new THREE.Mesh(
          new THREE.CircleGeometry(1.6, 20),
          new THREE.MeshBasicMaterial({ color: 0xffb020 })
        );
        pad.rotation.x = -Math.PI / 2;
        pad.position.set(Math.cos(a) * 17.5, 0.03, Math.sin(a) * 17.5);
        this.scene.add(pad);
        return { a, mesh: pad, x: pad.position.x, z: pad.position.z };
      });
    }

    spawn(i) {
      // Staggered grid just behind the line, one car per lane. Grid slots
      // are shuffled each race so nobody always gets pole position.
      // (spawn() runs inside the base constructor, so set this up lazily.)
      if (!this.grid) this.grid = TP.util.shuffle([0, 1, 2, 3]);
      const slot = this.grid[i];
      const a = -0.18 - (slot % 2) * 0.16;
      const r = 12.5 + slot * 3.4;
      return { x: Math.cos(a) * r, z: Math.sin(a) * r, heading: tangentHeading(a) };
    }

    // Keep cars between the two walls, bouncing off them.
    clampCar(car) {
      const r = Math.hypot(car.pos.x, car.pos.z) || 1;
      const nx = car.pos.x / r, nz = car.pos.z / r;
      const radial = car.vel.x * nx + car.vel.z * nz; // + = moving outward
      if (r < INNER + car.radius) {
        car.pos.x = nx * (INNER + car.radius);
        car.pos.z = nz * (INNER + car.radius);
        if (radial < 0) { car.vel.x -= nx * radial * 1.4; car.vel.z -= nz * radial * 1.4; }
      } else if (r > OUTER - car.radius) {
        car.pos.x = nx * (OUTER - car.radius);
        car.pos.z = nz * (OUTER - car.radius);
        if (radial > 0) { car.vel.x -= nx * radial * 1.4; car.vel.z -= nz * radial * 1.4; }
      }
    }

    tick(dt) {
      this.cars.forEach((car, i) => {
        const st = this.race[i];
        // Add how far round the centre we moved this step (can be negative).
        const a = Math.atan2(car.pos.z, car.pos.x);
        st.travelled += wrapAngle(a - st.last);
        st.last = a;

        // Boost pads.
        for (const p of this.pads) {
          if (TP.util.dist2D(car.pos.x, car.pos.z, p.x, p.z) < 2 && car.boost < 99) {
            car.boost = 100;
            if (car.player.controller !== "bot") TP.sfx.play("boost");
          }
        }

        if (!st.finished && st.travelled >= LAPS * FULL) {
          st.finished = true;
          st.time = this.elapsed;
          this.finishOrder.push(i);
          this.fx.confetti(car.pos.clone().setY(1), { count: 30 });
          TP.sfx.play(this.finishOrder.length === 1 ? "trophy" : "coin");
          TP.UI.toast(`🏁 ${car.player.name} finishes ${["1st", "2nd", "3rd", "4th"][this.finishOrder.length - 1]}!`);
          if (this.graceLeft === null) this.graceLeft = GRACE;
        } else if (!st.finished) {
          // Lap callouts for humans.
          const lap = Math.floor(st.travelled / FULL) + 1;
          if (lap > (st.lapShown || 1) && lap <= LAPS) {
            st.lapShown = lap;
            if (car.player.controller !== "bot") TP.UI.toast(lap === LAPS ? `${car.player.name}: FINAL LAP!` : `${car.player.name}: lap ${lap}/${LAPS}`);
          }
        }
      });
      if (this.graceLeft !== null) this.graceLeft -= dt;

      // Every few seconds bots drift to a new line, like real overtakes.
      this.lineTimer -= dt;
      if (this.lineTimer <= 0) {
        this.lineTimer = TP.util.rand(2, 4);
        const i = TP.util.randInt(0, this.lines.length - 1);
        this.lines[i] = TP.util.rand(13.5, 21.5);
      }
    }

    animate() {
      // Pads pulse.
      const k = 0.6 + 0.4 * Math.sin(performance.now() * 0.008);
      this.pads.forEach((p) => p.mesh.material.color.setRGB(1, 0.55 + 0.25 * k, 0.1));
    }

    // Over when everyone's home, the grace period runs out, or (safety
    // net) after 2 minutes. The HUD clock counts up during a race.
    isOver() {
      return this.race.every((s) => s.finished) || (this.graceLeft !== null && this.graceLeft <= 0) || this.elapsed > 120;
    }

    // Finishers by finish order; everyone else by how far they got.
    scores() {
      return this.race.map((s, i) => {
        const idx = this.finishOrder.indexOf(i);
        return idx >= 0 ? 1000 - idx : s.travelled / FULL;
      });
    }

    chips() {
      return this.players.map((p, i) => {
        const s = this.race[i];
        const idx = this.finishOrder.indexOf(i);
        const value = idx >= 0 ? `🏁 ${["1st", "2nd", "3rd", "4th"][idx]}` :
          `Lap ${clamp(Math.floor(Math.max(0, s.travelled) / FULL) + 1, 1, LAPS)}/${LAPS}`;
        return { name: p.name, css: p.css, value };
      });
    }

    botControls(car) {
      const st = this.race[car.index];
      if (st.finished) return TP.ai.driveTo(car, car.pos.x * 0.98, car.pos.z * 0.98, { arrive: 6 });
      // Aim at a point a little further round the track on this bot's line.
      const a = Math.atan2(car.pos.z, car.pos.x) + 0.5;
      const r = this.lines[car.index];
      const ctrl = TP.ai.driveTo(car, Math.cos(a) * r, Math.sin(a) * r, { boostDist: 0 });
      // Boost on reasonably straight bits (always slightly turning on a ring).
      ctrl.boost = Math.abs(TP.ai.angleTo(car, Math.cos(a) * r, Math.sin(a) * r)) < 0.35 && car.boost > 30;
      return ctrl;
    }
  }

  TP.MINIGAMES.push({
    id: "ring-race",
    name: "Ring Race",
    cls: RingRace,
    blurb: "4 laps clockwise around the ring. Orange pads refill your boost. Bump rivals into the walls! Once the winner finishes, everyone else has 8 seconds.",
  });
})();
