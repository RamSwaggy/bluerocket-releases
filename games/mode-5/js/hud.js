/* =====================================================================
   hud.js — Mode 5 on-screen display: score bar, timer, banners, floating
   numbers, hints, round and match cards.

   Art & UI owns this file. The 3D scene never draws text; it all lives in
   HTML layered over the canvas. This file builds its own elements and its
   own stylesheet, so it works on any page that loads it.

   Usage:
     const hud = new TP.M5.Hud({ camera: world.camera });
     hud.setPlayers([{ name: "Blue", index: 0 }, ...]);   // or read from state.players
     hud.update(dt, TP.M5.match);                          // every frame (game time)

   State it reads each frame (all optional, read-only):
     state.timeLeft   seconds left in the round
     state.scores     per player: percent (0..100) or fraction (0..1) of the floor
     state.players    [{ name, index }] if setPlayers() wasn't called
     state.roundWins  per player: rounds won so far (shows pips)
     state.round / state.rounds   current round number / rounds in the match

   Events it reacts to (TP.M5.on):
     roundCountdown → "ROUND N" + 3-2-1 countdown (with beeps)   roundStart → GO!
     overdrive → OVERDRIVE banner    fill → "FILL +X%" pops up where it happened
     pop → "POPPED!" over the spot   hint → hint pill   roundEnd → round card
     matchEnd → match results card
   ===================================================================== */
(function () {
  "use strict";
  TP.M5 = TP.M5 || {};
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CSS = () => TP.M5.NEON_CSS || TP.PLAYER_CSS;

  /* ---------- The stylesheet (injected once) ----------
     Sizes use clamp() so the same HUD reads on a 390 px phone and a 1920 px
     monitor. Colours follow the Rocket Rumble tokens, pushed a bit neon. */
  const STYLE = `
  #m5-hud { position: fixed; inset: 0; pointer-events: none; z-index: 20;
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif; color: #f2f5ff;
    --m5-panel: rgba(8, 10, 26, 0.78); --m5-line: rgba(255,255,255,0.16); --m5-hot: #ff3d9a; --m5-gold: #ffd23f; }
  #m5-hud * { box-sizing: border-box; }

  /* ----- Top: timer + stacked score bar + player chips ----- */
  .m5-top { position: absolute; top: max(10px, env(safe-area-inset-top)); left: 0; right: 0;
    display: flex; flex-direction: column; align-items: center; gap: clamp(4px, 0.8vw, 8px); }
  .m5-timer { font-weight: 900; font-style: italic; font-variant-numeric: tabular-nums;
    font-size: clamp(22px, 4.2vw, 40px); line-height: 1; padding: 4px 16px 5px; border-radius: 12px;
    background: var(--m5-panel); border: 1px solid var(--m5-line); letter-spacing: .02em;
    text-shadow: 0 2px 0 rgba(0,0,0,.5); }
  .m5-timer.warn { color: #fff; animation: m5-pulse 1s infinite; border-color: #ff5a6e; }
  .m5-timer.od { background: linear-gradient(90deg, #7a1550, #a3123f); border-color: var(--m5-hot);
    box-shadow: 0 0 22px rgba(255,61,154,.55); }
  @keyframes m5-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.14); color: #ffd1d8; } }

  .m5-bar { position: relative; width: min(94vw, 860px); height: clamp(16px, 2.4vw, 24px);
    border-radius: 999px; background: rgba(10, 12, 30, .85); border: 2px solid var(--m5-line);
    overflow: hidden; display: flex; box-shadow: 0 6px 20px rgba(0,0,0,.45); }
  .m5-seg { height: 100%; transition: width .35s ease-out; position: relative; overflow: hidden;
    display: flex; align-items: center; justify-content: center; min-width: 0;
    font-weight: 800; font-size: clamp(10px, 1.4vw, 14px); color: rgba(0,0,0,.75); white-space: nowrap; }
  .m5-seg::after { content: ""; position: absolute; inset: 0 0 50% 0; background: rgba(255,255,255,.22); }
  .m5-seg.lead { animation: m5-shine 1.6s linear infinite; }
  @keyframes m5-shine { 0%,100% { filter: brightness(1); } 50% { filter: brightness(1.25); } }
  .m5-row.team { grid-template-columns: minmax(96px, 8.5em) 1fr 3.4em; }
  .m5-tdiv { flex: 0 0 4px; height: 100%; background: #04050d; }
  .m5-half { position: absolute; left: 50%; top: -2px; bottom: -2px; width: 2px; background: rgba(255,255,255,.4); }

  .m5-chips { display: flex; gap: clamp(4px, 1vw, 10px); flex-wrap: wrap; justify-content: center; max-width: 96vw; }
  .m5-chip { display: flex; align-items: center; gap: 6px; padding: 3px 10px 3px 6px; border-radius: 999px;
    background: var(--m5-panel); border: 1px solid var(--m5-line); font-size: clamp(11px, 1.4vw, 14px);
    font-weight: 700; white-space: nowrap; }
  .m5-chip .dot { width: 12px; height: 12px; border-radius: 50%; box-shadow: 0 0 8px currentColor; background: currentColor; }
  .m5-chip .pct { font-variant-numeric: tabular-nums; min-width: 3.2em; text-align: right; }
  .m5-chip .pips { display: inline-flex; gap: 3px; }
  .m5-chip .pip { width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid currentColor; }
  .m5-chip .pip.on { background: currentColor; }
  .m5-chip.win { border-color: currentColor; box-shadow: 0 0 16px currentColor; }
  .m5-team { align-self: center; font-size: 11px; font-weight: 800; letter-spacing: .12em; color: #9aa6c8; padding: 0 2px 0 6px; }
  @media (max-width: 520px) { .m5-chip .nm { display: none; } .m5-chip { padding: 2px 7px 2px 4px; gap: 4px; }
    .m5-chip .pct { min-width: 2.4em; } .m5-chip .pips { gap: 2px; } .m5-chip .pip { width: 6px; height: 6px; } }

  /* ----- Portrait phones: chips move to the bottom edge. The floor is
     square, so on a tall screen there's spare height below it anyway; this
     keeps the top light and puts the scores where thumbs aren't. ----- */
  @media (max-aspect-ratio: 3/4) {
    .m5-chips { position: fixed; left: 0; right: 0; margin: 0 auto; bottom: max(12px, env(safe-area-inset-bottom)); }
    .m5-chip { font-size: 14px; padding: 5px 10px 5px 6px; }
    .m5-hint { bottom: calc(max(12px, env(safe-area-inset-bottom)) + 48px); }
  }

  /* ----- Short landscape screens (phones on their side): one slim row.
     The bar already shows each colour's %, so the chips go. ----- */
  @media (max-height: 500px) and (min-aspect-ratio: 1/1) {
    .m5-top { flex-direction: row; justify-content: center; gap: 10px; top: max(6px, env(safe-area-inset-top)); }
    .m5-timer { font-size: 20px; padding: 3px 10px; }
    .m5-bar { width: min(70vw, 620px); height: 16px; }
    .m5-chips { display: none; }
  }

  /* ----- Big centre banner ----- */
  .m5-banner { position: absolute; left: 0; right: 0; top: 34%; text-align: center; transform: translateY(-50%); }
  .m5-banner .big { display: inline-block; font-weight: 900; font-style: italic; line-height: .95;
    font-size: clamp(54px, 13vw, 150px); letter-spacing: .01em;
    -webkit-text-stroke: clamp(1px, .25vw, 3px) rgba(0,0,0,.55);
    text-shadow: 0 6px 0 rgba(0,0,0,.45), 0 0 30px var(--glow, #fff), 0 0 70px var(--glow, #fff); }
  .m5-banner .sub { display: block; margin-top: 8px; font-weight: 800; font-size: clamp(16px, 3vw, 28px);
    letter-spacing: .14em; text-transform: uppercase; text-shadow: 0 2px 0 rgba(0,0,0,.6); }
  .m5-banner.in .big { animation: m5-slam .45s cubic-bezier(.2, 1.6, .4, 1) both; }
  .m5-banner.in .sub { animation: m5-fade .4s .1s both; }
  .m5-banner.out { animation: m5-fadeout .3s both; }
  @keyframes m5-slam { 0% { transform: scale(2.4) rotate(-6deg); opacity: 0; } 100% { transform: scale(1) rotate(-3deg); opacity: 1; } }
  @keyframes m5-fade { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @keyframes m5-fadeout { to { opacity: 0; transform: translateY(-50%) scale(.9); } }

  /* ----- Floating numbers over the arena ----- */
  /* Floating numbers start just above the car and rise away. */
  .m5-float { position: absolute; transform: translate(-50%, -100%); font-weight: 900; font-style: italic;
    white-space: nowrap; text-shadow: 0 2px 0 rgba(0,0,0,.6), 0 0 12px currentColor;
    -webkit-text-stroke: 1px rgba(0,0,0,.45); animation: m5-rise .9s ease-out both; }
  .m5-float.huge { text-shadow: 0 3px 0 rgba(0,0,0,.6), 0 0 18px currentColor, 0 0 40px currentColor; }
  @keyframes m5-rise { 0% { opacity: 0; transform: translate(-50%, -60%) scale(.6); }
    15% { opacity: 1; transform: translate(-50%, -100%) scale(1.12); }
    30% { transform: translate(-50%, -110%) scale(1); }
    100% { opacity: 0; transform: translate(-50%, -260%) scale(1); } }

  /* ----- Hint pill at the bottom ----- */
  .m5-hint { position: absolute; left: 50%; bottom: max(18px, env(safe-area-inset-bottom)); transform: translateX(-50%);
    max-width: 92vw; padding: 10px 18px; border-radius: 999px; background: var(--m5-panel);
    border: 1px solid var(--m5-line); font-size: clamp(14px, 2.2vw, 20px); font-weight: 700; text-align: center;
    opacity: 0; transition: opacity .3s, transform .3s; }
  .m5-hint.show { opacity: 1; transform: translateX(-50%) translateY(-4px); }
  .m5-hint b { color: var(--m5-gold); }
  .m5-hint { border-width: 2px; }
  .m5-hint .who { font-weight: 900; margin-right: 4px; }

  /* ----- Round / match cards ----- */
  /* The results card never covers the floor's middle: on wide screens it's
     a side panel on the right, on tall screens a bottom sheet. The camera
     reads its size (safe area) and frames the floor in the rest. */
  .m5-card-wrap { position: absolute; inset: 0; display: flex; opacity: 0; transition: opacity .35s; pointer-events: none; }
  .m5-card-wrap.show { opacity: 1; }
  .m5-card { pointer-events: auto; overscroll-behavior: contain; overflow: auto; padding: clamp(14px, 2.4vw, 24px); background: rgba(12, 15, 36, .93);
    border: 2px solid var(--m5-line); box-shadow: 0 24px 70px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.04) inset;
    transition: transform .45s cubic-bezier(.2,.9,.25,1); }
  .m5-card-wrap.side { justify-content: flex-end; align-items: flex-end; /* sits low so it clears the player chips */ padding: 16px max(16px, env(safe-area-inset-right)) 16px 16px; }
  .m5-card-wrap.side .m5-card { width: min(380px, 38vw); max-height: calc(100vh - 32px); border-radius: 22px; transform: translateX(110%); }
  .m5-card-wrap.sheet { justify-content: center; align-items: flex-end; }
  .m5-card-wrap.sheet .m5-card { width: 100%; max-width: 640px; max-height: 54vh; border-radius: 22px 22px 0 0; background: rgba(12, 15, 36, .98);
    padding-bottom: max(16px, env(safe-area-inset-bottom)); transform: translateY(110%); }
  .m5-card-wrap.show .m5-card { transform: none; }
  /* Big screens: scale the whole side panel up so it reads from the couch. */
  @media (min-width: 1500px) and (min-height: 800px) { .m5-card-wrap.side .m5-card { zoom: 1.3; width: min(380px, 30vw); } }
  @media (max-height: 500px) {
    .m5-card-wrap.side .m5-card { width: min(330px, 42vw); padding: 12px 14px; }
    .m5-card h2 { font-size: 24px !important; margin-bottom: 8px !important; }
    .m5-row { margin: 4px 0 !important; }
    .m5-stats { font-size: 12px !important; margin-top: 8px !important; }
    /* Very short landscape screens: drop the least important stat column
       so the whole card fits without scrolling. */
    .m5-stats .opt { display: none; }
    .m5-card .kicker { font-size: 11px; }
  }
  .m5-card .kicker { font-size: 13px; letter-spacing: .18em; color: #9aa6c8; text-transform: uppercase; }
  .m5-card h2 { margin: 2px 0 14px; font-size: clamp(26px, 3.4vw, 40px); font-style: italic; font-weight: 900; line-height: 1;
    text-shadow: 0 0 24px var(--glow, transparent); }
  .m5-row { display: grid; grid-template-columns: minmax(64px, 6.5em) 1fr 3.4em; gap: 10px; align-items: center; margin: 8px 0; }
  .m5-row .nm { font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .m5-row .track { height: 18px; border-radius: 999px; background: #1a2042; overflow: hidden; }
  .m5-row .fill { display: block; height: 100%; width: 0; border-radius: 999px; transition: width 1.1s cubic-bezier(.2,.8,.2,1);
    box-shadow: 0 0 14px currentColor; background: currentColor; }
  .m5-row.head { margin: 0 0 -2px; font-size: 12px; color: #9aa6c8; letter-spacing: .08em; text-transform: uppercase; }
  .m5-row .val { text-align: right; font-weight: 800; font-variant-numeric: tabular-nums; }
  .m5-row.win .nm::after { content: " ★"; color: var(--m5-gold); }
  .m5-stats { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 14px; }
  .m5-stats th { text-align: right; color: #9aa6c8; font-weight: 600; padding: 4px 6px; font-size: 12px; }
  .m5-stats td { text-align: right; padding: 6px; border-top: 1px solid var(--m5-line); font-variant-numeric: tabular-nums; }
  .m5-stats th:first-child, .m5-stats td:first-child { text-align: left; }
  .m5-card .foot { margin-top: 14px; color: #9aa6c8; font-size: 14px; text-align: center; }
  .m5-card .foot b { white-space: nowrap; }   /* never split "Blue 0" across lines */
  /* The buttons stay pinned to the bottom of the card even when the card
     has to scroll on a small screen, so "what next" is always reachable. */
  .m5-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: nowrap; margin-top: 14px;
    position: sticky; bottom: calc(-1 * clamp(14px, 2.4vw, 24px)); padding: 10px 0 clamp(14px, 2.4vw, 24px);
    margin-bottom: calc(-1 * clamp(14px, 2.4vw, 24px)); background: linear-gradient(0deg, rgba(12,15,36,1) 70%, rgba(12,15,36,0)); }
  .m5-actions .m5-act { white-space: nowrap; }
  .m5-act { font: inherit; font-weight: 900; font-style: italic; font-size: 16px; cursor: pointer; border-radius: 12px;
    padding: 10px 18px; min-height: 44px; border: 2px solid var(--m5-line); background: #1a2042; color: #f2f5ff;
    text-decoration: none; display: inline-flex; align-items: center; }
  .m5-act.primary { border: none; color: #1a0610; background: linear-gradient(90deg, #ffd23f, #ff3d9a); padding: 10px 26px; }
  .m5-act:focus-visible, .m5-act.rr-nav-focus { outline: 2px solid #ffd23f; outline-offset: 2px; }
  @media (max-height: 500px), (max-width: 420px) { .m5-actions { margin-top: 8px; } .m5-act { min-height: 38px; padding: 6px 12px; font-size: 14px; } .m5-act.primary { padding: 6px 18px; } }
  .m5-card .why { margin: -6px 0 12px; color: #c8d0ea; font-size: 14px; }

  @media (prefers-reduced-motion: reduce) {
    .m5-timer.warn, .m5-seg.lead { animation: none; }
    .m5-banner.in .big { animation: m5-fade .2s both; }
  }`;

  function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  // Score values may arrive as fractions (0..1) or percents (0..100).
  function toPercents(scores) {
    if (!scores) return null;
    const arr = Array.from(scores, (v) => Number(v) || 0);
    const sum = arr.reduce((a, b) => a + b, 0);
    return sum <= 1.0001 && arr.every((v) => v <= 1) ? arr.map((v) => v * 100) : arr;
  }
  const fmtTime = (s) => {
    s = Math.max(0, Math.ceil(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  // Colour words for team names ("Team Blue–Green"), by player index.
  const COLOR_WORDS = ["Blue", "Orange", "Green", "Pink"];

  class Hud {
    constructor(opts = {}) {
      this.camera = opts.camera || null;
      this.players = opts.players || null;
      this.time = 0;
      this.countdownLeft = 0;      // seconds left in the 3-2-1 (game time)
      this.lastCount = 0;
      this.bannerTimer = 0;
      this.hintTimer = 0;
      this.overdrive = false;

      if (!document.getElementById("m5-hud-style")) {
        const st = el("style");
        st.id = "m5-hud-style";
        st.textContent = STYLE;
        document.head.appendChild(st);
      }
      const root = el("div", "", document.body);
      root.id = "m5-hud";
      this.root = root;

      const top = el("div", "m5-top", root);
      this.timerEl = el("div", "m5-timer", top);
      this.barEl = el("div", "m5-bar", top);
      this.chipsEl = el("div", "m5-chips", top);
      this.bannerEl = el("div", "m5-banner", root);
      this.floatLayer = el("div", "", root);
      this.hintEl = el("div", "m5-hint", root);
      this.cardWrap = el("div", "m5-card-wrap", root);
      this.timerEl.textContent = "2:00";
      this.segs = [];
      this.listen();
    }

    setCamera(camera) { this.camera = camera; }

    // Players (indices) in team t, and that team's name from its colours.
    teamMembers(t) { return (this.players || []).filter((p) => (p.team ?? 0) === t).map((p) => p.index).sort(); }
    // "Team Blue–Green" (or "Blue–Green" when short, for tight spots).
    teamName(t, short) { return (short ? "" : "Team ") + this.teamMembers(t).map((i) => COLOR_WORDS[i % 4]).join("–"); }
    teamGradient(t) {
      const c = this.teamMembers(t).map((i) => CSS()[i % 4]);
      return `linear-gradient(90deg, ${c[0]}, ${c[c.length - 1]})`;
    }

    // Two rows (one per team) with a bar; `vals[t]` shown, `w(t)` = bar width %.
    teamRows(vals, w, fmt, winner) {
      return [0, 1].sort((a, b) => (vals[b] || 0) - (vals[a] || 0)).map((t) => `
        <div class="m5-row team ${t === winner ? "win" : ""}">
          <span class="nm" style="background:${this.teamGradient(t)};-webkit-background-clip:text;background-clip:text;color:transparent">${esc(this.teamName(t, true))}</span>
          <span class="track"><span class="fill" data-w="${w(t).toFixed(1)}" style="background:${this.teamGradient(t)};color:${CSS()[this.teamMembers(t)[0] % 4]}"></span></span>
          <span class="val">${fmt(vals[t] || 0)}</span>
        </div>`).join("");
    }

    // New match: clear anything left over from the last one.
    reset() {
      this.hideCard();
      this.countUp = null;
      this.clearBanner();
      this.overdrive = false;
      this.countdownLeft = 0;
      this.floatLayer.innerHTML = "";
      this.timerEl.classList.remove("warn", "od");
    }
    // teams: true when the match is 2v2 (players carry .team); chips are
    // then grouped by team with a small label in front of each group.
    setPlayers(players, teams = false) {
      this.teams = !!teams;
      this.players = this.teams ? players.slice().sort((a, b) => (a.team ?? 0) - (b.team ?? 0) || a.index - b.index) : players;
      this.buildBar();
    }
    show(on) { this.root.style.display = on ? "" : "none"; this.measureSafeArea(); }
    showTop(on) { this.root.querySelector(".m5-top").style.visibility = on ? "" : "hidden"; }

    // One segment + one chip per player. Built once; update() only resizes.
    buildBar() {
      const ps = this.players || [];
      this.barEl.innerHTML = "";
      this.chipsEl.innerHTML = "";
      let lastTeam = null, lastTeamSegs = false;
      this.segs = [];
      this.segs = ps.map((p) => {
        const i = p.index ?? 0;
        if (this.teams && p.team !== lastTeam) {
          lastTeam = p.team;
          el("span", "m5-team", this.chipsEl).textContent = this.teamName(p.team ?? 0).toUpperCase();
          // A dark divider in the bar between the two teams' segments.
          if (this.segs && lastTeamSegs) el("div", "m5-tdiv", this.barEl);
          lastTeamSegs = true;
        }
        const seg = el("div", "m5-seg", this.barEl);
        seg.style.background = CSS()[i % 4];
        seg.style.width = "0%";
        const chip = el("div", "m5-chip", this.chipsEl);
        chip.dataset.i = i;
        chip.style.color = CSS()[i % 4];
        chip.innerHTML = `<span class="dot"></span><span class="nm" style="color:#f2f5ff">${esc(p.name)}</span>
          <span class="pct" style="color:#f2f5ff">0%</span><span class="pips"></span>`;
        return { seg, chip, pct: chip.querySelector(".pct"), pips: chip.querySelector(".pips"), last: -1, lastWins: "" };
      });
      el("div", "m5-half", this.barEl);  // halfway marker: own more than this and you've basically won
    }

    /* ---------- Per frame ---------- */
    update(dt, state) {
      this.time += dt;
      state = state || TP.M5.match || {};
      if (!this.players && state.players) this.setPlayers(state.players.map((p, i) => ({ name: p.name, index: p.index ?? i })));

      // Timer.
      if (typeof state.timeLeft === "number") {
        const txt = fmtTime(state.timeLeft);
        if (txt !== this.timerEl.textContent) this.timerEl.textContent = txt;
        const live = !state.phase || state.phase === "play" || state.phase === "playing";
        this.timerEl.classList.toggle("warn", live && state.timeLeft <= 10 && state.timeLeft > 0);
        this.timerEl.classList.toggle("od", this.overdrive);
      }

      // Score bar + chips (only touch the DOM when a value changes).
      // After a round ends the bars count up from zero to the final floor.
      let pcts = toPercents(state.scores);
      if (this.countUp) {
        const c = this.countUp;
        c.t += dt;
        const u = Math.min(1, c.t / c.dur), ease = 1 - Math.pow(1 - u, 3);
        pcts = c.final.map((v) => v * ease);
        if (u >= 1) this.countUp = null;
      }
      if (pcts && this.segs.length) {
        const lead = Math.max(...pcts);
        this.segs.forEach((s, k) => {
          const i = this.players[k].index ?? k;
          const v = pcts[i] || 0;
          const shown = Math.round(v);
          if (shown !== s.last) {
            s.last = shown;
            s.seg.style.width = v.toFixed(2) + "%";
            s.seg.textContent = v >= 7 ? shown + "%" : "";
            s.pct.textContent = shown + "%";
          }
          s.seg.classList.toggle("lead", v > 0 && v === lead);
          const wins = state.roundWins ? state.roundWins[i] || 0 : null;
          const need = state.rounds ? Math.ceil(state.rounds / 2) : 0;
          const key = wins + "/" + need;
          if (wins != null && need > 1 && key !== s.lastWins) {
            s.lastWins = key;
            s.pips.innerHTML = Array.from({ length: need }, (_, n) => `<span class="pip ${n < wins ? "on" : ""}"></span>`).join("");
          }
        });
      }

      // A card waiting to slide in (counted in game time, so ?speed works).
      if (this.pending) {
        this.pending.t -= dt;
        if (this.pending.t <= 0) { const fn = this.pending.fn; this.pending = null; fn(); }
      }

      // Tell the camera how much of the screen the HUD covers (top / bottom),
      // so the arena is framed in the free space. Measured a few times a second.
      this.safeTimer = (this.safeTimer || 0) - dt;
      if (this.safeTimer <= 0) { this.safeTimer = 0.25; this.measureSafeArea(); }

      // Countdown: 3, 2, 1 on game time, with a beep for each number.
      if (this.countdownLeft > 0) {
        this.countdownLeft -= dt;
        const n = Math.ceil(this.countdownLeft);
        if (n !== this.lastCount && n > 0) {
          this.lastCount = n;
          this.banner(String(n), { sub: this.countSub, color: "#ffffff", glow: "#7dd3fc", hold: 0.9 });
          if (TP.M5.Audio) TP.M5.Audio.play("count");
        }
      }
      // Banner and hint timers.
      if (this.bannerTimer > 0) {
        this.bannerTimer -= dt;
        if (this.bannerTimer <= 0) { this.bannerEl.classList.remove("in"); this.bannerEl.classList.add("out"); }
      }
      if (this.hintTimer > 0) {
        this.hintTimer -= dt;
        if (this.hintTimer <= 0) { this.hintEl.classList.remove("show"); this.hintGap = 0.35; }
      } else if (this.hintQueue && this.hintQueue.length) {
        // Small gap between hints so each one reads as new.
        this.hintGap = (this.hintGap || 0) - dt;
        if (this.hintGap <= 0) { const h = this.hintQueue.shift(); this.hint(h.text, h.seconds, h.player); }
      }
    }

    // Queue a hint (Gameplay's tutorial hints arrive in bursts).
    queueHint(text, seconds = 3.5, player = null) {
      this.hintQueue = this.hintQueue || [];
      if (this.hintQueue.some((h) => h.text === text) || this.hintEl.dataset.text === text && this.hintTimer > 0) return;
      this.hintQueue.push({ text, seconds, player });
      if (this.hintQueue.length > 4) this.hintQueue.shift();   // never fall far behind
    }

    measureSafeArea() {
      const W = innerWidth || 1, H = innerHeight || 1;
      let top = 0, bottom = 0, right = 0;
      if (this.root.style.display !== "none") {
        for (const e of [this.timerEl, this.barEl, this.chipsEl]) {
          const r = e.getBoundingClientRect();
          if (!r.height) continue;
          if (r.top + r.height / 2 < H / 2) top = Math.max(top, r.bottom / H);
          else bottom = Math.max(bottom, (H - r.top) / H);
        }
        // An open results card: side panel → right edge, bottom sheet → bottom.
        if (this.cardWrap.classList.contains("show")) {
          const r = this.cardWrap.firstElementChild && this.cardWrap.firstElementChild.getBoundingClientRect();
          if (r && r.width) {
            if (this.cardWrap.classList.contains("side")) right = (W - r.left) / W;
            else bottom = Math.max(bottom, (H - r.top) / H);
          }
        }
      }
      // A little breathing room past the HUD edge.
      TP.M5.safeArea = { top: top ? top + 0.01 : 0, bottom: bottom ? bottom + 0.01 : 0, left: 0, right: right ? right + 0.01 : 0 };
    }

    /* ---------- Big centre banner ----------
       opts: sub (smaller line), color (text), glow (halo colour), hold (seconds) */
    banner(text, opts = {}) {
      const b = this.bannerEl;
      b.style.setProperty("--glow", opts.glow || opts.color || "#ffffff");
      b.innerHTML = `<span class="big" style="color:${opts.color || "#fff"}">${esc(text)}</span>` +
        (opts.sub ? `<span class="sub">${esc(opts.sub)}</span>` : "");
      b.classList.remove("in", "out");
      void b.offsetWidth;            // restart the CSS animation
      b.classList.add("in");
      this.bannerTimer = opts.hold ?? 1.2;
    }
    clearBanner() { this.bannerEl.innerHTML = ""; this.bannerTimer = 0; }

    // Start a 3-2-1 countdown (game time). `sub` shows under the numbers.
    countdown(seconds = 3, sub = "") {
      this.countdownLeft = seconds;
      this.lastCount = 0;
      this.countSub = sub;
    }

    /* ---------- Floating text at a world position ---------- */
    /* size: 0.5 (small) … 1.6 (huge). Font scales with the smaller screen
       side (vmin), so it's the same share of the screen on a phone or a TV. */
    floater(text, x, z, color = "#fff", size = 1, life = 0.9) {
      let left = 50, top = 45;
      if (this.camera) {
        const v = new THREE.Vector3(x, 3.2, z).project(this.camera);   // just above the car
        left = Math.min(90, Math.max(10, (v.x * 0.5 + 0.5) * 100));
        top = Math.min(88, Math.max(16, (-v.y * 0.5 + 0.5) * 100));
      }
      const f = el("div", "m5-float" + (size >= 1.4 ? " huge" : ""), this.floatLayer);
      f.style.left = left + "%";
      f.style.top = top + "%";
      f.style.color = color;
      f.style.fontSize = `clamp(13px, ${(2.4 * size + 0.6).toFixed(2)}vmin, ${Math.round(18 + 34 * size)}px)`;
      f.style.animationDuration = life + "s";
      f.textContent = text;
      f.addEventListener("animationend", () => f.remove());
      // Safety net in case animationend never fires (hidden tab, reduced motion).
      setTimeout(() => f.remove(), life * 1000 + 600);
    }

    // World position of a player's car, or null.
    carPos(p) {
      const m = TP.M5.match;
      const car = m && m.cars ? m.cars[TP.M5.pi(p)] : null;
      return car ? car.pos : null;
    }

    /* ---------- Hint pill ---------- */
    // player (optional): the hint is for that player, shown with their colour and name.
    hint(text, seconds = 3.5, player = null) {
      // Allow **bold** in hint text for key words.
      let html = esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
      const p = player != null && (this.players || []).find((q) => q.index === TP.M5.pi(player));
      if (p) {
        const c = CSS()[p.index % 4];
        html = `<span class="who" style="color:${c}">${esc(p.name)}</span> ${html}`;
        this.hintEl.style.borderColor = c;
        this.hintEl.style.boxShadow = `0 0 18px ${c}55`;
      } else {
        this.hintEl.style.borderColor = "";
        this.hintEl.style.boxShadow = "";
      }
      this.hintEl.innerHTML = html;
      this.hintEl.dataset.text = text;
      this.hintEl.classList.add("show");
      this.hintTimer = seconds;
    }

    /* ---------- Round end card ---------- */
    roundCard(e = {}, state = TP.M5.match || {}) {
      this.layoutCard();
      if (e.teams && e.teamScores) {
        const w = e.winner, round = e.round || state.round;
        const glow = w >= 0 ? CSS()[this.teamMembers(w)[0] % 4] : "#fff";
        this.openCard(`
          <div class="kicker">${round ? `Round ${round}` : "Round over"} · Teams</div>
          <h2 style="--glow:${glow};${w >= 0 ? `background:${this.teamGradient(w)};-webkit-background-clip:text;background-clip:text;color:transparent` : "color:#fff"}">${w >= 0 ? esc(this.teamName(w, true)) + " take it!" : "Dead heat!"}</h2>
          ${this.teamRows(e.teamScores, (t) => Math.min(100, e.teamScores[t] || 0), (v) => Math.round(v) + "%", w)}
          ${e.teamWins ? `<div class="foot">Rounds won: ${[0, 1].map((t) => `<b>${esc(this.teamName(t, true))} ${e.teamWins[t] || 0}</b>`).join(" · ")}</div>` : ""}`);
        return;
      }
      const ps = this.players || [];
      const pcts = toPercents(e.scores || state.scores) || ps.map(() => 0);
      const winner = e.winner;
      const order = ps.map((p, k) => ({ p, i: p.index ?? k })).sort((a, b) => (pcts[b.i] || 0) - (pcts[a.i] || 0));
      const wName = winner != null && winner >= 0 && ps.find((p, k) => (p.index ?? k) === winner);
      const glow = wName ? CSS()[winner % 4] : "#fff";
      const round = e.round || state.round;
      this.openCard(`
        <div class="kicker">${round ? `Round ${round}` : "Round over"}</div>
        <h2 style="--glow:${glow};color:${wName ? glow : "#fff"}">${wName ? `${esc(wName.name)} takes it!` : "Dead heat!"}</h2>
        ${order.map(({ p, i }) => `
          <div class="m5-row ${i === winner ? "win" : ""}" style="color:${CSS()[i % 4]}">
            <span class="nm" style="color:#f2f5ff">${esc(p.name)}</span>
            <span class="track"><span class="fill" data-w="${(pcts[i] || 0).toFixed(1)}"></span></span>
            <span class="val" style="color:#f2f5ff">${Math.round(pcts[i] || 0)}%</span>
          </div>`).join("")}
        ${state.roundWins ? `<div class="foot">Rounds won: ${order.map(({ p, i }) =>
          `<b style="color:${CSS()[i % 4]}">${esc(p.name)} ${state.roundWins[i] || 0}</b>`).join(" · ")}</div>` : ""}`);
    }

    /* ---------- Match results card ----------
       e.standings: player indices best-first (or [{index, ...}])
       e.stats:     per player { bestFill, pops, painted, distance, ... } — any keys shown */
    matchCard(e = {}) {
      this.layoutCard();
      const ps = this.players || [];
      const st = TP.M5.match || {};
      const oneRound = (st.rounds || 0) <= 1 || !e.roundWins;
      if (e.teams) return this.teamMatchCard(e, oneRound);
      const nameOf = (i) => { const p = ps.find((q, k) => (q.index ?? k) === i); return p ? p.name : `P${i + 1}`; };
      const order = (e.standings || ps.map((p, k) => p.index ?? k)).map((s) => (typeof s === "number" ? s : s.player ?? s.index));
      const champ = order[0];
      const draw = e.winner === -1;
      const stats = e.stats || [];
      const LABELS = { bestFill: "Best fill", fills: "Fills", pops: "Pops", distance: "Distance" };
      // Show the stats we know how to label, in this order, if present.
      const first = stats[champ] || stats[0] || {};
      const keys = Object.keys(LABELS).filter((k) => typeof first[k] === "number");
      // painted is a cell count from Gameplay; turn it into % of the floor if we can.
      const grid = TP.M5.match && TP.M5.match.grid;
      const fmt = (k, v) => (v == null ? "–" : k === "distance" ? Math.round(v) + " m" :
        k === "bestFill" ? (Math.round(v * 10) / 10) + "%" :
        k === "painted" ? (grid && grid.paintable ? Math.round((v / grid.paintable) * 100) + "%" : Math.round(v)) : Math.round(v * 10) / 10);
      // If the top two finished level on rounds, say how it was decided
      // (most floor painted over the whole match), so the result isn't a mystery.
      const sds = e.standings || [];
      const tiedOnRounds = !oneRound && sds.length > 1 && typeof sds[0] === "object" && sds[0].roundWins === sds[1].roundWins;
      const whyLine = draw ? `<div class="why">Level on rounds and on paint.</div>`
        : tiedOnRounds ? `<div class="why">Tied on rounds, so the most floor painted over the match decides.</div>` : "";
      const need = Math.floor((st.rounds || 1) / 2) + 1;
      this.openCard(`
        <div class="kicker">Match over</div>
        <h2 style="--glow:${CSS()[champ % 4]};color:${CSS()[champ % 4]}">${draw ? "It's a draw!" : esc(nameOf(champ)) + " wins!"}</h2>
        ${whyLine}
        <div class="m5-row head"><span>Player</span><span>${oneRound ? "Final floor" : "Rounds won"}</span><span style="text-align:right">${oneRound ? "%" : "Wins"}</span></div>
        ${order.map((i, rank) => {
          // One round: bars = final % of the floor. Several: bars = rounds won.
          const sd = (e.standings || []).find((x) => x && x.player === i);
          const pct = sd && sd.totalPct != null ? sd.totalPct : (toPercents(st.scores) || [])[i] || 0;
          const wins = e.roundWins ? e.roundWins[i] || 0 : 0;
          // Bar = progress toward the rounds needed to win the match.
          const w = oneRound ? Math.min(100, pct) : Math.min(100, (wins / need) * 100);
          return `<div class="m5-row ${rank === 0 && !draw ? "win" : ""}" style="color:${CSS()[i % 4]}">
          <span class="nm" style="color:#f2f5ff">${rank + 1}. ${esc(nameOf(i))}</span>
          <span class="track"><span class="fill" data-w="${w.toFixed(1)}"></span></span>
          <span class="val" style="color:#f2f5ff">${oneRound ? Math.round(pct) + "%" : wins}</span></div>`;
        }).join("")}
        ${keys.length ? `<table class="m5-stats"><tr><th>Player</th>${keys.map((k) => `<th${k === "distance" ? ' class="opt"' : ""}>${esc(LABELS[k] || k)}</th>`).join("")}</tr>
          ${order.map((i) => `<tr><td style="color:${CSS()[i % 4]};font-weight:800">${esc(nameOf(i))}</td>
            ${keys.map((k) => `<td${k === "distance" ? ' class="opt"' : ""}>${fmt(k, stats[i] && stats[i][k])}</td>`).join("")}</tr>`).join("")}</table>` : ""}
        ${this.actionsHtml()}`);
    }

    // Match card for 2v2: team rows (rounds won, or final floor for one round)
    // and the per-player stats table.
    teamMatchCard(e, oneRound) {
      const w = e.winner;
      const st = TP.M5.match || {};
      const tot = [0, 1].map((t) => (e.standings || []).filter((x) => x.team === t).reduce((a, x) => a + (x.totalPct || 0), 0));
      const vals = oneRound ? tot : (e.teamWins || [0, 0]);
      const most = Math.max(1, ...vals);
      const glow = w >= 0 ? CSS()[this.teamMembers(w)[0] % 4] : "#fff";
      const stats = e.stats || [];
      const ps = this.players || [];
      this.openCard(`
        <div class="kicker">Match over · Teams</div>
        <h2 style="--glow:${glow};${w >= 0 ? `background:${this.teamGradient(w)};-webkit-background-clip:text;background-clip:text;color:transparent` : "color:#fff"}">${w >= 0 ? esc(this.teamName(w, true)) + " win!" : "It's a draw!"}</h2>
        <div class="m5-row head"><span>Team</span><span>${oneRound ? "Final floor" : "Rounds won"}</span><span style="text-align:right">${oneRound ? "%" : "Wins"}</span></div>
        ${this.teamRows(vals, (t) => (oneRound ? Math.min(100, vals[t]) : (vals[t] / most) * 100), (v) => (oneRound ? Math.round(v) + "%" : v), w)}
        ${stats.length ? `<table class="m5-stats"><tr><th>Player</th><th>Best fill</th><th>Fills</th><th>Pops</th></tr>
          ${ps.map((p) => `<tr><td style="color:${CSS()[p.index % 4]};font-weight:800">${esc(p.name)}</td>
            <td>${stats[p.index] ? Math.round(stats[p.index].bestFill * 10) / 10 + "%" : "–"}</td>
            <td>${stats[p.index] ? stats[p.index].fills : "–"}</td><td>${stats[p.index] ? stats[p.index].pops : "–"}</td></tr>`).join("")}</table>` : ""}
        ${this.actionsHtml()}`);
    }

    // Side panel on wide screens, bottom sheet on tall ones.
    layoutCard() {
      const side = innerWidth / Math.max(1, innerHeight) >= 1.1;
      this.cardWrap.classList.toggle("side", side);
      this.cardWrap.classList.toggle("sheet", !side);
    }

    openCard(html) {
      this.clearBanner();   // never draw a banner over a card
      this.cardWrap.innerHTML = `<div class="m5-card">${html}</div>`;
      void this.cardWrap.offsetWidth;
      this.cardWrap.classList.add("show");
      // Let the bars grow from zero (CSS transition) a moment after showing.
      setTimeout(() => this.cardWrap.querySelectorAll(".fill").forEach((f) => { f.style.width = f.dataset.w + "%"; }), 60);
      setTimeout(() => this.measureSafeArea(), 500);
      this.wireActions();
    }

    /* ---------- What next? (match results only) ----------
       Rematch (same players and options), Menu (back to the title menu),
       or ← All modes (the Rocket Rumble hub). Mouse/touch, keyboard
       (Rematch is focused, so Enter/Space press it; Tab moves) and
       gamepad (shared TP.MenuNav: d-pad + A, Start = Rematch). */
    actionsHtml() {
      return `<div class="m5-actions">
        <button type="button" class="m5-act primary" data-act="rematch" data-nav-primary>Rematch</button>
        <button type="button" class="m5-act" data-act="menu">Menu</button>
        <a class="m5-act" href="${esc((TP.Rumble && TP.Rumble.HUB_URL) || "../index.html")}">← All modes</a>
      </div>`;
    }
    wireActions() {
      const box = this.cardWrap.querySelector(".m5-actions");
      if (!box) return;
      box.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-act]");
        if (!b) return;
        const act = b.dataset.act;
        this.hideCard();
        if (act === "rematch") { if (TP.M5.restart) TP.M5.restart(); }
        else if (act === "menu") { TP.M5.emit("quit"); if (TP.M5.Menu) TP.M5.Menu.open(); }
      });
      // Arrive a beat after the card so a button still held from play
      // (boost, jump) doesn't press anything by accident.
      setTimeout(() => {
        if (!this.cardWrap.classList.contains("show") || !box.isConnected) return;
        const first = box.querySelector("[data-act=rematch]");
        if (first) first.focus({ preventScroll: true });
        if (TP.MenuNav && !this.cardNav) this.cardNav = TP.MenuNav.attach(box, {});
      }, 600);
    }
    hideCard() {
      if (this.cardNav) { this.cardNav.detach(); this.cardNav = null; }
      this.cardWrap.classList.remove("show");
      this.pending = null;
      this.segs.forEach((s) => s.chip.classList.remove("win"));
    }

    /* ---------- Events ---------- */
    listen() {
      if (!TP.M5.on || this.listening) return;
      this.listening = true;
      const on = TP.M5.on;
      const colorOf = (p) => CSS()[TP.M5.pi(p) % 4];
      // Hidden behind the title menu, back for the first countdown.
      on("menuOpen", () => { this.hideCard(); this.clearBanner(); this.show(false); });
      on("quit", () => this.show(false));
      on("roundCountdown", (e = {}) => {
        // (Not while the title menu is up: a backdrop match plays behind it.)
        if (!(TP.M5.Menu && TP.M5.Menu.isOpen)) this.show(true);
        this.hideCard();
        this.overdrive = false;
        const round = e.round || 1;
        const arenaName = e.arenaName || (e.arena && e.arena.name) || "";
        this.countSub = `Round ${round}${arenaName ? " · " + arenaName : ""}`;
        // Gameplay sends "countdown" {n} each second; until the first one
        // arrives, show the round title.
        this.gotCount = false;
        this.banner(`ROUND ${round}`, { sub: arenaName, color: "#ffffff", glow: "#7dd3fc", hold: 1.0 });
      });
      on("countdown", (e) => {
        this.gotCount = true;
        if (!e.n) return; // 0 = GO, handled by roundStart
        this.banner(String(e.n), { sub: this.countSub, color: "#ffffff", glow: "#7dd3fc", hold: 0.9 });
        if (TP.M5.Audio) TP.M5.Audio.play("count");
      });
      on("roundStart", () => {
        this.countdownLeft = 0;
        this.banner("GO!", { color: "#ffd23f", glow: "#ff7a1f", hold: 0.8 });
      });
      on("overdrive", () => {
        this.overdrive = true;
        this.banner("OVERDRIVE", { sub: "Wider paint · more pickups", color: "#ff3d9a", glow: "#ff3d9a", hold: 1.8 });
      });
      on("fill", (e) => {
        const pct = e.pct || 0;
        // Tiny fills (closing a loop around a sliver) happen constantly;
        // only real ones earn a number on screen.
        if (pct < 0.5) return;
        // Size grows with the fill: small for 1–3 %, big and loud from 10 %.
        const size = pct >= 10 ? 1.6 : pct >= 3 ? 0.7 + ((pct - 3) / 7) * 0.6 : 0.5;
        const p = this.carPos(e.player) || { x: e.cx || 0, z: e.cz || 0 };
        const txt = `+${pct >= 1 ? Math.round(pct) : pct.toFixed(1)}%`;
        this.floater(pct >= 10 ? `FILL ${txt}!` : txt, p.x, p.z, colorOf(e.player), size, pct >= 10 ? 1.4 : 0.9);
      });
      on("pop", (e) => !e.minor && this.floater("POPPED!", e.x || 0, e.z || 0, colorOf(e.victim), 0.75, 1.0));
      on("pickup", (e) => {
        const NAMES = { bomb: "PAINT BOMB!", mega: "MEGA ROLLER!", boost: "BOOST!" };
        const p = this.carPos(e.player);
        if (p) this.floater(NAMES[e.kind] || "PICKUP!", p.x, p.z, "#ffffff", 0.55);
      });
      // Tie-break round from Gameplay.
      on("suddenDeath", () => {
        this.banner("SUDDEN DEATH", { sub: "Tie-break round · most floor wins", color: "#ff3d6e", glow: "#ff3d6e", hold: 2.4 });
      });
      on("hint", (e) => this.queueHint(e.text || "", e.seconds || 3.5, e.player ?? null));
      /* Round over: a quick "TIME!", then ~2 s of the clean final floor
         (overhead camera) while the score bar counts up from zero and the
         winner's chip lights up, THEN the card slides in from the side.
         On the deciding round we skip the round card: the floor stays clean
         until the match card. */
      on("roundEnd", (e) => {
        this.overdrive = false;
        this.timerEl.classList.remove("warn", "od");
        this.banner("TIME!", { color: "#ffffff", glow: "#7dd3fc", hold: 0.8 });
        this.countUp = { t: 0, dur: 1.6, final: toPercents(e.scores) || [] };
        this.segs.forEach((s) => {
          const i = s.chip.dataset.i | 0;
          s.chip.classList.toggle("win", e.teams ? e.teams[i] === e.winner : i === e.winner);
        });
        const st = TP.M5.match || {};
        const wins = e.roundWins || st.roundWins || [];
        const need = Math.floor((st.rounds || 1) / 2) + 1;
        const final = (st.rounds || 1) <= 1 || Math.max(0, ...wins) >= need || (e.round || st.round) >= (st.rounds || 1);
        this.pending = final ? null : { t: 2.0, fn: () => this.roundCard(e) };
      });
      on("matchEnd", (e) => { this.pending = { t: 0.2, fn: () => this.matchCard(e) }; });
    }

    dispose() { this.root.remove(); }
  }

  TP.M5.Hud = Hud;
  // main.js looks for TP.M5.HUD (capitals) to know the real HUD is here.
  TP.M5.HUD = Hud;
})();
