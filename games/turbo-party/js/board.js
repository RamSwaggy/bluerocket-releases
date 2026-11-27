/* =====================================================================
   board.js — the party board: a looping track of spaces your car drives
   around, a trophy to buy, dice rolls and space effects.

   Space types:
     start  — where everyone begins. Passing it gives a +5 lap bonus.
     blue   — +3 coins
     red    — −3 coins
     boost  — zoom 3 more spaces
     event  — a random surprise (see EVENTS below)
   The trophy sits on one space. Drive onto or past it with 20+ coins
   and you can buy it; then it moves somewhere else on the board.
   ===================================================================== */
(function () {
  "use strict";
  const { pick, randInt, shuffle } = TP.util;

  const SPACE_COUNT = 30;
  const TROPHY_COST = 20;
  const TOKEN_SCALE = 0.55;  // cars are shrunk down on the board
  const STEP_TIME = 0.3;     // seconds to hop one space

  const SPACE_STYLE = {
    start: { color: 0xffffff, emissive: 0x666666 },
    blue: { color: 0x2f6bff, emissive: 0x0d2a7a },
    red: { color: 0xff3b3b, emissive: 0x6b0d0d },
    boost: { color: 0xffb020, emissive: 0x6b4300 },
    event: { color: 0x22d3a6, emissive: 0x0b5c48 },
  };

  // Where each player's car parks on a shared space (so they don't overlap).
  const PARK_OFFSETS = [[-0.85, -0.85], [0.85, -0.85], [-0.85, 0.85], [0.85, 0.85]];

  class Board {
    constructor(game) {
      this.game = game;
      this.players = game.players;

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x0b1226);
      this.scene.fog = new THREE.Fog(0x0b1226, 90, 220);
      TP.addStadiumLights(this.scene, 45);

      this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
      this.camFocus = new THREE.Vector3(0, 0, 0);       // where the camera looks
      this.camOffset = new THREE.Vector3(0, 62, 48);    // camera position relative to focus
      this.camera.position.copy(this.camFocus).add(this.camOffset);
      this.orbit = false; // menu background slowly circles the board

      this.buildTrack();
      this.buildDecor();
      this.buildTrophy();

      // One car token per player, all parked on the start space.
      this.tokens = this.players.map((p) => {
        const car = new TP.Car(this.scene, p);
        car.mesh.scale.setScalar(TOKEN_SCALE);
        p.space = 0;
        return car;
      });
      this.tokens.forEach((t, i) => this.parkToken(i));
    }

    /* ------------------------------------------------------------------
       Building the board
       ------------------------------------------------------------------ */
    buildTrack() {
      // A wobbly loop: an ellipse with a 3-lobed wave on its radius.
      const ctrl = [];
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * Math.PI * 2;
        const r = 1 + 0.16 * Math.sin(a * 3);
        ctrl.push(new THREE.Vector3(Math.cos(a) * 36 * r, 0, Math.sin(a) * 24 * r));
      }
      this.curve = new THREE.CatmullRomCurve3(ctrl, true);

      // The road ribbon underneath the spaces (a squashed tube).
      const road = new THREE.Mesh(
        new THREE.TubeGeometry(this.curve, 400, 1.1, 8, true),
        new THREE.MeshStandardMaterial({ color: 0x2a2f45, roughness: 0.9 })
      );
      road.scale.y = 0.12;
      road.receiveShadow = true;
      this.scene.add(road);

      // Choose space types: start first, then a shuffled bag so the mix
      // is fair but the order is different every game.
      const bag = [];
      const n = SPACE_COUNT - 1;
      const counts = { blue: Math.round(n * 0.48), red: Math.round(n * 0.2), boost: Math.round(n * 0.14) };
      counts.event = n - counts.blue - counts.red - counts.boost;
      for (const [type, c] of Object.entries(counts)) for (let i = 0; i < c; i++) bag.push(type);
      const types = ["start", ...shuffle(bag)];

      // No two boost spaces back-to-back (it would chain forever-ish).
      for (let i = 1; i < types.length; i++) {
        if (types[i] === "boost" && types[(i + 1) % types.length] === "boost") types[i] = "blue";
      }

      this.spaces = [];
      const discGeo = new THREE.CylinderGeometry(1.9, 1.9, 0.35, 32);
      for (let i = 0; i < SPACE_COUNT; i++) {
        const t = i / SPACE_COUNT;
        const pos = this.curve.getPointAt(t);
        const tangent = this.curve.getTangentAt(t);
        const type = types[i];
        const style = SPACE_STYLE[type];

        const mesh = new THREE.Mesh(discGeo, new THREE.MeshStandardMaterial({
          color: style.color, emissive: style.emissive, emissiveIntensity: 0.8, roughness: 0.5,
        }));
        mesh.position.copy(pos);
        mesh.position.y = 0.18;
        mesh.receiveShadow = true;
        this.scene.add(mesh);

        // Small icon on top so spaces are readable without colour alone.
        const icon = this.makeIcon(type, tangent);
        if (icon) { icon.position.copy(pos); this.scene.add(icon); }

        this.spaces.push({ index: i, type, pos, tangent, mesh, icon });
      }
    }

    // A simple 3D symbol per space type.
    makeIcon(type, tangent) {
      const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
      if (type === "boost") {
        // Flat arrow chevron pointing along the track.
        const g = new THREE.Group();
        const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.4, 3), white);
        arrow.rotation.x = Math.PI / 2;
        arrow.scale.y = 0.25;
        g.add(arrow);
        g.rotation.y = Math.atan2(tangent.x, tangent.z);
        g.position.y = 0.45;
        g.children[0].position.y = 0.45;
        return g;
      }
      if (type === "event") {
        // Spinning diamond hovering above.
        const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.55), white);
        m.userData.spin = true;
        const g = new THREE.Group();
        m.position.y = 1.1;
        g.add(m);
        return g;
      }
      if (type === "start") {
        // Checkered flag-ish stripe.
        const g = new THREE.Group();
        for (let k = 0; k < 4; k++) {
          const sq = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.6),
            new THREE.MeshBasicMaterial({ color: k % 2 ? 0x111111 : 0xffffff }));
          sq.position.set((k - 1.5) * 0.6, 0.38, 0);
          g.add(sq);
        }
        g.rotation.y = Math.atan2(tangent.x, tangent.z) + Math.PI / 2;
        return g;
      }
      if (type === "blue" || type === "red") {
        // Plus or minus sign.
        const g = new THREE.Group();
        const bar = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.05, 0.22), white);
        bar.position.y = 0.38;
        g.add(bar);
        if (type === "blue") {
          const bar2 = bar.clone();
          bar2.rotation.y = Math.PI / 2;
          g.add(bar2);
        }
        return g;
      }
      return null;
    }

    buildDecor() {
      // Ground.
      const ground = new THREE.Mesh(
        new THREE.CircleGeometry(140, 64),
        new THREE.MeshStandardMaterial({ color: 0x173a2c, roughness: 1 })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      this.scene.add(ground);

      // Giant ball sculpture in the middle of the loop.
      const ball = new THREE.Mesh(
        new THREE.IcosahedronGeometry(6, 1),
        new THREE.MeshStandardMaterial({ color: 0xdde4ff, flatShading: true, roughness: 0.4, emissive: 0x111833 })
      );
      ball.position.set(0, 6, 0);
      ball.castShadow = true;
      this.scene.add(ball);
      this.bigBall = ball;

      // Floodlight towers around the outside.
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x5b6585 });
      const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff3c4 });
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + 0.3;
        const x = Math.cos(a) * 58, z = Math.sin(a) * 42;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 22, 8), poleMat);
        pole.position.set(x, 11, z);
        pole.castShadow = true;
        this.scene.add(pole);
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 1), lampMat);
        lamp.position.set(x, 22, z);
        lamp.lookAt(0, 0, 0);
        this.scene.add(lamp);
      }

      // Scatter of low-poly trees outside the track.
      const treeMat = new THREE.MeshStandardMaterial({ color: 0x1f7a4d, flatShading: true });
      for (let k = 0; k < 40; k++) {
        const a = Math.random() * Math.PI * 2;
        const r = 1.35 + Math.random() * 0.5;
        const x = Math.cos(a) * 38 * r, z = Math.sin(a) * 27 * r;
        const tree = new THREE.Mesh(new THREE.ConeGeometry(1.4, 4 + Math.random() * 2, 6), treeMat);
        tree.position.set(x, 2.5, z);
        tree.castShadow = true;
        this.scene.add(tree);
      }
    }

    buildTrophy() {
      const gold = new THREE.MeshStandardMaterial({ color: 0xffcc33, metalness: 0.9, roughness: 0.2, emissive: 0x5a3d00 });
      const g = new THREE.Group();
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.45, 1.3, 20, 1, true), gold);
      cup.position.y = 1.4;
      g.add(cup);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.6, 10), gold);
      stem.position.y = 0.5;
      g.add(stem);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.7, 0.25, 20), gold);
      base.position.y = 0.12;
      g.add(base);
      for (const s of [-1, 1]) {
        const handle = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.08, 8, 16), gold);
        handle.position.set(s * 0.95, 1.5, 0);
        handle.rotation.y = Math.PI / 2;
        g.add(handle);
      }
      // Light beam so you can spot the trophy from the overview camera.
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(1.2, 1.2, 30, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffdd66, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })
      );
      beam.position.y = 15;
      g.add(beam);
      g.traverse((o) => { if (o.isMesh && o !== beam) o.castShadow = true; });
      this.trophy = g;
      this.scene.add(g);
      this.placeTrophy(randInt(8, SPACE_COUNT - 8));
    }

    placeTrophy(index) {
      this.trophyIndex = index;
      const p = this.spaces[index].pos;
      this.trophy.position.set(p.x, 2.2, p.z);
    }

    /* ------------------------------------------------------------------
       Per-frame update: camera, spinning things
       ------------------------------------------------------------------ */
    update(dt) {
      if (this.orbit) {
        // Slow circle for the title-screen background.
        const t = performance.now() * 0.00008;
        this.camera.position.set(Math.sin(t) * 70, 46, Math.cos(t) * 70);
        this.camera.lookAt(0, 0, 0);
      } else {
        // Smoothly glide toward the focus point.
        const target = this.camFocus.clone().add(this.camOffset);
        this.camera.position.x = TP.util.damp(this.camera.position.x, target.x, 3, dt);
        this.camera.position.y = TP.util.damp(this.camera.position.y, target.y, 3, dt);
        this.camera.position.z = TP.util.damp(this.camera.position.z, target.z, 3, dt);
        this._look = this._look || this.camFocus.clone();
        this._look.x = TP.util.damp(this._look.x, this.camFocus.x, 3, dt);
        this._look.y = TP.util.damp(this._look.y, this.camFocus.y, 3, dt);
        this._look.z = TP.util.damp(this._look.z, this.camFocus.z, 3, dt);
        this.camera.lookAt(this._look);
      }

      this.trophy.rotation.y += dt * 1.2;
      this.bigBall.rotation.y += dt * 0.15;
      for (const s of this.spaces) {
        if (s.icon) s.icon.traverse((o) => { if (o.userData.spin) o.rotation.y += dt * 2; });
      }
      this.tokens.forEach((t) => t.syncMesh(dt));
    }

    // Close-up camera on a player, or the whole-board view.
    focusOn(player) {
      const p = this.tokens[player.index].pos;
      this.camFocus.set(p.x, 0, p.z);
      this.camOffset.set(0, 20, 17);
    }
    focusOverview() {
      this.camFocus.set(0, 0, 4);
      this.camOffset.set(0, 62, 48);
    }

    /* ------------------------------------------------------------------
       Token movement
       ------------------------------------------------------------------ */
    // Position a player's car on its current space at its parking spot.
    parkToken(i) {
      const p = this.players[i];
      const s = this.spaces[p.space];
      const [ox, oz] = PARK_OFFSETS[i];
      const t = this.tokens[i];
      t.pos.set(s.pos.x + ox, 0.36, s.pos.z + oz);
      t.heading = Math.atan2(s.tangent.x, s.tangent.z);
      t.syncMesh(0);
    }

    // Hop one space forward with a little jump arc.
    async stepForward(player, fast = false) {
      const tok = this.tokens[player.index];
      const from = tok.pos.clone();
      const next = (player.space + 1) % SPACE_COUNT;
      const to = this.spaces[next].pos.clone();
      to.y = 0.36;
      tok.heading = Math.atan2(to.x - from.x, to.z - from.z);
      TP.sfx.play("step");

      await TP.sched.tween(fast ? STEP_TIME * 0.6 : STEP_TIME, (k) => {
        tok.pos.lerpVectors(from, to, k);
        tok.pos.y = 0.36 + Math.sin(k * Math.PI) * 1.2;
        this.camFocus.set(tok.pos.x, 0, tok.pos.z);
      });
      player.space = next;

      // Passing the start line pays a lap bonus.
      if (next === 0) {
        this.addCoins(player, 5, "Lap bonus! +5");
        await TP.sched.wait(0.5);
      }
      // Driving onto (or through) the trophy space → offer to buy.
      if (next === this.trophyIndex) await this.trophyStop(player);
    }

    /* ------------------------------------------------------------------
       One player's whole turn: roll → move → land
       ------------------------------------------------------------------ */
    async takeTurn(player) {
      const ui = TP.UI;
      const human = player.controller !== "bot";
      ui.setPlayers(this.players, player.index);
      this.focusOn(player);
      ui.center(`${player.name}'s turn`, "", player.css);
      await TP.sched.wait(0.9);
      ui.center("");

      /* ---------- Roll the die (1–10) ---------- */
      let value = randInt(1, 10);
      let flick = 0;
      ui.die(value);
      if (human) ui.hint(`<span style="color:${player.css}">${ui.esc(player.name)}</span>: press <kbd>${TP.keyNames(player.controller).confirm}</kbd> to stop the die`);
      let elapsed = 0;
      await TP.sched.run((dt) => {
        elapsed += dt;
        flick += dt;
        if (flick > 0.06) {         // change the number ~16 times a second
          flick = 0;
          value = (value % 10) + 1;
          ui.die(value);
          TP.sfx.play("tick");
        }
        return human ? TP.Input.get(player.controller).confirmPressed : elapsed > 1.0;
      });
      // Final roll is random, not whatever was showing, so you can't time it.
      value = randInt(1, 10);
      ui.die(value);
      ui.hint("");
      TP.sfx.play("coin");
      await TP.sched.wait(0.6);

      /* ---------- Move ---------- */
      for (let left = value; left > 0; left--) {
        await this.stepForward(player);
        ui.die(left - 1 > 0 ? left - 1 : null);
      }
      ui.die(null);

      /* ---------- Land ---------- */
      await this.landOn(player);
      this.parkToken(player.index);
      ui.setPlayers(this.players, player.index);
      await TP.sched.wait(0.5);
    }

    addCoins(player, amount, label) {
      const before = player.coins;
      player.coins = Math.max(0, player.coins + amount);
      TP.UI.toast(label || (amount >= 0 ? `+${amount} coins` : `${amount} coins`));
      TP.sfx.play(amount >= 0 ? "coin" : "lose");
      TP.UI.setPlayers(this.players, player.index);
      return player.coins - before;
    }

    async landOn(player, fromBoost = false) {
      const s = this.spaces[player.space];
      // Flash the landed space.
      s.mesh.material.emissiveIntensity = 2.5;
      TP.sched.wait(0.5).then(() => { s.mesh.material.emissiveIntensity = 0.8; });

      switch (s.type) {
        case "start":
        case "blue":
          this.addCoins(player, 3, "Blue space! +3 coins");
          break;
        case "red":
          this.addCoins(player, -3, "Red space! −3 coins");
          break;
        case "boost":
          if (fromBoost) break; // a boost can't trigger another boost
          TP.UI.toast("Boost pad! Zoom 3 more spaces!");
          TP.sfx.play("boost");
          await TP.sched.wait(0.6);
          for (let k = 0; k < 3; k++) await this.stepForward(player, true);
          await this.landOn(player, true);
          return;
        case "event":
          await this.runEvent(player);
          break;
      }
      await TP.sched.wait(0.9);
    }

    /* ---------- Event space surprises ---------- */
    async runEvent(player) {
      const rivals = this.players.filter((p) => p !== player);
      const events = [
        { title: "Sponsor deal!", run: () => this.addCoins(player, 8, "Sponsor deal! +8 coins") },
        { title: "Flat tyre!", run: () => this.addCoins(player, -5, "Flat tyre! −5 coins") },
        {
          title: "Pit-lane swap!",
          run: () => {
            // Swap board positions with a random rival.
            const other = pick(rivals);
            [player.space, other.space] = [other.space, player.space];
            this.parkToken(other.index);
            this.parkToken(player.index);
            TP.UI.toast(`Swapped places with ${other.name}!`);
            TP.sfx.play("boost");
          },
        },
        {
          title: "Toll booth!",
          run: () => {
            // Take up to 5 coins from the richest rival.
            const rich = rivals.slice().sort((a, b) => b.coins - a.coins)[0];
            const amt = Math.min(5, rich.coins);
            rich.coins -= amt;
            player.coins += amt;
            TP.UI.toast(`Took ${amt} coins from ${rich.name}!`);
            TP.sfx.play("coin");
            TP.UI.setPlayers(this.players, player.index);
          },
        },
      ];
      const ev = pick(events);
      TP.UI.center("? EVENT ?", ev.title, "#22d3a6");
      await TP.sched.wait(1.1);
      TP.UI.center("");
      ev.run();
    }

    /* ---------- Trophy purchase ---------- */
    async trophyStop(player) {
      if (player.coins < TROPHY_COST) {
        TP.UI.toast(`Trophy costs ${TROPHY_COST} coins — you have ${player.coins}`);
        await TP.sched.wait(0.9);
        return;
      }
      const yes = await this.choose(player, `Buy the trophy for ${TROPHY_COST} coins?`, ["Buy!", "Skip"], 0);
      if (yes !== 0) return;

      player.coins -= TROPHY_COST;
      player.trophies += 1;
      TP.sfx.play("trophy");
      TP.UI.center("🏆 TROPHY!", `${player.name} has ${player.trophies}`, "#ffcc33");
      TP.UI.setPlayers(this.players, player.index);
      await TP.sched.wait(1.6);
      TP.UI.center("");

      // Move the trophy at least 8 spaces away from where it was bought.
      const options = [];
      for (let i = 1; i < SPACE_COUNT; i++) {
        const d = Math.abs(i - player.space);
        if (Math.min(d, SPACE_COUNT - d) >= 8) options.push(i);
      }
      this.placeTrophy(pick(options));
      TP.UI.toast("The trophy moved!");
      const cam = this.camFocus.clone();
      this.camFocus.set(this.trophy.position.x, 0, this.trophy.position.z);
      await TP.sched.wait(1.4);
      this.camFocus.copy(cam);
      await TP.sched.wait(0.4);
    }

    /* Show a left/right choice and wait for the player to pick.
       Bots just take `botPick` after a short "thinking" pause. */
    async choose(player, title, options, botPick) {
      let sel = 0;
      TP.UI.choice(title, options, sel);
      if (player.controller === "bot") {
        await TP.sched.wait(0.9);
        sel = botPick;
        TP.UI.choice(title, options, sel);
        await TP.sched.wait(0.4);
      } else {
        const k = TP.keyNames(player.controller);
        TP.UI.hint(`<kbd>${k.steer}</kbd> choose · <kbd>${k.confirm}</kbd> confirm`);
        await TP.sched.until(() => {
          const c = TP.Input.get(player.controller);
          if (c.leftPressed) sel = (sel + options.length - 1) % options.length;
          if (c.rightPressed) sel = (sel + 1) % options.length;
          if (c.leftPressed || c.rightPressed) { TP.UI.choice(title, options, sel); TP.sfx.play("tick"); }
          return c.confirmPressed;
        });
        TP.UI.hint("");
      }
      TP.UI.choice(null);
      return sel;
    }

    dispose() { TP.disposeScene(this.scene); }
  }

  TP.Board = Board;
  TP.TROPHY_COST = TROPHY_COST;
})();
