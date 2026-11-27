/* =====================================================================
   main.js — starts everything: the renderer, the main loop, and the
   title/setup menu.

   Handy URL options (add to the end of the address, e.g. index.html?demo):
     ?demo           skip the menu: 4 bots, 2 turns — watch a full match
     ?turns=3        number of turns when using ?demo
     ?speed=3        run game time faster (testing)
     ?minigame=sumo-ring   only play this minigame (coin-rush / sumo-ring / goal-frenzy)
   ===================================================================== */
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const SPEED = Math.max(0.1, Number(params.get("speed")) || 1);

  /* ---------- Renderer ---------- */
  const canvas = document.getElementById("game");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    TP._aspect = w / h;
  }
  window.addEventListener("resize", resize);
  resize();

  /* ---------- Whatever is on screen ----------
     Before a match starts we show a slowly orbiting board behind the menu.
     Once a match starts, the Game decides (board or minigame arena). */
  let game = null;
  let backdrop = null;

  function currentView() {
    return game ? game.view : backdrop;
  }

  /* ---------- Main loop ---------- */
  let last = performance.now();
  function frame(now) {
    // Clamp dt so a background tab or a hitch doesn't teleport cars.
    const dt = Math.min(0.05, (now - last) / 1000) * SPEED;
    last = now;

    TP.Input.poll();         // 1) read controllers (fresh "just pressed" edges)
    TP.sched.update(dt);     // 2) advance timers/tweens → game-flow code resumes
    const view = currentView();
    if (view) {
      if (game) game.update(dt); else view.update(dt);   // 3) simulate
      view.camera.aspect = TP._aspect;
      view.camera.updateProjectionMatrix();
      renderer.render(view.scene, view.camera);           // 4) draw
    }
    requestAnimationFrame(frame);
  }

  /* ---------- Starting a match ---------- */
  function startGame(config) {
    TP.sfx.unlock();
    TP.UI.hideCard();
    if (backdrop) { backdrop.dispose(); backdrop = null; }
    // Optional: lock to one minigame (testing / favourite mode).
    const only = params.get("minigame");
    if (only) {
      const keep = TP.MINIGAMES.filter((m) => m.id === only);
      if (keep.length) TP.MINIGAMES.splice(0, TP.MINIGAMES.length, ...keep);
    }
    game = new TP.Game(config);
    TP.game = game; // exposed for debugging in the browser console
    game.run().catch((err) => {
      console.error(err);
      TP.UI.center("Something broke", String(err && err.message || err), "#f87171");
    });
  }

  /* ---------- Title / setup menu ---------- */
  function showMenu() {
    // Backdrop board with placeholder players, just for looks.
    backdrop = new TP.Board({
      players: TP.DEFAULT_NAMES.map((n, i) => ({ index: i, name: n, color: TP.PLAYER_COLORS[i], controller: "bot" })),
    });
    backdrop.orbit = true;
    TP.UI.showPlayers(false);

    const ctrlOptions = (selected) => TP.CONTROLLER_IDS.map((id) =>
      `<option value="${id}" ${id === selected ? "selected" : ""}>${TP.CONTROLLER_LABELS[id]}</option>`).join("");

    const card = TP.UI.card(`
      <h1><span class="t1">TURBO</span> PARTY</h1>
      <p>A rocket-car party board game. Roll the die, drive the board, buy trophies,
         and fight for coins in car minigames between turns. Most trophies wins.</p>

      <div class="slots">
        ${[0, 1, 2, 3].map((i) => `
          <div class="slot" style="border-color:${TP.PLAYER_CSS[i]}">
            <label>Player ${i + 1}</label>
            <input id="name${i}" maxlength="12" value="${TP.DEFAULT_NAMES[i]}" />
            <select id="ctrl${i}">${ctrlOptions(i === 0 ? "kb1" : "bot")}</select>
          </div>`).join("")}
      </div>

      <div class="row">
        <label class="muted" for="turns">Turns</label>
        <select id="turns">
          <option value="3">3 (quick)</option>
          <option value="5">5</option>
          <option value="10" selected>10</option>
          <option value="15">15</option>
        </select>
        <span class="muted" id="padinfo"></span>
      </div>

      <table class="controls-table">
        <tr><td>Keyboard 1</td><td>Drive <kbd>W</kbd><kbd>S</kbd> · Steer <kbd>A</kbd><kbd>D</kbd> · Jump/confirm <kbd>Space</kbd> · Boost <kbd>Shift</kbd></td></tr>
        <tr><td>Keyboard 2</td><td>Drive <kbd>↑</kbd><kbd>↓</kbd> · Steer <kbd>←</kbd><kbd>→</kbd> · Jump/confirm <kbd>Enter</kbd> · Boost <kbd>R-Shift</kbd></td></tr>
        <tr><td>Gamepad</td><td>Gas <kbd>RT</kbd> · Reverse <kbd>LT</kbd> · Steer stick · Jump/confirm <kbd>A</kbd> · Boost <kbd>B</kbd>/<kbd>X</kbd></td></tr>
      </table>

      <div class="row" style="margin-top:18px"><button class="btn" id="start">Start party</button></div>`);

    // Show how many gamepads the browser can see (press a button to wake them).
    const padInfo = card.querySelector("#padinfo");
    const refreshPads = () => {
      const pads = (navigator.getGamepads ? [...navigator.getGamepads()] : []).filter(Boolean);
      padInfo.textContent = pads.length ? `🎮 ${pads.length} gamepad(s) connected` : "🎮 Press a button on a gamepad to connect it";
    };
    refreshPads();
    window.addEventListener("gamepadconnected", refreshPads);
    window.addEventListener("gamepaddisconnected", refreshPads);

    card.querySelector("#start").addEventListener("click", () => {
      const slots = [0, 1, 2, 3].map((i) => ({
        name: card.querySelector("#name" + i).value.trim() || TP.DEFAULT_NAMES[i],
        controller: card.querySelector("#ctrl" + i).value,
      }));
      // Two players can't share one controller — the second becomes a bot.
      const used = new Set();
      for (const s of slots) {
        if (s.controller === "bot") continue;
        if (used.has(s.controller)) s.controller = "bot";
        used.add(s.controller);
      }
      startGame({ turns: Number(card.querySelector("#turns").value), slots });
    });
  }

  /* ---------- Go ---------- */
  if (params.has("demo")) {
    startGame({
      turns: Number(params.get("turns")) || 2,
      slots: TP.DEFAULT_NAMES.map((name) => ({ name, controller: "bot" })),
    });
  } else {
    showMenu();
  }
  requestAnimationFrame(frame);
})();
