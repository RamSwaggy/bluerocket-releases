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
       trophies, coins and held items. Two extra markers:
         - whose turn it is: that card glows in the player's colour, gets a
           "TURN" tab hanging under it, and the other cards dim;
         - who's leading: a crown badge (most trophies, coins break ties).
           If everyone is level, nobody gets the crown. */
    setPlayers(players, activeIndex = -1) {
      const score = (p) => p.trophies * 10000 + p.coins;
      const best = Math.max(...players.map(score));
      const leaders = players.filter((p) => score(p) === best);
      const showCrown = leaders.length < players.length;
      const someoneActive = activeIndex >= 0;

      $("hud-players").innerHTML = players.map((p, i) => {
        const active = i === activeIndex;
        const lead = showCrown && score(p) === best;
        const cls = ["pcard", active ? "active" : "", someoneActive && !active ? "idle" : ""].join(" ");
        // --pc carries the player colour into the CSS (glow, tab, border).
        return `
        <div class="${cls}" style="--pc:${p.css}">
          ${lead ? `<div class="crown" title="In the lead">👑 1st</div>` : ""}
          <div class="top">
            <span class="name" style="color:${p.css}">${esc(p.name)}</span>
            <span class="tag">${esc(UI.shortController(p.controller))}</span>
          </div>
          <div class="stats"><span>🏆 ${p.trophies}</span><span>🪙 ${p.coins}</span>
            <span title="Items">${(p.items || []).map((id) => TP.ITEMS[id].icon).join("")}</span></div>
          ${active ? `<div class="turn-tab">▶ TURN</div>` : ""}
        </div>`;
      }).join("");
    },

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

    /* ---------- Left/right choice prompt ---------- */
    choice(title, options, selected) {
      const el = $("choice");
      if (!title) { el.classList.remove("show"); return; }
      el.innerHTML = `<div class="title">${esc(title)}</div>
        <div class="opts">${options.map((o, i) => `<div class="opt ${i === selected ? "sel" : ""}">${esc(o)}</div>`).join("")}</div>`;
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

    /* ---------- Full-screen card (menu, intros, results) ---------- */
    card(html) {
      $("card").innerHTML = html;
      $("overlay").classList.add("show");
      return $("card");
    },
    hideCard() { $("overlay").classList.remove("show"); },

    /* Clear everything transient (used between phases). */
    clearTransient() {
      UI.center("");
      UI.choice(null);
      UI.hint("");
    },
  };

  TP.UI = UI;
})();
