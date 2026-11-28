/* =====================================================================
   ui.js — every piece of on-screen text (HUD, prompts, cards).

   The 3D scene never draws text; it all lives in HTML elements layered
   over the canvas (see index.html). This file is the only place that
   touches those elements, so the rest of the code just says things like
   TP.UI.toast("+3 coins").
   ===================================================================== */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let toastTimer = null;

  const UI = {
    esc,

    /* ---------- Board HUD: one card per player ----------
       Each card shows the name, a small controller tag (CPU / KEYS 1 / PAD 2),
       trophies, coins and held items. Extra markers:
         - whose turn it is: that card glows in the player's colour, gets a
           "TURN" tab hanging under it, and the other cards dim;
         - live rank: a place ribbon on every card's corner (gold 1st,
           silver 2nd, bronze 3rd, plain 4th), ranked on trophies, then
           coins. Players level on both share a place. If everyone is
           level, no ribbons are shown (nobody is ahead). When a player's
           place changes, their ribbon pops so the change is noticed;
         - coins count up or down to the new value instead of jumping, and
           the coin number flashes green (gain) or red (loss). */
    setPlayers(players, activeIndex = -1) {
      const places = UI.places(players);
      const showRanks = new Set(places).size > 1;
      const someoneActive = activeIndex >= 0;

      $("hud-players").innerHTML = players.map((p, i) => {
        const active = i === activeIndex;
        const cls = ["pcard", active ? "active" : "", someoneActive && !active ? "idle" : ""].join(" ");
        // Has this player's place changed since the last redraw? Then the
        // ribbon gets the "moved" animation this once.
        const moved = UI._lastPlaces[i] !== undefined && UI._lastPlaces[i] !== places[i];
        // The coin number starts from what was shown last time and is
        // counted toward the real value by the ticker below.
        if (UI._shownCoins[i] === undefined) UI._shownCoins[i] = p.coins;
        const shown = UI._shownCoins[i];
        const dir = p.coins > shown ? "up" : p.coins < shown ? "down" : "";
        // --pc carries the player colour into the CSS (glow, tab, border).
        return `
        <div class="${cls}" style="--pc:${p.css}">
          ${showRanks ? `<div class="rank r${places[i] + 1} ${moved ? "moved" : ""}" title="Current place">${UI.PLACE_NAMES[places[i]]}</div>` : ""}
          <div class="top">
            <span class="name" style="color:${p.css}">${esc(p.name)}</span>
            <span class="tag">${esc(UI.shortController(p.controller))}</span>
          </div>
          <div class="stats"><span>🏆 ${p.trophies}</span><span class="coins ${dir}">🪙 <b id="hud-coins-${i}">${shown}</b></span>
            <span title="Items">${(p.items || []).map((id) => TP.ITEMS[id] ? TP.ITEMS[id].icon : "").join("")}</span></div>
          ${active ? `<div class="turn-tab">▶ TURN</div>` : ""}
        </div>`;
      }).join("");
      UI._lastPlaces = places.slice();
      UI._players = players;
      UI._startCoinTicker();
    },

    PLACE_NAMES: ["1st", "2nd", "3rd", "4th"],

    /* Place (0 = 1st) for each player: most trophies first, coins break
       ties, and players level on both share the better place
       (e.g. [0, 1, 1, 3]). Same rule as the final standings. */
    places(players) {
      const score = (p) => p.trophies * 100000 + p.coins;
      return players.map((p) => players.filter((o) => score(o) > score(p)).length);
    },

    /* Coin counter animation. One scheduler job runs while any shown
       number differs from the real one, stepping it closer each frame
       (faster for big changes, so a +20 doesn't take forever). It runs on
       the game clock (TP.sched), so it keeps pace with ?speed=. */
    _shownCoins: [],
    _lastPlaces: [],
    _players: null,
    _ticking: false,
    _startCoinTicker() {
      if (UI._ticking) return;
      UI._ticking = true;
      let acc = 0;
      TP.sched.run((dt) => {
        const players = UI._players || [];
        acc += dt;
        // About 25 count-steps per second.
        if (acc < 0.04) return false;
        acc = 0;
        let busy = false;
        players.forEach((p, i) => {
          const shown = UI._shownCoins[i];
          if (shown === p.coins) return;
          const gap = p.coins - shown;
          const step = Math.max(1, Math.round(Math.abs(gap) / 8));
          UI._shownCoins[i] = shown + Math.sign(gap) * Math.min(step, Math.abs(gap));
          const el = document.getElementById("hud-coins-" + i);
          if (el) el.textContent = UI._shownCoins[i];
          if (UI._shownCoins[i] !== p.coins) busy = true;
          else if (el && el.parentNode) el.parentNode.classList.remove("up", "down");
        });
        if (!busy) UI._ticking = false;
        return !busy;
      });
    },

    /* ---------- Floating text bubble at a screen spot ----------
       Used for "+3 🪙" / "−3 🪙" over a car on the board. (x, y) are
       pixels from the top-left of the window; the board works them out by
       projecting the car's 3D position through the camera. The bubble
       rises and fades by itself (CSS animation), then removes itself. */
    popup(text, x, y, color = "#ffcc33", big = false) {
      const el = document.createElement("div");
      el.className = "popup" + (big ? " big" : "");
      el.textContent = text;
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.style.color = color;
      $("popups").appendChild(el);
      setTimeout(() => el.remove(), 1600);
    },

    /* ---------- Sliding banner ----------
       A wide coloured strip that sweeps in from the left, holds, then
       sweeps out to the right. For "Blue's turn", "Final 3 turns!" and
       other headline moments. Purely visual; game code waits with
       TP.sched.wait() for as long as it wants the banner up. */
    banner(title, sub = "", color = "#ffcc33", seconds = 1.4) {
      const el = $("banner");
      el.innerHTML = `<div class="strip" style="--bc:${color}">
          <span class="bt">${esc(title)}</span>${sub ? `<span class="bs">${esc(sub)}</span>` : ""}
        </div>`;
      // Restart the CSS animation (removing and re-adding the class
      // after a reflow is the standard trick).
      el.classList.remove("show");
      void el.offsetWidth;
      el.style.setProperty("--hold", seconds + "s");
      el.classList.add("show");
      TP.partySfx && TP.partySfx.play("whoosh");
      clearTimeout(UI._bannerTimer);
      UI._bannerTimer = setTimeout(() => el.classList.remove("show"), (seconds + 0.8) * 1000);
    },
    _bannerTimer: null,

    // Short controller name for the little tag on each player card.
    shortController(id) {
      if (id === "bot") return "CPU";
      if (id === "kb1") return "KEYS 1";
      if (id === "kb2") return "KEYS 2";
      const pad = /^pad(\d)$/.exec(id || "");
      return pad ? `PAD ${Number(pad[1]) + 1}` : String(id || "").toUpperCase();
    },
    showPlayers(show) { $("hud-players").style.display = show ? "flex" : "none"; },

    turnLabel(text) { $("turn-label").textContent = text || ""; },

    /* ---------- Big centre text. Pass "" to clear. ---------- */
    center(text, sub = "", color = "") {
      // The text sits in a dark rounded panel (.box) so it stays readable over
      // a busy 3D scene. The panel's top edge picks up the message colour.
      $("center-msg").innerHTML = text
        ? `<div class="box" style="--cc:${color || "var(--line)"}">
             <span class="main" style="color:${color || "inherit"}">${esc(text)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}
           </div>`
        : "";
    },

    /* ---------- Short pop-up note at the bottom ---------- */
    toast(text, seconds = 1.6) {
      const el = $("toast");
      el.textContent = text;
      el.classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.classList.remove("show"), seconds * 1000);
    },

    /* ---------- Hint bar. Accepts trusted HTML (we build it ourselves). ---------- */
    hint(html) { $("hint").innerHTML = html || ""; },

    /* ---------- Left/right choice prompt ----------
       Options are plain strings, or { label, disabled } where `disabled` is
       a short reason. Disabled ones are greyed out with the reason in small
       text underneath (e.g. "need 14🪙"). */
    choice(title, options, selected) {
      const el = $("choice");
      if (!title) { el.classList.remove("show"); return; }
      el.innerHTML = `<div class="title">${esc(title)}</div>
        <div class="opts">${options.map((o, i) => {
          const label = typeof o === "object" ? o.label : o;
          const why = typeof o === "object" ? o.disabled : "";
          const cls = ["opt", i === selected ? "sel" : "", why ? "off" : ""].join(" ");
          return `<div class="${cls}">${esc(label)}${why ? `<span class="why">${esc(why)}</span>` : ""}</div>`;
        }).join("")}</div>`;
      el.classList.add("show");
    },

    /* ---------- Minigame HUD: timer + score chips ---------- */
    mgHud(timerText, chips) {
      const el = $("mg-hud");
      if (timerText == null) { el.classList.remove("show"); el.innerHTML = ""; return; }
      el.innerHTML = `<div class="timer">${esc(timerText)}</div>` + chips.map((c) =>
        `<div class="score ${c.out ? "out" : ""}" style="border-color:${c.css}">
           <span style="color:${c.css}">${esc(c.name)}</span> ${esc(c.value)}
         </div>`).join("");
      el.classList.add("show");
    },

    /* ---------- Full-screen card (menu, intros, results) ----------
       Cards that contain buttons, links or dropdowns (the setup menu, the
       final standings) get controller navigation from the shared
       TP.MenuNav helper: D-pad / stick / arrow keys move a highlight, A or
       Enter presses it (MenuNav handles Enter itself), B or Escape presses
       the [data-nav-back] link, and
       Start presses [data-nav-primary].
       Cards with no buttons (minigame intro and results) don't attach it,
       so during a match only the game's own input code reads controllers
       and nothing fights the in-game choose() menus. */
    card(html) {
      UI._detachNav();
      $("card").innerHTML = html;
      $("overlay").classList.add("show");
      const card = $("card");
      if (TP.MenuNav && card.querySelector("button, a[href], select")) {
        UI._nav = TP.MenuNav.attach(card);
      }
      return card;
    },
    hideCard() {
      UI._detachNav();
      $("overlay").classList.remove("show");
      // Drop keyboard focus from the hidden card, so a Space or Enter meant
      // for the game can't "click" a button the player can no longer see.
      if (document.activeElement && $("card").contains(document.activeElement)) document.activeElement.blur();
    },
    _nav: null,
    _detachNav() {
      if (UI._nav) { UI._nav.detach(); UI._nav = null; }
    },

    /* Clear everything transient (used between phases). */
    clearTransient() {
      UI.center("");
      UI.choice(null);
      UI.hint("");
    },
  };

  TP.UI = UI;
})();
