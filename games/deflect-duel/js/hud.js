/* =====================================================================
   hud.js — on-screen text for Deflect Duel (chips, speed, callouts,
   menu/result cards). The 3D scene never draws text itself.
   ===================================================================== */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let toastTimer = null;
  let calloutTimer = null;
  let lastHud = "";
  let nav = null;   // gamepad/arrow-key navigation on the current card (TP.MenuNav)

  /* ---------- Rolling speed number ----------
     The shown number eases from where it was to the new speed over a
     short time, like a fruit-machine counter, so a big jump reads as a
     climb. A drop (a serve) snaps down quickly. */
  const speedRoll = { shown: 0, from: 0, to: 0, t0: 0, dur: 0.18, nextDur: 0 };
  // Colour stops along the way to top speed (fraction of max → colour).
  const RAMP = [[0, [255, 255, 255]], [0.12, [125, 211, 252]], [0.3, [255, 225, 77]], [0.5, [255, 159, 26]], [0.72, [255, 59, 59]], [1, [255, 79, 216]]];
  function rampColor(f) {
    f = Math.max(0, Math.min(1, f));
    for (let i = 1; i < RAMP.length; i++) {
      const [f1, c1] = RAMP[i], [f0, c0] = RAMP[i - 1];
      if (f <= f1) {
        const k = (f - f0) / (f1 - f0);
        return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(",")})`;
      }
    }
    return "rgb(255,79,216)";
  }
  function drawSpeed(speed, ownerCss) {
    const box = document.getElementById("speed");
    if (!box) return;
    const now = performance.now() / 1000;
    const r = speedRoll;
    if (Math.abs(speed - r.to) > 0.5) {
      // A new target: roll from what's on screen now.
      r.from = r.shown;
      r.to = speed;
      r.t0 = now;
      r.dur = speed < r.shown ? 0.15 : (r.nextDur || 0.18);
      r.nextDur = 0;
    }
    const k = Math.min(1, (now - r.t0) / r.dur);
    const ease = 1 - Math.pow(1 - k, 3);            // fast at first, settles at the end
    r.shown = r.from + (r.to - r.from) * ease;
    const rolling = k < 1 && r.to > r.from;

    const max = (TP.duel && TP.duel.cfg && TP.duel.cfg.maxSpeed) || (TP.DUEL_CFG && TP.DUEL_CFG.maxSpeed) || 56;
    const f = r.shown / max;
    const val = box.querySelector(".val");
    val.textContent = String(Math.round(r.shown));
    const col = rampColor(f);
    val.style.color = col;
    // Bigger as it gets faster (30px → 50px), with a glow while it climbs.
    val.style.fontSize = (30 + 20 * Math.min(1, f)) + "px";
    val.style.textShadow = rolling ? `0 0 18px ${col}` : (f > 0.5 ? `0 0 10px ${col}` : "none");
    box.classList.toggle("rolling", rolling);
    box.style.borderBottom = `4px solid ${ownerCss || "transparent"}`;
    box.querySelector(".label").style.color = ownerCss && ownerCss !== "#ffffff" ? ownerCss : "";
  }

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
       speed in the middle. `ballCss` is the ball owner's colour: it tints
       the speed box's label and underline. The NUMBER rolls up to the new
       speed (see rollSpeed) and its colour ramps white → cyan → yellow →
       orange → red → pink as the ball gets faster, growing as it goes. */
    /* info (optional) changes the chips for other modes:
         info.mode   "time": chips show KOs instead of hearts
                     "teams": chips show a team mark (▲ / ■)
                     "practice": chips show how many times you've been hit
         info.clock  text under the speed, e.g. "2:13" or "OVERTIME" */
    update(players, speed, ballCss, info) {
      if (!players) { $("hud").classList.remove("show"); lastHud = ""; speedRoll.shown = 0; speedRoll.to = 0; return; }
      const mode = (info && info.mode) || "stock";
      const half = Math.ceil(players.length / 2);
      const status = (p) => {
        if (mode === "time") return `${p.score || 0} KO${p.score === 1 ? "" : "s"}`;
        if (mode === "practice") return `hit ×${p.knockedOut || 0}`;
        return p.lives > 0 ? "♥".repeat(p.lives) : "OUT";
      };
      const mark = (p) => (mode === "teams" ? `<span class="team">${p.team === 0 ? "▲" : "■"}</span> ` : "");
      const chip = (p) => `
        <div class="chip ${mode !== "time" && mode !== "practice" && p.lives <= 0 ? "out" : ""}" style="border-color:${p.css}">
          <span style="color:${p.css}">${mark(p)}${esc(p.name)}</span>
          <span class="lives">${status(p)}</span>
        </div>`;
      const clock = info && info.clock ? `<div class="label">${esc(info.clock)}</div>` : "";
      const html =
        players.slice(0, half).map(chip).join("") +
        `<div id="speed"><div class="label">BALL SPEED</div><div class="val">0</div>${clock}</div>` +
        players.slice(half).map(chip).join("");
      // Only rebuild the chips when something in them changed (it's per-frame).
      if (html !== lastHud) { $("hud").innerHTML = html; lastHud = html; }
      $("hud").classList.add("show");
      drawSpeed(speed, ballCss);
    },

    /* The next speed change rolls up over `seconds` (e.g. the length of
       the hit-freeze that's about to start), instead of the quick default. */
    rollSpeed(seconds) { speedRoll.nextDur = Math.max(0.1, seconds); },

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

    /* Announcer callout: a big word that punches in and fades ("FAST!",
       "FLIP STRIKE!", "PERFECT!"). big = an even bigger one. */
    callout(text, color = "", big = false) {
      const el = $("callout");
      if (!el) { TP.HUD.toast(text, color, 1.0); return; }
      el.textContent = text;
      el.style.color = color || "#ffffff";
      el.classList.toggle("big", !!big);
      el.classList.remove("show");
      void el.offsetWidth; // restart the animation
      el.classList.add("show");
      clearTimeout(calloutTimer);
      calloutTimer = setTimeout(() => el.classList.remove("show"), big ? 1500 : 1000);
    },

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
       onStart — called as onStart(setup, lives, extra) with the edited
                 setup. extra = { mode, difficulty, practice } where mode is
                 "stock" | "teams" | "time" | "sudden", difficulty is "easy" |
                 "normal" | "hard", and practice is null, "practice" or
                 "tutorial" (the Practice / Tutorial buttons).
       The setup is also saved back to the hub (TP.Rumble.saveSetup) so the
       next mode you open starts with the same players. */
    showMenu(setup, lives, onStart) {
      TP.HUD.update(null);
      TP.HUD.center("");
      TP.HUD.hint("");

      const slots = (setup && setup.slots ? setup.slots : TP.Rumble.loadSetup().slots).slice(0, 4);
      let pickedLives = lives === 5 ? 5 : 3;
      // Remember the last mode and bot level picked (this browser only).
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem("deflectDuel.menu") || "{}") || {}; } catch (e) { saved = {}; }
      let pickedMode = ["stock", "teams", "time", "sudden"].includes(saved.mode) ? saved.mode : "stock";
      let pickedLevel = ["easy", "normal", "hard"].includes(saved.level) ? saved.level : "normal";
      const ARENAS = Object.assign({ random: { name: "Random" } }, TP.DUEL_ARENAS || {});
      let pickedArena = ARENAS[saved.arena] ? saved.arena : "classic";

      // Seat options: Off, then every known controller (Bot, Keyboard 1, ...).
      const LABELS = Object.assign({ off: "Off (empty)" }, TP.CONTROLLER_LABELS);
      const IDS = ["off", ...TP.CONTROLLER_IDS];
      const opts = (sel) => IDS.map((id) =>
        `<option value="${id}" ${id === sel ? "selected" : ""}>${esc(LABELS[id])}</option>`).join("");

      const card = TP.HUD.card(`
        <h1><span class="t1">DEFLECT</span> <span class="t2">DUEL</span></h1>
        <p class="blurb">One ball, and it speeds up with every hit. It glows in the colour of whoever
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
          <span class="muted">Mode</span>
          <span class="seg" id="mode">
            <button data-v="stock" title="Lives; last car standing">Free-for-all</button><button data-v="teams" title="Seats 1 &amp; 3 vs 2 &amp; 4; your teammate's ball is harmless">Teams 2v2</button><button data-v="time" title="2:30 on the clock; most KOs wins; endless respawns">Time</button><button data-v="sudden" title="One life each">Sudden Death</button>
          </span>
        </div>
        <div class="row">
          <span class="muted">Arena</span>
          <span class="seg" id="arena">
            ${Object.keys(TP.DUEL_ARENAS || {}).concat("random").map((id) => `<button data-v="${id}" title="${esc((TP.DUEL_ARENAS[id] || {}).blurb || "A different arena each match")}">${esc(ARENAS[id].name)}</button>`).join("")}
          </span>
        </div>
        <div class="row">
          <span class="muted" id="lives-label">Lives</span>
          <span class="seg" id="lives">
            <button data-v="3">3</button><button data-v="5">5</button>
          </span>
          <span class="muted">Bots</span>
          <span class="seg" id="level">
            <button data-v="easy">Easy</button><button data-v="normal">Normal</button><button data-v="hard">Hard</button>
          </span>
          <span class="muted" id="padinfo"></span>
          <span class="muted">· <kbd>M</kbd> mutes</span>
        </div>

        <table class="controls-table">
          <tr><td>Keyboard 1</td><td>Drive <kbd>W</kbd><kbd>S</kbd> · Steer/aim <kbd>A</kbd><kbd>D</kbd> · Hit <kbd>E</kbd> · Jump <kbd>Space</kbd> · Boost <kbd>Shift</kbd></td></tr>
          <tr><td>Keyboard 2</td><td>Drive <kbd>↑</kbd><kbd>↓</kbd> · Steer/aim <kbd>←</kbd><kbd>→</kbd> · Hit <kbd>.</kbd> · Jump <kbd>Enter</kbd> · Boost <kbd>R-Shift</kbd></td></tr>
          <tr><td>Gamepad</td><td>Gas <kbd>RT</kbd> · Reverse <kbd>LT</kbd> · Steer/aim stick · Hit <kbd>X</kbd>/<kbd>RB</kbd> · Jump <kbd>A</kbd> · Boost <kbd>B</kbd></td></tr>
          <tr><td>Aim</td><td>Hold <b>Up</b>/<b>Down</b> while you hit to aim up/down. On a keyboard you can bind separate <b>Aim up/down</b> keys in 🎮 Controls so <kbd>W</kbd>/<kbd>S</kbd> only drive.</td></tr>
          <tr><td>Moves</td><td>Boost + Hit = <b>Smash</b> · jump twice = double jump · jump + direction = <b>flip</b> · land on the ball = <b>bunt</b>. New? Try the <b>Tutorial</b>.</td></tr>
        </table>

        <p class="error" id="menu-error"></p>
        <div class="btn-row sticky">
          <button class="btn" id="start" data-nav-primary>Start duel</button>
          <button class="btn alt" id="practice" title="You vs a ball launcher, endless lives">Practice</button>
          <button class="btn alt" id="tutorial" title="A 90-second walkthrough of every move">Tutorial</button>
        <button class="btn alt" data-open-controls title="Rebind keys and buttons (pad: View)">🎮 Controls</button>
          <a class="btn hub" href="${TP.Rumble.HUB_URL}">← All modes</a>
        </div>`);

      const livesEl = card.querySelector("#lives");
      const modeEl = card.querySelector("#mode");
      const levelEl = card.querySelector("#level");
      const arenaEl = card.querySelector("#arena");
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

      // Mode and bot level work the same way as the lives toggle.
      const paintSeg = (el, v) => el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
      const paintMode = () => {
        paintSeg(modeEl, pickedMode);
        // Time mode has no lives; Sudden Death is always one life.
        const noLives = pickedMode === "time" || pickedMode === "sudden";
        livesEl.style.opacity = noLives ? 0.35 : 1;
        card.querySelector("#lives-label").textContent = pickedMode === "sudden" ? "Lives: 1" : pickedMode === "time" ? "Lives: ∞" : "Lives";
      };
      modeEl.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; pickedMode = b.dataset.v; paintMode(); validate(); });
      levelEl.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; pickedLevel = b.dataset.v; paintSeg(levelEl, pickedLevel); });
      arenaEl.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; pickedArena = b.dataset.v; paintSeg(arenaEl, pickedArena); });

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
        else if (pickedMode === "teams") {
          // Teams are by seat: 1 & 3 against 2 & 4. Both sides need someone.
          const on = s.map((seat) => seat.controller !== "off");
          if (!(on[0] || on[2]) || !(on[1] || on[3])) msg = "Teams: seats 1 & 3 play seats 2 & 4. Put someone on each side.";
        }
        errEl.textContent = msg;
        startBtn.disabled = !!msg;
        return !msg;
      };
      card.querySelectorAll("select, input").forEach((el) => {
        el.addEventListener("change", validate);
        el.addEventListener("input", validate);
      });
      validate();
      paintMode();
      paintSeg(levelEl, pickedLevel);
      paintSeg(arenaEl, pickedArena);
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

      const go = (practice) => {
        if (!practice && !validate()) return;
        const newSetup = { slots: read() };
        TP.Rumble.saveSetup(newSetup.slots);
        try { localStorage.setItem("deflectDuel.menu", JSON.stringify({ mode: pickedMode, level: pickedLevel, arena: pickedArena })); } catch (e) { /* storage blocked: fine */ }
        if (TP.sfx) { TP.sfx.unlock(); TP.sfx.play("go"); } // clicking counts as the audio "unlock" gesture
        window.removeEventListener("gamepadconnected", refreshPads);
        window.removeEventListener("gamepaddisconnected", refreshPads);
        TP.HUD.hideCard();
        if (onStart) onStart(newSetup, pickedLives, { mode: pickedMode, difficulty: pickedLevel, practice, arena: pickedArena });
      };
      startBtn.addEventListener("click", () => go(null));
      card.querySelector("#practice").addEventListener("click", () => go("practice"));
      card.querySelector("#tutorial").addEventListener("click", () => go("tutorial"));
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

      // Different modes, different headline and second stat.
      const mode = (result && result.mode) || "stock";
      const teams = mode === "teams";
      const headline = teams && result.winnerTeamName
        ? `<span style="color:${winCss}">${esc(result.winnerTeamName)}</span> win!`
        : winName ? `<span style="color:${winCss}">${esc(winName)}</span> wins!` : "Draw!";
      const sub = { stock: "Last car standing.", teams: "Last team standing.", time: "Most KOs when the clock ran out." }[mode] || "";
      const wTeam = teams ? result.winnerTeam : null;

      /* MVP tags: each goes to the single best player for that stat (and
         only if they actually did it). One player can collect several. */
      const tags = places.map(() => []);
      const award = (label, val) => {
        let best = -1, bi = -1, tie = false;
        places.forEach((p, i) => { const v = val(p); if (v > best) { best = v; bi = i; tie = false; } else if (v === best) tie = true; });
        if (bi >= 0 && best > 0 && !tie) tags[bi].push(label);
      };
      const st = (p) => p.stats || {};
      award("MOST KOs", (p) => p.kos || 0);
      award("SPEED DEMON", (p) => st(p).topSpeed || 0);
      award("AIR ACE", (p) => st(p).aerial || 0);
      award("FLIP MASTER", (p) => st(p).flips || 0);
      award("RESET KING", (p) => st(p).bunts || 0);
      award("THE WALL", (p) => st(p).returns || 0);

      // The podium (top three) for everything except Teams.
      const podium = !teams && places.length >= 2 ? `
        <div class="podium">
          ${[1, 0, 2].filter((k) => places[k]).map((k) => `
            <div class="step p${k + 1}" style="border-color:${places[k].css}">
              <div class="pnum">${k + 1}</div>
              <div class="pname" style="color:${places[k].css}">${esc(places[k].name)}</div>
            </div>`).join("")}
        </div>` : "";
      const matchStats = result && (result.topSpeed || result.bestRally) ? `
        <div class="match-stats">
          <span>Top speed <b>${Math.round(result.topSpeed || 0)}</b></span>
          <span>Longest rally <b>${result.bestRally || 0}</b> strikes</span>
          ${result.duration ? `<span>Time <b>${Math.floor(result.duration / 60)}:${String(Math.round(result.duration % 60)).padStart(2, "0")}</b></span>` : ""}
        </div>` : "";
      const pline = (p) => {
        const q = st(p);
        if (!p.stats) return "";
        return `<div class="pstats">top ${Math.round(q.topSpeed || 0)} · ${q.returns || 0} returns · ${q.aerial || 0} aerial · ${q.flips || 0} flip · ${q.bunts || 0} bunt</div>`;
      };
      const card = TP.HUD.card(`
        <h2>${headline}</h2>
        <p>${sub}</p>
        ${podium}
        ${matchStats}
        ${places.map((p, i) => `
          <div class="result-row ${(teams ? p.team === wTeam : i === 0) && winName ? "win" : ""}" style="border-color:${p.css}">
            <span class="place">${teams ? (p.team === wTeam ? "WIN" : "") : ord(i + 1)}</span>
            <span class="who" style="color:${p.css}">${teams ? (p.team === 0 ? "▲ " : "■ ") : ""}${esc(p.name)}${tags[i].map((t) => `<span class="mvp">${t}</span>`).join("")}${pline(p)}</span>
            <span class="stat">${p.kos ?? 0} KO${(p.kos ?? 0) === 1 ? "" : "s"}</span>
            <span class="stat">${mode === "time" ? "" : (p.livesLeft ?? 0) > 0 ? "♥".repeat(p.livesLeft) : "OUT"}</span>
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
