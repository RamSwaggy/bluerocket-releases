/* =====================================================================
   ui.js — every piece of on-screen text in Car Fighter: the fight HUD,
   the big centre calls (ROUND 1, 3-2-1, FIGHT!, K.O., TIME, DRAW), the
   controls hint, and the full-screen cards (menu and results are built
   in main.js and shown through UI.card()).

   The 3D scene never draws text; it all lives in HTML over the canvas
   (see index.html). This file only READS fight.state. It's called by
   view.js once per rendered frame: TP.FightUI.update(state, dt).

   Timing note: anything tied to the fight (how long FIGHT! stays up,
   the countdown) is measured in FIGHT FRAMES (state.frame, 60 per
   second), not wall-clock time, so it still lines up when a test runs
   the game at ?speed=8. Bar animations use real time (they're just
   for looks).
   ===================================================================== */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const FPS = 60;

  /* The two players as main.js describes them. Defaults are used for
     ?demo (bot vs bot) when main.js doesn't set anything. */
  let players = [
    { name: "Bot 1", fighter: "Rivet", controller: "bot" },
    { name: "Bot 2", fighter: "Rivet", controller: "bot" },
  ];
  let winsNeeded = 2;          // best of 3 → first to 2

  // Per-match tracking.
  let T = null;

  function freshTracking() {
    return {
      phase: "",                 // last phase we saw ("hitstop" counts as "fight")
      phaseStart: 0,             // state.frame when that phase began
      call: null,                // { html, until (frame) } — current centre call
      callKey: "",
      lag: [1, 1],               // white "damage just taken" bar, as a 0..1 fraction
      lagHold: [0, 0],           // seconds before the lag bar starts to drain
      shown: [1, 1],             // health fraction last frame
      cache: {},                 // last values written to the DOM (skip no-op writes)
      rounds: [],                // our own round log for the results card
      lastRound: 0,
      ended: false,
    };
  }

  /* ---------- Small DOM helpers ---------- */
  function setStyle(el, key, prop, value) {
    if (T.cache[key] === value) return;
    T.cache[key] = value;
    el.style[prop] = value;
  }
  function setClass(el, key, cls, on) {
    if (T.cache[key] === on) return;
    T.cache[key] = on;
    el.classList.toggle(cls, on);
  }

  /* Build the two side panels once per match (names, gauges, segments). */
  function buildHud() {
    for (let i = 0; i < 2; i++) {
      const p = players[i];
      const el = $("side" + i);
      el.style.setProperty("--seat", TP.PLAYER_CSS[i]);
      el.innerHTML = `
        <div class="who"><span class="name" style="color:${TP.PLAYER_CSS[i]}">${esc(p.name)}</span>
          <span class="car">${esc(p.fighter)}</span></div>
        <div class="gauge"><div class="lag"></div><div class="fill"></div><div class="ticks"></div></div>
        <div class="meters">
          <div class="super">${[0, 1, 2].map(() => `<div class="seg"><i></i></div>`).join("")}</div>
          <div class="boostbar" title="Boost"><i></i></div>
        </div>`;
    }
    $("pips").innerHTML = [0, 1].map((i) =>
      `<div class="set p${i + 1}" style="--seat:${TP.PLAYER_CSS[i]}"></div>`).join("");
    T.cache = {};
  }

  /* Show a big centre call until fight frame `until`. */
  function call(text, sub, color, untilFrame, key) {
    const k = key || text + "|" + (sub || "");
    if (T.callKey === k) { T.call.until = untilFrame; return; }
    T.callKey = k;
    T.call = { until: untilFrame };
    const el = $("call");
    el.classList.remove("show");
    void el.offsetWidth;               // restart the slam-in animation
    el.innerHTML = `<span style="color:${color || "inherit"}">${esc(text)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}`;
    el.classList.add("show");
  }
  function clearCall() {
    T.call = null;
    T.callKey = "";
    $("call").classList.remove("show");
  }

  const hp = (c) => (c && c.maxHealth ? Math.max(0, c.health) / c.maxHealth : 1);

  /* Who won the round that just ended, and how. Derived from the state
     ourselves so the HUD doesn't depend on the exact roundResults shape:
       KO        one car at 0 health
       DOUBLE KO both at 0 on the same frame → draw
       TIME      clock ran out: higher health % wins, equal = draw */
  function judgeRound(state) {
    const [a, b] = state.cars || [];
    const ha = hp(a), hb = hp(b);
    if (ha <= 0 && hb <= 0) return { winner: -1, how: "Double KO" };
    if (ha <= 0) return { winner: 1, how: "KO" };
    if (hb <= 0) return { winner: 0, how: "KO" };
    if (Math.abs(ha - hb) < 1e-6) return { winner: -1, how: "Time · draw" };
    return { winner: ha > hb ? 0 : 1, how: "Time" };
  }

  // The round clock in whole seconds. (If fight.js ever reports frames
  // instead of seconds, divide down: no real round lasts 200+ seconds.)
  function clockSeconds(state) {
    let t = Number(state.timer) || 0;
    if (t > 200) t /= FPS;
    return Math.max(0, Math.ceil(t - 1e-6));
  }

  /* ---------- Phase changes: the calls that drive the match's rhythm ---------- */
  function onPhase(state, phase, prev) {
    const f = state.frame || 0;
    const round = state.round || 1;
    if (phase === "intro") {
      const last = (state.roundWins || [0, 0]).every((w) => w === winsNeeded - 1);
      const sudden = state.suddenDeath || round > winsNeeded * 2 - 1;
      call(sudden ? "SUDDEN DEATH" : last ? "FINAL ROUND" : `ROUND ${round}`, "", "#f2f5ff", f + 600, "intro" + round);
      T.lastRound = round;
    } else if (phase === "fight" && prev === "countdown") {
      call("FIGHT!", "", "#ffcc33", f + 45, "fight" + round);
      if (TP.sfx) TP.sfx.play("go");
      $("hint").classList.add("dim");
    } else if (phase === "roundEnd") {
      const r = judgeRound(state);
      T.rounds.push({ round, winner: r.winner, how: r.how });
      const who = r.winner >= 0 ? players[r.winner].name : "";
      const color = r.winner >= 0 ? TP.PLAYER_CSS[r.winner] : "#f2f5ff";
      if (r.how === "KO") call("K.O.", `${who} takes round ${round}`, "#ff5a3c", f + 100000, "end" + round);
      else if (r.how === "Double KO") call("DOUBLE K.O.", "Draw: a round each", "#ff5a3c", f + 100000, "end" + round);
      else if (r.winner < 0) call("DRAW", "Time! A round each", "#f2f5ff", f + 100000, "end" + round);
      else call("TIME", `${who} takes round ${round}`, color, f + 100000, "end" + round);
      if (TP.sfx) TP.sfx.play(r.how === "KO" || r.how === "Double KO" ? "lose" : "count");
    } else if (phase === "matchEnd" && !T.ended) {
      T.ended = true;
      clearCall();
      // Let the last KO breathe before the results card covers the stage.
      setTimeout(() => { if (UI.onMatchEnd) UI.onMatchEnd(state, T.rounds.slice()); }, 900);
    }
  }

  const UI = {
    esc,

    /* main.js: who's playing. list = [{ name, fighter, controller }, x2] */
    setPlayers(list, needed) {
      players = list.map((p, i) => Object.assign({}, players[i], p));
      if (needed) winsNeeded = needed;
    },
    get players() { return players; },
    get winsNeeded() { return winsNeeded; },

    /* view.js calls this from init(): a new match starts. */
    startMatch() {
      T = freshTracking();
      buildHud();
      clearCall();
      UI.hideCard();
      $("hud").classList.add("show");
      UI.showHint();
    },

    /* view.js calls this every rendered frame. */
    update(state, dt) {
      if (!T || !state) return;
      const f = state.frame || 0;

      // Phase tracking. Hit-stop is just a pause inside the fight.
      const phase = state.phase === "hitstop" ? "fight" : state.phase || "fight";
      if (phase !== T.phase) {
        const prev = T.phase;
        T.phase = phase;
        T.phaseStart = f;
        onPhase(state, phase, prev);
      }

      // Countdown: 3-2-1 from the frames left in the countdown phase
      // (fight.js's phaseFramesLeft), or from when the phase began.
      if (phase === "countdown") {
        let n = state.phaseFramesLeft != null ? Math.ceil(Number(state.phaseFramesLeft) / FPS - 1e-6)
                                              : 3 - Math.floor((f - T.phaseStart) / FPS);
        n = Math.max(1, Math.min(3, n));
        if (T.callKey !== "count" + n + state.round && TP.sfx) TP.sfx.play("count");
        call(String(n), `Round ${state.round || 1}`, "#f2f5ff", f + FPS, "count" + n + state.round);
      }
      if (T.call && f > T.call.until) clearCall();

      // ----- Side panels -----
      const cs = state.cars || [];
      for (let i = 0; i < 2; i++) {
        const c = cs[i];
        const side = $("side" + i);
        if (!c || !side.firstElementChild) continue;
        const frac = hp(c);
        // Lag bar: snaps to wherever health was, waits a beat, then drains.
        if (frac < T.shown[i] - 1e-6) T.lagHold[i] = 0.45;
        if (frac > T.lag[i]) T.lag[i] = frac;           // healed / new round
        T.lagHold[i] -= dt;
        if (T.lagHold[i] <= 0) T.lag[i] = Math.max(frac, T.lag[i] - dt * 0.9);
        T.shown[i] = frac;

        const fill = side.querySelector(".fill");
        setStyle(fill, "f" + i, "width", (frac * 100).toFixed(1) + "%");
        setClass(fill, "low" + i, "low", frac < 0.3);
        setStyle(side.querySelector(".lag"), "l" + i, "width", (T.lag[i] * 100).toFixed(1) + "%");

        // Super: 3 segments of 100. Each fills in turn; full ones glow.
        const sup = Math.max(0, Number(c.super) || 0);
        side.querySelectorAll(".seg").forEach((seg, k) => {
          const part = Math.max(0, Math.min(1, (sup - k * 100) / 100));
          setStyle(seg.firstElementChild, `s${i}${k}`, "width", (part * 100).toFixed(0) + "%");
          setClass(seg, `sf${i}${k}`, "full", part >= 1);
        });
        const boost = Math.max(0, Math.min(100, Number(c.boost ?? 100)));
        setStyle(side.querySelector(".boostbar i"), "b" + i, "width", boost.toFixed(0) + "%");
      }

      // ----- Timer: two flip digits -----
      const secs = Math.min(99, clockSeconds(state));
      const digits = String(secs).padStart(2, "0");
      if (T.cache.timer !== digits) {
        T.cache.timer = digits;
        $("timer").innerHTML = digits.split("").map((d) => `<b>${d}</b>`).join("");
      }
      setClass($("timer"), "hurry", "hurry", secs <= 10 && phase === "fight");

      // ----- Round bulbs (more appear in sudden death) -----
      const wins = state.roundWins || [0, 0];
      const pipKey = wins.join(",");
      if (T.cache.pips !== pipKey) {
        T.cache.pips = pipKey;
        const n = Math.max(winsNeeded, wins[0] || 0, wins[1] || 0);
        $("pips").querySelectorAll(".set").forEach((set, i) => {
          set.innerHTML = Array.from({ length: n }, (_, k) =>
            `<div class="bulb ${k < (wins[i] || 0) ? "lit" : ""}"></div>`).join("");
        });
      }
    },

    /* Controls hint along the bottom, one row per human player. */
    showHint() {
      const rows = players.map((p, i) => {
        const id = p.controller;
        if (!id || id === "bot" || id === "off") return "";
        const k = TP.keyNames(id);
        const pad = id.startsWith("pad");
        const move = pad ? "Stick ←/→" : k.steer;
        const dodge = pad ? "Stick ↑/↓" : k.drive;
        return `<div class="row" style="--seat:${TP.PLAYER_CSS[i]}"><b>${esc(p.name)}</b> ·
          Move <kbd>${esc(move)}</kbd> · Guard: hold away · Dodge <kbd>${esc(dodge)}</kbd> ·
          Jump <kbd>${esc(k.confirm)}</kbd> · Boost <kbd>${esc(k.boost)}</kbd> ·
          Hit <kbd>${esc(k.hit)}</kbd> · Heavy <kbd>${esc(k.heavy)}</kbd></div>`;
      }).join("");
      const el = $("hint");
      el.innerHTML = rows;
      el.classList.remove("dim");
    },

    /* Generic big centre text, e.g. errors. Pass "" to clear. */
    message(text, sub = "", color = "") {
      if (!text) { $("call").classList.remove("show"); return; }
      const el = $("call");
      el.innerHTML = `<span style="color:${color || "inherit"}">${esc(text)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}`;
      el.classList.add("show");
    },

    hideHud() {
      $("hud").classList.remove("show");
      $("hint").innerHTML = "";
      $("call").classList.remove("show");
    },

    /* Full-screen card (menu, results). Returns the card element. */
    card(html) {
      $("card").innerHTML = html;
      $("overlay").classList.add("show");
      return $("card");
    },
    hideCard() { $("overlay").classList.remove("show"); },

    // Set by main.js: called once when the match is over, with the state
    // and our round log [{ round, winner (0, 1 or -1 for a draw), how }].
    onMatchEnd: null,
  };

  TP.FightUI = UI;
})();
