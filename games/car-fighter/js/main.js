/* =====================================================================
   main.js — Car Fighter's page flow: the menu, starting a match, and the
   results card. (The match loop itself lives in match.js, Gameplay's.)

   Flow:
     1. Page loads. With ?demo (bot vs bot) or ?headless we skip the menu:
        match.js reads the URL options and runs the fight.
     2. Otherwise: the menu, over the empty stage turning slowly. Seats
        come from the Rocket Rumble hub's saved setup (seats 1 and 2).
     3. Start → save the setup back to the hub → TP.Match.start(config).
     4. Match over → results card: Rematch, Menu, "← All modes".

   How main.js and match.js meet (agreed with Gameplay through the boss):
     TP.Match.start(config)   config = { p1, p2, rounds, roundTime } in the
                              same shape as TP.Fight.create's options
                              (see DESIGN.md §9). Pass null to run from the
                              URL options (that's what ?demo does).
   match.js then creates the fight, calls TP.FightView.init(scene, fight)
   and TP.FightView.frame(state) every frame.
   ===================================================================== */
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const UI = TP.FightUI;
  const esc = UI.esc;
  const PREFS_KEY = "carFighter.menu.v1";   // this page's own bits (bot difficulty)
  const DIFFS = [["easy", "Easy"], ["normal", "Normal"], ["hard", "Hard"]];

  let lastConfig = null;   // what Rematch replays

  // Headless runs (fast sims for QC) don't draw anything at all.
  if (params.has("headless")) return;

  /* ---------- Small per-browser preferences (bot difficulty per seat) ---------- */
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { return {}; }
  }
  function savePrefs(p) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* storage blocked: fine */ }
  }

  const isBot = (id) => id === "bot" || id === "off";
  const winsFor = (rounds) => Math.ceil((rounds || 3) / 2);

  /* ---------- Starting a match ---------- */
  function startMatch(config) {
    if (!TP.Match || typeof TP.Match.start !== "function") {
      UI.message("Fight core not loaded", "js/match.js is missing (Gameplay's file)", "#f87171");
      return;
    }
    lastConfig = config;
    UI.hideCard();
    try {
      TP.Match.start(config);
    } catch (err) {
      console.error(err);
      UI.message("Something broke", String((err && err.message) || err), "#f87171");
    }
  }

  /* ---------- The menu ---------- */
  function showMenu() {
    UI.hideHud();
    TP.FightView.backdrop();

    const setup = TP.Rumble.loadSetup();
    const prefs = loadPrefs();
    // Controllers offered per seat. "Empty seat" is the hub's "off": in
    // Car Fighter an empty seat is played by a bot (DESIGN: 1 player vs bot).
    const CTRLS = ["off", "bot", ...TP.CONTROLLER_IDS.filter((id) => id !== "bot")];
    const label = (id) => (id === "off" ? "Empty seat (bot plays)" : TP.CONTROLLER_LABELS[id]);

    const seatHtml = (i) => {
      const s = setup.slots[i];
      const diff = (prefs.bot && prefs.bot[i]) || "normal";
      return `
        <div class="slot" style="border-color:${TP.PLAYER_CSS[i]}">
          <div class="label"><b style="color:${TP.PLAYER_CSS[i]}">Player ${i + 1}</b><span>${i ? "right side" : "left side"}</span></div>
          <input id="name${i}" maxlength="12" value="${esc(s.name)}" aria-label="Player ${i + 1} name" />
          <select id="ctrl${i}" aria-label="Player ${i + 1} controller">
            ${CTRLS.map((id) => `<option value="${id}" ${id === s.controller ? "selected" : ""}>${esc(label(id))}</option>`).join("")}
          </select>
          <select id="diff${i}" class="full botonly" aria-label="Player ${i + 1} bot difficulty" ${isBot(s.controller) ? "" : "hidden"}>
            ${DIFFS.map(([v, l]) => `<option value="${v}" ${v === diff ? "selected" : ""}>Bot: ${l}</option>`).join("")}
          </select>
          <div class="fighter">
            <span class="nm">Rivet</span><span class="ds">All-rounder · compact coupe</span>
            <span class="soon">More cars soon</span>
          </div>
        </div>`;
    };

    const card = UI.card(`
      <a class="back" href="${TP.Rumble.HUB_URL}">← All modes</a>
      <h1><span class="a">CAR</span> <span class="b">FIGHTER</span></h1>
      <p class="tagline">Scrapyard Floodlight League. One on one on the turntable: rams, swipes,
        flips and boost dashes. Best of 3 rounds, 60 seconds each.</p>
      <div class="seats">${seatHtml(0)}${seatHtml(1)}</div>
      <table class="keys">
        <tr><td>Keyboard 1</td><td>Move <kbd>A</kbd><kbd>D</kbd> · Dodge <kbd>W</kbd><kbd>S</kbd> · Jump <kbd>Space</kbd> · Boost <kbd>Shift</kbd> · Hit <kbd>E</kbd> · Heavy <kbd>R</kbd></td></tr>
        <tr><td>Keyboard 2</td><td>Move <kbd>←</kbd><kbd>→</kbd> · Dodge <kbd>↑</kbd><kbd>↓</kbd> · Jump <kbd>Enter</kbd> · Boost <kbd>R-Shift</kbd> · Hit <kbd>.</kbd> · Heavy <kbd>,</kbd></td></tr>
        <tr><td>Gamepad</td><td>Move/dodge stick · Jump <kbd>A</kbd> · Boost <kbd>B</kbd> · Hit <kbd>X</kbd> · Heavy <kbd>Y</kbd></td></tr>
        <tr><td>Fighting</td><td>Hold <b>away</b> to guard · Hit Hit Hit combo · Toward + Heavy launches · Hit + Heavy up close throws</td></tr>
      </table>
      <div class="actions">
        <span class="muted" id="padinfo"></span>
        <span class="muted">Press <kbd>M</kbd> to mute</span>
        <button class="btn" id="start">Fight!</button>
      </div>`);

    // Show/hide the difficulty picker as the controller changes.
    for (const i of [0, 1]) {
      card.querySelector("#ctrl" + i).addEventListener("change", (e) => {
        card.querySelector("#diff" + i).hidden = !isBot(e.target.value);
      });
    }

    // Gamepads only show up after a button press, so tell people that.
    const padInfo = card.querySelector("#padinfo");
    const refreshPads = () => {
      const pads = (navigator.getGamepads ? [...navigator.getGamepads()] : []).filter(Boolean);
      padInfo.textContent = pads.length ? `🎮 ${pads.length} gamepad(s) connected` : "🎮 Press a gamepad button to connect it";
    };
    refreshPads();
    window.addEventListener("gamepadconnected", refreshPads);
    window.addEventListener("gamepaddisconnected", refreshPads);

    const startBtn = card.querySelector("#start");
    startBtn.focus({ preventScroll: true });
    startBtn.addEventListener("click", () => {
      TP.sfx.unlock();
      const seats = [0, 1].map((i) => ({
        name: card.querySelector("#name" + i).value.trim() || setup.slots[i].name,
        controller: card.querySelector("#ctrl" + i).value,
        bot: card.querySelector("#diff" + i).value,
      }));
      // Two players can't share one controller: the second one becomes a bot.
      if (!isBot(seats[0].controller) && seats[1].controller === seats[0].controller) seats[1].controller = "bot";

      // Save back to the hub: only seats 1 and 2 change; 3 and 4 are kept.
      const slots = setup.slots.map((s, i) => (i < 2 ? { name: seats[i].name, controller: seats[i].controller } : s));
      TP.Rumble.saveSetup(slots);
      savePrefs({ bot: [seats[0].bot, seats[1].bot] });

      const rounds = Number(params.get("rounds")) || 3;
      const roundTime = Number(params.get("roundTime")) || 60;
      const config = {
        rounds, roundTime,
        p1: { fighter: "rivet", controller: isBot(seats[0].controller) ? "bot" : seats[0].controller, bot: seats[0].bot },
        p2: { fighter: "rivet", controller: isBot(seats[1].controller) ? "bot" : seats[1].controller, bot: seats[1].bot },
      };
      UI.setPlayers(seats.map((s, i) => ({
        name: s.name, fighter: "Rivet", controller: config[i ? "p2" : "p1"].controller,
      })), winsFor(rounds));
      startMatch(config);
    });
  }

  /* ---------- Results ---------- */
  UI.onMatchEnd = (state, rounds) => {
    const players = UI.players;
    const w = state.winner;
    const won = w === 0 || w === 1;
    const title = won ? `${players[w].name} wins!` : "It's a draw";
    const color = won ? TP.PLAYER_CSS[w] : "var(--text)";
    const wins = state.roundWins || [0, 0];
    const demo = params.has("demo");

    const card = UI.card(`
      <h2 style="color:${color}">${esc(title)}</h2>
      <p class="tagline">${esc(players[0].name)} ${wins[0]} – ${wins[1]} ${esc(players[1].name)}</p>
      <div class="rounds">
        ${rounds.map((r) => `
          <div class="r" style="--seat:${r.winner >= 0 ? TP.PLAYER_CSS[r.winner] : "#9aa6c8"}">
            <span class="n">Round ${r.round}</span>
            <span class="w">${r.winner >= 0 ? esc(players[r.winner].name) : "Draw"}</span>
            <span class="how">${esc(r.how)}</span>
          </div>`).join("")}
      </div>
      <div class="actions">
        <a class="back" href="${TP.Rumble.HUB_URL}">← All modes</a>
        <button class="btn ghost" id="menu">Menu</button>
        <button class="btn" id="rematch">${demo ? "Watch again" : "Rematch"}</button>
      </div>`);
    const rematch = card.querySelector("#rematch");
    rematch.focus({ preventScroll: true });
    rematch.addEventListener("click", () => {
      // A demo was started from the URL, so the simplest clean rerun is a reload.
      if (demo || !lastConfig) { location.reload(); return; }
      startMatch(lastConfig);
    });
    // Back to the menu: reload without ?demo, so everything starts clean.
    card.querySelector("#menu").addEventListener("click", () => {
      location.href = location.pathname;
    });
  };

  /* ---------- M = mute / unmute ---------- */
  window.addEventListener("keydown", (e) => {
    if (e.code !== "KeyM" || (e.target && e.target.tagName === "INPUT")) return;
    const muted = TP.sfx.toggleMute();
    UI.message(muted ? "🔇 Sound off" : "🔊 Sound on", "", "#9aa6c8");
    setTimeout(() => UI.message(""), 700);
  });

  /* ---------- Go ---------- */
  if (params.has("demo")) {
    const rounds = Number(params.get("rounds")) || 3;
    const b1 = params.get("bot") || "normal", b2 = params.get("bot2") || b1;
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const fname = (k, d) => cap(params.get(k) || d);
    // Named after the seat colours so "who won" is never ambiguous; the
    // difficulty goes next to the car name.
    UI.setPlayers([
      { name: `${TP.DEFAULT_NAMES[0]} Bot`, fighter: `${fname("p1", "rivet")} · ${cap(b1)}`, controller: "bot" },
      { name: `${TP.DEFAULT_NAMES[1]} Bot`, fighter: `${fname("p2", "rivet")} · ${cap(b2)}`, controller: "bot" },
    ], winsFor(rounds));
    // Wait for every script to load, then start from the URL options,
    // unless match.js already started the demo by itself.
    window.addEventListener("load", () => { if (!TP.fight) startMatch(null); });
  } else {
    showMenu();
  }
})();
