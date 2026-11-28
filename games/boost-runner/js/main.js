/* =====================================================================
   main.js — starts Boost Runner: renderer, main loop, menu, and the
   glue that turns game events into effects, sounds and HUD changes.

   Who does what:
     • Gameplay's logic runs the match (cars, course, view rectangle,
       KOs, rounds). We only read its state and its events.
     • This file draws it: scene.js (the look), camera.js (fits the
       view rectangle to the screen), fx-br.js (particles), hud.js (all
       text), music.js (track + mode sounds).

   URL options (add to the address, e.g. index.html?demo&rounds=2):
     ?demo          skip the menu: all bots, start straight away
     &rounds=N      round wins needed to take the match (default 3)
     &bots=2..4     how many cars in a demo (default 4)
     &speed=X       run game time X times faster (testing)
     &seed=S        course / bot seed
     &chunk=<id>    loop one course chunk (passed to the logic)
     &norender      run without drawing (headless checks)
   ===================================================================== */
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const SPEED = Math.max(0.1, Number(params.get("speed")) || 1);
  const NORENDER = params.has("norender");
  const BG = 0x070b1a; // letterbox bars, same as the page background

  /* ---------- The one place that creates a match ----------
     Everything else in this file talks to the match only through the
     shape below, so switching from the temporary stub to Gameplay's real
     logic means changing just this function. */
  function createMatch(cfg) {
    return TP.BRStub.createMatch(cfg);
  }

  /* ---------- Renderer, look, camera, effects ---------- */
  const canvas = document.getElementById("game");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const look = new TP.BRScene();
  const cam = new TP.BRCamera();
  look.attachCamera(cam.camera);
  const fx = new TP.BRFX(look.scene);

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    cam.resize(window.innerWidth, window.innerHeight, cam.aspect);
    TP.BRHud.setStage(cam.viewport);
  }
  window.addEventListener("resize", resize);
  resize();

  /* ---------- App state ---------- */
  const app = {
    match: null,      // the running match (real or attract-mode)
    config: null,     // last match settings, for Rematch
    attract: false,   // true = bots racing quietly behind the menu
    players: [],      // [{ seat, name, color, css, controller }]
    freeze: 0,        // seconds of KO hit-stop left (real time)
    slowmo: 0,        // seconds of round-end slow motion left (real time)
    cardTimer: 0,     // seconds until the round card appears
    pendingCard: null,
    beepTimer: 0,
    muted: false,
  };
  TP.brApp = app; // handy in the browser console

  /* ---------- Start a match ----------
     config: { slots: [{ name, controller }] (4), roundsToWin, seed,
               difficulty, carCount } */
  function startMatch(config, attract = false) {
    if (app.match) app.match.dispose();
    fx.clear();
    if (!attract) TP.BRHud.hideCard(); // (the menu card stays up over attract mode)
    TP.BRHud.center("");
    app.config = config;
    app.attract = attract;
    app.freeze = app.slowmo = app.cardTimer = 0;
    app.pendingCard = null;

    const count = TP.util.clamp(config.carCount || 4, 2, 4);
    app.players = config.slots.slice(0, count).map((s, seat) => ({
      seat,
      name: s.name || TP.DEFAULT_NAMES[seat],
      color: TP.PLAYER_COLORS[seat],
      css: TP.PLAYER_CSS[seat],
      // Empty seats ("off") are played by bots, as the design says.
      controller: s.controller === "off" ? "bot" : s.controller,
    }));
    app.match = createMatch({
      scene: look.scene,
      players: app.players,
      roundsToWin: config.roundsToWin || 3,
      seed: config.seed ?? Math.floor(Math.random() * 1e6),
      difficulty: config.difficulty || "normal",
      chunk: params.get("chunk") || null,
    });
    TP.BRHud.setup(app.players, config.roundsToWin || 3);
    TP.BRHud.show(!attract);
    TP.BRHud.round(attract ? 0 : app.match.round);
    if (!attract) {
      TP.sfx.music(true, "boost-runner");
      const humans = app.players.filter((p) => p.controller !== "bot");
      TP.BRHud.toast(humans.length ? "Jump: Space / Enter / A · Boost: Shift / B" : "Demo: bots only", 2.5);
    }
  }

  /* ---------- Game events → effects, sound, HUD ---------- */
  const isHuman = (seat) => app.players[seat] && app.players[seat].controller !== "bot";
  const loud = () => !app.attract;

  function handleEvent(e) {
    const m = app.match;
    switch (e.type) {
      case "round_start":
        fx.clear();
        if (!app.attract) TP.BRHud.hideCard();
        TP.BRHud.round(app.attract ? 0 : e.round);
        break;
      case "countdown":
        if (!app.attract) { TP.BRHud.countdown(e.n); TP.sfx.play("count"); }
        break;
      case "go":
        if (!app.attract) { TP.BRHud.go(); TP.sfx.play("go"); }
        break;
      case "jump":
        if (loud() && isHuman(e.seat)) TP.BRSound.play(e.double ? "djump" : "jump");
        break;
      case "land":
        fx.dust(e.x, e.y);
        if (loud() && isHuman(e.seat)) TP.BRSound.play("land");
        break;
      case "bump":
        fx.spark(e.x, e.y, e.strength ?? 0.5);
        cam.shake(0.15 + 0.2 * (e.strength ?? 0.5));
        if (loud()) TP.sfx.play("bump");
        break;
      case "ko": {
        // Explode where the car left the picture: clamp to just inside
        // the view so you always see it.
        const v = m.view;
        const x = TP.util.clamp(e.x, v.left + 1.5, v.right - 1.5);
        const y = TP.util.clamp(e.y, v.bottom + 1.5, v.top - 1.5);
        fx.ko(x, y, app.players[e.seat].color);
        cam.shake(0.55);
        app.freeze = 0.08; // 80 ms hit-stop
        if (loud()) TP.sfx.play("ko");
        break;
      }
      case "round_end":
        // Slow motion on the last car, then the round card.
        app.slowmo = 1.2;
        app.cardTimer = 1.2;
        app.pendingCard = { winner: e.winner, round: e.round, koOrder: e.koOrder, wins: e.wins };
        if (loud()) TP.BRSound.play("roundWin");
        break;
      case "match_end": {
        app.pendingCard = null;
        if (app.attract) { startMatch(app.config, true); break; } // attract mode just loops
        const winner = m.cars.find((c) => c.seat === e.winner);
        if (winner) fx.confetti(new THREE.Vector3(winner.pos.x, winner.pos.y + 1, 0));
        TP.BRSound.play("matchWin");
        TP.BRHud.matchCard({ winner: e.winner, wins: e.wins }, {
          rematch: () => startMatch(app.config),
          menu: () => showMenu(),
        });
        break;
      }
    }
  }

  /* ---------- Main loop ---------- */
  let last = performance.now();
  function frame(now) {
    const realDt = Math.min(0.05, (now - last) / 1000);
    last = now;
    TP.Input.poll();
    if (TP.sched) TP.sched.update(realDt);

    const m = app.match;
    if (m) {
      // Time scale: freeze for KO hit-stop, slow motion at round end.
      let scale = SPEED;
      if (app.freeze > 0) { app.freeze -= realDt; scale = 0; }
      else if (app.slowmo > 0) { app.slowmo -= realDt; scale *= 0.3; }
      const dt = realDt * scale;

      // Controls for human seats (bots are driven by the logic itself).
      const controls = {};
      for (const p of app.players) if (p.controller !== "bot") controls[p.seat] = TP.Input.get(p.controller);
      if (!app.attract || m.state !== "match_end") m.update(dt, controls);
      for (const e of m.drainEvents()) handleEvent(e);

      // Round card appears once the slow motion is over.
      if (app.pendingCard && (app.cardTimer -= realDt) <= 0) {
        if (!app.attract) TP.BRHud.roundCard(app.pendingCard);
        app.pendingCard = null;
      }

      // Visuals.
      look.setCourse(m.course);
      for (const c of m.cars) if (c.alive && c.boosting) fx.trail(c, app.players[c.seat].color, dt);
      fx.update(dt);
      cam.fit(m.view, realDt);
      look.update(dt, m.view, cam.camera);
      TP.BRHud.setStage(cam.viewport);

      if (!app.attract) {
        const danger = TP.BRHud.update(m.cars, m.wins, cam);
        // Rising warning beep: faster and higher the deeper a car is in.
        if (danger > 0 && m.state === "race") {
          app.beepTimer -= realDt;
          if (app.beepTimer <= 0) { TP.BRSound.play("danger", danger); app.beepTimer = 0.32 - danger * 0.2; }
        } else app.beepTimer = 0;
      }
    }

    if (!NORENDER) draw();
    requestAnimationFrame(frame);
  }

  // Clear the whole window to the background colour, then draw the
  // picture into the letterbox area only.
  function draw() {
    const W = window.innerWidth, H = window.innerHeight, vp = cam.viewport;
    renderer.setScissorTest(true);
    renderer.setViewport(0, 0, W, H);
    renderer.setScissor(0, 0, W, H);
    renderer.setClearColor(BG, 1);
    renderer.clear();
    // WebGL measures y from the bottom of the canvas.
    const y = H - vp.y - vp.h;
    renderer.setViewport(vp.x, y, vp.w, vp.h);
    renderer.setScissor(vp.x, y, vp.w, vp.h);
    renderer.render(look.scene, cam.camera);
  }

  /* ---------- Title / setup menu ---------- */
  function showMenu() {
    // Bots race quietly behind the menu.
    startMatch({ slots: TP.DEFAULT_NAMES.map((name) => ({ name, controller: "bot" })), roundsToWin: 99, carCount: 4 }, true);
    TP.sfx.music(false);

    const setup = TP.Rumble.loadSetup();
    const CONTROLLERS = ["off", ...TP.CONTROLLER_IDS];
    const LABEL = (id) => (id === "off" ? "Empty seat (bot)" : TP.CONTROLLER_LABELS[id]);
    const esc = TP.BRHud.esc;

    const card = TP.BRHud.card(`
      <h1><span class="a">BOOST</span> RUNNER</h1>
      <p>Everyone races on one screen. The camera follows the leader. Fall behind the
         edge or drop off the bottom and you're out. Last car on screen takes the round.</p>

      <div class="slots">
        ${setup.slots.map((s, i) => `
          <div class="slot" style="border-color:${TP.PLAYER_CSS[i]}">
            <label for="n${i}">Player ${i + 1}</label>
            <input id="n${i}" maxlength="12" value="${esc(s.name)}" aria-label="Player ${i + 1} name" />
            <select id="c${i}" aria-label="Player ${i + 1} controller">
              ${CONTROLLERS.map((id) => `<option value="${id}" ${id === s.controller ? "selected" : ""}>${LABEL(id)}</option>`).join("")}
            </select>
          </div>`).join("")}
      </div>

      <div class="row">
        <label class="muted" for="rounds">First to</label>
        <select id="rounds">
          <option value="2">2 wins</option>
          <option value="3" selected>3 wins</option>
          <option value="5">5 wins</option>
        </select>
        <label class="muted" for="diff">Bots</label>
        <select id="diff">
          <option value="easy">Easy</option>
          <option value="normal" selected>Normal</option>
          <option value="hard">Hard</option>
        </select>
        <span class="muted small" id="padinfo"></span>
      </div>

      <table class="keys">
        <tr><td>Keyboard 1</td><td>Drive <kbd>D</kbd>/<kbd>A</kbd> · Tilt <kbd>W</kbd><kbd>S</kbd> · Jump <kbd>Space</kbd> (twice = double) · Boost <kbd>Shift</kbd> · Dash <kbd>E</kbd></td></tr>
        <tr><td>Keyboard 2</td><td>Drive <kbd>→</kbd>/<kbd>←</kbd> · Tilt <kbd>↑</kbd><kbd>↓</kbd> · Jump <kbd>Enter</kbd> · Boost <kbd>R-Shift</kbd> · Dash <kbd>.</kbd></td></tr>
        <tr><td>Gamepad</td><td>Drive stick / <kbd>RT</kbd><kbd>LT</kbd> · Tilt stick up/down · Jump <kbd>A</kbd> · Boost <kbd>B</kbd> · Dash <kbd>X</kbd></td></tr>
      </table>
      <p class="small">Tip: in the air, tilt the nose up and boost to fly over gaps. Press <kbd>M</kbd> to mute.</p>

      <div class="row" style="margin-top:14px">
        <a class="link" href="${TP.Rumble.HUB_URL}">← All modes</a>
        <button class="btn" id="start" data-nav-primary>Start race</button>
      </div>`, "menu");
    TP.BRHud.attachNav(card, { onBack: () => { location.href = TP.Rumble.HUB_URL; } });

    // Gamepad hint.
    const padInfo = card.querySelector("#padinfo");
    const refreshPads = () => {
      const n = (navigator.getGamepads ? [...navigator.getGamepads()] : []).filter(Boolean).length;
      padInfo.textContent = n ? `🎮 ${n} gamepad(s)` : "🎮 Press a pad button to connect";
    };
    refreshPads();
    window.addEventListener("gamepadconnected", refreshPads);

    card.querySelector("#start").addEventListener("click", () => {
      const slots = [0, 1, 2, 3].map((i) => ({
        name: card.querySelector("#n" + i).value.trim() || TP.DEFAULT_NAMES[i],
        controller: card.querySelector("#c" + i).value,
      }));
      // Save back to the hub's shared setup (with "off" kept as "off").
      TP.Rumble.saveSetup(slots);
      // Two players can't share one controller: the second becomes a bot.
      const used = new Set();
      for (const s of slots) {
        if (s.controller === "bot" || s.controller === "off") continue;
        if (used.has(s.controller)) s.controller = "bot";
        used.add(s.controller);
      }
      TP.sfx.unlock();
      TP.BRSound.unlock();
      startMatch({
        slots,
        roundsToWin: Number(card.querySelector("#rounds").value),
        difficulty: card.querySelector("#diff").value,
        carCount: 4,
      });
    });
  }

  /* ---------- M = mute / unmute everything ---------- */
  window.addEventListener("keydown", (e) => {
    if (e.code !== "KeyM" || (e.target && e.target.tagName === "INPUT")) return;
    app.muted = TP.sfx.toggleMute();
    TP.BRSound.setMuted(app.muted);
    TP.BRHud.toast(app.muted ? "🔇 Sound off" : "🔊 Sound on", 1.2);
  });

  /* ---------- Go ---------- */
  if (params.has("demo")) {
    startMatch({
      slots: TP.DEFAULT_NAMES.map((name) => ({ name, controller: "bot" })),
      roundsToWin: Number(params.get("rounds")) || 3,
      carCount: Number(params.get("bots")) || 4,
      seed: params.has("seed") ? Number(params.get("seed")) : undefined,
    });
  } else {
    showMenu();
  }
  requestAnimationFrame(frame);
})();
