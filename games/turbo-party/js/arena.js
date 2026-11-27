/* =====================================================================
   arena.js — the shared skeleton every minigame is built on.

   A minigame subclass only fills in the bits that make it unique:
     build()              add floor, walls, props to this.scene
     spawn(i)             → { x, z, heading } start spot for player i
     groundHeightAt(x,z)  floor height, or null where there's no floor
     clampCar(car)        keep a car inside walls (optional)
     tick(dt)             game rules for one frame
     botControls(car)     → controls for a CPU car
     isOver()             true to end early (e.g. one car left in Sumo)
     scores()             → number per player (higher = better)
     chips()              → HUD score chips
   Everything else — countdown, timer, running cars, bumping, the camera
   and handing back the results — happens here.
   ===================================================================== */
(function () {
  "use strict";

  class Arena {
    constructor(game, opts) {
      this.game = game;
      this.players = game.players;
      this.title = opts.title;
      this.duration = opts.duration;     // seconds, or 0 for "until isOver()"
      // Shared car feel; a minigame may only tweak the settings listed in
      // TP.MODE_TUNABLE (see shared/js/car.js).
      this.tuning = TP.modeTuning(opts.tuning || {});

      /* ---------- Scene, camera, lights ---------- */
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x0d1430);
      this.scene.fog = new THREE.Fog(0x0d1430, 70, 160);
      TP.addStadiumLights(this.scene, opts.size || 25);
      this.fx = new TP.FX(this.scene); // particle effects for this arena

      // One fixed camera showing the whole arena — best for couch play,
      // since everyone shares the screen.
      this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
      const cam = opts.camera || { y: 40, z: 34, lookZ: 2 };
      this.camera.position.set(0, cam.y, cam.z);
      this.camera.lookAt(0, 0, cam.lookZ);

      this.build();

      /* ---------- Cars ---------- */
      this.cars = this.players.map((p, i) => {
        const car = new TP.Car(this.scene, p);
        const s = this.spawn(i);
        car.placeAt(s.x, s.z, s.heading);
        return car;
      });

      this.state = "countdown";
      this.clock = 3.5;                  // countdown length
      this.timeLeft = this.duration;
      this.elapsed = 0;
    }

    /* Plays the minigame start to finish. Resolves with ranked groups,
       e.g. [[2], [0, 1], [3]] (see TP.util.rankByScore). */
    async run() {
      TP.UI.showPlayers(false);
      TP.UI.turnLabel("");
      this._showHints();

      // Countdown 3-2-1 (the cars are frozen during this).
      let shown = -1;
      await TP.sched.until(() => {
        const n = Math.ceil(this.clock - 0.5);
        if (n !== shown && n > 0) { shown = n; TP.UI.center(String(n)); TP.sfx.play("count"); }
        return this.clock <= 0.5;
      });
      TP.UI.center("GO!", "", "#ffcc33");
      TP.sfx.play("go");
      this.state = "play";
      TP.sched.wait(0.7).then(() => { if (this.state === "play") TP.UI.center(""); });

      // Play until time runs out or the mode says it's over.
      await TP.sched.until(() => this.state === "done");

      TP.UI.center("FINISH!", "", "#ffcc33");
      TP.sfx.play("goal");
      TP.UI.hint("");
      await TP.sched.wait(1.8);
      TP.UI.center("");
      TP.UI.mgHud(null);
      TP.UI.showPlayers(true);
      return TP.util.rankByScore(this.scores());
    }

    // Called every frame by the game while this arena is on screen.
    // Physics runs in small fixed slices (max 1/60 s each) so a slow frame
    // can't make cars or the ball skip through walls and floors.
    update(dt) {
      const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
      for (let i = 0; i < steps; i++) this.step(dt / steps);
      this.animate(dt);

      // Boost trail: a puff of flame-coloured particles behind boosting cars.
      for (const car of this.cars) {
        if (car.out || !car.boosting || Math.random() > 0.6) continue;
        const back = car.forward().multiplyScalar(-2.3).add(car.pos);
        back.y += 0.65;
        this.fx.burst(back, [0xffa62b, 0xffe14d, 0x888888], { count: 1, speed: 1.5, up: 0.5, life: 0.35, size: 0.3, gravity: -2 });
      }
      this.fx.update(dt);
      this._updateHud();
    }

    // One physics slice.
    step(dt) {
      if (this.state === "countdown") {
        this.clock -= dt;
        this.cars.forEach((c) => c.syncMesh(dt));
      } else if (this.state === "play") {
        this.elapsed += dt;
        if (this.duration) this.timeLeft = Math.max(0, this.timeLeft - dt);

        // 1) Drive every car with human or bot controls.
        for (const car of this.cars) {
          if (car.out) continue;
          const ctrl = car.player.controller === "bot"
            ? this.botControls(car, dt)
            : TP.Input.get(car.player.controller);
          const wasBoosting = car.boosting;
          car.update(dt, ctrl, this, this.tuning);
          if (car.boosting && !wasBoosting && car.player.controller !== "bot") TP.sfx.play("boost");
          this.clampCar(car);
        }

        // 2) Bumps between cars.
        const hits = TP.Car.collideAll(this.cars, this.tuning);
        for (const h of hits) {
          if (h.impact > 6) {
            TP.sfx.play("bump");
            // Sparks where the two cars met.
            const mid = h.a.pos.clone().add(h.b.pos).multiplyScalar(0.5);
            mid.y += 0.8;
            this.fx.burst(mid, [0xffffff, 0xffcc33], { count: Math.min(20, Math.round(h.impact)), speed: 6, size: 0.18 });
          }
          this.onBump(h);
        }

        // 3) Mode-specific rules.
        this.tick(dt);

        if ((this.duration && this.timeLeft <= 0) || this.isOver()) this.state = "done";
      } else {
        // "done": brake every car to a stop for the finish screen (so
        // nobody rolls off a ledge after the whistle).
        for (const car of this.cars) {
          if (car.out) continue;
          const k = Math.exp(-5 * dt);
          car.vel.x *= k;
          car.vel.z *= k;
          car.update(dt, TP.Input.NEUTRAL, this, this.tuning);
          this.clampCar(car);
        }
      }
    }

    _updateHud() {
      const t = this.duration ? Math.ceil(this.timeLeft) : Math.floor(this.elapsed);
      TP.UI.mgHud(String(t), this.chips());
    }

    // Show each human's keys at the bottom of the screen.
    _showHints() {
      const humans = this.players.filter((p) => p.controller !== "bot");
      if (!humans.length) { TP.UI.hint("All bots — sit back and watch!"); return; }
      TP.UI.hint(humans.map((p) => {
        const k = TP.keyNames(p.controller);
        return `<span style="color:${p.css}">${TP.UI.esc(p.name)}</span>: drive <kbd>${k.drive}</kbd> steer <kbd>${k.steer}</kbd> jump <kbd>${k.confirm}</kbd> boost <kbd>${k.boost}</kbd>`;
      }).join(" &nbsp;·&nbsp; "));
    }

    /* ---------- Defaults that subclasses override as needed ---------- */
    build() {}
    spawn(i) { return { x: (i - 1.5) * 5, z: 0, heading: Math.PI }; }
    groundHeightAt() { return 0; }
    clampCar() {}
    onBump() {}
    tick() {}
    animate() {}
    botControls() { return TP.Input.NEUTRAL; }
    isOver() { return false; }
    scores() { return this.players.map(() => 0); }
    chips() {
      const s = this.scores();
      return this.players.map((p, i) => ({ name: p.name, css: p.css, value: s[i] }));
    }

    dispose() {
      this.fx.dispose();
      TP.disposeScene(this.scene);
    }

    /* ---------- Helpers subclasses commonly use ---------- */

    // Box-shaped arena: keep cars inside |x|,|z| < half, bouncing off walls.
    clampToBox(car, half) {
      const lim = half - car.radius;
      if (car.pos.x > lim) { car.pos.x = lim; car.vel.x = -Math.abs(car.vel.x) * 0.4; }
      if (car.pos.x < -lim) { car.pos.x = -lim; car.vel.x = Math.abs(car.vel.x) * 0.4; }
      if (car.pos.z > lim) { car.pos.z = lim; car.vel.z = -Math.abs(car.vel.z) * 0.4; }
      if (car.pos.z < -lim) { car.pos.z = -lim; car.vel.z = Math.abs(car.vel.z) * 0.4; }
    }

    // Floor + four walls for a square arena. Returns the floor mesh.
    buildBoxArena(half, floorColor = 0x1f6f4a, wallColor = 0x2a3566, gaps = null) {
      const floor = new THREE.Mesh(
        new THREE.BoxGeometry(half * 2, 1, half * 2),
        new THREE.MeshStandardMaterial({ color: floorColor, roughness: 0.9 })
      );
      floor.position.y = -0.5;
      floor.receiveShadow = true;
      this.scene.add(floor);

      // Field lines: centre circle + halfway line, just for looks.
      const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 });
      const ring = new THREE.Mesh(new THREE.RingGeometry(half * 0.22, half * 0.22 + 0.3, 48), lineMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      this.scene.add(ring);

      // Walls. `gaps` (optional) = half-width of an opening in the middle
      // of every wall, used by Goal Frenzy for the goals.
      const wallMat = new THREE.MeshStandardMaterial({ color: wallColor, transparent: true, opacity: 0.85 });
      const H = 2.2, T = 1;
      const addWall = (w, d, x, z) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, H, d), wallMat);
        m.position.set(x, H / 2, z);
        m.castShadow = true;
        this.scene.add(m);
      };
      for (const side of [-1, 1]) {
        if (!gaps) {
          addWall(half * 2 + T * 2, T, 0, side * (half + T / 2));
          addWall(T, half * 2, side * (half + T / 2), 0);
        } else {
          // Two wall pieces per side with an opening between them.
          // North/south pieces run from the goal edge out to the corner
          // (one wall-thickness longer, so the corners are closed).
          const lenX = half + T - gaps;
          // East/west pieces stop at the inside corner.
          const lenZ = half - gaps;
          for (const s2 of [-1, 1]) {
            addWall(lenX, T, s2 * (gaps + lenX / 2), side * (half + T / 2));
            addWall(T, lenZ, side * (half + T / 2), s2 * (gaps + lenZ / 2));
          }
        }
      }
      return floor;
    }
  }

  TP.Arena = Arena;

  // Every minigame registers itself here; the game picks from this list.
  TP.MINIGAMES = [];
})();
