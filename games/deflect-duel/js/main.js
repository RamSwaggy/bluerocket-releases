/* =====================================================================
   main.js — starts Deflect Duel: the renderer, the main loop, the menu,
   the match, and the results / rematch screen.

   Flow:  menu → match (TP.Duel) → results → rematch or back to menu.

   The menu starts from the players set up in the Rocket Rumble hub
   (TP.Rumble.loadSetup()) and saves them back when you press Start. A
   seat set to "off" is empty; at least 2 seats must be filled.

   Art and UI can replace the plain menu and results cards: if
   TP.HUD.showMenu / TP.HUD.showResults exist they're used, otherwise the
   simple fallback cards below are shown.

   Handy URL options (add to the end of the address, e.g. index.html?demo):
     ?demo            no menu: an all-bot match, then the results (no auto-rematch)
     ?players=3       how many bots in ?demo (2–4, default 4)
     ?lives=5         lives per car (default 3)
     ?speed=4         run game time faster (testing)
   ===================================================================== */
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const SPEED = Math.max(0.1, Number(params.get("speed")) || 1);
  const DEMO = params.has("demo");

  // The hub glue. If rumble.js isn't loaded (it should be), fall back to
  // sensible defaults so the mode still runs on its own.
  const Rumble = TP.Rumble || {
    loadSetup: () => ({ slots: TP.DEFAULT_NAMES.map((name, i) => ({ name, controller: i === 0 ? "kb1" : "bot" })) }),
    saveSetup: () => {},
    HUB_URL: "../index.html",
  };

  /* ---------- Renderer ---------- */
  const canvas = document.getElementById("game");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x0a0d1c);
  let aspect = 16 / 9;
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    aspect = w / h;
  }
  window.addEventListener("resize", resize);
  resize();

  // M mutes everything (same key as the other modes), unless typing a name.
  window.addEventListener("keydown", (e) => {
    if (e.code !== "KeyM" || (e.target && e.target.tagName === "INPUT")) return;
    if (TP.sfx && TP.sfx.toggleMute) TP.sfx.toggleMute();
  });

  /* ---------- The current match ---------- */
  let duel = null;        // the TP.Duel being played (or the finished one behind the results)
  let lastConfig = null;  // { players, lives } of the last match, for Rematch
  let shownCount = -1;    // last countdown number shown, so each one shows once

  /* ---------- Main loop ---------- */
  let last = performance.now();
  function frame(now) {
    // Clamp dt so a background tab or a hitch doesn't jump the game ahead.
    const dt = Math.min(0.05, (now - last) / 1000) * SPEED;
    last = now;

    TP.Input.poll();       // 1) read controllers
    TP.sched.update(dt);   // 2) advance timers (results delay, etc.)
    if (duel) {
      duel.update(dt);     // 3) the rules (fixed steps inside)
      showCountdown();
      updateHud();
      duel.camera.aspect = aspect;
      duel.camera.updateProjectionMatrix();
      renderer.render(duel.scene, duel.camera); // 4) draw
    } else {
      renderer.clear();
    }
    requestAnimationFrame(frame);
  }

  // Top bar: a chip per car (hearts = lives) and the ball speed, tinted
  // by the ball's owner.
  function updateHud() {
    const b = duel.ball;
    const css = b.owner === null ? "#ffffff" : duel.players[b.owner].css;
    TP.HUD.update(duel.players, b.speed, css);
  }

  // 3-2-1-GO before the first serve.
  function showCountdown() {
    if (duel.countdown <= 0) return;
    const n = Math.ceil(duel.countdown);
    if (n !== shownCount) {
      shownCount = n;
      TP.HUD.center(String(n));
      TP.sfx.play("count");
    }
  }

  /* ---------- Things that happen during a match ----------
     Callouts and sounds. (Art and UI can add more through duel.hooks.) */
  function onEvent(name, data) {
    switch (name) {
      case "go":
        TP.HUD.center("GO!", "", "#ffe14d");
        TP.sfx.play("go");
        TP.sched.wait(0.7).then(() => { if (duel && duel.state !== "over") TP.HUD.center(""); });
        break;
      case "swing":
        TP.sfx.play("swing");
        break;
      case "hit":
        TP.sfx.play("hit", data.frac);
        if (data.smash) TP.HUD.toast("SMASH!", data.player.css, 0.8);
        break;
      case "ko":
        TP.sfx.play("ko");
        TP.HUD.toast(
          data.victim.lives > 0
            ? `${data.owner ? data.owner.name : "?"} KO'd ${data.victim.name}!`
            : `${data.victim.name} is OUT!`,
          data.owner ? data.owner.css : "", 1.6);
        break;
      case "stalemate":
        TP.HUD.toast("Nobody hit it: re-serve", "", 1.2);
        break;
      case "end":
        onMatchEnd(data);
        break;
    }
  }

  /* ---------- Starting a match ---------- */
  // config.players: [{ seat, name, controller }], config.lives: 3 or 5
  function startMatch(config) {
    TP.sfx.unlock();
    TP.HUD.hideCard();
    TP.HUD.center("");
    TP.sched.clear();
    if (duel) duel.dispose();
    lastConfig = config;
    shownCount = -1;
    duel = new TP.Duel({ players: config.players, lives: config.lives, onEvent });
    showHints(config.players);
  }

  // Each human's keys along the bottom of the screen.
  function showHints(players) {
    const humans = players.filter((p) => p.controller !== "bot");
    if (!humans.length) { TP.HUD.hint("All bots: sit back and watch!"); return; }
    TP.HUD.hint(humans.map((p) => {
      const k = TP.keyNames(p.controller);
      return `<span style="color:${TP.PLAYER_CSS[p.seat]}">${TP.HUD.esc(p.name)}</span>: ` +
        `hit <kbd>${k.hit}</kbd> (+boost = smash) jump <kbd>${k.confirm}</kbd> aim <kbd>${k.steer}</kbd>`;
    }).join(" &nbsp;·&nbsp; "));
  }

  /* ---------- Match over → results ---------- */
  function onMatchEnd(result) {
    TP.sfx.play("trophy");
    TP.HUD.center(`${result.winnerName} WINS!`, "", result.winnerCss);
    TP.HUD.hint("");
    // Let the moment land before the results card covers the arena.
    TP.sched.wait(2).then(() => {
      TP.HUD.center("");
      if (typeof TP.HUD.showResults === "function") {
        TP.HUD.showResults(result, rematch, backToMenu);
      } else {
        showResultsFallback(result);
      }
    });
  }

  function rematch() { if (lastConfig) startMatch(lastConfig); }

  function backToMenu() {
    if (duel) { duel.dispose(); duel = null; }
    TP.sched.clear();
    TP.HUD.update(null);
    TP.HUD.center("");
    TP.HUD.hint("");
    showMenu();
  }

  function showResultsFallback(result) {
    const rows = result.standings.map((s) => `
      <div class="result-row" style="border-color:${s.css}">
        <span class="place">${s.place}${["st", "nd", "rd"][s.place - 1] || "th"}</span>
        <span class="who" style="color:${s.css}">${TP.HUD.esc(s.name)}</span>
        <span class="muted">${s.kos} KO${s.kos === 1 ? "" : "s"} · ${s.lives > 0 ? "♥".repeat(s.lives) : "out"}</span>
      </div>`).join("");
    const card = TP.HUD.card(`
      <h2>RESULTS</h2>
      <p>${TP.HUD.esc(result.winnerName)} is the last car standing.</p>
      ${rows}
      <div class="row" style="margin-top:18px">
        <button class="btn" id="rematch" data-nav-primary>Rematch</button>
        <button class="btn alt" id="menu">Menu</button>
      </div>`);
    card.querySelector("#rematch").onclick = rematch;
    card.querySelector("#menu").onclick = backToMenu;
    attachNav(card);
  }

  /* ---------- Menu ---------- */
  // Turn the 4 hub seats into the match's player list. "off" = empty seat.
  function playersFromSlots(slots) {
    return slots
      .map((s, seat) => ({ seat, name: String(s.name || TP.DEFAULT_NAMES[seat]).slice(0, 12), controller: s.controller }))
      .filter((p) => p.controller && p.controller !== "off");
  }

  // Called by either menu when Start is pressed. Returns an error message,
  // or "" if the match started.
  function startFromMenu(slots, lives) {
    const players = playersFromSlots(slots);
    if (players.length < 2) return "Fill at least 2 seats to play.";
    Rumble.saveSetup(slots);
    startMatch({ players, lives: Number(lives) === 5 ? 5 : 3 });
    return "";
  }

  function showMenu() {
    const setup = Rumble.loadSetup();
    const lives = 3;
    if (typeof TP.HUD.showMenu === "function") {
      // Art's menu. It calls back with (slots, lives) or ({ slots, lives }).
      TP.HUD.showMenu(setup, lives, (a, b) => {
        const slots = a && a.slots ? a.slots : a;
        const l = a && a.slots ? a.lives ?? b : b;
        return startFromMenu(slots, l);
      });
      return;
    }
    showMenuFallback(setup, lives);
  }

  function showMenuFallback(setup, lives) {
    const ids = ["off", ...TP.CONTROLLER_IDS];
    const label = (id) => (id === "off" ? "Off (empty)" : TP.CONTROLLER_LABELS[id]);
    const options = (sel) => ids.map((id) => `<option value="${id}" ${id === sel ? "selected" : ""}>${label(id)}</option>`).join("");
    const card = TP.HUD.card(`
      <p class="muted" style="margin:0 0 2px;letter-spacing:.12em">ROCKET RUMBLE</p>
      <h1><span class="t1">DEFLECT</span> <span class="t2">DUEL</span></h1>
      <p>One ball. It gets faster with every hit and takes the colour of whoever hit it last.
         If it touches anyone else, they lose a life. Hit it back, or jump over it.
         Last car standing wins.</p>
      <div class="slots">
        ${[0, 1, 2, 3].map((i) => `
          <div class="slot" style="border-color:${TP.PLAYER_CSS[i]}">
            <label>Seat ${i + 1}</label>
            <input id="name${i}" maxlength="12" value="${TP.HUD.esc(setup.slots[i].name)}" />
            <select id="ctrl${i}">${options(setup.slots[i].controller)}</select>
          </div>`).join("")}
      </div>
      <div class="row">
        <label class="muted" for="lives">Lives</label>
        <select id="lives">
          <option value="3" ${lives === 3 ? "selected" : ""}>3</option>
          <option value="5" ${lives === 5 ? "selected" : ""}>5</option>
        </select>
        <span class="muted">· Press <kbd>M</kbd> to mute</span>
      </div>
      <table class="controls-table">
        <tr><td>Keyboard 1</td><td>Drive <kbd>W</kbd><kbd>S</kbd> · Steer/aim <kbd>A</kbd><kbd>D</kbd> · Hit <kbd>E</kbd> · Jump <kbd>Space</kbd> · Boost <kbd>Shift</kbd></td></tr>
        <tr><td>Keyboard 2</td><td>Drive <kbd>↑</kbd><kbd>↓</kbd> · Steer/aim <kbd>←</kbd><kbd>→</kbd> · Hit <kbd>.</kbd> · Jump <kbd>Enter</kbd> · Boost <kbd>R-Shift</kbd></td></tr>
        <tr><td>Gamepad</td><td>Gas <kbd>RT</kbd> · Reverse <kbd>LT</kbd> · Steer stick · Hit <kbd>X</kbd>/<kbd>RB</kbd> · Jump <kbd>A</kbd> · Boost <kbd>B</kbd>/<kbd>LB</kbd></td></tr>
      </table>
      <p class="muted">Hit while boosting to <b>SMASH</b> (faster, costs boost).</p>
      <p class="error" id="err"></p>
      <div class="row" style="margin-top:10px">
        <button class="btn" id="start" data-nav-primary>Start duel</button>
        <a class="btn alt" style="text-decoration:none" href="${Rumble.HUB_URL}" data-nav-back>← All modes</a>
      </div>`);

    card.querySelector("#start").onclick = () => {
      const slots = [0, 1, 2, 3].map((i) => ({
        name: card.querySelector(`#name${i}`).value.trim() || TP.DEFAULT_NAMES[i],
        controller: card.querySelector(`#ctrl${i}`).value,
      }));
      const err = startFromMenu(slots, card.querySelector("#lives").value);
      card.querySelector("#err").textContent = err;
    };
    attachNav(card);
  }

  // Gamepad / arrow-key menu control, if the shared helper is loaded.
  let nav = null;
  function attachNav(card) {
    if (nav) { nav.detach(); nav = null; }
    if (TP.MenuNav && typeof TP.MenuNav.attach === "function") nav = TP.MenuNav.attach(card, {});
  }

  /* ---------- Go ---------- */
  if (DEMO) {
    // All bots, no menu. QC's smoke test uses this.
    const n = Math.min(4, Math.max(2, Number(params.get("players")) || 4));
    const lives = Math.max(1, Number(params.get("lives")) || 3);
    startMatch({
      players: TP.DEFAULT_NAMES.slice(0, n).map((name, seat) => ({ seat, name, controller: "bot" })),
      lives,
    });
  } else {
    showMenu();
  }
  requestAnimationFrame(frame);
})();
