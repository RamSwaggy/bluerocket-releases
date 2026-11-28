/* =====================================================================
   sfx-fight.js — Car Fighter's sounds and fight music, all synthesised
   with the Web Audio API (no audio files, so nothing for CREDITS.md).

   Sounds go through the SHARED master volume (TP.sfx.context().master),
   so the M key mutes them like every other Rocket Rumble sound.

     TP.FightSfx.hit(tier, combo)   metal crunch; tier 0 light, 1 heavy,
                                    2 signature. Pitch climbs with combo.
     .clang()        a blocked hit: a dull ringing clank
     .screech()      tyres: sidestep, dash strike
     .whoosh()       a whiff (missed attack)
     .thump()        the low "freeze" under hit-stop on heavy hits
     .count()        3-2-1 beep
     .roundSting()   "ROUND N"
     .fightSting()   "FIGHT!"
     .koSting()      a KO
     .winSting()     match won
     .sigSting()     a signature move starting
     .chime()        a super bar just filled
     .music(on)      the Car Fighter fight track (defined below)
     .intensity(k)   0 normal, 1 hurry (last 10 s), 2 match point too:
                     the track speeds up

   Browsers block audio until the player clicks or presses a key. We don't
   touch the audio system at all until that first gesture (so a ?demo
   with no clicks stays silent and logs no autoplay warnings).
   ===================================================================== */
window.TP = window.TP || {};

(function () {
  "use strict";

  let armed = false;             // set on the first click / key press
  let noise = null;              // 1 s of white noise, made once per audio context
  let noiseCtx = null;
  let wantMusic = false;
  let musicOn = false;
  let level = -1;                // current intensity (for tempo changes)

  const BASE_BPM = 138;
  const BPM = [BASE_BPM, BASE_BPM * 1.1, BASE_BPM * 1.18];

  function arm() {
    if (armed) return;
    armed = true;
    window.removeEventListener("pointerdown", arm, true);
    window.removeEventListener("keydown", arm, true);
    if (TP.sfx) TP.sfx.unlock();
    if (wantMusic) startMusic();
  }
  window.addEventListener("pointerdown", arm, true);
  window.addEventListener("keydown", arm, true);

  // The shared audio context + master bus, or null if not allowed yet.
  function ac() {
    if (!armed || !TP.sfx || !TP.sfx.context) return null;
    const { ctx, master } = TP.sfx.context();
    if (!ctx || !master) return null;
    if (noiseCtx !== ctx) {
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noiseCtx = ctx;
    }
    return { ctx, out: master };
  }

  /* A gain envelope: quick attack to `vol`, exponential fall over `dur`. */
  function env(ctx, t, vol, dur, attack = 0.004) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    return g;
  }

  /* One oscillator note sliding f0 → f1. */
  function osc(a, type, f0, f1, dur, vol, delay = 0) {
    const t = a.ctx.currentTime + delay;
    const o = a.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    o.connect(env(a.ctx, t, vol, dur)).connect(a.out);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  /* Filtered noise: `type` is a BiquadFilter type; the filter frequency
     slides f0 → f1. This is the basis of crunches, screeches and whooshes. */
  function hiss(a, type, f0, f1, q, dur, vol, delay = 0) {
    const t = a.ctx.currentTime + delay;
    const src = a.ctx.createBufferSource();
    src.buffer = noise;
    const f = a.ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    src.connect(f).connect(env(a.ctx, t, vol, dur)).connect(a.out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.03);
  }

  const FX = {
    /* Metal crunch. Each hit in a combo is pitched a little higher
       (about a semitone per hit, capped), so long combos "climb". */
    hit(tier = 0, combo = 1) {
      const a = ac(); if (!a) return;
      const p = Math.pow(2, Math.min(10, Math.max(0, combo - 1)) / 12);
      const len = [0.12, 0.2, 0.3][tier] || 0.12;
      hiss(a, "bandpass", 1400 * p, 380 * p, 1.1, len, [0.55, 0.7, 0.8][tier]);
      osc(a, "square", 260 * p, 90, len * 0.8, [0.12, 0.16, 0.18][tier]);
      osc(a, "sine", 150 * p, 45, len * 1.4, [0.35, 0.55, 0.7][tier]);
      if (tier >= 1) hiss(a, "highpass", 4000, 2500, 0.7, 0.06, 0.3);   // a sharp metal "tick" on top
    },
    clang() {
      const a = ac(); if (!a) return;
      // Two out-of-tune partials ring like a struck steel panel.
      osc(a, "triangle", 820, 800, 0.32, 0.18);
      osc(a, "triangle", 1235, 1210, 0.24, 0.1);
      hiss(a, "highpass", 3000, 2000, 0.7, 0.04, 0.25);
    },
    screech() {
      const a = ac(); if (!a) return;
      hiss(a, "bandpass", 2600, 2100, 9, 0.26, 0.35);
      osc(a, "sawtooth", 1750, 1480, 0.22, 0.03);
    },
    whoosh() {
      const a = ac(); if (!a) return;
      hiss(a, "bandpass", 350, 1600, 1.4, 0.2, 0.28);
    },
    thump() {
      const a = ac(); if (!a) return;
      osc(a, "sine", 75, 32, 0.22, 0.7);
    },
    // A super bar just filled: a bright two-note chime.
    chime() {
      const a = ac(); if (!a) return;
      osc(a, "triangle", 1319, 1319, 0.14, 0.12);
      osc(a, "triangle", 1976, 1976, 0.3, 0.1, 0.08);
    },
    count() {
      const a = ac(); if (!a) return;
      osc(a, "square", 660, 660, 0.12, 0.09);
    },
    roundSting() {
      const a = ac(); if (!a) return;
      osc(a, "sawtooth", 220, 220, 0.18, 0.08);
      osc(a, "sawtooth", 330, 330, 0.3, 0.08, 0.16);
      osc(a, "sine", 110, 55, 0.4, 0.4);
    },
    fightSting() {
      const a = ac(); if (!a) return;
      // A minor power chord stab plus a crash of noise.
      for (const f of [220, 330, 440]) osc(a, "sawtooth", f, f * 0.99, 0.45, 0.06);
      hiss(a, "highpass", 6000, 3000, 0.5, 0.6, 0.25);
      osc(a, "sine", 120, 40, 0.35, 0.6);
    },
    koSting() {
      const a = ac(); if (!a) return;
      osc(a, "sawtooth", 440, 90, 0.9, 0.12);
      osc(a, "square", 220, 50, 1.0, 0.07, 0.05);
      osc(a, "sine", 90, 30, 0.8, 0.7);
      hiss(a, "lowpass", 1800, 200, 0.8, 0.9, 0.35);
    },
    winSting() {
      const a = ac(); if (!a) return;
      [523, 659, 784, 1047].forEach((f, i) => osc(a, "square", f, f, 0.22, 0.07, i * 0.11));
      osc(a, "sawtooth", 262, 262, 0.7, 0.05, 0.44);
    },
    sigSting() {
      const a = ac(); if (!a) return;
      // A rising power-up whine, then a low hit.
      osc(a, "sawtooth", 180, 900, 0.35, 0.07);
      hiss(a, "bandpass", 500, 3500, 2, 0.35, 0.2);
      osc(a, "sine", 60, 30, 0.5, 0.6, 0.3);
    },

    /* ---------- Music ---------- */
    music(on) {
      wantMusic = !!on;
      if (on) startMusic(); else stopMusic();
    },
    /* 0 = normal, 1 = hurry (last 10 seconds), 2 = hurry at match point. */
    intensity(k) {
      if (k === level) return;
      level = k;
      if (musicOn && TP.sfx.setTempo) TP.sfx.setTempo(BPM[k] || BASE_BPM);
    },
  };

  function startMusic() {
    if (!armed || musicOn || !TP.sfx) return;
    TP.sfx.music(true, "car-fighter");
    if (TP.sfx.setTempo) TP.sfx.setTempo(BPM[Math.max(0, level)] || BASE_BPM);
    musicOn = true;
  }
  function stopMusic() {
    if (!musicOn) return;
    TP.sfx.music(false);
    musicOn = false;
  }

  /* =====================================================================
     The Car Fighter fight track: "Turntable".
     Heavy and mechanical: a stomping kick, a clanky snare, a sawtooth bass
     riff in E minor, ticking hats, and a stab every second bar. Defined
     with the shared custom-step form, so shared/sfx.js isn't touched.
     One loop = 4 bars of 16 sixteenth notes.
     ===================================================================== */
  const ROOTS = [40, 40, 43, 38];                  // E, E, G, D (bass roots per bar)
  const RIFF = { 0: 0, 3: 0, 6: 12, 8: 0, 10: 3, 11: 0, 14: 7 };  // step → semitones above the root
  if (TP.sfx && TP.sfx.defineTrack) {
    TP.sfx.defineTrack("car-fighter", {
      bpm: BASE_BPM,
      step(s, t, api) {
        const { noteAt, hatAt, hz, len } = api;
        const bar = Math.floor(s / 16) % 4;
        const i = s % 16;
        // Kick: beats 1 and 3, plus a push on the "and" before beat 4.
        if (i === 0 || i === 8 || i === 10) noteAt(t, 155, 38, 0.2, "sine", 0.55);
        // Snare: a short triangle knock plus a noise tick on beats 2 and 4.
        if (i === 4 || i === 12) { noteAt(t, 240, 150, 0.1, "triangle", 0.26); hatAt(t, 0.24); }
        // Hats on the off 16ths, accented on the off-beats.
        if (i % 2 === 1) hatAt(t, i % 4 === 3 ? 0.09 : 0.05);
        // Bass riff.
        if (RIFF[i] !== undefined) {
          const n = ROOTS[bar] + RIFF[i];
          noteAt(t, hz(n), hz(n), len * 1.5, "sawtooth", 0.12);
        }
        // A stab chord at the top of every second bar.
        if (i === 0 && bar % 2 === 0) {
          for (const k of [12, 19, 24]) noteAt(t, hz(ROOTS[bar] + k), hz(ROOTS[bar] + k), len * 3, "square", 0.03);
        }
        // A metal "clank" at the end of the loop.
        if (bar === 3 && i === 14) noteAt(t, 1250, 1170, 0.12, "square", 0.04);
      },
    });
  }

  TP.FightSfx = FX;
})();
