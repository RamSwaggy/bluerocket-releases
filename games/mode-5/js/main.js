/* =====================================================================
   main.js — boots the mode: renderer, the main loop, starting matches,
   and the URL test hooks.

   URL options (add to the address, e.g. index.html?demo&speed=8):
     ?demo          4 bots, starts straight away (watch a match)
     ?speed=N       run N fixed physics steps every frame (fast-forward
                    for tests; the game always simulates in 1/60 s steps)
     ?time=30       round length in seconds
     ?rounds=N      best-of-N rounds (1, 3, 5)
     ?arena=N       first arena (they rotate each round)
     ?bot=hard      bot difficulty: easy / normal / hard

   Hand-off with Art and UI: if their files are loaded, main.js uses them
   and skips the stand-in versions at the bottom of this file:
     TP.M5.World  — new TP.M5.World(match, renderer) → { scene, camera,
                    update(dt), resize?(w, h), dispose?() }. It must add
                    match.root (the cars) to its scene and draw the floor
                    from match.grid (see paint.js for the cell arrays).
                    A new World is built for every match.
     TP.M5.HUD    — if present, the stand-in HUD below is not created.
     TP.M5.Menu   — if present and there's no ?demo, main.js doesn't
                    auto-start; the menu calls TP.M5.startMatch(config)
                    with { players, rounds, roundTime, arena, botLevel }.
   ===================================================================== */
(function () {
  "use strict";
  const CFG = TP.M5.CFG;
  const DT = 1 / 60;

  /* ---------- URL options ---------- */
  const params = new URLSearchParams(location.search);
  const DEMO = params.has("demo");
  const SPEED = Math.max(0, Math.floor(Number(params.get("speed")) || 0)); // 0 = real time
  const num = (k) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : null);
  if (num("time")) CFG.roundTime = Math.max(5, num("time"));
  if (num("rounds")) CFG.rounds = Math.max(1, Math.floor(num("rounds")));
  if (params.get("bot") && TP.M5.BOT_LEVELS[params.get("bot")]) CFG.botLevel = params.get("bot");

  /* ---------- Renderer ---------- */
  const canvas = document.getElementById("game");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  let match = null, world = null, hud = null;

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    if (world) {
      if (world.resize) world.resize(w, h);
      else { world.camera.aspect = w / h; world.camera.updateProjectionMatrix(); }
    }
  }
  window.addEventListener("resize", resize);

  /* ---------- Starting a match ----------
     config: { players: [{ name, controller }] × 4, rounds, roundTime,
               arena, botLevel }. Anything missing uses config.js. */
  TP.M5.startMatch = function (config = {}) {
    TP.sfx.unlock();
    TP.M5._lastConfig = config;
    if (world && world.dispose) world.dispose();
    if (match) match.dispose();

    match = new TP.M5.Match({
      players: config.players || seatsFromHub(),
      rounds: config.rounds || CFG.rounds,
      roundTime: config.roundTime || CFG.roundTime,
      arena: config.arena ?? num("arena") ?? 0,
      botLevel: config.botLevel || CFG.botLevel,
    });
    TP.M5.match = match; // read-only state for the HUD and QC's tests

    world = TP.M5.World ? new TP.M5.World(match, renderer) : new StandInWorld(match);
    if (!TP.M5.HUD && !hud) hud = new StandInHud();
    resize();
    return match;
  };
  TP.M5.restart = () => TP.M5.startMatch(TP.M5._lastConfig || {});

  /* Seats from the Rocket Rumble hub. This mode always has 4 cars, so an
     empty seat ("off") plays as a bot. ?demo makes every seat a bot. */
  function seatsFromHub() {
    return TP.Rumble.loadSetup().slots.map((s) => ({
      name: s.name,
      controller: DEMO || s.controller === "off" ? "bot" : s.controller,
    }));
  }

  /* ---------- Main loop ----------
     Physics always runs in fixed 1/60 s steps, so the game plays the same
     at any frame rate. In real time we run as many steps as the clock
     says are due (capped, so a background tab can't cause a long
     catch-up). With ?speed=N we run exactly N steps per frame. */
  let last = performance.now();
  let acc = 0;
  function frame(now) {
    const realDt = Math.min(0.1, (now - last) / 1000);
    last = now;
    TP.Input.poll();
    TP.sched.update(realDt);

    let simDt = 0;
    if (match) {
      let steps;
      if (SPEED) steps = SPEED;
      else { acc += realDt; steps = Math.min(5, Math.floor(acc / DT)); acc -= steps * DT; if (steps === 5) acc = 0; }
      for (let i = 0; i < steps; i++) match.step(DT);
      simDt = steps * DT;
    }
    if (world) {
      world.update(simDt || realDt);
      renderer.render(world.scene, world.camera);
    }
    if (hud) hud.update();
    requestAnimationFrame(frame);
  }

  // Browsers only allow sound after the player interacts with the page.
  const unlock = () => TP.sfx.unlock();
  window.addEventListener("keydown", unlock);
  window.addEventListener("pointerdown", unlock);


  /* =====================================================================
     Stand-in look (milestone 1 only). Art and UI's world.js / hud.js
     replace these. Kept deliberately plain: just enough to see and test
     the rules.
     ===================================================================== */
  class StandInWorld {
    constructor(m) {
      this.match = m;
      const half = m.arena.half;
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x080a14);
      TP.addStadiumLights(this.scene, half);
      this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 600);
      this.camera.position.set(0, 92, 66);
      this.camera.lookAt(0, 0, 4);
      this.scene.add(m.root);

      // Floor: one plane with the paint grid as its texture (one pixel
      // per cell). Texture row 0 is the far (+Z) edge after the plane is
      // laid flat, so rows are written flipped.
      const N = m.grid.N;
      this.pixels = new Uint8Array(N * N * 4);
      this.tex = new THREE.DataTexture(this.pixels, N, N, THREE.RGBAFormat);
      this.tex.magFilter = THREE.NearestFilter;
      this.tex.minFilter = THREE.NearestFilter;
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(half * 2, half * 2),
        new THREE.MeshStandardMaterial({ map: this.tex, roughness: 0.8 })
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      this.scene.add(floor);
      this._version = -1;
      this._builtFor = null;
      this.statics = new THREE.Group();
      this.scene.add(this.statics);
      this.pickupMeshes = new Map();
      this.colors = TP.PLAYER_COLORS.map((h) => new THREE.Color(h));
    }

    // Walls, pillars and ramps for the current arena.
    _buildStatics(A) {
      this.statics.clear();
      const mat = new THREE.MeshStandardMaterial({ color: 0x3a4170, roughness: 0.6 });
      for (const s of [-1, 1]) {
        const w1 = new THREE.Mesh(new THREE.BoxGeometry(A.size + 2, 2, 1), mat);
        w1.position.set(0, 1, s * (A.half + 0.5));
        const w2 = new THREE.Mesh(new THREE.BoxGeometry(1, 2, A.size), mat);
        w2.position.set(s * (A.half + 0.5), 1, 0);
        this.statics.add(w1, w2);
      }
      for (const p of A.pillars) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r, 8, 32), mat);
        m.position.set(p.x, 4, p.z);
        m.castShadow = true;
        this.statics.add(m);
      }
      for (const r of A.ramps) {
        // A wedge: a right triangle (length × height) pushed out to the width.
        const shape = new THREE.Shape();
        shape.moveTo(-r.L / 2, 0); shape.lineTo(r.L / 2, 0); shape.lineTo(r.L / 2, r.h); shape.closePath();
        const geo = new THREE.ExtrudeGeometry(shape, { depth: r.W, bevelEnabled: false });
        geo.translate(0, 0, -r.W / 2);
        const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x5b6496, roughness: 0.5 }));
        m.position.set(r.x, 0, r.z);
        m.rotation.y = Math.atan2(-r.fz, r.fx); // shape's +X → the ramp's climb direction
        m.castShadow = true;
        this.statics.add(m);
      }
    }

    update(dt) {
      const m = this.match, g = m.grid;
      if (this._builtFor !== m.arena.id) { this._builtFor = m.arena.id; this._buildStatics(m.arena); }

      // Re-colour the floor texture when the paint changed.
      if (g.version !== this._version) {
        this._version = g.version;
        const N = g.N, px = this.pixels;
        const pulse = 0.75 + 0.25 * Math.sin(performance.now() * 0.012);
        for (let j = 0; j < N; j++) {
          const row = (N - 1 - j) * N;
          for (let i = 0; i < N; i++) {
            const c = j * N + i, o = (row + i) * 4;
            let r = 30, gg = 34, b = 52;
            if (g.blocked[c]) { r = gg = b = 12; }
            else if (g.owner[c]) {
              const col = this.colors[g.owner[c] - 1];
              const k = g.wet[c] ? pulse * 255 : 150; // trails brighter
              r = col.r * k; gg = col.g * k; b = col.b * k;
              if (g.wet[c]) { r = Math.min(255, r + 60); gg = Math.min(255, gg + 60); b = Math.min(255, b + 60); }
            }
            px[o] = r; px[o + 1] = gg; px[o + 2] = b; px[o + 3] = 255;
          }
        }
        this.tex.needsUpdate = true;
        g.clearDirty();
      }

      // Pickups: a spinning box per pickup, coloured by kind.
      const live = new Set(m.pickups.map((p) => p.id));
      for (const [id, mesh] of this.pickupMeshes) if (!live.has(id)) { this.scene.remove(mesh); this.pickupMeshes.delete(id); }
      for (const p of m.pickups) {
        let mesh = this.pickupMeshes.get(p.id);
        if (!mesh) {
          const color = { bomb: 0xff4040, mega: 0xffffff, boost: 0xffcc33 }[p.kind];
          mesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), new THREE.MeshBasicMaterial({ color }));
          mesh.position.set(p.x, 1.2, p.z);
          this.scene.add(mesh);
          this.pickupMeshes.set(p.id, mesh);
        }
        mesh.rotation.y += dt * 3;
      }
    }

    dispose() { TP.disposeScene(this.scene); }
  }

  /* Stand-in HUD: timer, round and scores as text, plus a banner line
     for countdown / fills / pops / round results. Listens to events. */
  class StandInHud {
    constructor() {
      this.top = document.getElementById("hud");
      this.banner = document.getElementById("banner");
      this.bannerT = 0;
      const say = (text, sec = 1.5) => { this.banner.textContent = text; this.bannerT = performance.now() + sec * 1000; };
      const name = (i) => (match ? match.players[i].name : "P" + (i + 1));
      TP.M5.on("countdown", (e) => say(e.n ? String(e.n) : "GO!", 0.9));
      TP.M5.on("roundCountdown", (e) => say(`Round ${e.round}`, 1));
      TP.M5.on("overdrive", () => say("OVERDRIVE!", 2));
      TP.M5.on("fill", (e) => say(`${name(e.player)} FILL +${e.pct}%`, 1.2));
      TP.M5.on("pop", (e) => say(`${name(e.by)} popped ${name(e.victim)}!`, 1.2));
      TP.M5.on("hint", (e) => say(e.text, 2.5));
      TP.M5.on("roundEnd", (e) => say(e.winner >= 0 ? `${name(e.winner)} wins the round!` : "Draw!", 4));
      TP.M5.on("matchEnd", (e) => say(e.winner >= 0 ? `${name(e.winner)} WINS THE MATCH!` : "Match drawn!", 3600));
    }

    update() {
      if (!match || !this.top) return;
      const t = Math.ceil(match.timeLeft);
      const clock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
      this.top.innerHTML = `Round ${match.round}/${match.rounds} · ${clock}${match.overdrive ? " · OVERDRIVE" : ""}<br>` +
        match.players.map((p, i) => `<span style="color:${p.css}">${TP.M5.esc(p.name)} ${match.scores[i].toFixed(1)}% (${match.roundWins[i]})</span>`).join(" &nbsp; ");
      if (this.bannerT && performance.now() > this.bannerT) { this.banner.textContent = ""; this.bannerT = 0; }
    }
  }

  // Escape text for HTML (player names come from the hub's name boxes).
  TP.M5.esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  /* ---------- Go ----------
     (At the very end, so the stand-in classes above are defined first.)
     Start straight away in demo mode, or when there's no menu yet. */
  if (DEMO || !TP.M5.Menu) TP.M5.startMatch();
  resize();
  requestAnimationFrame(frame);
})();
