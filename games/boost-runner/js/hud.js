/* =====================================================================
   hud.js — everything drawn in HTML over the 3D picture (Art and UI).

   The 3D scene never draws text. This file is the only one that touches
   the HUD elements in index.html, so the rest of the code just says
   things like TP.BRHud.countdown(3).

   Pieces:
     • Player panels along the top: name, controller, round-win pips
       (●●○ for first to 3), boost bar. Grey with a "KO" stamp when out.
     • "Round N" chip, top centre.
     • Big centre text: 3-2-1-GO and short messages.
     • The STAGE: a box laid exactly over the 3D picture (the letterbox
       area, see camera.js). Inside it:
         – the danger edge: red-orange glow on the trailing 10%
         – a P1..P4 tag over every car
         – a pulsing ring round any car inside the danger edge
         – an arrow pinned to the screen edge for a car that's gone off
           the top, bottom or back, in that car's colour
     • Cards: round-win card and match-end card.
   ===================================================================== */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DANGER = 0.1; // the trailing 10% of the screen is the danger edge

  let players = [];      // [{ seat, name, css, controller }]
  let roundsToWin = 3;
  let marks = [];        // per seat: { tag, ring, arrow } elements
  let nav = null;        // TP.MenuNav handle while a card with buttons is up
  let toastTimer = null;

  const pips = (won, total) =>
    Array.from({ length: total }, (_, i) => `<span class="pip ${i < won ? "on" : ""}"></span>`).join("");

  const Hud = {
    esc,
    DANGER,

    /* Build the panels and per-car markers for a new match. */
    setup(list, toWin) {
      players = list;
      roundsToWin = toWin;
      $("hud-players").innerHTML = players.map((p) => `
        <div class="pcard" id="pc${p.seat}" style="--pc:${p.css}">
          <div class="top"><span class="name">${esc(p.name)}</span><span class="pips">${pips(0, roundsToWin)}</span></div>
          <div class="ctrl">${esc(p.controller === "bot" ? "Bot" : TP.CONTROLLER_LABELS[p.controller] || p.controller)}</div>
          <div class="boost"><i></i></div>
          <div class="ko">KO</div>
        </div>`).join("");
      $("marks").innerHTML = "";
      marks = players.map((p) => {
        const mk = (cls, html = "") => {
          const el = document.createElement("div");
          el.className = cls;
          el.style.setProperty("--pc", p.css);
          el.innerHTML = html;
          $("marks").appendChild(el);
          return el;
        };
        return {
          tag: mk("tag", `P${p.seat + 1}`),
          ring: mk("ring"),
          arrow: mk("arrow", `<b></b><span>P${p.seat + 1}</span>`),
        };
      });
    },

    show(on) {
      for (const id of ["hud-players", "round-label", "stage"]) $(id).style.display = on ? "" : "none";
    },

    // Lay the stage exactly over the 3D picture.
    setStage(vp) {
      Object.assign($("stage").style, { left: vp.x + "px", top: vp.y + "px", width: vp.w + "px", height: vp.h + "px" });
    },

    round(n) { $("round-label").textContent = n ? `ROUND ${n}` : ""; },

    /* Per-frame update.
       cars:  Gameplay's cars ({ seat, x, y, alive, boost, ... })
       wins:  round wins per seat
       cam:   the BRCamera (for world → stage pixels)
       Returns how deep the worst car is into the danger edge (0..1),
       so main.js can pitch the warning beep. */
    update(cars, wins, cam, state = "race") {
      // Rings and edge arrows only matter while racing. Once a round is
      // decided (round end, match end) the winner may drive off the
      // leading edge, and an arrow there would just be noise.
      const racing = state === "race";
      const vp = cam.viewport, v = cam.view;
      const dangerX = v.dangerX ?? v.left + (v.right - v.left) * DANGER;
      let worst = 0;
      for (const c of cars) {
        const pc = $("pc" + c.seat);
        const m = marks[c.seat];
        if (!pc || !m) continue;
        pc.classList.toggle("out", !c.alive);
        pc.querySelector(".boost i").style.width = Math.round(c.boost ?? 0) + "%";
        const pp = pc.querySelector(".pips");
        const want = pips(wins[c.seat] || 0, roundsToWin);
        if (pp.innerHTML !== want) pp.innerHTML = want;

        if (!c.alive) { m.tag.style.display = m.ring.style.display = m.arrow.style.display = "none"; continue; }
        const p = cam.toStage(c.x, c.y + 0.7);
        const inside = p.x >= 0 && p.x <= vp.w && p.y >= 0 && p.y <= vp.h;
        if (!racing) {
          m.ring.style.display = m.arrow.style.display = "none";
          m.tag.style.display = inside ? "" : "none";
          if (inside) m.tag.style.transform = `translate(${cam.toStage(c.x, c.y + 3.6).x}px, ${cam.toStage(c.x, c.y + 3.6).y}px)`;
          continue;
        }

        // Tag floats above the car's marker arrow.
        const tp = cam.toStage(c.x, c.y + 3.6);
        m.tag.style.display = inside ? "" : "none";
        m.tag.style.transform = `translate(${tp.x}px, ${tp.y}px)`;

        // Danger ring: how far into the trailing 10% is the car (0..1)?
        const k = c.x < dangerX ? Math.min(1, (dangerX - c.x) / (dangerX - v.left)) : 0;
        worst = Math.max(worst, k);
        m.ring.style.display = k > 0 && inside ? "" : "none";
        m.ring.style.transform = `translate(${p.x}px, ${p.y}px) scale(${1 + k * 0.4})`;

        // Off-screen arrow, pinned to the nearest edge.
        if (!inside) {
          const ax = Math.min(vp.w - 26, Math.max(26, p.x));
          const ay = Math.min(vp.h - 26, Math.max(26, p.y));
          const dir = p.y < 0 ? "up" : p.y > vp.h ? "down" : p.x > vp.w ? "right" : "left";
          m.arrow.dataset.dir = dir;
          m.arrow.style.display = "";
          m.arrow.style.transform = `translate(${ax}px, ${ay}px)`;
        } else m.arrow.style.display = "none";
      }
      // The danger glow brightens while anyone is in it.
      const d = $("danger");
      d.classList.toggle("hot", racing && worst > 0);
      return worst;
    },

    /* ---------- Big centre text ---------- */
    center(text, sub = "", color = "") {
      const el = $("center-msg");
      el.innerHTML = text
        ? `<span class="big" style="color:${color || "inherit"}">${esc(text)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}`
        : "";
      // Restart the pop-in animation every time the text changes.
      el.classList.remove("pop"); void el.offsetWidth; if (text) el.classList.add("pop");
    },
    countdown(n) { Hud.center(String(n)); },
    go() {
      Hud.center("GO!", "", "var(--good)");
      setTimeout(() => { if ($("center-msg").textContent === "GO!") Hud.center(""); }, 700);
    },

    toast(text, seconds = 1.4) {
      const el = $("toast");
      el.textContent = text;
      el.classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.classList.remove("show"), seconds * 1000);
    },

    /* ---------- Round-win card ----------
       info: { winner (seat or -1 for a draw), round, koOrder: [seats], wins } */
    roundCard(info) {
      const w = players.find((p) => p.seat === info.winner);
      const title = w
        ? `<h2 class="winner" style="color:${w.css}">${esc(w.name.toUpperCase())} TAKES THE ROUND</h2>`
        : `<h2 class="winner">DRAW</h2><p class="muted">Everyone went out together. No point this round.</p>`;
      const order = (info.koOrder || []).map((seat, i) => {
        const p = players.find((q) => q.seat === seat);
        return p ? `<li><span class="dot" style="background:${p.css}"></span>${esc(p.name)} <span class="muted">· out ${ordinal(i + 1)}</span></li>` : "";
      }).join("");
      const rows = players.map((p) => `
        <div class="wrow" style="--pc:${p.css}"><span class="who">${esc(p.name)}</span>
          <span class="pips">${pips(info.wins[p.seat] || 0, roundsToWin)}</span></div>`).join("");
      Hud.card(`<div class="eyebrow">ROUND ${info.round}</div>${title}
        <div class="wtable">${rows}</div>
        ${order ? `<ol class="koorder">${order}</ol>` : ""}
        <p class="muted small">Next round starting…</p>`, "round");
    },

    /* ---------- Match-end card ----------
       info: { winner, wins }; handlers: { rematch, menu } */
    matchCard(info, handlers) {
      const w = players.find((p) => p.seat === info.winner);
      const ranked = players.slice().sort((a, b) => (info.wins[b.seat] || 0) - (info.wins[a.seat] || 0));
      const rows = ranked.map((p, i) => `
        <div class="wrow" style="--pc:${p.css}"><span class="place">${i + 1}</span><span class="who">${esc(p.name)}</span>
          <span class="pips">${pips(info.wins[p.seat] || 0, roundsToWin)}</span>
          <span class="num">${info.wins[p.seat] || 0}</span></div>`).join("");
      const el = Hud.card(`<div class="eyebrow">MATCH OVER</div>
        <h1 class="winner" style="color:${w ? w.css : "var(--text)"}">${w ? esc(w.name.toUpperCase()) + " WINS!" : "NO WINNER"}</h1>
        <div class="wtable">${rows}</div>
        <div class="row">
          <a class="link" href="${TP.Rumble.HUB_URL}">← All modes</a>
          <button class="btn ghost" id="m-menu">Menu</button>
          <button class="btn" id="m-rematch" data-nav-primary>Rematch</button>
        </div>`, "match");
      el.querySelector("#m-rematch").addEventListener("click", () => handlers.rematch());
      el.querySelector("#m-menu").addEventListener("click", () => handlers.menu());
      Hud.attachNav(el, { onBack: () => handlers.menu() });
      return el;
    },

    /* ---------- Generic full-screen card ---------- */
    card(html, kind = "") {
      Hud.detachNav();
      const card = $("card");
      card.className = "card " + kind;
      card.innerHTML = html;
      $("overlay").classList.add("show");
      return card;
    },
    hideCard() {
      Hud.detachNav();
      $("overlay").classList.remove("show");
    },

    // Gamepad / arrow-key navigation for cards with buttons (shared helper).
    attachNav(el, opts) {
      Hud.detachNav();
      if (TP.MenuNav) nav = TP.MenuNav.attach(el, opts || {});
    },
    detachNav() { if (nav) { nav.detach(); nav = null; } },
  };

  function ordinal(n) { return n + (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"); }

  TP.BRHud = Hud;
})();
