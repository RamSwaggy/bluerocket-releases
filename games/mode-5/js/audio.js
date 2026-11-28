/* =====================================================================
   audio.js — Mode 5 music and sound effects, all driven by game events.

   Art & UI owns this file. No audio files: everything is synthesised with
   the Web Audio API, like the rest of Rocket Rumble.

   Usage:
     TP.M5.Audio.init();      // once, after events.js; hooks up listeners
     (TP.sfx.unlock() from the Start button also unlocks our sounds)

   MUSIC — "neon-turf", an original synthwave-style loop in D minor, 124 bpm,
   registered with the shared player via TP.sfx.defineTrack (custom step
   function). 16 bars long, in four 4-bar parts so it doesn't feel repetitive:
       bars  0–3   INTRO   kick, pumping octave bass, chord stabs, pads
       bars  4–7   HOOK    + the lead melody and a sparkly arpeggio
       bars  8–11  LIFT    new chords (Gm B♭ Dm A), long singing lead, 16th hats
       bars 12–15  HOOK 2  the hook again, doubled an octave up, drum fill at the end
   OVERDRIVE (last 20 s): tempo goes up, and an extra layer joins in: rolling
   16th hats, an off-beat bass, and the arpeggio doubled an octave higher.

   SOUNDS — splat, fill whoosh-chord, pop "plip", countdown beeps + GO,
   overdrive siren, round-win stinger, match fanfare, landing thud, bump
   crunch, pickup sparkle, pickup-spawn chime. Each is a few oscillators
   or a burst of filtered noise.

   Mode sounds play through the shared audio context and master volume
   (TP.sfx.context()), so the shared M (mute) key and the Start-button
   unlock cover them too. While the title menu is open (a bot match plays
   behind it as a backdrop) mode sounds stay quiet.
   ===================================================================== */
(function () {
  "use strict";
  TP.M5 = TP.M5 || {};

  const BPM = 124;
  const OVERDRIVE_BPM = 144;

  /* =================================================================
     The music track
     ================================================================= */
  const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);

  // Chord voicings (MIDI note numbers). root = bass note.
  const CH = {
    Dm: { root: 38, notes: [57, 62, 65] },
    Bb: { root: 34, notes: [58, 62, 65] },
    F:  { root: 41, notes: [57, 60, 65] },
    C:  { root: 36, notes: [55, 60, 64] },
    Gm: { root: 43, notes: [55, 58, 62] },
    A:  { root: 45, notes: [57, 61, 64] },
  };
  const PART_A = [CH.Dm, CH.Bb, CH.F, CH.C];   // intro + hooks
  const PART_B = [CH.Gm, CH.Bb, CH.Dm, CH.A];  // the lift (A major pulls back home to Dm)

  // Lead melodies: [step within the phrase, MIDI note, length in 16ths].
  // HOOK_1 plays over Dm–B♭ (2 bars), HOOK_2 answers over F–C.
  const HOOK_1 = [
    [0, 74, 2], [3, 77, 1], [4, 81, 3], [8, 79, 2], [10, 77, 2], [12, 74, 4],
    [16, 77, 2], [18, 74, 1], [19, 77, 1], [20, 82, 4], [24, 81, 2], [26, 77, 2], [28, 74, 4],
  ];
  const HOOK_2 = [
    [0, 84, 2], [3, 81, 1], [4, 77, 3], [8, 79, 2], [10, 81, 2], [12, 84, 4],
    [16, 76, 2], [18, 79, 1], [19, 84, 1], [20, 79, 4], [24, 76, 2], [26, 74, 2], [28, 72, 4],
  ];
  // The lift's lead: long notes over Gm–B♭–Dm–A (4 bars = 64 steps).
  const LIFT = [
    [0, 74, 6], [6, 70, 2], [8, 74, 4], [12, 79, 4],
    [16, 77, 6], [22, 74, 2], [24, 77, 4], [28, 82, 4],
    [32, 81, 8], [40, 77, 4], [44, 74, 4],
    [48, 76, 4], [52, 73, 4], [56, 76, 4], [60, 81, 4],
  ];
  // Index each melody by step for quick lookup.
  const byStep = (list) => { const m = new Map(); list.forEach((n) => m.set(n[0], n)); return m; };
  const H1 = byStep(HOOK_1), H2 = byStep(HOOK_2), LF = byStep(LIFT);

  // Arpeggio shape over the chord (indexes into notes; 3 = top note an octave up).
  const ARP = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 3, 1, 2];

  let overdrive = false;   // set by the "overdrive" event, read by the track

  const NEON_TURF = {
    bpm: BPM,
    step(s, t, api) {
      const { noteAt, hatAt, len } = api;
      const s16 = s % 256;               // position in the 16-bar loop
      const bar = Math.floor(s16 / 16);
      const st = s16 % 16;               // 16th within the bar
      const part = bar < 4 ? "intro" : bar < 8 ? "hook" : bar < 12 ? "lift" : "hook2";
      const chord = part === "lift" ? PART_B[bar - 8] : PART_A[bar % 4];
      const od = overdrive;
      const fillBar = bar === 15;

      /* ---------- Drums ---------- */
      // Four-on-the-floor kick (the fill bar drops it out in its second half).
      if (st % 4 === 0 && !(fillBar && st >= 8)) noteAt(t, 165, 42, 0.22, "sine", 0.6);
      // Clap on beats 2 and 4: a pitched thump plus two noise ticks smeared together.
      if ((st === 4 || st === 12) && !(bar === 0) && !(fillBar && st === 12)) {
        noteAt(t, 260, 150, 0.1, "triangle", 0.22);
        hatAt(t, 0.3); hatAt(t + 0.011, 0.22); hatAt(t + 0.023, 0.14);
      }
      // Hats: off-beat 8ths always (after the first bar); 16ths in the lift and in overdrive.
      if (bar > 0 && st % 4 === 2) hatAt(t, 0.13);
      if ((part === "lift" || od) && st % 2 === 1) hatAt(t, 0.05);
      // Drum fill: rising snare roll through the last half of bar 15.
      if (fillBar && st >= 8) {
        const k = (st - 8) / 8;
        noteAt(t, 200 + k * 260, 120 + k * 120, 0.07, "triangle", 0.12 + k * 0.12);
        hatAt(t, 0.1 + k * 0.15);
      }

      /* ---------- Bass: pumping octaves on 8ths ---------- */
      if (st % 2 === 0) {
        const n = chord.root + (st % 4 === 2 ? 12 : 0);
        noteAt(t, hz(n), hz(n), len * 1.7, "triangle", 0.34);
        noteAt(t, hz(n), hz(n), len * 0.8, "square", 0.035);   // a little bite on top
      }
      // Overdrive: extra off-beat bass push.
      if (od && st % 4 === 3) noteAt(t, hz(chord.root + 12), hz(chord.root + 12), len * 0.9, "sawtooth", 0.05);

      /* ---------- Chords ---------- */
      // A soft pad that blooms at the start of each bar...
      if (st === 0) {
        for (const n of chord.notes) {
          noteAt(t, hz(n), hz(n), len * 15, "triangle", 0.05);
          noteAt(t, hz(n) * 1.004, hz(n) * 1.004, len * 12, "sawtooth", 0.012); // slight detune = width
        }
      }
      // ...and short off-beat stabs that give it the bounce.
      if (st % 4 === 2) {
        for (const n of chord.notes) noteAt(t, hz(n + 12), hz(n + 12), len * 1.2, "square", 0.018);
      }

      /* ---------- Arpeggio (from the hook on) ---------- */
      if (part !== "intro" || od) {
        const idx = ARP[st];
        const base = idx === 3 ? chord.notes[0] + 12 : chord.notes[idx];
        noteAt(t, hz(base + 12), hz(base + 12), len * 0.9, "square", 0.022);
        if (od) noteAt(t, hz(base + 24), hz(base + 24), len * 0.6, "triangle", 0.03);
      }

      /* ---------- Lead melody ---------- */
      let note = null;
      if (part === "hook" || part === "hook2") {
        const phraseBar = bar % 4;                      // 0–1 → HOOK_1, 2–3 → HOOK_2
        const local = (phraseBar % 2) * 16 + st;
        note = (phraseBar < 2 ? H1 : H2).get(local);
      } else if (part === "lift") {
        note = LF.get((bar - 8) * 16 + st);
      }
      if (note) {
        const [, n, l] = note;
        const dur = len * l * 0.95;
        // Lead voice: a square with a slightly detuned triangle under it.
        noteAt(t, hz(n), hz(n), dur, "square", 0.05);
        noteAt(t, hz(n) * 0.997, hz(n) * 0.997, dur, "triangle", 0.06);
        // Second hook and overdrive: doubled an octave up for extra shine.
        if (part === "hook2" || od) noteAt(t, hz(n + 12), hz(n + 12), dur * 0.8, "triangle", 0.03);
        // A quiet echo one 8th later (fake delay).
        noteAt(t + len * 3, hz(n), hz(n), dur * 0.6, "triangle", 0.018);
      }
    },
  };

  /* =================================================================
     Mode sound effects (own small AudioContext; see header)
     ================================================================= */
  let ctx = null, out = null;
  let noiseBuf = null;

  // Hook into the shared audio context (created by TP.sfx on unlock).
  function ensure() {
    if (ctx) return true;
    try {
      const shared = TP.sfx.context ? TP.sfx.context() : null;
      if (!shared || !shared.ctx) return false;
      ctx = shared.ctx;
      out = ctx.createGain();       // our own volume knob, into the shared master
      out.gain.value = 0.85;
      out.connect(shared.master);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.0, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { ctx = null; }
    return !!ctx;
  }

  // One oscillator note: pitch slides f0 → f1, quick attack, smooth decay.
  function tone(f0, f1, dur, type = "square", vol = 0.12, delay = 0) {
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(out);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }

  // A burst of noise through a filter whose frequency sweeps f0 → f1.
  // lowpass = wet/splashy, bandpass = whoosh, highpass = hiss/sparkle.
  function noise(dur, filter, f0, f1, vol = 0.2, delay = 0, q = 1) {
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = filter; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t0, Math.random() * 0.5); src.stop(t0 + dur + 0.03);
  }

  // Rate-limit busy sounds (four bots can splat in the same frame).
  const lastPlayed = {};
  function ok(name, gap) {
    const now = performance.now();
    if (now - (lastPlayed[name] || 0) < gap * 1000) return false;
    lastPlayed[name] = now;
    return true;
  }

  const SOUNDS = {
    // Wet splat: low splashy noise + a soft thump. Bigger = lower + longer.
    // r = splat radius in world units (about 2 to 8).
    splat(r = 3) {
      const k = Math.min(1, r / 8);
      noise(0.16 + k * 0.14, "lowpass", 2400, 260, 0.32 + k * 0.15);
      tone(200 - k * 60, 55, 0.16 + k * 0.1, "sine", 0.3);
    },
    // Fill: rising whoosh, then a bright chord arpeggio. Bigger fills add notes.
    fill(pct = 5) {
      noise(0.45, "bandpass", 300, 5000, 0.22, 0, 1.6);
      const notes = [65, 69, 72, 77, 81, 84];       // F major, climbing
      const count = 3 + Math.min(3, Math.floor(pct / 4));
      for (let i = 0; i < count; i++) {
        const f = hz(notes[i]);
        tone(f, f, 0.5 - i * 0.03, "triangle", 0.12, 0.08 + i * 0.055);
        tone(f * 2, f * 2, 0.18, "square", 0.025, 0.08 + i * 0.055);
      }
      noise(0.5, "highpass", 6000, 9000, 0.05, 0.2);  // sparkle tail
    },
    // Pop: a quick bubbly "plip-plop" and a splash.
    pop() {
      tone(1500, 480, 0.08, "sine", 0.3);
      tone(900, 260, 0.12, "sine", 0.22, 0.06);
      noise(0.12, "highpass", 3000, 1200, 0.12, 0.02);
    },
    count() { tone(660, 660, 0.14, "square", 0.1); tone(1320, 1320, 0.06, "sine", 0.05); },
    go() {
      [74, 78, 81, 86].forEach((n) => tone(hz(n), hz(n), 0.45, "square", 0.06));
      noise(0.3, "bandpass", 800, 6000, 0.12, 0, 1.2);
    },
    // Overdrive siren: four rising wails over a low boom.
    overdrive() {
      tone(90, 40, 0.8, "sine", 0.45);
      for (let i = 0; i < 4; i++) {
        tone(520, 1040, 0.22, "sawtooth", 0.07, i * 0.24);
        tone(530, 1060, 0.22, "square", 0.03, i * 0.24);
      }
    },
    // Round won: a quick D-major run up into a held chord.
    roundWin() {
      [62, 66, 69, 74].forEach((n, i) => tone(hz(n), hz(n), 0.16, "square", 0.08, i * 0.09));
      [74, 78, 81, 86].forEach((n) => tone(hz(n), hz(n), 0.9, "triangle", 0.09, 0.38));
      noise(0.6, "highpass", 5000, 9000, 0.05, 0.38);
    },
    // Match won: longer fanfare.
    matchWin() {
      const run = [62, 66, 69, 74, 69, 74, 78, 81];
      run.forEach((n, i) => tone(hz(n), hz(n), 0.15, "square", 0.08, i * 0.11));
      [74, 78, 81, 86, 90].forEach((n) => tone(hz(n), hz(n), 1.6, "triangle", 0.08, 0.92));
      tone(hz(50), hz(50), 1.6, "triangle", 0.2, 0.92);
    },
    // Round over: referee-style double whistle.
    roundEnd() {
      tone(1800, 1750, 0.14, "square", 0.06);
      tone(1800, 1500, 0.32, "square", 0.06, 0.18);
    },
    land(air = 0.4) {
      const k = Math.min(1, air / 1.2);
      tone(130, 45, 0.12 + k * 0.1, "sine", 0.18 + k * 0.2);
    },
    bump(impact = 10) {
      const k = Math.min(1, impact / 20);
      noise(0.12, "bandpass", 1100, 400, 0.2 + k * 0.2, 0, 2);
      tone(150, 50, 0.14, "sawtooth", 0.08 + k * 0.08);
    },
    pickup() {
      [76, 81, 86, 93].forEach((n, i) => tone(hz(n), hz(n), 0.12, "sine", 0.12, i * 0.05));
    },
    pickupSpawn() {
      tone(hz(86), hz(86), 0.3, "sine", 0.07);
      tone(hz(93), hz(93), 0.4, "sine", 0.06, 0.12);
    },
    trail() { tone(700, 1000, 0.05, "sine", 0.035); },
    hint() { tone(hz(81), hz(81), 0.08, "sine", 0.06); tone(hz(88), hz(88), 0.12, "sine", 0.05, 0.08); },
  };

  /* =================================================================
     Public API + event wiring
     ================================================================= */
  const Audio = {
    BPM, OVERDRIVE_BPM,
    play(name, arg) {
      if (TP.M5.Menu && TP.M5.Menu.isOpen) return;   // quiet behind the title menu
      if (!ensure() || ctx.state !== "running") return;
      try { if (SOUNDS[name]) SOUNDS[name](arg); } catch (e) { /* never let audio break the game */ }
    },
    unlock() { TP.sfx.unlock(); ensure(); },
    isOverdrive: () => overdrive,

    // Start the round's music from the top at normal speed.
    startMusic() {
      overdrive = false;
      TP.sfx.music(false);
      TP.sfx.music(true, "neon-turf");
      TP.sfx.setTempo(BPM);
    },
    stopMusic() { TP.sfx.music(false); overdrive = false; },

    init() {
      if (this.ready) return;
      this.ready = true;
      TP.sfx.defineTrack("neon-turf", NEON_TURF);


      if (!TP.M5.on) return;
      const on = TP.M5.on;
      // Countdown beeps ("3, 2, 1") are played by the HUD as it shows each
      // number (it runs on game time, so ?speed=N stays in sync); GO is here.
      on("roundCountdown", () => Audio.stopMusic());
      on("roundStart", () => {
        Audio.play("go");
        if (!(TP.M5.Menu && TP.M5.Menu.isOpen)) Audio.startMusic();
      });
      on("overdrive", () => {
        overdrive = true;
        TP.sfx.setTempo(OVERDRIVE_BPM);
        Audio.play("overdrive");
      });
      on("roundEnd", () => { Audio.stopMusic(); Audio.play("roundEnd"); setTimeout(() => Audio.play("roundWin"), 450); });
      on("matchEnd", () => { Audio.stopMusic(); setTimeout(() => Audio.play("matchWin"), 300); });
      on("splat", (e) => { if (ok("splat", 0.05)) Audio.play("splat", e.r); });
      // Big fills get the whoosh-chord; slivers just a soft blip.
      on("fill", (e) => {
        if ((e.pct || 0) >= 0.5) Audio.play("fill", e.pct);
        else if (ok("fillTiny", 0.12)) Audio.play("trail");
      });
      on("pop", () => { if (ok("pop", 0.06)) Audio.play("pop"); });
      on("land", (e) => { if (ok("land", 0.05)) Audio.play("land", e.airtime); });
      on("bump", (e) => { if (ok("bump", 0.08)) Audio.play("bump", e.impact); });
      on("pickup", () => Audio.play("pickup"));
      on("pickupSpawn", () => Audio.play("pickupSpawn"));
      on("trailStart", () => { if (ok("trail", 0.15)) Audio.play("trail"); });
      on("hint", () => Audio.play("hint"));
    },
  };

  TP.M5.Audio = Audio;
})();
