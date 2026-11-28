/* =====================================================================
   presentation.js — the "show" around a Deflect Duel match: everything
   that makes it feel like an event rather than a physics test.

   In plain English:
     • MUSIC that builds with the ball. A driving loop that starts calm;
       as the ball gets faster the tempo rises and more layers join in
       (busier hi-hats, a doubled bassline, a higher, faster melody).
     • ANNOUNCER CALLOUTS: big words for big moments ("FAST!", "200!!",
       "FLIP STRIKE!", "PERFECT!"), with a sound for each.
     • The CROWD (the light dots along the stands) jumps and glows when the
       ball gets fast or someone is knocked out, and roars.
     • INSTANT REPLAY: after a big KO (a fast ball, or the match-winner),
       the last couple of seconds play again in slow motion. Any Hit or
       Jump press skips it.
     • At the end, the results card shows a podium, match stats and MVP
       tags (built in hud.js from the stats the rules collect).

   Used by main.js:
     TP.DuelShow.start(duel)          a match began
     TP.DuelShow.event(name, data)    every match event (hit, ko, clash, ...)
     TP.DuelShow.record()             once per frame after duel.update()
     TP.DuelShow.replaying            true while a replay is showing
     TP.DuelShow.replayStep(dt)       once per frame instead of duel.update()
                                      while replaying
     TP.DuelShow.stop()               back to the menu (music off)
   Nothing here changes the rules: replays only redraw saved positions.
   ===================================================================== */
(function () {
  "use strict";

  /* ---------- Music: a track whose layers follow the ball's speed ---------- */
  let heat = 0;          // 0 (calm) .. 1 (ball at top speed), smoothed
  const CHORDS = [       // A minor feel: Am → F → C → G (one bar each)
    { root: 45, notes: [57, 60, 64] },
    { root: 41, notes: [57, 60, 65] },
    { root: 48, notes: [60, 64, 67] },
    { root: 43, notes: [59, 62, 67] },
  ];
  if (TP.sfx && TP.sfx.defineTrack) {
    TP.sfx.defineTrack("duel", {
      bpm: 118,
      step(s, t, api) {
        const { noteAt, hatAt, hz, len } = api;
        const bar = Math.floor(s / 16) % CHORDS.length, inBar = s % 16;
        const c = CHORDS[bar];
        // Kick on every beat; a hi-hat that gets busier with heat.
        if (inBar % 4 === 0) noteAt(t, 150, 40, 0.16, "sine", 0.5);
        if (inBar % 4 === 2) hatAt(t, 0.1);
        if (heat > 0.25 && inBar % 2 === 1) hatAt(t, 0.05 + 0.05 * heat);
        // Bass: on the beat, then doubled on the off-beats when it heats up.
        if (inBar % 4 === 0) noteAt(t, hz(c.root), hz(c.root), len * 1.6, "triangle", 0.26);
        if (heat > 0.4 && inBar % 4 === 2) noteAt(t, hz(c.root + 12), hz(c.root + 12), len * 0.9, "triangle", 0.16);
        // Melody: an arpeggio, quarter notes when calm, 8ths then 16ths as
        // it heats up, and an octave higher near the top.
        const every = heat > 0.7 ? 1 : heat > 0.3 ? 2 : 4;
        if (inBar % every === 0) {
          const n = c.notes[(inBar / every) % c.notes.length] + 12 + (heat > 0.75 ? 12 : 0);
          noteAt(t, hz(n), hz(n), len * 1.4, "square", 0.035 + 0.02 * heat);
        }
      },
    });
  }

  /* ---------- The crowd's roar: filtered noise, louder for bigger moments ---------- */
  let noise = null;
  function roar(amount) {
    if (!TP.sfx || !TP.sfx.context) return;
    const { ctx, master } = TP.sfx.context();
    if (!ctx || !master) return;
    if (!noise) {
      noise = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 700 + 500 * amount;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06 + 0.12 * amount, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6 + 0.8 * amount);
    src.connect(bp).connect(g).connect(master);
    src.start(t);
    src.stop(t + 1.5);
  }

  /* ---------- State for the current match ---------- */
  let duel = null;
  let rallyCalled = 0;      // highest speed threshold already called this rally
  let firstKO = true;

  // Speed callouts, each once per rally (the ball has to get there).
  const SPEED_CALLS = [
    { at: 50, text: "FAST!", color: "#7de7ff" },
    { at: 100, text: "BLAZING!", color: "#ffe14d" },
    { at: 150, text: "INSANE!", color: "#ff8a3d" },
    { at: 200, text: "200!!", color: "#ff4fd8" },
  ];

  function callout(text, color, big = false) {
    if (TP.HUD.callout) TP.HUD.callout(text, color, big);
    else TP.HUD.toast(text, color, 1.0);
  }

  function cheer(amount, css) {
    if (duel && duel.arenaLook && duel.arenaLook.cheer) duel.arenaLook.cheer(amount, css);
    roar(amount);
  }

  /* ---------- Instant replay ----------
     Every frame we save a light copy of what's on screen: each car's
     position, rotation and visibility, and the ball's position, motion,
     owner and mode. After a big KO we play the last ~2 s back in slow
     motion by putting those values back and calling duel.animate(), so
     the normal drawing code (and every effect) shows the replay. When
     it's over, the real current state is put back exactly as it was. */
  const REPLAY_SEC = 2.0, REPLAY_RATE = 0.45;
  let tape = [];            // [{ t, cars: [...], ball: {...} }]
  let tapeT = 0;            // real seconds recorded so far
  let replay = null;        // { frames, k, saved, onDone }
  let pendingReplay = null; // set by a big KO, started once the KO pause shows

  function grab() {
    const b = duel.ball;
    return {
      cars: duel.cars.map((c, i) => ({
        x: c.pos.x, y: c.pos.y, z: c.pos.z, h: c.heading,
        q: c.quat ? [c.quat.x, c.quat.y, c.quat.z, c.quat.w] : null,
        vis: c.mesh.visible, dead: duel.players[i].dead, out: c.out,
      })),
      ball: { x: b.pos.x, y: b.pos.y, z: b.pos.z, vx: b.vel.x, vy: b.vel.y, vz: b.vel.z, owner: b.owner, mode: b.mode, neutral: b.neutral, speed: b.speed, heat: b.heat || 0 },
    };
  }
  function put(f) {
    f.cars.forEach((s, i) => {
      const c = duel.cars[i];
      c.pos.set(s.x, s.y, s.z);
      c.heading = s.h;
      if (s.q && c.quat) c.quat.set(s.q[0], s.q[1], s.q[2], s.q[3]);
      c.mesh.visible = s.vis;
      c.out = s.out;
      duel.players[i].dead = s.dead;
    });
    const b = duel.ball, x = f.ball;
    b.pos.set(x.x, x.y, x.z);
    b.vel.set(x.vx, x.vy, x.vz);
    b.owner = x.owner; b.mode = x.mode; b.neutral = x.neutral; b.speed = x.speed; b.heat = x.heat;
  }

  TP.DuelShow = {
    get replaying() { return !!replay; },
    get heat() { return heat; },

    start(d) {
      duel = d;
      heat = 0;
      rallyCalled = 0;
      firstKO = true;
      tape = []; tapeT = 0; replay = null; pendingReplay = null;
      if (TP.sfx) { TP.sfx.music(true, "duel"); TP.sfx.setTempo(118); }
    },

    stop() {
      duel = null;
      replay = null; pendingReplay = null;
      if (TP.sfx) TP.sfx.music(false);
    },

    // Once per frame (after the rules ran): music heat, and the replay tape.
    record(dt) {
      if (!duel || replay) return;
      const target = Math.min(1, (duel.ball.speed || 0) / duel.cfg.maxSpeed) * (duel.ball.mode === "neutral" ? 0.4 : 1);
      heat += (target - heat) * Math.min(1, dt * (target > heat ? 3 : 0.6)); // rises fast, falls slowly
      if (TP.sfx && TP.sfx.setTempo) TP.sfx.setTempo(Math.round(118 + 34 * heat));
      // Tape: only the last REPLAY_SEC seconds of real play are kept.
      if (duel.state === "play" && duel.freezeLeft <= 0) {
        tapeT += dt;
        tape.push(Object.assign({ t: tapeT }, grab()));
        while (tape.length && tape[0].t < tapeT - REPLAY_SEC) tape.shift();
      }
      // A replay waits for the KO's own pause/explosion to show first.
      if (pendingReplay && (pendingReplay.wait -= dt) <= 0) {
        const frames = tape.slice();
        const onDone = pendingReplay.onDone;
        pendingReplay = null;
        if (frames.length > 10) {
          replay = { frames, k: 0, saved: grab(), onDone };
          TP.HUD.center("REPLAY", "press Hit to skip", "#ffffff");
        } else if (onDone) onDone();
      }
    },

    // Asked for by main.js: should a KO at this speed get a replay?
    // (Not in quick all-bot demos, practice or the tutorial.)
    wantsReplay(speed, final) {
      if (!duel || duel.mode === "practice") return false;
      return final || speed >= 100;
    },

    // Queue a replay of the moments before this KO; onDone runs after it.
    queueReplay(onDone) {
      if (pendingReplay) {
        // Already one waiting (say the final KO also ends the match): one
        // replay, then both follow-ups.
        const prev = pendingReplay.onDone;
        pendingReplay.onDone = () => { if (prev) prev(); if (onDone) onDone(); };
        return;
      }
      pendingReplay = { wait: 0.7, onDone };
    },

    // Is a replay waiting or showing?
    get busy() { return !!(pendingReplay || replay); },

    // One frame of an active replay (main.js calls this instead of duel.update).
    replayStep(dt) {
      if (!replay) return;
      const r = replay;
      // Skip with Hit or Jump from anyone.
      const skip = duel.players.some((p) => !p.launcher && p.controller !== "bot" && (() => { const c = TP.Input.get(p.controller); return c.hit || c.jump; })());
      r.k += dt * REPLAY_RATE / Math.max(1e-3, (r.frames[r.frames.length - 1].t - r.frames[0].t) / r.frames.length);
      const i = Math.floor(r.k);
      if (skip && r.k > 6 || i >= r.frames.length) {
        put(r.saved);
        duel.animate(0);
        replay = null;
        TP.HUD.center("");
        tape = []; tapeT = 0;
        if (r.onDone) r.onDone();
        return;
      }
      put(r.frames[i]);
      duel.animate(dt * REPLAY_RATE);
    },

    // Every match event (main.js forwards them): callouts and the crowd.
    event(name, data) {
      if (!duel) return;
      if (name === "hit") {
        const sp = data.speed || 0, css = data.player && data.player.css;
        // Speed milestones, each once per rally.
        for (const c of SPEED_CALLS) {
          if (sp >= c.at && rallyCalled < c.at) { rallyCalled = c.at; callout(c.text, c.color, c.at >= 150); TP.sfx.play("goal"); }
        }
        if (data.info && data.info.flip) callout("FLIP STRIKE!", css);
        else if (data.info && data.info.aerial && data.player && data.player.car && data.player.car.pos.y > 2.5) callout("AERIAL!", css);
        if (duel.ball.hits === 10) callout("RALLY ×10", "#ffffff");
        cheer(Math.min(1, sp / duel.cfg.maxSpeed), css);
      } else if (name === "bunt") {
        callout("RESET!", data.player && data.player.css);
        cheer(0.3, data.player && data.player.css);
      } else if (name === "clash") {
        cheer(0.8, "#ffe14d");
      } else if (name === "ko") {
        const sp = data.speed || 0, css = data.owner ? data.owner.css : "#ffffff";
        if (firstKO) { callout("FIRST KO!", css); firstKO = false; }
        else if (sp >= 150) callout("OBLITERATED!", css, true);
        cheer(1, css);
        rallyCalled = 0;
      } else if (name === "serve" || name === "stalemate") {
        rallyCalled = 0;
      } else if (name === "end") {
        // How did the winner win?
        const r = data, w = duel.players[r.winner];
        if (w && duel.mode === "stock" && w.lives === duel.lives) callout("PERFECT!", w.css, true);
        else if (w && duel.mode === "stock" && w.lives === 1 && duel.lives > 1) callout("CLUTCH!", w.css, true);
        cheer(1, w && w.css);
      }
    },
  };
})();
