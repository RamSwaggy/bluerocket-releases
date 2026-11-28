/* =====================================================================
   hud.js — on-screen text for Deflect Duel (chips, speed, callouts,
   menu/result cards). The 3D scene never draws text itself.
   ===================================================================== */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let toastTimer = null;
  let lastHud = "";
  let nav = null;   // gamepad/arrow-key navigation on the current card (TP.MenuNav)

  // Hook gamepad + arrow-key navigation onto a freshly drawn card,
  // dropping whatever was attached to the previous one.
  function attachNav(card, opts) {
    if (nav) nav.detach();
    nav = TP.MenuNav ? TP.MenuNav.attach(card, opts) : null;
  }
  function detachNav() { if (nav) { nav.detach(); nav = null; } }

  TP.HUD = {
    esc,

    /* Top bar: a chip per player (hearts = lives left) and the ball's
       speed in the middle. `ballCss` tints the speed by the ball's owner. */
    update(players, speed, ballCss) {
      if (!players) { $("hud").classList.remove("show"); lastHud = ""; return; }
      const half = Math.ceil(players.length / 2);
      const chip = (p) => `
        <div class="chip ${p.lives <= 0 ? "out" : ""}" style="border-color:${p.css}">
          <span style="color:${p.css}">${esc(p.name)}</span>
          <span class="lives">${p.lives > 0 ? "♥".repeat(p.lives) : "OUT"}</span>
        </div>`;
      const html =
        players.slice(0, half).map(chip).join("") +
        `<div id="speed"><div class="label">BALL SPEED</div>
           <div class="val" style="color:${ballCss}">${Math.round(speed)}</div></div>` +
        players.slice(half).map(chip).join("");
      // Only touch the DOM when something actually changed (it's per-frame).
      if (html !== lastHud) { $("hud").innerHTML = html; lastHud = html; }
      $("hud").classList.add("show");
    },

    center(text, sub = "", color = "") {
      $("center-msg").innerHTML = text
        ? `<span style="color:${color || "inherit"}">${esc(text)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}`
        : "";
    },

    toast(text, color = "", seconds = 1.4) {
      const el = $("toast");
      el.textContent = text;
      el.style.color = color || "";
      el.classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.classList.remove("show"), seconds * 1000);
    },

    /* A quick full-screen flash of colour (a KO, a smash). strength is
       the peak opacity (0..1); it fades out on its own. */
    flash(css, strength = 0.3) {
      const el = $("flash");
      el.classList.add("now");                 // jump straight to the peak...
      el.style.background = css || "#ffffff";
      el.style.opacity = String(strength);
      void el.offsetWidth;                     // (make the browser apply it now)
      el.classList.remove("now");              // ...then let the CSS fade take over
      el.style.opacity = "0";
    },

    hint(html) { $("hint").innerHTML = html || ""; },

    card(html) {
      $("card").innerHTML = html;
      $("overlay").classList.add("show");
      return $("card");
    },
    hideCard() { detachNav(); $("overlay").classList.remove("show"); },

    /* ---------- Title / setup menu ----------
       setup   — the hub's saved setup, { slots: [{ name, controller }] × 4 }
                 (from TP.Rumble.loadSetup()). Seat i's colour is always
                 TP.PLAYER_CSS[i], the same in every Rocket Rumble mode.
       lives   — starting choice, 3 or 5.
       onStart — called as onStart(setup, lives) with the edited setup.
       The setup is also saved back to the hub (TP.Rumble.saveSetup) so the
       next mode you open starts with the same players. */
    showMenu(setup, lives, onStart) {
      TP.HUD.update(null);
      TP.HUD.center("");
      TP.HUD.hint("");

      const slots = (setup && setup.slots ? setup.slots : TP.Rumble.loadSetup().slots).slice(0, 4);
      let pickedLives = lives === 5 ? 5 : 3;

      // Seat options: Off, then every known controller (Bot, Keyboard 1, ...).
      const LABELS = Object.assign({ off: "Off (empty)" }, TP.CONTROLLER_LABELS);
      const IDS = ["off", ...TP.CONTROLLER_IDS];
      const opts = (sel) => IDS.map((id) =>
        `<option value="${id}" ${id === sel ? "selected" : ""}>${esc(LABELS[id])}</option>`).join("");

      const card = TP.HUD.card(`
        <h1><span class="t1">DEFLECT</span> <span class="t2">DUEL</span></h1>
        <p>One ball, and it speeds up with every hit. It glows in the colour of whoever
           hit it last and knocks out anyone else it touches. Swing to send it back,
           jump to dodge it. Last car standing wins.</p>

        <div class="slots">
          ${[0, 1, 2, 3].map((i) => `
            <div class="slot" id="slot${i}" style="border-color:${TP.PLAYER_CSS[i]}">
              <label for="name${i}">Seat ${i + 1}</label>
              <input id="name${i}" maxlength="12" value="${esc(slots[i] ? slots[i].name : TP.DEFAULT_NAMES[i])}" />
              <select id="ctrl${i}">${opts(slots[i] ? slots[i].controller : "bot")}</select>
            </div>`).join("")}
        </div>

        <div class="row">
          <span class="muted">Lives</span>
          <span class="seg" id="lives">
            <button data-v="3">3</button><button data-v="5">5</button>
          </span>
          <span class="muted" id="padinfo"></span>
          <span class="muted">· <kbd>M</kbd> mutes</span>
        </div>

        <table class="controls-table">
          <tr><td>Keyboard 1</td><td>Drive <kbd>W</kbd><kbd>S</kbd> · Steer/aim <kbd>A</kbd><kbd>D</kbd> · Hit <kbd>E</kbd> · Jump <kbd>Space</kbd> · Boost <kbd>Shift</kbd></td></tr>
          <tr><td>Keyboard 2</td><td>Drive <kbd>↑</kbd><kbd>↓</kbd> · Steer/aim <kbd>←</kbd><kbd>→</kbd> · Hit <kbd>.</kbd> · Jump <kbd>Enter</kbd> · Boost <kbd>R-Shift</kbd></td></tr>
          <tr><td>Gamepad</td><td>Gas <kbd>RT</kbd> · Reverse <kbd>LT</kbd> · Steer/aim stick · Hit <kbd>X</kbd>/<kbd>RB</kbd> · Jump <kbd>A</kbd> · Boost <kbd>B</kbd></td></tr>
          <tr><td>Tip</td><td>Hit while boosting for a <b>Smash</b>: a much faster ball.</td></tr>
        </table>

        <p class="error" id="menu-error"></p>
        <div class="btn-row">
          <button class="btn" id="start" data-nav-primary>Start duel</button>
          <a class="btn hub" href="${TP.Rumble.HUB_URL}">← All modes</a>
        </div>`);

      const livesEl = card.querySelector("#lives");
      const startBtn = card.querySelector("#start");
      const errEl = card.querySelector("#menu-error");

      const paintLives = () => livesEl.querySelectorAll("button").forEach((b) =>
        b.classList.toggle("on", Number(b.dataset.v) === pickedLives));
      livesEl.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        pickedLives = Number(b.dataset.v);
        paintLives();
      });
      paintLives();

      // Read the form back into a setup object.
      const read = () => [0, 1, 2, 3].map((i) => ({
        name: card.querySelector("#name" + i).value.trim() || TP.DEFAULT_NAMES[i],
        controller: card.querySelector("#ctrl" + i).value,
      }));

      /* Check the seats every time something changes: at least 2 must be
         active (not Off), and two people can't share one keyboard or pad.
         Start stays disabled, with the reason shown, until it's valid. */
      const validate = () => {
        const s = read();
        s.forEach((seat, i) => card.querySelector("#slot" + i).classList.toggle("off", seat.controller === "off"));
        const active = s.filter((seat) => seat.controller !== "off").length;
        const humans = s.map((seat) => seat.controller).filter((c) => c !== "off" && c !== "bot");
        const dup = humans.find((c, i) => humans.indexOf(c) !== i);
        let msg = "";
        if (active < 2) msg = "Turn on at least 2 seats (players or bots).";
        else if (dup) msg = `Two seats are both on ${TP.CONTROLLER_LABELS[dup]}. Give each person their own controller.`;
        errEl.textContent = msg;
        startBtn.disabled = !!msg;
        return !msg;
      };
      card.querySelectorAll("select, input").forEach((el) => {
        el.addEventListener("change", validate);
        el.addEventListener("input", validate);
      });
      validate();
      attachNav(card);

      // Show how many gamepads the browser can see (they wake on a button press).
      const padInfo = card.querySelector("#padinfo");
      const refreshPads = () => {
        if (!padInfo.isConnected) return;
        const pads = (navigator.getGamepads ? [...navigator.getGamepads()] : []).filter(Boolean);
        padInfo.textContent = pads.length ? `🎮 ${pads.length} gamepad(s)` : "🎮 Press a pad button to connect";
      };
      refreshPads();
      window.addEventListener("gamepadconnected", refreshPads);
      window.addEventListener("gamepaddisconnected", refreshPads);

      startBtn.addEventListener("click", () => {
        if (!validate()) return;
        const newSetup = { slots: read() };
        TP.Rumble.saveSetup(newSetup.slots);
        if (TP.sfx) { TP.sfx.unlock(); TP.sfx.play("go"); } // clicking counts as the audio "unlock" gesture
        window.removeEventListener("gamepadconnected", refreshPads);
        window.removeEventListener("gamepaddisconnected", refreshPads);
        TP.HUD.hideCard();
        if (onStart) onStart(newSetup, pickedLives);
      });
      return card;
    },

    /* ---------- Results card ----------
       result = { winner, places: [{ name, css, kos, livesLeft }] }
       places is in finishing order (1st first). winner may be a place
       entry, a name string, or null (no winner). */
    showResults(result, onRematch, onMenu) {
      TP.HUD.center("");
      TP.HUD.hint("");
      const places = (result && result.places) || [];
      const w = result && result.winner;
      const winName = w ? (typeof w === "string" ? w : w.name) : (places[0] && places[0].name);
      const winCss = (w && w.css) || (places[0] && places[0].css) || "var(--accent2)";
      const ord = (n) => ["1st", "2nd", "3rd", "4th"][n - 1] || n + "th"; // at most 4 players

      const card = TP.HUD.card(`
        <h2>${winName ? `<span style="color:${winCss}">${esc(winName)}</span> wins!` : "Draw!"}</h2>
        <p>Last car standing.</p>
        ${places.map((p, i) => `
          <div class="result-row ${i === 0 && winName ? "win" : ""}" style="border-color:${p.css}">
            <span class="place">${ord(i + 1)}</span>
            <span class="who" style="color:${p.css}">${esc(p.name)}</span>
            <span class="stat">${p.kos ?? 0} KO${(p.kos ?? 0) === 1 ? "" : "s"}</span>
            <span class="stat">${(p.livesLeft ?? 0) > 0 ? "♥".repeat(p.livesLeft) : "OUT"}</span>
          </div>`).join("")}
        <div class="btn-row">
          <button class="btn" id="rematch" data-nav-primary>Rematch</button>
          <button class="btn alt" id="menu">Menu</button>
          <a class="btn hub" href="${TP.Rumble.HUB_URL}">← All modes</a>
        </div>`);
      card.querySelector("#rematch").addEventListener("click", () => { TP.HUD.hideCard(); if (onRematch) onRematch(); });
      card.querySelector("#menu").addEventListener("click", () => { TP.HUD.hideCard(); if (onMenu) onMenu(); });
      // B / Escape on the results card goes back to the menu.
      attachNav(card, { onBack: () => { TP.HUD.hideCard(); if (onMenu) onMenu(); } });
      return card;
    },
  };
})();
