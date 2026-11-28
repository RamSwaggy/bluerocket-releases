/* =====================================================================
   menu.js — Mode 5 title menu, match options, how-to-play strip, and the
   pause overlay.

   Art & UI owns this file. It never starts the game itself: it tells
   Gameplay what the players chose, through events.

   Usage:
     TP.M5.Menu.open();          // show the title menu (index.html does this at boot)

   Starting: Start calls Gameplay's TP.M5.startMatch({ players, rounds,
   roundTime, arena, botLevel, teams }). While the menu is open a quiet
   all-bot match plays behind it as a backdrop (also via startMatch).
     TP.M5.Pause.enabled = true; // done for you on Start; Esc / gamepad Start then pause

   Events it emits (TP.M5.emit):
     menuOpen                           the menu is on screen (HUD hides itself)
     menuStart { slots, options }       Start pressed. slots = 4 × { name, controller },
                                        where an "off" seat is already turned into "bot".
                                        options = { rounds, roundLength, difficulty, arena, teams }
     pause / resume / restart / quit    from the pause overlay (quit = back to this menu)

   Player seats come from the shared Rocket Rumble setup
   (TP.Rumble.loadSetup) and are saved back with TP.Rumble.saveSetup on
   Start. Options are remembered in localStorage under
   "rocketRumble.mode5.options" (silently skipped if storage is blocked).

   Input: mouse/touch everywhere; Enter / Space / gamepad A = Start on the
   menu; Esc / gamepad Start = pause; arrows / W S / d-pad + Enter / Space / A
   to pick in the pause overlay. Gamepads are read directly here (the
   shared input module doesn't expose the Start button).
   ===================================================================== */
(function () {
  "use strict";
  TP.M5 = TP.M5 || {};
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const emit = (name, data) => { if (TP.M5.emit) TP.M5.emit(name, data); };
  const NEON_CSS = () => TP.M5.NEON_CSS || ["#3d8bff", "#ff7a1f", "#2ee86a", "#ff4fb0"];
  const click = () => { if (TP.M5.Audio) TP.M5.Audio.play("hint"); };

  /* ---------- Match options ---------- */
  const OPT_KEY = "rocketRumble.mode5.options";
  const OPTIONS = [
    { key: "rounds", label: "Rounds", def: 3, choices: [[1, "1 round"], [3, "Best of 3"], [5, "Best of 5"]] },
    { key: "roundLength", label: "Round length", def: 120, choices: [[90, "1:30"], [120, "2:00"], [180, "3:00"]] },
    { key: "difficulty", label: "Bots", def: "normal", choices: [["easy", "Easy"], ["normal", "Normal"], ["hard", "Hard"]] },
    // Arena choices are filled in from Gameplay's TP.M5.ARENAS (see arenaChoices()).
    { key: "arena", label: "Arena", def: "random", choices: [["random", "Random"]] },
    { key: "teams", label: "Teams", def: "ffa", choices: [["ffa", "Free-for-all"], ["2v2", "2 v 2"]] },
  ];

  // "Random" plus every arena Gameplay has defined.
  function arenaChoices() {
    const def = OPTIONS.find((d) => d.key === "arena");
    def.choices = [["random", "Random"]].concat((TP.M5.ARENAS || []).map((a) => [a.id, a.name]));
  }

  const SHORT_LABELS = { off: "Empty", bot: "Bot", kb1: "Keys WASD", kb2: "Keys ↑↓",
    pad0: "Pad 1", pad1: "Pad 2", pad2: "Pad 3", pad3: "Pad 4" };
  const narrow = () => innerWidth < 600;
  const HELP_KEY = "rocketRumble.mode5.seenHelp";

  function loadOptions() {
    arenaChoices();
    const o = {};
    OPTIONS.forEach((d) => { o[d.key] = d.def; });
    try {
      const saved = JSON.parse(localStorage.getItem(OPT_KEY) || "{}");
      // Only accept values that are still valid choices.
      OPTIONS.forEach((d) => { if (d.choices.some((c) => c[0] === saved[d.key])) o[d.key] = saved[d.key]; });
    } catch (e) { /* blocked or corrupt storage: use defaults */ }
    return o;
  }
  function saveOptions(o) {
    try { localStorage.setItem(OPT_KEY, JSON.stringify(o)); } catch (e) { /* fine */ }
  }

  /* ---------- Stylesheet (injected once) ---------- */
  const STYLE = `
  .m5m { position: fixed; inset: 0; z-index: 40; display: none; flex-direction: column;
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif; color: #f2f5ff;
    background: radial-gradient(ellipse at 50% 0%, rgba(20, 24, 70, .55), rgba(4, 5, 13, .88) 70%);
    --line: rgba(255,255,255,.14); --muted: #9aa6c8; --panel: rgba(10, 13, 34, .86); --gold: #ffd23f; --hot: #ff3d9a; --cyan: #7dd3fc; }
  .m5m.show { display: flex; }
  .m5m * { box-sizing: border-box; }
  .m5m-scroll { flex: 1; overflow-y: auto; padding: max(14px, env(safe-area-inset-top)) 16px 12px; }
  .m5m-inner { max-width: 1180px; margin: 0 auto; }

  /* ----- Logo: "NEON" as a hollow glowing tube, "TURF" filled with the four paint colours ----- */
  .m5m-head { text-align: center; margin: clamp(4px, 2vh, 22px) 0 clamp(10px, 2.4vh, 22px); }
  .m5m-kicker { font-size: 12px; letter-spacing: .3em; color: var(--muted); text-transform: uppercase; }
  .m5m-logo { margin: 2px 0 0; font-size: clamp(48px, 10vw, 118px); font-weight: 900; font-style: italic;
    line-height: .92; letter-spacing: .02em; transform: skewX(-6deg); white-space: nowrap; }
  .m5m-logo .neon { color: transparent; -webkit-text-stroke: clamp(2px, .35vw, 4px) #bff3ff;
    text-shadow: 0 0 12px var(--cyan), 0 0 34px #38bdf8, 0 0 70px rgba(56,189,248,.6); margin-right: .18em;
    animation: m5m-flicker 6s infinite; }
  .m5m-logo .turf { background: linear-gradient(100deg, #3d8bff 0 25%, #ff7a1f 25% 50%, #2ee86a 50% 75%, #ff4fb0 75%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    filter: drop-shadow(0 0 14px rgba(255,79,176,.55)) drop-shadow(0 5px 0 rgba(0,0,0,.5)); }
  @keyframes m5m-flicker { 0%, 92%, 100% { opacity: 1; } 93% { opacity: .55; } 94% { opacity: 1; } 96% { opacity: .7; } }
  .m5m-tag { margin: 8px 0 0; color: #c9d2ee; font-size: clamp(14px, 1.8vw, 18px); }
  .m5m-tiles { display: inline-flex; gap: 5px; margin-top: 10px; }
  .m5m-tiles i { width: 14px; height: 14px; border-radius: 3px; display: block; animation: m5m-tile 2.4s infinite; }
  .m5m-tiles i:nth-child(2) { animation-delay: .15s; } .m5m-tiles i:nth-child(3) { animation-delay: .3s; } .m5m-tiles i:nth-child(4) { animation-delay: .45s; }
  @keyframes m5m-tile { 0%, 60%, 100% { transform: none; filter: none; } 20% { transform: translateY(-5px); filter: brightness(1.5); } }

  /* ----- Layout: players | options on top, how-to-play below ----- */
  .m5m-grid { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 14px; }
  .m5m-panel { background: var(--panel); border: 1px solid var(--line); border-radius: 18px; padding: 16px;
    backdrop-filter: blur(6px); }
  .m5m-panel h2 { margin: 0 0 10px; font-size: 15px; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
  /* How to play: a panel over the menu (first visit, or the "?" button). */
  .m5m-howwrap { position: absolute; inset: 0; z-index: 2; display: none; align-items: center; justify-content: center;
    padding: 16px; background: rgba(4, 5, 13, .78); backdrop-filter: blur(4px); overflow-y: auto; }
  .m5m-howwrap.show { display: flex; }
  .m5m-how { width: min(1040px, 100%); max-height: 100%; overflow-y: auto; box-shadow: 0 24px 70px rgba(0,0,0,.6); }
  .m5m-how h2 { color: #fff !important; font-size: 18px !important; }
  .m5m-howfoot { display: flex; justify-content: center; margin-top: 14px; }
  .m5m-gotit { padding: 10px 40px !important; min-height: 48px !important; }
  .m5m-help { font-size: 16px; font-style: normal; font-weight: 800; padding: 12px 18px; min-height: 48px; color: #1a1300;
    background: #ffd23f; box-shadow: 0 0 16px rgba(255,210,63,.35); gap: 8px; }
  .m5m-help .q { display: inline-flex; width: 22px; height: 22px; border-radius: 50%; align-items: center; justify-content: center;
    background: #1a1300; color: #ffd23f; font-size: 14px; }

  /* ----- Seats ----- */
  .m5m-seat { display: grid; grid-template-columns: 1fr 1.25fr; gap: 8px; align-items: center; margin-bottom: 8px;
    padding: 8px 8px 8px 12px; border-radius: 12px; background: #141a3c; border-left: 6px solid; }
  .m5m-seat.bot { opacity: .78; }
  .m5m-seat input, .m5m-seat select { width: 100%; font: inherit; font-size: 15px; padding: 8px 9px; border-radius: 9px;
    border: 1px solid var(--line); background: #0b1030; color: #f2f5ff; min-height: 40px; }
  .m5m-seat input:focus, .m5m-seat select:focus, .m5m-seg button:focus-visible, .m5m-btn:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  .m5m-ctrls { margin-top: 10px; font-size: 13px; color: var(--muted); line-height: 1.6; }
  .m5m-ctrls b { font-weight: 800; }
  kbd.m5k { display: inline-block; padding: 0 6px; border-radius: 5px; background: #26305a; color: #f2f5ff;
    font: 600 12px "Segoe UI", system-ui, sans-serif; border-bottom: 2px solid #0a0f22; }

  /* ----- Option segments ----- */
  .m5m-opt { display: grid; grid-template-columns: 7.5em 1fr; gap: 8px; align-items: center; margin-bottom: 9px; }
  .m5m-opt > span { font-size: 14px; color: #c9d2ee; font-weight: 600; }
  .m5m-seg { display: flex; flex-wrap: wrap; gap: 5px; }
  .m5m-seg button { flex: 1 1 auto; font: inherit; font-size: 14px; font-weight: 700; padding: 8px 10px; min-height: 38px;
    border-radius: 9px; border: 1px solid var(--line); background: #141a3c; color: #c9d2ee; cursor: pointer; }
  .m5m-seg button[aria-pressed="true"] { background: linear-gradient(180deg, #2b3784, #1d2766); color: #fff;
    border-color: var(--cyan); box-shadow: 0 0 12px rgba(125,211,252,.35) inset, 0 0 10px rgba(125,211,252,.25); }

  /* ----- How to play ----- */
  .m5m-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .m5m-step { background: #0b0f26; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  .m5m-step canvas { display: block; width: 100%; aspect-ratio: 16 / 9; background: #060814; }
  .m5m-step p { margin: 0; padding: 9px 12px 11px; font-size: 14px; line-height: 1.4; color: #c9d2ee; }
  .m5m-step p b { color: #fff; }
  .m5m-step .n { display: inline-block; width: 22px; height: 22px; border-radius: 50%; background: var(--gold); color: #1a1300;
    font-weight: 900; text-align: center; line-height: 22px; font-size: 13px; margin-right: 6px; }
  .m5m-extra { margin: 10px 2px 0; font-size: 13px; color: var(--muted); }
  .m5m-extra b { color: #e7ecff; }

  /* ----- Footer: back link + big Start ----- */
  .m5m-foot { display: flex; align-items: center; justify-content: center; gap: 14px; flex-wrap: wrap;
    padding: 12px 16px max(12px, env(safe-area-inset-bottom)); background: linear-gradient(0deg, rgba(4,5,13,.96), rgba(4,5,13,.7));
    border-top: 1px solid var(--line); }
  .m5m-btn { font: inherit; font-weight: 900; font-style: italic; cursor: pointer; border: none; border-radius: 14px;
    text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
  .m5m-start { font-size: clamp(20px, 2.6vw, 28px); padding: 12px 46px; min-height: 52px; color: #1a0610; letter-spacing: .06em;
    background: linear-gradient(100deg, #ffd23f, #ff7a1f 45%, #ff3d9a); box-shadow: 0 0 26px rgba(255,61,154,.45), 0 6px 0 #7a1240; }
  .m5m-start:hover { filter: brightness(1.08); } .m5m-start:active { transform: translateY(3px); box-shadow: 0 0 20px rgba(255,61,154,.4), 0 3px 0 #7a1240; }
  .m5m-back { font-size: 16px; font-style: normal; font-weight: 700; padding: 12px 18px; min-height: 48px; color: #f2f5ff; background: #1b2250;
    border: 1px solid var(--line); }
  .m5m-press { font-size: 13px; color: var(--muted); }

  /* ----- Pause overlay ----- */
  .m5p { position: fixed; inset: 0; z-index: 45; display: none; align-items: center; justify-content: center; padding: 16px;
    background: rgba(4, 5, 13, .66); backdrop-filter: blur(3px); font-family: "Segoe UI", system-ui, -apple-system, sans-serif; color: #f2f5ff; }
  .m5p.show { display: flex; }
  .m5p-card { width: min(340px, 100%); padding: 22px; border-radius: 20px; background: rgba(12, 15, 36, .96);
    border: 2px solid rgba(255,255,255,.14); box-shadow: 0 24px 70px rgba(0,0,0,.6); text-align: center; }
  .m5p-card h2 { margin: 0 0 14px; font-size: 40px; font-style: italic; font-weight: 900; letter-spacing: .04em; color: transparent;
    -webkit-text-stroke: 2px #bff3ff; text-shadow: 0 0 14px #7dd3fc, 0 0 34px #38bdf8; }
  .m5p-card button { display: block; width: 100%; margin: 8px 0; padding: 12px; min-height: 48px; border-radius: 12px; cursor: pointer;
    font: inherit; font-size: 18px; font-weight: 800; color: #f2f5ff; background: #1b2250; border: 2px solid transparent; }
  .m5p-card button.sel { border-color: #ffd23f; background: #2b3784; }
  .m5p-card .tip { margin-top: 10px; font-size: 13px; color: #9aa6c8; }

  /* ----- Smaller screens ----- */
  @media (max-width: 520px) {
    .m5m-foot { gap: 8px; }
    .m5m-back, .m5m-help { font-size: 14px; padding: 10px 12px; }
    .m5m-start { padding: 12px 28px; }
  }
  @media (max-width: 860px) {
    .m5m-grid { grid-template-columns: 1fr; }
    .m5m-steps { grid-template-columns: 1fr; }
    .m5m-step { display: grid; grid-template-columns: 42% 1fr; align-items: center; }
    .m5m-press { display: none; }
  }
  /* Landscape phones: very little height — tighten everything. */
  @media (max-height: 500px) {
    .m5m-head { margin: 0 0 8px; }
    .m5m-logo { font-size: clamp(36px, 8vw, 64px); }
    .m5m-tag, .m5m-tiles { display: none; }
    .m5m-steps { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .m5m-step { display: block; }
    .m5m-foot { padding-top: 8px; padding-bottom: max(8px, env(safe-area-inset-bottom)); }
    .m5m-start { min-height: 46px; padding: 8px 40px; }
    .m5m-back, .m5m-help { min-height: 44px; padding: 8px 14px; }
    .m5m-how { padding: 12px; }
    .m5m-step p { font-size: 12px; padding: 6px 8px 8px; }
    .m5m-extra { display: none; }
  }
  /* Landscape phones are wide enough for two columns. */
  @media (max-height: 500px) and (min-width: 700px) {
    .m5m-grid { grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); }
    .m5m-kicker { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { .m5m-logo .neon, .m5m-tiles i { animation: none; } }`;

  function injectStyle() {
    if (document.getElementById("m5m-style")) return;
    const st = document.createElement("style");
    st.id = "m5m-style";
    st.textContent = STYLE;
    document.head.appendChild(st);
  }

  /* =====================================================================
     How-to-play animations: tiny canvas drawings of the floor grid.
     Each one is a pure function of time (no state), looping forever.
     ===================================================================== */
  const COLS = 15, ROWS = 10;
  const HEX = { blue: "#3d8bff", orange: "#ff7a1f", empty: "#0d1124", grout: "#161c3a" };

  // Draw the bare grid, then call paint(cell) to colour cells.
  function drawFloor(g, W, H, cells) {
    // Cell size that fits the whole grid; centre it in the box.
    const cs = Math.min(W / COLS, H / ROWS);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#060814"; g.fillRect(0, 0, W, H);
    g.translate((W - cs * COLS) / 2, (H - cs * ROWS) / 2);
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      const c = cells.get(i + "," + j);
      g.fillStyle = c ? c.color : HEX.empty;
      g.globalAlpha = c ? (c.alpha ?? 1) : 1;
      g.fillRect(i * cs + 1, j * cs + 1, cs - 2, cs - 2);
      if (c && c.flash) { g.fillStyle = "#fff"; g.globalAlpha = c.flash; g.fillRect(i * cs + 1, j * cs + 1, cs - 2, cs - 2); }
      g.globalAlpha = 1;
    }
    return cs;
  }
  // A little top-down rocket car with a roller on its nose.
  function drawCar(g, cs, x, y, ang, color, opts = {}) {
    g.save();
    g.translate(x * cs, y * cs);
    g.rotate(ang);
    const s = opts.scale || 1;
    g.scale(s, s);
    if (opts.shadow) { g.fillStyle = "rgba(0,0,0,.45)"; g.fillRect(-cs * 0.8 + 4, -cs * 0.5 + 6, cs * 1.6, cs); }
    if (opts.flame) { g.fillStyle = "#ffb02b"; g.beginPath(); g.moveTo(-cs * 0.8, -cs * 0.25); g.lineTo(-cs * 1.6, 0); g.lineTo(-cs * 0.8, cs * 0.25); g.fill(); }
    g.fillStyle = color; g.fillRect(-cs * 0.8, -cs * 0.45, cs * 1.5, cs * 0.9);
    g.fillStyle = "#cfe8ff"; g.fillRect(-cs * 0.25, -cs * 0.3, cs * 0.45, cs * 0.6);
    g.fillStyle = "#fff"; g.fillRect(cs * 0.78, -cs * 0.55, cs * 0.22, cs * 1.1);   // roller
    g.restore();
  }
  function label(g, W, H, text, color, k) {
    if (k <= 0) return;
    g.save();
    g.globalAlpha = Math.min(1, k);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.font = `italic 900 ${Math.round(Math.min(H * 0.13, W * 0.075))}px "Segoe UI", system-ui, sans-serif`;
    g.textAlign = "center";
    g.lineWidth = 4; g.strokeStyle = "rgba(0,0,0,.7)";
    g.strokeText(text, W / 2, H * 0.16 + (1 - Math.min(1, k)) * 8);
    g.fillStyle = color; g.shadowColor = color; g.shadowBlur = 12;
    g.fillText(text, W / 2, H * 0.16 + (1 - Math.min(1, k)) * 8);
    g.restore();
  }
  const wetAlpha = (t, i) => 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 8 - i * 0.7));

  const HOW = [
    // 1) Paint: drive leaves a stripe; boost widens it; a hop leaves a splat.
    function paint(g, W, H, t) {
      t %= 4.4;
      const cells = new Map();
      for (let j = 4; j <= 6; j++) for (let i = 0; i <= 2; i++) cells.set(i + "," + j, { color: HEX.blue });
      const x = 2.5 + Math.min(1, t / 3.2) * 10.5;         // car position (cells)
      const boostAt = (i) => i >= 5 && i <= 8;
      const airAt = (i) => i >= 10 && i < 12;
      for (let i = 3; i <= Math.floor(x); i++) {
        if (airAt(i)) continue;
        cells.set(i + ",5", { color: HEX.blue });
        if (boostAt(i)) { cells.set(i + ",4", { color: HEX.blue }); cells.set(i + ",6", { color: HEX.blue }); }
      }
      // Landing splat at x = 12 once landed.
      if (x >= 12) {
        const age = t - 3.2 * (12 - 2.5) / 10.5;
        for (let j = 2; j <= 8; j++) for (let i = 9; i <= 14; i++) {
          if ((i - 12.2) ** 2 + (j - 5) ** 2 <= 4.6) cells.set(i + "," + j, { color: HEX.blue, flash: Math.max(0, 0.7 - age * 2) });
        }
      }
      const cs = drawFloor(g, W, H, cells);
      const inAir = airAt(Math.floor(x));
      const hop = inAir ? Math.sin(((x - 10) / 2) * Math.PI) : 0;
      drawCar(g, cs, x, 5.5 - hop * 0.6, 0, HEX.blue, { flame: boostAt(Math.floor(x)), scale: 1 + hop * 0.35, shadow: inAir });
      const lbl = boostAt(Math.floor(x)) ? "BOOST = WIDE" : inAir ? "JUMP…" : x >= 12 && t < 4.2 ? "SPLAT!" : "";
      if (lbl) label(g, W, H, lbl, "#fff", 1);
    },

    // 2) Loop back to FILL: leave your turf, drive a loop (wet trail), come home → flood.
    function loop(g, W, H, t) {
      t %= 5.2;
      const cells = new Map();
      for (let j = 2; j <= 7; j++) for (let i = 0; i <= 3; i++) cells.set(i + "," + j, { color: HEX.blue });
      // Path: (3,2.5)→(12,2.5)→(12,7.5)→(3,7.5), 23 cells long, driven in 3 s.
      const L = Math.min(1, t / 3) * 23;
      const pts = [];
      let x, y, ang;
      if (L < 9) { x = 3 + L; y = 2.5; ang = 0; }
      else if (L < 14) { x = 12; y = 2.5 + (L - 9); ang = Math.PI / 2; }
      else { x = 12 - (L - 14); y = 7.5; ang = Math.PI; }
      for (let s = 0; s <= L; s += 0.5) {
        const px = s < 9 ? 3 + s : s < 14 ? 12 : 12 - (s - 14);
        const py = s < 9 ? 2.5 : s < 14 ? 2.5 + (s - 9) : 7.5;
        pts.push([Math.floor(px), Math.floor(py)]);
      }
      const done = t >= 3;
      for (const [i, j] of pts) if (i >= 4) cells.set(i + "," + j, { color: HEX.blue, alpha: done ? 1 : wetAlpha(t, i + j) });
      if (done) {
        // Flood the inside, sweeping out from the middle over 0.4 s.
        const age = t - 3;
        for (let j = 3; j <= 6; j++) for (let i = 4; i <= 11; i++) {
          const d = Math.hypot(i - 7.5, j - 4.5) / 4.5;
          if (age >= d * 0.4) cells.set(i + "," + j, { color: HEX.blue, flash: Math.max(0, 0.8 - (age - d * 0.4) * 2.5) });
        }
      }
      const cs = drawFloor(g, W, H, cells);
      drawCar(g, cs, x, y, ang, HEX.blue);
      if (done) label(g, W, H, "FILL +12%", "#7cc0ff", (t - 3) * 4);
      else if (t > 0.6) label(g, W, H, "WET TRAIL…", "#cfe8ff", 0.85);
    },

    // 3) Pop rival trails: cross someone's wet trail and it becomes yours.
    function pop(g, W, H, t) {
      t %= 4.4;
      const cells = new Map();
      for (let j = 1; j <= 3; j++) for (let i = 12; i <= 14; i++) cells.set(i + "," + j, { color: HEX.orange });
      const ox = Math.max(4, 12 - (t / 2.4) * 8);            // orange drives left, leaving a wet trail
      const by = 9.5 - Math.min(1, t / 2.0) * 7.5 - Math.max(0, t - 2.0) * 3;  // blue drives up through it
      const popped = t >= 2.0;
      for (let i = Math.floor(ox); i <= 11; i++) {
        cells.set(i + ",2", popped
          ? { color: HEX.blue, flash: Math.max(0, 0.9 - (t - 2) * 2) }
          : { color: HEX.orange, alpha: wetAlpha(t, i) });
      }
      for (let j = Math.max(0, Math.floor(by)); j <= 9; j++) if (j !== 2 || popped) cells.set("7," + j, { color: HEX.blue });
      const cs = drawFloor(g, W, H, cells);
      const spin = popped ? (t - 2) * 14 : 0;
      drawCar(g, cs, ox - (popped ? 0 : 0), 2.5, Math.PI + spin, HEX.orange);
      drawCar(g, cs, 7.5, by, -Math.PI / 2, HEX.blue);
      if (popped) label(g, W, H, "POP!", "#ff9ad5", (t - 2) * 5);
    },
  ];

  /* =====================================================================
     The menu
     ===================================================================== */
  const Menu = {
    isOpen: false,
    built: false,
    options: null,
    slots: null,

    build() {
      if (this.built) return;
      this.built = true;
      injectStyle();
      const root = document.createElement("div");
      root.className = "m5m";
      root.id = "m5-menu";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-label", "Neon Turf menu");
      root.innerHTML = `
        <div class="m5m-scroll"><div class="m5m-inner">
          <header class="m5m-head">
            <div class="m5m-kicker">Rocket Rumble</div>
            <h1 class="m5m-logo"><span class="neon">NEON</span><span class="turf">TURF</span></h1>
            <p class="m5m-tag">Paint the arena. Close the loop. Own the floor.</p>
            <div class="m5m-tiles" aria-hidden="true">${NEON_CSS().map((c) => `<i style="background:${c};box-shadow:0 0 10px ${c}"></i>`).join("")}</div>
          </header>
          <div class="m5m-grid">
            <section class="m5m-panel" aria-labelledby="m5m-ph">
              <h2 id="m5m-ph">Players</h2>
              <div id="m5m-seats"></div>
              <div class="m5m-ctrls" id="m5m-ctrls"></div>
            </section>
            <section class="m5m-panel" aria-labelledby="m5m-oh">
              <h2 id="m5m-oh">Match</h2>
              <div id="m5m-opts"></div>
            </section>
          </div>
        </div></div>
        <footer class="m5m-foot">
          <a class="m5m-btn m5m-back" href="${esc(TP.Rumble ? TP.Rumble.HUB_URL : "../index.html")}">← All modes</a>
          <button class="m5m-btn m5m-help" id="m5m-help" type="button"><span class="q">?</span> How to play</button>
          <button class="m5m-btn m5m-start" id="m5m-start" type="button" data-nav-primary>START</button>
          <span class="m5m-press">or press <kbd class="m5k">Enter</kbd> / <kbd class="m5k">A</kbd></span>
        </footer>
        <div class="m5m-howwrap" id="m5m-how" role="dialog" aria-labelledby="m5m-hh">
          <section class="m5m-panel m5m-how">
              <h2 id="m5m-hh">How to play</h2>
              <div class="m5m-steps">
                <div class="m5m-step"><canvas aria-hidden="true"></canvas>
                  <p><span class="n">1</span><b>Drive to paint.</b> Your roller paints the floor. <b>Boost</b> paints wider; <b>jump</b> and land to splat.</p></div>
                <div class="m5m-step"><canvas aria-hidden="true"></canvas>
                  <p><span class="n">2</span><b>Loop back to FILL.</b> Leave your turf, drive a loop, come home: everything inside turns yours.</p></div>
                <div class="m5m-step"><canvas aria-hidden="true"></canvas>
                  <p><span class="n">3</span><b>Pop rival trails.</b> A trail is wet until it's home. Cross a rival's wet trail to steal it and spin them out.</p></div>
              </div>
              <p class="m5m-extra">Most floor when the clock hits zero wins the round. Last 20 seconds: <b>OVERDRIVE</b>, wider paint and more pickups.
                Pickups: <b>Paint Bomb</b> (big splat) · <b>Mega Roller</b> (huge brush, trail can't pop) · <b>Boost Can</b>.</p>
              <div class="m5m-howfoot"><button class="m5m-btn m5m-start m5m-gotit" id="m5m-gotit" type="button" data-nav-primary>GOT IT</button></div>
          </section>
        </div>`;
      document.body.appendChild(root);
      this.root = root;

      this.renderSeats();
      this.renderOptions();

      // Seats: names and controllers.
      root.querySelector("#m5m-seats").addEventListener("input", (e) => {
        const i = Number(e.target.dataset.i);
        if (Number.isNaN(i)) return;
        if (e.target.tagName === "INPUT") this.slots[i].name = e.target.value.trim().slice(0, 12) || TP.DEFAULT_NAMES[i];
        else { this.slots[i].controller = e.target.value; this.renderSeats(i); click(); }
        this.renderControls();
      });
      // Options: segmented buttons.
      root.querySelector("#m5m-opts").addEventListener("click", (e) => {
        const b = e.target.closest("button[data-k]");
        if (!b) return;
        const def = OPTIONS.find((d) => d.key === b.dataset.k);
        const choice = def.choices[Number(b.dataset.c)];
        this.options[def.key] = choice[0];
        saveOptions(this.options);
        this.renderOptions();
        click();
      });
      root.querySelector("#m5m-start").addEventListener("click", () => this.start());
      root.querySelector("#m5m-help").addEventListener("click", () => { click(); this.showHelp(); });
      root.querySelector("#m5m-gotit").addEventListener("click", () => { click(); this.hideHelp(); });
      root.querySelector("#m5m-how").addEventListener("click", (e) => { if (e.target.id === "m5m-how") this.hideHelp(); });
      // Narrow ↔ wide changes the controller label length.
      addEventListener("resize", () => { if (this.isOpen && narrow() !== this.wasNarrow) this.renderSeats(); });

      // How-to-play canvases: size to their box (crisp on hi-dpi), animate while open.
      this.canvases = [...root.querySelectorAll(".m5m-step canvas")];
      this.anim();
    },

    renderSeats(only) {
      const seats = this.root.querySelector("#m5m-seats");
      const ids = ["off", ...TP.CONTROLLER_IDS];
      // Narrow screens get short labels so the dropdowns don't truncate.
      this.wasNarrow = narrow();
      const lab = (id) => (this.wasNarrow ? SHORT_LABELS[id] || TP.CONTROLLER_LABELS[id]
        : id === "off" ? "Empty (bot plays)" : TP.CONTROLLER_LABELS[id]);
      const html = (s, i) => `
        <div class="m5m-seat ${s.controller === "bot" || s.controller === "off" ? "bot" : ""}" style="border-color:${NEON_CSS()[i]}">
          <input data-i="${i}" maxlength="12" value="${esc(s.name)}" aria-label="Player ${i + 1} name" />
          <select data-i="${i}" aria-label="Player ${i + 1} controller">
            ${ids.map((id) => `<option value="${id}" ${id === s.controller ? "selected" : ""}>${esc(lab(id))}</option>`).join("")}
          </select>
        </div>`;
      if (only != null && seats.children[only]) {
        // Only restyle the changed seat (keeps focus in the select).
        seats.children[only].classList.toggle("bot", ["bot", "off"].includes(this.slots[only].controller));
        return;
      }
      seats.innerHTML = this.slots.map(html).join("");
      this.renderControls();
    },

    // One line per human seat: what their buttons are.
    renderControls() {
      const humans = this.slots.map((s, i) => ({ s, i })).filter(({ s }) => s.controller !== "bot" && s.controller !== "off");
      const el = this.root.querySelector("#m5m-ctrls");
      if (!humans.length) { el.innerHTML = "All seats are bots: sit back and watch them paint."; return; }
      const k = (t) => `<kbd class="m5k">${esc(t)}</kbd>`;
      el.innerHTML = humans.map(({ s, i }) => {
        const n = TP.keyNames(s.controller);
        return `<div><b style="color:${NEON_CSS()[i]}">${esc(s.name)}</b>: steer ${k(n.steer)} · drive ${k(n.drive)} · boost ${k(n.boost)} · jump ${k(n.confirm)}</div>`;
      }).join("");
    },

    renderOptions() {
      this.root.querySelector("#m5m-opts").innerHTML = OPTIONS.map((d) => `
        <div class="m5m-opt" role="group" aria-label="${esc(d.label)}"><span>${esc(d.label)}</span>
          <div class="m5m-seg">${d.choices.map((c, ci) =>
            `<button type="button" data-k="${d.key}" data-c="${ci}" aria-pressed="${this.options[d.key] === c[0]}">${esc(c[1])}</button>`).join("")}</div>
        </div>`).join("");
    },

    anim() {
      const frame = (now) => {
        if (this.isOpen) {
          const t = now / 1000;
          const dpr = Math.min(2, devicePixelRatio || 1);
          this.canvases.forEach((c, k) => {
            const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
            if (!w || !h) return;
            if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
            HOW[k](c.getContext("2d"), w, h, t + k * 0.7);
          });
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },

    open() {
      this.slots = TP.Rumble.loadSetup().slots.map((s) => ({ ...s }));
      this.options = loadOptions();
      this.build();
      this.renderSeats();
      this.renderOptions();
      this.root.classList.add("show");
      this.isOpen = true;
      Pause.enabled = false;
      Pause.close(true);
      this.navOn(this.root);
      emit("menuOpen");
      this.attract();
      // First visit: show How to play straight away.
      let seen = false;
      try { seen = localStorage.getItem(HELP_KEY) === "1"; } catch (e) { /* blocked: show it */ }
      if (!seen) this.showHelp();
    },

    /* Gamepad / arrow-key navigation (shared TP.MenuNav): one container at
       a time, either the whole menu or the How-to-play panel on top of it. */
    navOn(el) {
      this.navOff();
      if (TP.MenuNav) this.nav = TP.MenuNav.attach(el, el === this.root ? {} : { onBack: () => this.hideHelp() });
    },
    navOff() { if (this.nav) { this.nav.detach(); this.nav = null; } },

    showHelp() {
      const how = this.root.querySelector("#m5m-how");
      how.classList.add("show");
      this.helpOpen = true;
      this.navOn(how);
    },
    hideHelp() {
      if (!this.helpOpen) return;
      this.root.querySelector("#m5m-how").classList.remove("show");
      this.helpOpen = false;
      try { localStorage.setItem(HELP_KEY, "1"); } catch (e) { /* fine */ }
      if (this.isOpen) this.navOn(this.root);
    },

    // Backdrop: four bots painting a long round behind the menu. The HUD
    // and mode sounds stay hidden/quiet while the menu is open.
    attract() {
      if (!TP.M5.startMatch) return;
      const n = (TP.M5.ARENAS || [1]).length;
      TP.M5.startMatch({
        players: TP.DEFAULT_NAMES.map((name) => ({ name, controller: "bot" })),
        rounds: 1, roundTime: 600, botLevel: "hard",
        arena: Math.floor(Math.random() * n),
      });
    },
    close() {
      if (!this.root) return;
      this.root.classList.remove("show");
      this.isOpen = false;
      this.helpOpen = false;
      this.root.querySelector("#m5m-how").classList.remove("show");
      this.navOff();
    },

    start() {
      if (!this.isOpen || this.helpOpen) return;
      if (TP.sfx) TP.sfx.unlock();
      // Save the seats exactly as chosen (so "off" stays "off" in the hub)...
      TP.Rumble.saveSetup(this.slots);
      saveOptions(this.options);
      // ...but hand Gameplay a full table: an empty seat plays as a bot.
      const slots = this.slots.map((s) => ({ name: s.name, controller: s.controller === "off" ? "bot" : s.controller }));
      this.close();
      Pause.enabled = true;
      const o = this.options;
      emit("menuStart", { slots, options: { ...o } });
      if (TP.M5.startMatch) {
        // Arena: its index in TP.M5.ARENAS, or a random one.
        const arenas = TP.M5.ARENAS || [];
        let arena = arenas.findIndex((a) => a.id === o.arena);
        if (arena < 0) arena = Math.floor(Math.random() * Math.max(1, arenas.length));
        TP.M5.startMatch({
          players: slots, rounds: o.rounds, roundTime: o.roundLength,
          arena, botLevel: o.difficulty, teams: o.teams === "2v2",   // Gameplay wants true/false
        });
      }
    },
  };

  /* =====================================================================
     Pause overlay
     ===================================================================== */
  const Pause = {
    enabled: false,
    isOpen: false,
    ACTIONS: [["resume", "Resume"], ["restart", "Restart round"], ["quit", "Menu"]],

    build() {
      if (this.root) return;
      injectStyle();
      const root = document.createElement("div");
      root.className = "m5p";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-label", "Paused");
      root.innerHTML = `<div class="m5p-card"><h2>PAUSED</h2>
        ${this.ACTIONS.map(([id, txt], i) => `<button type="button" data-a="${id}" ${i === 0 ? "data-nav-primary" : ""}>${txt}</button>`).join("")}
        <div class="tip">Esc / Start to resume</div></div>`;
      root.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-a]");
        if (b) this.act(b.dataset.a);
        else if (e.target === root) this.act("resume");   // tap outside = resume
      });
      document.body.appendChild(root);
      this.root = root;
    },
    open() {
      if (!this.enabled || this.isOpen || Menu.isOpen) return;
      this.build();
      this.root.classList.add("show");
      this.isOpen = true;
      // Pads / arrows move between the buttons; B or Escape resumes.
      if (TP.MenuNav) this.nav = TP.MenuNav.attach(this.root, { onBack: () => this.act("resume") });
      emit("pause");
    },
    // quiet = close without emitting (used when the menu takes over).
    close(quiet) {
      if (!this.isOpen) return;
      this.root.classList.remove("show");
      this.isOpen = false;
      this.navOff();
      if (!quiet) emit("resume");
    },
    navOff() { if (this.nav) { this.nav.detach(); this.nav = null; } },
    toggle() { if (this.isOpen) this.act("resume"); else this.open(); },
    act(id) {
      if (!this.isOpen) return;
      this.root.classList.remove("show");
      this.isOpen = false;
      this.navOff();
      if (id === "resume") emit("resume");
      else if (id === "restart") { emit("restart"); if (TP.M5.restart) TP.M5.restart(); }
      else if (id === "quit") { emit("quit"); Menu.open(); }
    },
  };

  /* =====================================================================
     Keyboard + gamepad
     ===================================================================== */
  // Capture phase, so we see keys before the shared input module blocks them.
  addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (Menu.isOpen) {
      // A focused button, link or dropdown handles Enter/Space itself (and
      // the shared MenuNav handles arrows). Enter while typing a name, or
      // Enter/Space with nothing focused, starts the match.
      if (Menu.helpOpen) return;
      const onControl = ["BUTTON", "A", "SELECT"].includes(tag);
      if (!onControl && (e.code === "Enter" || (e.code === "Space" && tag !== "INPUT"))) {
        e.preventDefault();
        Menu.start();
      }
      return;
    }
    if (e.code === "Escape" || (e.code === "KeyP" && tag !== "INPUT")) {
      e.preventDefault();
      if (Pause.isOpen) Pause.act("resume");
      // Open AFTER this keypress is done: otherwise the overlay's own
      // navigation would see the same Escape and close it straight away.
      else setTimeout(() => Pause.open(), 0);
    }
  }, true);

  // Gamepad Start (9) pauses during play. Inside the pause overlay (and
  // the menu) the shared TP.MenuNav does the rest: d-pad/stick, A, B, Start.
  const Pad = {
    prev: {},
    pressed(pad, b) {
      const key = pad.index + ":" + b;
      const now = !!(pad.buttons[b] && pad.buttons[b].pressed);
      const was = this.prev[key];
      this.prev[key] = now;
      return now && !was;
    },
    pads() { return navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : []; },
    gameTick() {
      for (const p of this.pads()) {
        // Keep reading so the edge is fresh, but only act while not paused
        // (when paused, MenuNav's Start presses Resume).
        if (this.pressed(p, 9) && !Pause.isOpen) Pause.open();
      }
    },
  };
  (function padLoop() {
    if (!Menu.isOpen && Pause.enabled) Pad.gameTick();
    requestAnimationFrame(padLoop);
  })();

  // If the tab is hidden mid-round, pause so nobody loses the round.
  document.addEventListener("visibilitychange", () => { if (document.hidden) Pause.open(); });

  TP.M5.Menu = Menu;
  TP.M5.Pause = Pause;
  TP.M5.MENU_OPTIONS = OPTIONS;
})();
