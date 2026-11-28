/* =====================================================================
   board.js — the party board: a looping track your car drives around,
   a risky shortcut across the middle, shops, a trophy to buy, dice rolls
   and space effects.

   The board is a small graph: every space lists the space(s) that come
   after it in `next`. Most spaces have one way forward. The fork space
   has two — the main road (passes the start line for a lap bonus) or the
   Risky Shortcut straight across the middle (much shorter, but full of
   red and event spaces).

   Space types:
     start  — where everyone begins. Passing it gives a +5 lap bonus.
     blue   — +3 coins
     red    — −3 coins
     boost  — zoom 3 more spaces
     event  — a random surprise (see runEvent)
     shop   — buy an item to use at the start of a later turn
   The trophy sits on one space. Drive onto or past it with 20+ coins
   and you can buy it (once per turn); then it moves at least 10 spaces
   further along the track.
   ===================================================================== */
(function () {
  "use strict";
  const { pick, randInt, shuffle, rand } = TP.util;

  const LOOP_COUNT = 30;      // spaces on the main loop
  const SHORTCUT_COUNT = 8;   // spaces on the risky shortcut
  const TROPHY_COST = 20;
  const TOKEN_SCALE = 0.55;   // cars are shrunk down on the board
  const STEP_TIME = 0.3;      // seconds to hop one space
  const MAX_ITEMS = 2;
  // After someone buys the trophy it moves at least this many spaces
  // ahead of them (counted along the track), so it can't just be re-bought.
  const MIN_TROPHY_AHEAD = 10;

  const SPACE_STYLE = {
    start: { color: 0xffffff, emissive: 0x666666 },
    blue: { color: 0x2f6bff, emissive: 0x0d2a7a },
    red: { color: 0xff3b3b, emissive: 0x6b0d0d },
    boost: { color: 0xffb020, emissive: 0x6b4300 },
    // Event is lime, not teal: from the overview camera teal read as "another blue".
    event: { color: 0x9be22d, emissive: 0x3a5c0a },
    shop: { color: 0xa855f7, emissive: 0x3d1466 },
  };

  /* ---------- Items sold at shops ----------
     Each is used at the start of a turn, before rolling. */
  const ITEMS = {
    double: { id: "double", name: "Double Dice", icon: "🎲", price: 5, desc: "Roll two dice and add them" },
    turbo: { id: "turbo", name: "Turbo Dice", icon: "⚡", price: 4, desc: "Roll is always 6–10" },
    steal: { id: "steal", name: "Pickpocket", icon: "🧲", price: 7, desc: "Steal 8 coins from the richest rival" },
    warp: { id: "warp", name: "Trophy Warp", icon: "🌀", price: 14, desc: "Teleport right next to the trophy" },
  };
  TP.ITEMS = ITEMS;

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
      this.fx = new TP.FX(this.scene);

      this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
      this.camFocus = new THREE.Vector3(0, 0, 0);       // where the camera looks
      this.camOffset = new THREE.Vector3(0, 62, 48);    // camera position relative to focus
      this.camera.position.copy(this.camFocus).add(this.camOffset);
      this.orbit = false; // menu background / intro slowly circles the board
      this.trophyBoughtThisTurn = false; // reset at the start of every turn

      this.buildTrack();
      this.buildDecor();
      this.buildTrophy();
      this.buildDie();

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
      this.addRoad(this.curve, true);

      /* ---------- Main loop space types ----------
         Start first, then a shuffled bag so the mix is fair but the
         order is different every game. */
      const n = LOOP_COUNT - 1;
      const counts = { shop: 2, boost: 4, event: 5, red: 6 };
      counts.blue = n - counts.shop - counts.boost - counts.event - counts.red;
      const bag = [];
      for (const [type, c] of Object.entries(counts)) for (let i = 0; i < c; i++) bag.push(type);
      const types = ["start", ...shuffle(bag)];
      // Tidy-ups: no boost right after a boost, and keep the two shops apart.
      for (let i = 1; i < types.length; i++) {
        const nx = types[(i + 1) % types.length];
        if (types[i] === "boost" && nx === "boost") types[i] = "blue";
        if (types[i] === "shop" && (nx === "shop" || types[i - 1] === "shop")) types[i] = "blue";
      }

      this.spaces = [];
      for (let i = 0; i < LOOP_COUNT; i++) {
        const t = i / LOOP_COUNT;
        this.addSpace(types[i], this.curve.getPointAt(t), this.curve.getTangentAt(t), [(i + 1) % LOOP_COUNT]);
      }

      /* ---------- The Risky Shortcut ----------
         Runs straight across the middle, from the loop's southern-most
         space (the fork) to its northern-most space (the merge). It
         skips about half the loop — including the start line's lap bonus. */
      const loop = this.spaces.slice(0, LOOP_COUNT);
      const fork = loop.reduce((a, b) => (b.pos.z < a.pos.z ? b : a));
      const merge = loop.reduce((a, b) => (b.pos.z > a.pos.z ? b : a));
      this.forkIndex = fork.index;
      this.mergeIndex = merge.index;

      const scCurve = new THREE.CatmullRomCurve3([
        fork.pos.clone(),
        new THREE.Vector3(fork.pos.x * 0.4, 0, fork.pos.z * 0.55),
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(merge.pos.x * 0.4, 0, merge.pos.z * 0.55),
        merge.pos.clone(),
      ]);
      this.addRoad(scCurve, false, 0x4a2333);

      const scTypes = ["red", "event", "red", "blue", "event", "red", "event", "red"];
      const firstSc = this.spaces.length;
      for (let k = 0; k < SHORTCUT_COUNT; k++) {
        const u = (k + 1) / (SHORTCUT_COUNT + 1);
        const last = k === SHORTCUT_COUNT - 1;
        this.addSpace(scTypes[k], scCurve.getPointAt(u), scCurve.getTangentAt(u), [last ? merge.index : firstSc + k + 1]);
        this.spaces[this.spaces.length - 1].shortcut = true;
      }
      // The fork now has two ways forward: [main road, shortcut].
      fork.next.push(firstSc);
      this.shortcutFirst = firstSc;

      // A sign post at the fork so people notice it.
      const sign = new THREE.Mesh(
        new THREE.BoxGeometry(2.6, 1.2, 0.2),
        new THREE.MeshBasicMaterial({ color: 0xff3b3b })
      );
      sign.position.set(fork.pos.x * 0.85, 2.4, fork.pos.z * 0.85);
      sign.lookAt(0, 2.4, 0);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.4, 8), new THREE.MeshStandardMaterial({ color: 0x888888 }));
      post.position.set(sign.position.x, 1.2, sign.position.z);
      this.scene.add(sign, post);
    }

    // Road ribbon underneath a row of spaces (a squashed tube).
    addRoad(curve, closed, color = 0x2a2f45) {
      const road = new THREE.Mesh(
        new THREE.TubeGeometry(curve, closed ? 400 : 120, 1.1, 8, closed),
        new THREE.MeshStandardMaterial({ color, roughness: 0.9 })
      );
      road.scale.y = 0.12;
      road.receiveShadow = true;
      this.scene.add(road);
    }

    addSpace(type, pos, tangent, next) {
      if (!this.discGeo) this.discGeo = new THREE.CylinderGeometry(1.9, 1.9, 0.35, 32);
      const style = SPACE_STYLE[type];
      const mesh = new THREE.Mesh(this.discGeo, new THREE.MeshStandardMaterial({
        color: style.color, emissive: style.emissive, emissiveIntensity: 0.8, roughness: 0.5,
      }));
      mesh.position.set(pos.x, 0.18, pos.z);
      mesh.receiveShadow = true;
      this.scene.add(mesh);

      // Small icon on top so spaces are readable without colour alone.
      const icon = this.makeIcon(type, tangent);
      if (icon) { icon.position.set(pos.x, 0, pos.z); this.scene.add(icon); }

      const space = { index: this.spaces.length, type, pos: pos.clone(), tangent: tangent.clone(), mesh, icon, next };
      this.spaces.push(space);
      return space;
    }

    // A simple 3D symbol per space type.
    makeIcon(type, tangent) {
      const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const g = new THREE.Group();
      if (type === "boost") {
        // Flat arrow pointing along the track.
        const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.4, 3), white);
        arrow.rotation.x = Math.PI / 2;
        arrow.scale.y = 0.25;
        arrow.position.y = 0.45;
        g.add(arrow);
        g.rotation.y = Math.atan2(tangent.x, tangent.z);
      } else if (type === "event") {
        // A big "?" painted flat on the disc, readable from the overview camera.
        // (A floating 3D symbol was tried, but from above it stacks on top of
        // the decal and makes the space harder to read, not easier.)
        g.add(this.flatDecal(this.decalTexture("event")));
      } else if (type === "shop") {
        // Same idea with a shopping bag, so shops never look like events.
        g.add(this.flatDecal(this.decalTexture("shop")));
      } else if (type === "start") {
        // Checkered stripe.
        for (let k = 0; k < 4; k++) {
          const sq = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.6),
            new THREE.MeshBasicMaterial({ color: k % 2 ? 0x111111 : 0xffffff }));
          sq.position.set((k - 1.5) * 0.6, 0.38, 0);
          g.add(sq);
        }
        g.rotation.y = Math.atan2(tangent.x, tangent.z) + Math.PI / 2;
      } else if (type === "blue" || type === "red") {
        // Plus or minus sign.
        const bar = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.05, 0.22), white);
        bar.position.y = 0.38;
        g.add(bar);
        if (type === "blue") {
          const bar2 = bar.clone();
          bar2.rotation.y = Math.PI / 2;
          g.add(bar2);
        }
      } else {
        return null;
      }
      return g;
    }

    /* ---------- Space decals ----------
       Event and shop symbols are drawn onto a small canvas once per board
       and shared by every space of that type. A flat picture on the disc
       reads far better from the high overview camera than a tiny 3D shape. */
    decalTexture(kind) {
      this._decals = this._decals || {};
      if (this._decals[kind]) return this._decals[kind];
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      const g = c.getContext("2d");
      g.fillStyle = "#ffffff";
      g.strokeStyle = "#ffffff";
      g.lineJoin = "round";
      if (kind === "event") {
        // A chunky question mark.
        g.font = "900 112px Segoe UI, system-ui, sans-serif";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText("?", 64, 70);
      } else {
        // Shopping bag: a rounded body with a loop handle on top.
        g.lineWidth = 10;
        g.beginPath();
        g.arc(64, 44, 20, Math.PI, 0);      // handle
        g.stroke();
        g.beginPath();
        g.moveTo(28, 44); g.lineTo(100, 44); // body: wider at the bottom
        g.lineTo(108, 112); g.lineTo(20, 112);
        g.closePath();
        g.fill();
      }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      this._decals[kind] = tex;
      return tex;
    }

    // The decal lying flat on top of a space disc.
    flatDecal(tex) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(2.4, 2.4),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.37; // just above the disc's top face (0.355)
      return m;
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

      // Two ball sculptures inside the loop, either side of the shortcut.
      this.balls = [];
      for (const x of [-18, 18]) {
        const ball = new THREE.Mesh(
          new THREE.IcosahedronGeometry(4, 1),
          new THREE.MeshStandardMaterial({ color: 0xdde4ff, flatShading: true, roughness: 0.4, emissive: 0x111833 })
        );
        ball.position.set(x, 4, 0);
        ball.castShadow = true;
        this.scene.add(ball);
        this.balls.push(ball);
      }

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
        const tree = new THREE.Mesh(new THREE.ConeGeometry(1.4, 4 + Math.random() * 2, 6), treeMat);
        tree.position.set(Math.cos(a) * 38 * r, 2.5, Math.sin(a) * 27 * r);
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
      // Everyone starts on space 0, so the first trophy uses the same
      // "far enough ahead" rule measured from the start line.
      this.placeTrophy(this.randomTrophySpot(0));
    }

    placeTrophy(index) {
      this.trophyIndex = index;
      const p = this.spaces[index].pos;
      this.trophy.position.set(p.x, 2.2, p.z);
    }

    /* How many hops forward it takes to reach every space from `fromIndex`,
       following the board's `next` links (so the fork's two ways are both
       explored). It's a breadth-first search, so each number is the
       SHORTEST forward route — the fewest spaces anyone starting here
       could drive to get there, whichever way they take at the fork.
       Returns an array: distances[spaceIndex] = hops (0 for fromIndex). */
    spacesAhead(fromIndex) {
      const dist = new Array(this.spaces.length).fill(Infinity);
      dist[fromIndex] = 0;
      const queue = [fromIndex];
      while (queue.length) {
        const i = queue.shift();
        for (const n of this.spaces[i].next) {
          if (dist[n] === Infinity) {
            dist[n] = dist[i] + 1;
            queue.push(n);
          }
        }
      }
      return dist;
    }

    /* Is the Risky Shortcut "directly ahead" of someone on `fromIndex`?
       True if they're already on it, or if the very next stretch of road
       they come to is the fork (they reach it in under MIN_TROPHY_AHEAD
       spaces). In both cases a trophy on the shortcut would be an easy
       grab, so the trophy isn't allowed to land there. */
    shortcutAhead(fromIndex) {
      if (this.spaces[fromIndex].shortcut) return true;
      return this.spacesAhead(fromIndex)[this.forkIndex] < MIN_TROPHY_AHEAD;
    }

    /* Where the trophy may move to, given the buyer is on `fromIndex`.
       Rules (the Director's ruling, approved by Reece):
         • at least MIN_TROPHY_AHEAD spaces ahead of the buyer, counted
           along the track by the shortest route (not straight-line
           distance — two spaces can be close on screen but far apart
           on the road, and vice versa);
         • never on the shortcut when the shortcut is directly ahead;
         • never on the start space or a shop (those have their own
           effects and it reads oddly to have the trophy there).
       Returns a list of space indices. */
    trophySpotsFrom(fromIndex) {
      const ahead = this.spacesAhead(fromIndex);
      const noShortcut = this.shortcutAhead(fromIndex);
      return this.spaces
        .filter((s) => s.type !== "start" && s.type !== "shop")
        .filter((s) => ahead[s.index] >= MIN_TROPHY_AHEAD && ahead[s.index] !== Infinity)
        .filter((s) => !(noShortcut && s.shortcut))
        .map((s) => s.index);
    }

    // Pick a random legal new spot for the trophy (see trophySpotsFrom).
    // The board is a 30-space loop, so there are always plenty of legal
    // spots; the fallback only exists so a future board edit can't crash.
    randomTrophySpot(fromIndex) {
      const ok = this.trophySpotsFrom(fromIndex);
      if (ok.length) return pick(ok);
      return pick(this.spaces.filter((s) => s.index !== fromIndex && s.type !== "start")).index;
    }

    /* ---------- The 3D die: a cube that floats above the active car ----------
       All six faces show the same number (drawn onto a canvas texture),
       so it reads clearly however it's spinning. */
    buildDie() {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      this.dieCanvas = canvas;
      this.dieTex = new THREE.CanvasTexture(canvas);
      this.dieTex.colorSpace = THREE.SRGBColorSpace;
      this.die = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshStandardMaterial({ map: this.dieTex, roughness: 0.35, emissive: 0x222222 })
      );
      this.die.castShadow = true;
      this.die.visible = false;
      this.scene.add(this.die);
      this.dieSpin = 0;
      this.setDie(1);
    }

    setDie(value, color = "#111") {
      const c = this.dieCanvas.getContext("2d");
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, 128, 128);
      c.strokeStyle = "#c9d1ea";
      c.lineWidth = 10;
      c.strokeRect(5, 5, 118, 118);
      c.fillStyle = color;
      c.font = "bold 84px Segoe UI, system-ui, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(String(value), 64, 70);
      this.dieTex.needsUpdate = true;
      this.dieValue = value;
    }

    /* ------------------------------------------------------------------
       Per-frame update: camera, spinning things, particles
       ------------------------------------------------------------------ */
    update(dt) {
      if (this.orbit) {
        // Slow circle for the title-screen background and the intro.
        const t = performance.now() * 0.00008;
        this.camera.position.set(Math.sin(t) * 70, 46, Math.cos(t) * 70);
        this.camera.lookAt(0, 0, 0);
        this._look = null;
      } else {
        // Smoothly glide toward the focus point.
        const target = this.camFocus.clone().add(this.camOffset);
        this.camera.position.x = TP.util.damp(this.camera.position.x, target.x, 3, dt);
        this.camera.position.y = TP.util.damp(this.camera.position.y, target.y, 3, dt);
        this.camera.position.z = TP.util.damp(this.camera.position.z, target.z, 3, dt);
        this._look = this._look || new THREE.Vector3(0, 0, 0);
        this._look.x = TP.util.damp(this._look.x, this.camFocus.x, 3, dt);
        this._look.y = TP.util.damp(this._look.y, this.camFocus.y, 3, dt);
        this._look.z = TP.util.damp(this._look.z, this.camFocus.z, 3, dt);
        this.camera.lookAt(this._look);
      }

      this.trophy.rotation.y += dt * 1.2;
      this.balls.forEach((b, i) => { b.rotation.y += dt * (i ? 0.15 : -0.15); });
      for (const s of this.spaces) {
        if (s.icon) s.icon.traverse((o) => { if (o.userData.spin) o.rotation.y += dt * 2; });
      }

      // Die floats above whoever owns it and tumbles while rolling.
      if (this.die.visible && this.dieOwner) {
        const p = this.tokens[this.dieOwner.index].pos;
        this.die.position.set(p.x, p.y + 4 + Math.sin(performance.now() * 0.004) * 0.2, p.z);
        this.die.rotation.x += this.dieSpin * dt;
        this.die.rotation.y += this.dieSpin * 1.3 * dt;
        // When it stops spinning, ease it to face the camera squarely.
        if (this.dieSpin === 0) {
          this.die.rotation.x = TP.util.damp(this.die.rotation.x, Math.round(this.die.rotation.x / (Math.PI / 2)) * (Math.PI / 2) - 0.35, 10, dt);
          this.die.rotation.y = TP.util.damp(this.die.rotation.y, Math.round(this.die.rotation.y / (Math.PI / 2)) * (Math.PI / 2), 10, dt);
        }
      }

      this.tokens.forEach((t) => t.syncMesh(dt));
      this.fx.update(dt);
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

    // Which space comes next? At the fork, the player decides.
    async pickNext(player) {
      const s = this.spaces[player.space];
      if (s.next.length === 1) return s.next[0];
      const choice = await this.choose(player, "Which way?", ["Main road", "Risky shortcut!"], this.botForkChoice(player));
      return s.next[choice];
    }

    /* Bots take the shortcut when the trophy is on it (or just past it)
       and they can afford it; avoid it when they're broke (red spaces
       hurt); otherwise it's a coin flip with a lean toward the main road. */
    botForkChoice(player) {
      const t = this.spaces[this.trophyIndex];
      const trophyOnShortcut = t.shortcut;
      const trophyNearMerge = t.pos.distanceTo(this.spaces[this.mergeIndex].pos) < 18 && !t.shortcut;
      if ((trophyOnShortcut || trophyNearMerge) && player.coins >= TROPHY_COST - 3) return 1;
      if (player.coins < 8) return 0;
      return Math.random() < 0.35 ? 1 : 0;
    }

    // Hop one space forward with a little jump arc.
    async stepForward(player, fast = false) {
      const tok = this.tokens[player.index];
      const from = tok.pos.clone();
      const next = await this.pickNext(player);
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
      player.stats.spacesMoved++;

      // Passing the start line pays a lap bonus.
      if (next === 0) {
        this.addCoins(player, 5, "Lap bonus! +5");
        await TP.sched.wait(0.5);
      }
      // Driving onto (or through) the trophy space → offer to buy.
      if (next === this.trophyIndex) await this.trophyStop(player);
    }

    /* ------------------------------------------------------------------
       One player's whole turn: (item) → roll → move → land
       ------------------------------------------------------------------ */
    async takeTurn(player) {
      const ui = TP.UI;
      const human = player.controller !== "bot";
      ui.setPlayers(this.players, player.index);
      this.focusOn(player);
      ui.center(`${player.name}'s turn`, "", player.css);
      await TP.sched.wait(0.9);
      ui.center("");
      // Fresh turn, so this player may buy the trophy again (max one per turn).
      this.trophyBoughtThisTurn = false;

      /* ---------- Use an item? ---------- */
      let rollMode = "normal";
      if (player.items.length) {
        // Items that would do nothing right now are shown greyed out with the
        // reason, and humans can't pick them (see itemUnusable).
        const labels = ["Just roll", ...player.items.map((id) => {
          const why = this.itemUnusable(player, id);
          return why
            ? { label: `${ITEMS[id].icon} ${ITEMS[id].name}`, disabled: why }
            : `${ITEMS[id].icon} ${ITEMS[id].name}`;
        })];
        const pickIdx = await this.choose(player, "Use an item?", labels, this.botItemChoice(player));
        if (pickIdx > 0) {
          const id = player.items.splice(pickIdx - 1, 1)[0];
          ui.setPlayers(this.players, player.index);
          rollMode = await this.useItem(player, id);
        }
      }

      /* ---------- Roll ---------- */
      let total = await this.rollDie(player, human, rollMode === "turbo" ? 6 : 1);
      if (rollMode === "double") {
        ui.toast(`First die: ${total}. Roll again!`);
        await TP.sched.wait(0.5);
        total += await this.rollDie(player, human, 1);
        ui.toast(`Total: ${total}!`);
        this.setDie(total, "#d97706");
        await TP.sched.wait(0.6);
      }

      /* ---------- Move ---------- */
      for (let left = total; left > 0; left--) {
        await this.stepForward(player);
        this.setDie(left - 1);
      }
      this.die.visible = false;

      /* ---------- Land ---------- */
      await this.landOn(player);
      this.parkToken(player.index);
      ui.setPlayers(this.players, player.index);
      await TP.sched.wait(0.5);
    }

    /* Spin the die above the car until the player (or bot) stops it.
       Returns the result. `min` lets Turbo Dice skip the low numbers. */
    async rollDie(player, human, min) {
      const ui = TP.UI;
      this.dieOwner = player;
      this.die.visible = true;
      this.dieSpin = 9;
      let value = randInt(min, 10);
      let flick = 0, elapsed = 0;
      if (human) ui.hint(`<span style="color:${player.css}">${ui.esc(player.name)}</span>: press <kbd>${TP.keyNames(player.controller).confirm}</kbd> to hit the die`);
      await TP.sched.run((dt) => {
        elapsed += dt;
        flick += dt;
        if (flick > 0.07) {
          flick = 0;
          value = value >= 10 ? min : value + 1;
          this.setDie(value);
          TP.sfx.play("tick");
        }
        return human ? TP.Input.get(player.controller).confirmPressed : elapsed > 1.0;
      });
      ui.hint("");

      // The car hops up and bonks the die. The result is random, not
      // whatever was showing, so you can't time it.
      const tok = this.tokens[player.index];
      const y0 = tok.pos.y;
      await TP.sched.tween(0.22, (k) => { tok.pos.y = y0 + Math.sin(k * Math.PI) * 2.2; });
      tok.pos.y = y0;
      value = randInt(min, 10);
      this.dieSpin = 0;
      this.setDie(value, "#2f6bff");
      this.fx.burst(this.die.position, [0xffffff, 0xffcc33, player.color], { count: 18, speed: 7, up: 1, gravity: 10 });
      TP.sfx.play("coin");
      await TP.sched.wait(0.6);
      return value;
    }

    /* ---------- Bot item strategy ----------
       Shared by the shop and the "use an item?" choice. The question is
       always the same: how far is the trophy, and can I afford it when I
       get there? Rolls are 1–10 (average 5.5), Turbo Dice 6–10, Double
       Dice 2–20 (average 11), and Trophy Warp puts you on the space just
       before the trophy, so your first step reaches it. */

    // Spaces from `fromIndex` to the trophy by the shortest forward route.
    trophyDistance(fromIndex) {
      return this.spacesAhead(fromIndex)[this.trophyIndex];
    }

    // The richest rival, and by how many coins they lead `player`.
    richestRival(player) {
      const rich = this.players.filter((p) => p !== player).sort((a, b) => b.coins - a.coins)[0];
      return { rich, lead: rich.coins - player.coins };
    }

    /* Which items would a bot standing on `fromIndex` with `coins` want
       to use next, most useful first? Each bot has a little random
       "temperament" (see botMood) so they don't all play identically.
         warp   — can afford the trophy but it's out of a normal roll's
                  reach (more than ~10 spaces): jump straight to it
         turbo  — can afford it and it's 6–10 ahead: a roll of 6–10
                  gives a good chance of getting there this turn
         double — can afford it and it's 11–20 ahead: two dice average 11
         steal  — a rival is clearly richer: take 8 off them (helps the
                  trailing bots catch up, and slows the leader) */
    botItemWants(player, fromIndex, coins) {
      const mood = this.botMood(player);
      const d = this.trophyDistance(fromIndex);
      const canBuy = coins >= TROPHY_COST;
      const wants = [];
      if (canBuy && d > 10 + mood.reach) wants.push("warp");
      if (canBuy && d >= 6 && d <= 10) wants.push("turbo");
      if (canBuy && d > 10 && d <= 20) wants.push("double");
      if (this.richestRival(player).lead >= mood.envy) wants.push("steal");
      return wants;
    }

    /* Per-bot temperament, rolled once per match:
         reach — how far past 10 spaces before Warp feels worth it (0–3)
         envy  — how big a rival's lead must be before Pickpocket (8–14)
         thrift — extra coins kept in hand on top of the trophy price
                  before spending on an item (0–4)
         whim  — chance of an off-plan pick at the shop (10–25%) */
    botMood(player) {
      if (!player.mood) {
        player.mood = { reach: randInt(0, 3), envy: randInt(8, 14), thrift: randInt(0, 4), whim: rand(0.1, 0.25) };
      }
      return player.mood;
    }

    /* Start of turn: which held item (if any) should a bot use? Returns a
       menu index (0 = "Just roll", 1+ = player.items[index-1]). Never
       picks an item the menu greys out (see itemUnusable). */
    botItemChoice(player) {
      const usable = (id) => !this.itemUnusable(player, id);
      // Use the most useful held item that fits the situation right now.
      for (const id of this.botItemWants(player, player.space, player.coins)) {
        const i = player.items.indexOf(id);
        if (i >= 0 && usable(id)) return i + 1;
      }
      // Both slots full and nothing fits: use a movement item anyway so
      // the slot frees up for something better (never waste a Warp).
      if (player.items.length >= MAX_ITEMS) {
        const i = player.items.findIndex((id) => id !== "warp" && usable(id));
        if (i >= 0) return i + 1;
      }
      return 0;
    }

    /* Why an item can't usefully be used right now, or "" if it can.
       Shown as the greyed-out reason in the "Use an item?" menu. */
    itemUnusable(player, id) {
      if (id === "steal") {
        // Pickpocket takes from the richest rival; pointless if they're all broke.
        const anyCoins = this.players.some((p) => p !== player && p.coins > 0);
        if (!anyCoins) return "rivals are broke";
      }
      if (id === "warp") {
        // Warp drops you on the space just before the trophy: no use if you're already there.
        const before = this.spaces.find((s) => s.next.includes(this.trophyIndex));
        if (before && before.index === player.space) return "already there";
      }
      return "";
    }

    // Apply an item. Returns a roll mode for the dice ("normal"/"double"/"turbo").
    async useItem(player, id) {
      const ui = TP.UI;
      const item = ITEMS[id];
      ui.center(`${item.icon} ${item.name}!`, item.desc, "#a855f7");
      TP.sfx.play("boost");
      await TP.sched.wait(1.1);
      ui.center("");
      if (id === "double" || id === "turbo") return id;

      if (id === "steal") {
        const rich = this.players.filter((p) => p !== player).sort((a, b) => b.coins - a.coins)[0];
        const amt = Math.min(8, rich.coins);
        rich.coins -= amt;
        player.coins += amt;
        player.stats.coinsEarned += amt;
        ui.toast(`Pickpocketed ${amt} coins from ${rich.name}!`);
        this.fx.burst(this.tokens[rich.index].pos, 0xffcc33, { count: amt * 2 });
        TP.sfx.play("coin");
        ui.setPlayers(this.players, player.index);
        await TP.sched.wait(1);
      }

      if (id === "warp") {
        // Fly up, jump to the space just before the trophy, drop back down.
        const tok = this.tokens[player.index];
        const before = this.spaces.find((s) => s.next.includes(this.trophyIndex));
        const y0 = 0.36;
        this.fx.burst(tok.pos, 0xa855f7, { count: 24 });
        await TP.sched.tween(0.5, (k) => { tok.pos.y = y0 + k * 25; });
        player.space = before.index;
        this.parkToken(player.index);
        tok.pos.y = 25;
        this.focusOn(player);
        await TP.sched.wait(0.4);
        await TP.sched.tween(0.5, (k) => { tok.pos.y = 25 - TP.ease.outCubic(k) * (25 - y0); });
        this.fx.burst(tok.pos, 0xa855f7, { count: 24 });
        TP.sfx.play("bump");
        await TP.sched.wait(0.4);
      }
      return "normal";
    }

    addCoins(player, amount, label) {
      const before = player.coins;
      player.coins = Math.max(0, player.coins + amount);
      const change = player.coins - before;
      if (change > 0) player.stats.coinsEarned += change;
      TP.UI.toast(label || (amount >= 0 ? `+${amount} coins` : `${amount} coins`));
      TP.sfx.play(amount >= 0 ? "coin" : "lose");
      const pos = this.tokens[player.index].pos;
      if (amount > 0) this.fx.burst(pos, 0xffcc33, { count: 6 + amount, speed: 6 });
      TP.UI.setPlayers(this.players, player.index);
      return change;
    }

    async landOn(player, fromBoost = false) {
      const s = this.spaces[player.space];
      // Flash the landed space and spray particles in its colour.
      s.mesh.material.emissiveIntensity = 2.5;
      TP.sched.wait(0.5).then(() => { s.mesh.material.emissiveIntensity = 0.8; });
      this.fx.burst(s.pos, SPACE_STYLE[s.type].color, { count: 14, speed: 5, size: 0.22 });

      switch (s.type) {
        case "start":
          // Same payout as a blue space, but its own wording.
          this.addCoins(player, 3, "Start line! +3 coins");
          break;
        case "blue":
          this.addCoins(player, 3, "Blue space! +3 coins");
          break;
        case "red":
          player.stats.redSpaces++;
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
        case "shop":
          await this.runShop(player);
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
          run: async () => {
            // Swap board positions with a random rival.
            const other = pick(rivals);
            [player.space, other.space] = [other.space, player.space];
            this.parkToken(other.index);
            this.parkToken(player.index);
            this.fx.burst(this.tokens[player.index].pos, SPACE_STYLE.event.color, { count: 16 });
            this.fx.burst(this.tokens[other.index].pos, SPACE_STYLE.event.color, { count: 16 });
            TP.UI.toast(`Swapped places with ${other.name}!`);
            TP.sfx.play("boost");
            // Landed on the trophy by swapping? Offer it as if you'd driven
            // there. (Only the player whose turn it is gets the offer; the
            // rival swapped away is just along for the ride.)
            if (player.space === this.trophyIndex) {
              await TP.sched.wait(0.8);
              await this.trophyStop(player);
            }
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
            player.stats.coinsEarned += amt;
            TP.UI.toast(`Took ${amt} coins from ${rich.name}!`);
            TP.sfx.play("coin");
            TP.UI.setPlayers(this.players, player.index);
          },
        },
      ];
      const ev = pick(events);
      TP.UI.center("? EVENT ?", ev.title, "#9be22d");
      await TP.sched.wait(1.1);
      TP.UI.center("");
      await ev.run(); // some events (pit-lane swap) can pause for a trophy offer
    }

    /* ---------- Shop: buy one item ---------- */
    async runShop(player) {
      const ui = TP.UI;
      if (player.items.length >= MAX_ITEMS) {
        ui.toast(`Shop: your item slots are full (${MAX_ITEMS} max)`);
        return;
      }
      const stock = Object.values(ITEMS);
      // Items you can't afford are greyed out with what they cost, and humans
      // can't select them. "Leave" is always available.
      const labels = ["Leave", ...stock.map((it) => player.coins >= it.price
        ? `${it.icon} ${it.name} · ${it.price}🪙`
        : { label: `${it.icon} ${it.name}`, disabled: `need ${it.price}🪙` })];
      ui.center("SHOP", "Items are used at the start of your turn", "#a855f7");
      const choice = await this.choose(player, `Buy something? You have ${player.coins} coins`, labels, this.botShopChoice(player, stock));
      ui.center("");
      if (choice === 0) return;
      const item = stock[choice - 1];
      if (player.coins < item.price) {
        ui.toast(`Not enough coins for ${item.name}`);
        TP.sfx.play("lose");
        return;
      }
      player.coins -= item.price;
      player.items.push(item.id);
      ui.toast(`Bought ${item.icon} ${item.name}!`);
      TP.sfx.play("coin");
      ui.setPlayers(this.players, player.index);
    }

    /* Shop: which item (if any) should a bot buy? Returns a menu index
       (0 = "Leave", 1+ = stock[index-1]).
       The bot is standing where its NEXT turn starts, so the trophy
       distance from here is exactly what that item will face.
       Rules of thumb:
         • Movement items only matter once you can afford the trophy, so
           a bot buys one only if it can pay for it AND still have the
           trophy price left over (plus its own "thrift" margin). Warp is
           the exception: a bot within 4 coins of that is allowed to buy
           it, since the next minigame usually tops it up.
         • Pickpocket is bought when a rival is clearly richer.
         • Never buy a second copy of an item already held.
         • Now and then (the bot's "whim") pick any sensible item at random
           instead of the best one, so bots don't all behave the same. */
    botShopChoice(player, stock) {
      const mood = this.botMood(player);
      const coins = player.coins;
      const price = (id) => ITEMS[id].price;
      const affordable = (id) => {
        if (player.items.includes(id) || coins < price(id)) return false;
        if (id === "steal") return true; // it pays for itself (up to +8)
        const margin = id === "warp" ? -4 : mood.thrift;
        return coins - price(id) >= TROPHY_COST + margin;
      };
      // What would we want next turn if we had the coins left over after
      // buying? (Judge movement items as if we can afford the trophy.)
      const wants = this.botItemWants(player, player.space, Math.max(coins, TROPHY_COST))
        .filter(affordable);
      let id = wants[0];
      if (wants.length > 1 && Math.random() < mood.whim) id = pick(wants);
      // Nothing fits but we're comfortably rich: a Double Dice is never
      // a bad thing to hold (it gets used when the trophy's 11–20 away).
      if (!id && affordable("double") && coins >= TROPHY_COST + 10) id = "double";
      return id ? stock.findIndex((it) => it.id === id) + 1 : 0;
    }

    /* ---------- Trophy purchase ---------- */
    async trophyStop(player) {
      // One trophy per turn. Even with the trophy moving 10+ spaces away,
      // a big roll (Double Dice goes up to 20, plus a boost pad's 3) could
      // carry you onto it again before your turn ends.
      if (this.trophyBoughtThisTurn) {
        TP.UI.toast("Only one trophy per turn — come back next time!");
        await TP.sched.wait(0.9);
        return;
      }
      if (player.coins < TROPHY_COST) {
        TP.UI.toast(`Trophy costs ${TROPHY_COST} coins — you have ${player.coins}`);
        await TP.sched.wait(0.9);
        return;
      }
      const yes = await this.choose(player, `Buy the trophy for ${TROPHY_COST} coins?`, ["Buy!", "Skip"], 0);
      if (yes !== 0) return;

      player.coins -= TROPHY_COST;
      player.trophies += 1;
      this.trophyBoughtThisTurn = true;
      TP.sfx.play("trophy");
      this.fx.confetti(this.trophy.position);
      TP.UI.center("🏆 TROPHY!", `${player.name} has ${player.trophies}`, "#ffcc33");
      TP.UI.setPlayers(this.players, player.index);
      await TP.sched.wait(1.6);
      TP.UI.center("");

      // Move the trophy at least 10 spaces ahead of the buyer (see
      // trophySpotsFrom for the full rules), and show where it went.
      this.placeTrophy(this.randomTrophySpot(player.space));
      TP.UI.toast("The trophy moved!");
      const cam = this.camFocus.clone();
      this.camFocus.set(this.trophy.position.x, 0, this.trophy.position.z);
      this.fx.burst(this.trophy.position, 0xffcc33, { count: 20 });
      await TP.sched.wait(1.4);
      this.camFocus.copy(cam);
      await TP.sched.wait(0.4);
    }

    /* Show a left/right choice and wait for the player to pick.
       Bots just take `botPick` after a short "thinking" pause.

       Each option is either a plain string, or { label, disabled } where
       `disabled` is a short reason ("need 14🪙"). Disabled options are drawn
       greyed out with their reason, and left/right skips straight over them,
       so a human can only ever confirm an enabled option. The first option
       (Leave / Skip / Just roll) should always be enabled. */
    async choose(player, title, options, botPick) {
      const off = (i) => typeof options[i] === "object" && !!options[i].disabled;
      // Step from `from` in direction `dir` (+1 / -1) to the next enabled
      // option, wrapping around. If somehow nothing else is enabled, stay put.
      const step = (from, dir) => {
        for (let n = 1; n <= options.length; n++) {
          const i = (from + dir * n + options.length * n) % options.length;
          if (!off(i)) return i;
        }
        return from;
      };
      let sel = off(0) ? step(0, 1) : 0;
      TP.UI.choice(title, options, sel);
      if (player.controller === "bot") {
        await TP.sched.wait(0.8);
        sel = botPick; // bot logic is unchanged; it already avoids unaffordable picks
        TP.UI.choice(title, options, sel);
        await TP.sched.wait(0.5);
      } else {
        const k = TP.keyNames(player.controller);
        TP.UI.hint(`<kbd>${k.steer}</kbd> choose · <kbd>${k.confirm}</kbd> confirm`);
        await TP.sched.until(() => {
          const c = TP.Input.get(player.controller);
          const before = sel;
          if (c.leftPressed) sel = step(sel, -1);
          if (c.rightPressed) sel = step(sel, 1);
          if (sel !== before) { TP.UI.choice(title, options, sel); TP.sfx.play("tick"); }
          return c.confirmPressed && !off(sel);
        });
        TP.UI.hint("");
      }
      TP.UI.choice(null);
      return sel;
    }

    dispose() {
      this.fx.dispose();
      TP.disposeScene(this.scene);
    }
  }

  TP.Board = Board;
  TP.TROPHY_COST = TROPHY_COST;
})();
