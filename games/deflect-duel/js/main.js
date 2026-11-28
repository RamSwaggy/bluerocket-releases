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
     ?test            like ?demo, plus QC's test hooks (see the bottom of this file)

   Test hooks (only in ?demo / ?test):
     TP.duel.paused = true      this loop stops updating and drawing the
                                match, so a test can call TP.duel.update()
                                itself
     TP.duelTest.newMatch({ players, lives, pillars })
                                start a fresh match. players is a count (all
                                bots) or [{ seat, name, controller }]
     TP.duel.setInput(i, ctrl) / setBot(i, on) / placeCar(i, {x,z}, heading)
     TP.duel.setBall({ pos, vel, owner })        (these live in duel.js)
   ===================================================================== */
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const SPEED = Math.max(0.1, Number(params.get("speed")) || 1);
  const TEST = params.has("test");
  const DEMO = params.has("demo") || TEST;

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
    if (e.target && e.target.tagName === "INPUT") return;
    if (e.code === "KeyM") { if (TP.sfx && TP.sfx.toggleMute) TP.sfx.toggleMute(); return; }
    // Practice room / tutorial: number keys set the launcher speed,
    // Escape goes back to the menu.
    if (TP.DuelPractice && TP.DuelPractice.active) {
      const m = /^Digit([0-5])$/.exec(e.code);
      if (m) TP.DuelPractice.dial(Number(m[1]));
      if (e.code === "Escape") backToMenu();
    }
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
    if (TP.DuelPractice && TP.DuelPractice.active && duel && !duel.paused) TP.DuelPractice.update(dt);
    if (duel && duel.paused) {
      // A test is driving the match by hand: leave it alone.
    } else if (duel) {
      duel.update(dt);     // 3) the rules (fixed steps inside)
      showCountdown();
      updateHud();
      duel.camera.aspect = aspect;
      duel.camera.updateProjectionMatrix();
      // 4) The broadcast camera (Art's js/camera.js): a side-on view that
      //    eases to fit every car and the ball's height, with shake,
      //    punch-ins and the standoff push-in during long hit-freezes.
      //    The real (unscaled) frame time keeps it smooth in ?demo speed-ups.
      if (TP.DuelCamera) TP.DuelCamera.update(duel.camera, duel, dt / SPEED);
      renderer.render(duel.scene, duel.camera); // 5) draw
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
    // The practice launcher isn't a player: no chip for it.
    const shown = duel.players.filter((p) => !p.launcher);
    let clock = "";
    if (duel.mode === "time") {
      const t = Math.ceil(duel.clockLeft);
      clock = duel.overtime ? "OVERTIME: next KO wins" : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
    } else if (duel.mode === "practice") {
      clock = duel.practiceSpeed ? `LAUNCHER ${Math.round(duel.practiceSpeed)}` : "LAUNCHER OFF";
    }
    TP.HUD.update(shown, b.speed, css, { mode: duel.mode, clock });
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
      case "bunt":
        // The thunk, ring and wheel glow come from Art's onBunt hook (arena.js).
        // Only fall back to our own cue when that look isn't loaded.
        if (!TP.DuelArena) { TP.sfx.play("swing"); TP.HUD.toast("BUNT", data.player.css, 0.7); }
        break;
      case "clash":
        TP.sfx.play("hit", 1);
        // The big flash and the "CLASH!" toast come from Art's onClash hook.
        if (!TP.DuelArena) TP.HUD.toast("CLASH!", "#ffe14d", 0.9);
        break;
      case "overtime":
        TP.HUD.center("OVERTIME", "Next KO wins", "#ffe14d");
        TP.sfx.play("go");
        TP.sched.wait(1.6).then(() => { if (duel && duel.state !== "over") TP.HUD.center(""); });
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
    if (TP.DuelPractice) TP.DuelPractice.stop();
    TP.sfx.unlock();
    TP.HUD.hideCard();
    TP.HUD.center("");
    TP.sched.clear();
    if (duel) duel.dispose();
    lastConfig = config;
    shownCount = -1;
    duel = new TP.Duel({
      players: config.players, lives: config.lives, pillars: config.pillars, onEvent,
      mode: config.mode, difficulty: config.difficulty, timeLimit: config.timeLimit, practiceSpeed: config.practiceSpeed,
      countdown: config.countdown,
    });
    if (config.mode === "practice" && TP.DuelPractice) TP.DuelPractice.start(duel, { tutorial: !!config.tutorial });
    if (config.mode !== "practice") showHints(config.players);
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
    if (result.mode === "teams") TP.HUD.center(`${result.winnerTeamName} WIN!`, "", result.winnerCss);
    else TP.HUD.center(`${result.winnerName} WINS!`, "", result.winnerCss);
    TP.HUD.hint("");
    // Let the moment land before the results card covers the arena.
    TP.sched.wait(2).then(() => {
      TP.HUD.center("");
      if (typeof TP.HUD.showResults === "function") {
        // Art's card wants { winner, places: [{ name, css, kos, livesLeft }] }.
        const places = result.standings.map((s) => ({ name: s.name, css: s.css, kos: s.kos, livesLeft: s.lives, team: s.team, score: s.score }));
        TP.HUD.showResults(Object.assign({}, result, { winner: places[0] || null, places }), rematch, backToMenu);
      } else {
        showResultsFallback(result);
      }
    });
  }

  function rematch() { if (lastConfig) startMatch(lastConfig); }

  function backToMenu() {
    if (TP.DuelPractice) TP.DuelPractice.stop();
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

  // Called by either menu when Start (or Practice / Tutorial) is pressed.
  // extra = { mode: "stock"|"teams"|"time"|"sudden", difficulty, practice }.
  // Returns an error message, or "" if the match started.
  function startFromMenu(slots, lives, extra = {}) {
    const players = playersFromSlots(slots);
    // Practice / tutorial: just you (the first human seat, else Keyboard 1
    // in seat 1) and the ball launcher.
    if (extra.practice) {
      const me = players.find((p) => p.controller !== "bot") || { seat: 0, name: TP.DEFAULT_NAMES[0], controller: "kb1" };
      Rumble.saveSetup(slots);
      startMatch({ players: [me], lives: 3, mode: "practice", practiceSpeed: extra.practice === "tutorial" ? 0 : 40, tutorial: extra.practice === "tutorial", countdown: 1 });
      return "";
    }
    if (players.length < 2) return "Fill at least 2 seats to play.";
    Rumble.saveSetup(slots);
    const mode = extra.mode || "stock";
    startMatch({
      players,
      // Sudden Death is the normal rules with one life each.
      lives: mode === "sudden" ? 1 : Number(lives) === 5 ? 5 : 3,
      mode: mode === "sudden" ? "stock" : mode,
      difficulty: extra.difficulty || "normal",
      timeLimit: 150,
    });
    return "";
  }

  function showMenu() {
    const setup = Rumble.loadSetup();
    const lives = 3;
    if (typeof TP.HUD.showMenu === "function") {
      // Art's menu. It calls back with (slots, lives) or ({ slots, lives }).
      TP.HUD.showMenu(setup, lives, (a, b, extra) => {
        const slots = a && a.slots ? a.slots : a;
        const l = a && a.slots ? a.lives ?? b : b;
        return startFromMenu(slots, l, extra || {});
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
        <button class="btn alt" data-open-controls title="Rebind keys and buttons (pad: View)">🎮 Controls</button>
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
  // n all-bot players, seats 0..n-1.
  const botPlayers = (n) => TP.DEFAULT_NAMES.slice(0, Math.min(4, Math.max(2, n))).map((name, seat) => ({ seat, name, controller: "bot" }));

  if (DEMO) {
    // All bots, no menu. QC's smoke test uses this.
    startMatch({
      players: botPlayers(Number(params.get("players")) || 4),
      lives: Math.max(1, Number(params.get("lives")) || 3),
    });
    // QC's test hooks (TP.duel itself also has setInput/setBot/placeCar/setBall).
    TP.duelTest = {
      newMatch({ players = 4, lives = 3, pillars, mode, difficulty, timeLimit, practiceSpeed } = {}) {
        startMatch({ players: Array.isArray(players) ? players : botPlayers(players), lives, pillars, mode, difficulty, timeLimit, practiceSpeed });
        return TP.duel;
      },
    };
  } else {
    showMenu();
  }
  requestAnimationFrame(frame);
})();
