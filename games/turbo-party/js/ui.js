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

    /* ---------- Board HUD: one card per player ---------- */
    setPlayers(players, activeIndex = -1) {
      $("hud-players").innerHTML = players.map((p, i) => `
        <div class="pcard ${i === activeIndex ? "active" : ""}"
             style="border-color:${i === activeIndex ? p.css : "var(--line)"}">
          <div class="name" style="color:${p.css}">${esc(p.name)}</div>
          <div class="ctrl">${esc(TP.CONTROLLER_LABELS[p.controller])}</div>
          <div class="stats"><span>🏆 ${p.trophies}</span><span>🪙 ${p.coins}</span></div>
        </div>`).join("");
    },
    showPlayers(show) { $("hud-players").style.display = show ? "flex" : "none"; },

    turnLabel(text) { $("turn-label").textContent = text || ""; },

    /* ---------- Big centre text. Pass "" to clear. ---------- */
    center(text, sub = "", color = "") {
      $("center-msg").innerHTML = text
        ? `<span style="color:${color || "inherit"}">${esc(text)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}`
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

    /* ---------- Dice box. null hides it. ---------- */
    die(value) {
      const el = $("die");
      if (value == null) { el.classList.remove("show"); return; }
      el.textContent = value;
      el.classList.add("show");
    },

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
      UI.die(null);
      UI.choice(null);
      UI.hint("");
    },
  };

  TP.UI = UI;
})();
