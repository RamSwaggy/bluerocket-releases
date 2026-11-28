/* =====================================================================
   party-sfx.js — Turbo Party's own extra sound effects.

   The shared sounds (TP.sfx.play("coin") and friends) live in
   shared/js/sfx.js, which belongs to the Director. These are the extra
   party-show sounds this mode needs — a drumroll, a whoosh for banners,
   a cheer, a sad trombone-ish "aww", a pop for coin bubbles and a
   fanfare — built here in our own folder, the way TEAMS.md asks.

   Every sound is made in code (no audio files): short oscillator notes
   and bursts of filtered noise. They are plugged into the shared
   `master` volume (TP.sfx.context()), so the shared M-to-mute still
   silences them.

   Usage:  TP.partySfx.play("drumroll", 1.6);   // name, optional length
   ===================================================================== */
(function () {
  "use strict";

  // One short note: pitch slides from f0 to f1 over `dur` seconds.
  function note(ctx, out, f0, f1, dur, type, vol, delay = 0) {
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    // Quick fade in and out so notes don't click.
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // A burst of white noise through a filter: drums, whooshes, crowd noise.
  // `sweep` slides the filter from f0 to f1 (a rising whoosh, say).
  let noiseBuf = null;
  function noise(ctx, out, dur, vol, { delay = 0, type = "bandpass", f0 = 1200, f1 = f0, q = 1 } = {}) {
    if (!noiseBuf) {
      // One second of noise, made once and reused by every burst.
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f0, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.05, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(out);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  // Each effect gets the audio context and the shared master output.
  const EFFECTS = {
    // Snare drumroll that swells, then a cymbal-ish crash at the end.
    // `len` = seconds of roll before the crash.
    drumroll(ctx, out, len = 1.6) {
      const hits = Math.round(len * 22);
      for (let i = 0; i < hits; i++) {
        const k = i / hits; // 0 → 1, gets louder
        noise(ctx, out, 0.06, 0.05 + k * 0.12, { delay: i / 22, f0: 1800, q: 0.8 });
      }
      noise(ctx, out, 0.9, 0.22, { delay: len, type: "highpass", f0: 5000, f1: 3000, q: 0.5 });
      note(ctx, out, 110, 55, 0.5, "sine", 0.3, len);
    },
    // Rising air swish, for banners sliding in.
    whoosh(ctx, out) {
      noise(ctx, out, 0.35, 0.12, { f0: 400, f1: 3500, q: 1.5 });
    },
    // Crowd cheer: a wash of noise plus a few rising "woo" voices.
    cheer(ctx, out) {
      noise(ctx, out, 1.4, 0.12, { f0: 900, f1: 1400, q: 0.6 });
      for (let i = 0; i < 4; i++) note(ctx, out, 300 + i * 70, 520 + i * 90, 0.5, "triangle", 0.035, i * 0.08);
    },
    // A sad descending "wah-wah" for last place.
    aww(ctx, out) {
      [392, 370, 349].forEach((f, i) => note(ctx, out, f, f * 0.97, 0.28, "sawtooth", 0.05, i * 0.3));
      note(ctx, out, 330, 260, 0.7, "sawtooth", 0.05, 0.9);
    },
    // Tiny bubbly pop for coin bubbles. `up` = true for gains, false for losses.
    pop(ctx, out, up = true) {
      if (up) note(ctx, out, 700, 1400, 0.08, "sine", 0.1);
      else note(ctx, out, 500, 220, 0.12, "sine", 0.1);
    },
    // Short brass-like fanfare for the champion.
    fanfare(ctx, out) {
      const seq = [[523, 0], [659, 0.14], [784, 0.28], [1047, 0.42], [784, 0.62], [1047, 0.76]];
      for (const [f, t] of seq) {
        note(ctx, out, f, f, t >= 0.76 ? 0.7 : 0.16, "square", 0.06, t);
        note(ctx, out, f / 2, f / 2, t >= 0.76 ? 0.7 : 0.16, "triangle", 0.08, t);
      }
    },
    // Camera "zoom in" thump, for punch-ins.
    thump(ctx, out) {
      note(ctx, out, 160, 60, 0.18, "sine", 0.25);
      noise(ctx, out, 0.12, 0.06, { type: "lowpass", f0: 600 });
    },
    // Ready-up blip on the minigame card.
    ready(ctx, out) {
      note(ctx, out, 660, 660, 0.07, "square", 0.06);
      note(ctx, out, 990, 990, 0.1, "square", 0.06, 0.07);
    },
  };

  TP.partySfx = {
    play(name, arg) {
      try {
        const { ctx, master } = TP.sfx.context();
        if (!ctx || !master || !EFFECTS[name]) return;
        EFFECTS[name](ctx, master, arg);
      } catch (e) { /* audio problems must never break the game */ }
    },
  };
})();
