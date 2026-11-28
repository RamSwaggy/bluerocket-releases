/* =====================================================================
   main.js — Car Fighter's page flow: the menu, the character select
   screen, starting a match, and the results card. (The match loop itself
   lives in match.js, Gameplay's.)

   Flow:
     1. Page loads. With ?demo (bot vs bot) or ?headless we skip the menu:
        match.js reads the URL options (including ?p1= / ?p2= cars) and
        starts the fight on page load. Otherwise we set
        TP.MATCH_MANUAL_START so match.js waits for us.
     2. MENU (over the empty stage turning slowly): who's playing. Seats
        come from the Rocket Rumble hub's saved setup (seats 1 and 2).
     3. CHARACTER SELECT: each player picks a car. The two picks are shown
        live on the stage behind, turning on the spot.
     4. Fight! → save the setup back to the hub → TP.Match.start(...).
     5. Match over → results card: Rematch, Menu, "← All modes".

   Every screen works with mouse, keyboard arrows and gamepads through the
   shared TP.MenuNav (the main button on each is marked data-nav-primary).

   How main.js and match.js meet (see the header of match.js):
     TP.Match.start(overrides)   overrides = { p1, p2 (fighter ids),
                                 bot, bot2 (difficulties), controllers:
                                 [seat1, seat2], rounds, roundTime }
   match.js then creates the fight, calls TP.FightView.init(scene, fight)
   and TP.FightView.frame(state, dt, fight) every frame.
   ===================================================================== */
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const UI = TP.FightUI;
  const esc = UI.esc;
  const PREFS_KEY = "carFighter.menu.v1";   // this page's own bits: bot difficulty and cars per seat
  const DIFFS = [["easy", "Easy"], ["normal", "Normal"], ["hard", "Hard"]];
  const STATS = [["power", "Power"], ["speed", "Speed"], ["weight", "Weight"], ["reach", "Reach"]];

  let lastConfig = null;   // what Rematch replays
  let nav = null;          // the MenuNav on the current card

  // Headless runs (fast sims for QC) don't draw anything at all, and a
  // ?demo is started by match.js itself. Every other visit gets the menu,
  // so match.js must wait for the Fight! button.
  if (params.has("headless")) return;
  if (!params.has("demo")) TP.MATCH_MANUAL_START = true;

  /* ---------- Small per-browser preferences ---------- */
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { return {}; }
  }
  function savePrefs(p) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* storage blocked: fine */ }
  }

  const isBot = (id) => id === "bot" || id === "off";
  const winsFor = (rounds) => Math.ceil((rounds || 3) / 2);

  /* The cars on offer: the look table's order, and only the ones the
     fight core actually has (TP.FIGHTERS). Missing ones show as locked. */
  const carIds = () => TP.FightBodies.ORDER;
  const carReady = (id) => !!(TP.FIGHTERS && TP.FIGHTERS[id]);
  const validCar = (id) => (carReady(id) ? id : TP.DEFAULT_FIGHTER || "rivet");

  /* Show a card and give it gamepad / arrow-key navigation. */
  function showCard(html, cls, onBack) {
    if (nav) { nav.detach(); nav = null; }
    const card = UI.card(html);
    card.className = "card" + (cls ? " " + cls : "");
    // The select screen keeps the middle of the stage clear for the preview.
    document.getElementById("overlay").classList.toggle("select-mode", cls === "select");
    if (TP.MenuNav) nav = TP.MenuNav.attach(card, onBack ? { onBack } : {});
    return card;
  }
  function hideCard() {
    if (nav) { nav.detach(); nav = null; }
    UI.hideCard();
  }

  /* ---------- Starting a match ---------- */
  function startMatch(config) {
    if (!TP.Match || typeof TP.Match.start !== "function") {
      UI.message("Fight core not loaded", "js/match.js is missing (Gameplay's file)", "#f87171");
      return;
    }
    lastConfig = config;
    hideCard();
    try {
      TP.Match.start(config);
    } catch (err) {
      console.error(err);
      UI.message("Something broke", String((err && err.message) || err), "#f87171");
    }
  }

  /* The choices being made on the menu and select screens. */
  const pick = {
    setup: null,            // the hub's saved setup (all 4 seats)
    seats: null,            // [{ name, controller, bot }] for seats 1 and 2
    cars: ["rivet", "rivet"],
  };

  /* =====================================================================
     1. MENU: who's playing
     ===================================================================== */
  function showMenu() {
    UI.hideHud();
    TP.FightView.backdrop();

    pick.setup = TP.Rumble.loadSetup();
    const prefs = loadPrefs();
    if (!pick.seats) {
      pick.seats = [0, 1].map((i) => ({
        name: pick.setup.slots[i].name,
        controller: pick.setup.slots[i].controller,
        bot: (prefs.bot && prefs.bot[i]) || "normal",
      }));
      pick.cars = [0, 1].map((i) => validCar(prefs.cars && prefs.cars[i]));
    }
    TP.FightView.preview(pick.cars, false);

    // Controllers offered per seat. "Empty seat" is the hub's "off": in
    // Car Fighter an empty seat is played by a bot (DESIGN: 1 player vs bot).
    const CTRLS = ["off", "bot", ...TP.CONTROLLER_IDS.filter((id) => id !== "bot")];
    const label = (id) => (id === "off" ? "Empty seat (bot plays)" : TP.CONTROLLER_LABELS[id]);

    const seatHtml = (i) => {
      const s = pick.seats[i];
      return `
        <div class="slot" style="border-color:${TP.PLAYER_CSS[i]}">
          <div class="label"><b style="color:${TP.PLAYER_CSS[i]}">Player ${i + 1}</b><span>${i ? "right side" : "left side"}</span></div>
          <input id="name${i}" maxlength="12" value="${esc(s.name)}" aria-label="Player ${i + 1} name" />
          <select id="ctrl${i}" aria-label="Player ${i + 1} controller">
            ${CTRLS.map((id) => `<option value="${id}" ${id === s.controller ? "selected" : ""}>${esc(label(id))}</option>`).join("")}
          </select>
          <select id="diff${i}" class="full botonly" aria-label="Player ${i + 1} bot difficulty" ${isBot(s.controller) ? "" : "hidden"}>
            ${DIFFS.map(([v, l]) => `<option value="${v}" ${v === s.bot ? "selected" : ""}>Bot: ${l}</option>`).join("")}
          </select>
        </div>`;
    };

    const card = showCard(`
      <a class="back" href="${TP.Rumble.HUB_URL}">← All modes</a>
      <h1><span class="a">CAR</span> <span class="b">FIGHTER</span></h1>
      <p class="tagline">Scrapyard Floodlight League. One on one on the turntable: rams, swipes,
        flips and boost dashes. Best of 3 rounds, 60 seconds each.</p>
      <div class="seats">${seatHtml(0)}${seatHtml(1)}</div>
      <table class="keys">
        <tr><td>Keyboard 1</td><td>Move <kbd>A</kbd><kbd>D</kbd> · Dodge <kbd>W</kbd><kbd>S</kbd> · Jump <kbd>Space</kbd> · Boost <kbd>Shift</kbd> · Hit <kbd>E</kbd> · Heavy <kbd>R</kbd></td></tr>
        <tr><td>Keyboard 2</td><td>Move <kbd>←</kbd><kbd>→</kbd> · Dodge <kbd>↑</kbd><kbd>↓</kbd> · Jump <kbd>Enter</kbd> · Boost <kbd>R-Shift</kbd> · Hit <kbd>.</kbd> · Heavy <kbd>,</kbd></td></tr>
        <tr><td>Gamepad</td><td>Move/dodge stick · Jump <kbd>A</kbd> · Boost <kbd>B</kbd> · Hit <kbd>X</kbd> · Heavy <kbd>Y</kbd></td></tr>
        <tr><td>Fighting</td><td>Hold <b>away</b> to guard · Hit Hit Hit combo · Toward + Heavy launches · Hit + Heavy up close throws · Boost + Heavy: signature move (1 super bar)</td></tr>
      </table>
      <div class="actions">
        <span class="muted" id="padinfo"></span>
        <span class="muted">Press <kbd>M</kbd> to mute</span>
        <button class="btn" id="next" data-nav-primary>Choose cars →</button>
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

    card.querySelector("#next").addEventListener("click", () => {
      pick.seats = [0, 1].map((i) => ({
        name: card.querySelector("#name" + i).value.trim() || pick.setup.slots[i].name,
        controller: card.querySelector("#ctrl" + i).value,
        bot: card.querySelector("#diff" + i).value,
      }));
      // Two players can't share one controller: the second one becomes a bot.
      if (!isBot(pick.seats[0].controller) && pick.seats[1].controller === pick.seats[0].controller) pick.seats[1].controller = "bot";
      showSelect();
    });
  }

  /* =====================================================================
     2. CHARACTER SELECT
     Two panels, P1 on the left and P2 on the right, each with the three
     car tiles, a stats strip (1–5 pips from TP.FIGHTERS[id].stats), the
     blurb and the signature move. The stage in the middle shows both
     picks live, turning on the spot.
     ===================================================================== */
  function carInfo(id) {
    const def = (TP.FIGHTERS && TP.FIGHTERS[id]) || {};
    const look = TP.FightBodies.info(id);
    return {
      name: def.displayName || def.name || UI.fighterName(id),
      role: def.role || "",
      body: look.body,
      blurb: def.blurb || "",
      stats: def.stats || null,
      health: def.health || null,
      signature: (def.signature && def.signature.name) || look.signature,
    };
  }

  function detailHtml(i) {
    const c = carInfo(pick.cars[i]);
    const strip = c.stats ? STATS.map(([k, l]) => {
      const v = Math.max(0, Math.min(5, Math.round(c.stats[k] || 0)));
      return `<div class="stat"><span>${l}</span><span class="pips" aria-label="${l} ${v} of 5">${
        [1, 2, 3, 4, 5].map((n) => `<i class="${n <= v ? "on" : ""}"></i>`).join("")}</span></div>`;
    }).join("") : "";
    return `
      <div class="carname">${esc(c.name)}</div>
      <div class="carrole">${esc([c.role, c.body].filter(Boolean).join(" · "))}${c.health ? ` · ${c.health} HP` : ""}</div>
      ${strip ? `<div class="stats">${strip}</div>` : ""}
      ${c.blurb ? `<p class="blurb">${esc(c.blurb)}</p>` : ""}
      <div class="sig">Signature: <b>${esc(c.signature)}</b> <span class="muted">(Boost + Heavy)</span></div>`;
  }

  function showSelect() {
    TP.FightView.preview(pick.cars, true);
    const panel = (i) => `
      <section class="pick p${i + 1}" style="--seat:${TP.PLAYER_CSS[i]}" aria-label="Player ${i + 1} car">
        <div class="who"><b>P${i + 1}</b> ${esc(pick.seats[i].name)}${isBot(pick.seats[i].controller) ? ` <span class="muted">(Bot · ${esc(pick.seats[i].bot)})</span>` : ""}</div>
        <div class="tiles">
          ${carIds().map((id) => `
            <button class="tile ${pick.cars[i] === id ? "on" : ""}" data-seat="${i}" data-car="${id}" ${carReady(id) ? "" : "disabled"}
              aria-pressed="${pick.cars[i] === id}">
              <span class="tn">${esc(carInfo(id).name)}</span>
              <span class="tr">${carReady(id) ? esc(TP.FightBodies.info(id).body) : "Coming soon"}</span>
            </button>`).join("")}
        </div>
        <div class="detail" id="detail${i}">${detailHtml(i)}</div>
      </section>`;

    const card = showCard(`
      <h2 class="title">Choose your car</h2>
      ${panel(0)}
      ${panel(1)}
      <div class="actions">
        <button class="btn ghost" id="back" data-nav-back>← Back</button>
        <button class="btn" id="fight" data-nav-primary>Fight!</button>
      </div>`, "select", () => showMenu());

    card.querySelectorAll(".tile").forEach((btn) => btn.addEventListener("click", () => {
      const i = Number(btn.dataset.seat);
      pick.cars[i] = btn.dataset.car;
      // Update only this panel's tiles and details, so the highlight stays put.
      card.querySelectorAll(`.tile[data-seat="${i}"]`).forEach((t) => {
        const on = t.dataset.car === pick.cars[i];
        t.classList.toggle("on", on);
        t.setAttribute("aria-pressed", String(on));
      });
      card.querySelector("#detail" + i).innerHTML = detailHtml(i);
      TP.FightView.preview(pick.cars, true);
      if (TP.FightSfx) TP.FightSfx.count();
    }));
    card.querySelector("#back").addEventListener("click", () => showMenu());
    card.querySelector("#fight").addEventListener("click", () => fightFromMenu());
  }

  /* Fight! from character select: save the setup and start. */
  function fightFromMenu() {
    TP.sfx.unlock();
    const seats = pick.seats;
    // Save back to the hub: only seats 1 and 2 change; 3 and 4 are kept.
    const slots = pick.setup.slots.map((s, i) => (i < 2 ? { name: seats[i].name, controller: seats[i].controller } : s));
    TP.Rumble.saveSetup(slots);
    savePrefs({ bot: [seats[0].bot, seats[1].bot], cars: pick.cars.slice() });

    const rounds = Number(params.get("rounds")) || 3;
    const roundTime = Number(params.get("roundTime")) || 60;
    const controllers = seats.map((s) => (isBot(s.controller) ? "bot" : s.controller));
    const config = {
      rounds, roundTime,
      p1: pick.cars[0], p2: pick.cars[1],
      bot: seats[0].bot, bot2: seats[1].bot,    // difficulty per seat (used only if it's a bot)
      controllers,
    };
    UI.setPlayers(seats.map((s, i) => ({
      name: s.name, fighter: carInfo(pick.cars[i]).name, controller: controllers[i],
    })), winsFor(rounds));
    startMatch(config);
  }

  /* =====================================================================
     3. RESULTS
     ===================================================================== */
  UI.onMatchEnd = (state, ourLog) => {
    const players = UI.players;
    // Prefer the fight core's own round log (state.roundResults: winner is
    // 0, 1 or null for a draw; reason is "KO", "time-out", "draw" or
    // "double-KO"). Our HUD's log is the fallback; it only knows about
    // rounds it actually saw rendered.
    const HOW = { "KO": "KO", "time-out": "Time", "draw": "Time · draw", "double-KO": "Double KO" };
    const rounds = Array.isArray(state.roundResults) && state.roundResults.length
      ? state.roundResults.map((r, i) => ({
          round: r.round || i + 1,
          winner: r.winner === 0 || r.winner === 1 ? r.winner : -1,
          how: HOW[r.reason] || String(r.reason || ""),
        }))
      : ourLog;
    const w = state.winner;
    const won = w === 0 || w === 1;
    const title = won ? `${players[w].name} wins!` : "It's a draw";
    const color = won ? TP.PLAYER_CSS[w] : "var(--text)";
    const wins = state.roundWins || [0, 0];
    const demo = params.has("demo");

    const card = showCard(`
      <h2 style="color:${color}">${esc(title)}</h2>
      <p class="tagline">${esc(players[0].name)} (${esc(players[0].fighter)}) ${wins[0]} – ${wins[1]} ${esc(players[1].name)} (${esc(players[1].fighter)})</p>
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
        <button class="btn" id="rematch" data-nav-primary>${demo ? "Watch again" : "Rematch"}</button>
      </div>`);
    card.querySelector("#rematch").addEventListener("click", () => {
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
    // Named after the seat colours so "who won" is never ambiguous. The
    // car names on the HUD come from the fight itself (?p1= / ?p2=).
    UI.setPlayers([
      { name: `${TP.DEFAULT_NAMES[0]} Bot`, controller: "bot" },
      { name: `${TP.DEFAULT_NAMES[1]} Bot`, controller: "bot" },
    ], winsFor(rounds));
    // match.js starts the demo by itself once the page has loaded.
  } else {
    showMenu();
  }
})();
