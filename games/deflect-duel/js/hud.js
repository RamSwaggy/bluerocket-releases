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

    hint(html) { $("hint").innerHTML = html || ""; },

    card(html) {
      $("card").innerHTML = html;
      $("overlay").classList.add("show");
      return $("card");
    },
    hideCard() { $("overlay").classList.remove("show"); },
  };
})();
