/* =====================================================================
   music.js — Boost Runner's music track and its own small sound effects.

   1) THE TRACK: "Test Fire" (original, generated in code; no audio files)
      140 bpm, A minor, a 16-bar loop:
        chords, one per bar:  Am  F  C  G  Am  F  Dm  E   (then again)
        • four-on-the-floor kick, snare on beats 2 and 4, off-beat hats
        • a pumping 8th-note bass (root, octave up, root, octave up...)
        • a 16th-note arpeggio in bars 1–8
        • a lead melody in bars 9–16
      Registered with the shared player via TP.sfx.defineTrack, so the
      shared sfx.js needs no changes. Start it with
      TP.sfx.music(true, "boost-runner").

   2) MODE SOUNDS (TP.BRSound): a few effects the shared set doesn't
      have yet (jump, double jump, landing, the rising danger beep, the
      round-win sting). They use their own tiny Web Audio synth, the same
      technique as shared/js/sfx.js. If the Director later adds these to
      the shared set, this part can go.
   ===================================================================== */
(function () {
  "use strict";

  /* ---------- 1) The track ---------- */
  // Each chord: bass root (low MIDI note) and three chord notes.
  const CHORDS = [
    { root: 45, notes: [57, 60, 64] }, // Am
    { root: 41, notes: [57, 60, 65] }, // F
    { root: 48, notes: [55, 60, 64] }, // C
    { root: 43, notes: [55, 59, 62] }, // G
    { root: 45, notes: [57, 60, 64] }, // Am
    { root: 41, notes: [57, 60, 65] }, // F
    { root: 38, notes: [57, 62, 65] }, // Dm
    { root: 40, notes: [56, 59, 64] }, // E (major: G# pulls back home to Am)
  ];
  // Lead melody: one row per bar, eight 8th notes per bar (null = rest).
  const LEAD = [
    [81, null, 84, null, 88, null, 86, 84],
    [84, null, 81, null, 77, null, 79, 81],
    [79, null, 76, null, 79, null, 84, null],
    [83, null, 79, null, 74, null, 79, 83],
    [81, null, 84, 88, null, 86, 84, null],
    [77, null, 81, 84, null, 81, 77, null],
    [74, 77, 81, null, 79, 77, 74, null],
    [76, null, 80, null, 83, null, 80, 76],
  ];
  const ARP = [0, 1, 2, 1, 2, 1, 0, 1, 0, 1, 2, 1, 2, 0, 2, 1];

  TP.sfx.defineTrack("boost-runner", {
    bpm: 140,
    // Called once per 16th note. s = step count, t = exact audio time.
    step(s, t, api) {
      const { noteAt, hatAt, hz, len } = api;
      const loop = s % 256;                  // 16 bars × 16 steps
      const bar = Math.floor(loop / 16);
      const inBar = loop % 16;
      const chord = CHORDS[bar % 8];

      // Drums.
      if (inBar % 4 === 0) noteAt(t, 160, 42, 0.16, "sine", 0.55);            // kick on every beat
      if (inBar === 4 || inBar === 12) {                                       // snare on 2 and 4
        noteAt(t, 240, 130, 0.11, "triangle", 0.22);
        hatAt(t, 0.22);
      }
      if (inBar % 4 === 2) hatAt(t, 0.11);                                     // off-beat hat
      else if (inBar % 2 === 1) hatAt(t, 0.035);                               // quiet 16th ghost hats

      // Pumping bass: an 8th note every 2 steps, alternating root / octave.
      if (inBar % 2 === 0) {
        const n = chord.root + (inBar % 4 === 2 ? 12 : 0);
        noteAt(t, hz(n), hz(n), len * 1.5, "square", 0.09);
        noteAt(t, hz(n - 12), hz(n - 12), len * 1.5, "triangle", 0.2);
      }

      if (bar < 8) {
        // Bars 1–8: 16th-note arpeggio, an octave up.
        const n = chord.notes[ARP[inBar]] + 12;
        noteAt(t, hz(n), hz(n), len * 0.9, "square", 0.03);
      } else if (inBar % 2 === 0) {
        // Bars 9–16: the lead melody (8th notes).
        const n = LEAD[bar % 8][inBar / 2];
        if (n != null) noteAt(t, hz(n), hz(n), len * 1.8, "square", 0.05);
        // A soft chord pad under the lead, on the first beat of each bar.
        if (inBar === 0) for (const c of chord.notes) noteAt(t, hz(c), hz(c), len * 14, "triangle", 0.035);
      }
    },
  });

  /* ---------- 2) Mode sounds ---------- */
  let ctx = null, out = null, muted = false;

  function tone(f0, f1, dur, type = "square", vol = 0.12, delay = 0) {
    if (!ctx || muted) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  const SOUNDS = {
    jump: () => tone(260, 520, 0.12, "triangle", 0.12),
    djump: () => { tone(380, 760, 0.1, "triangle", 0.11); tone(570, 1140, 0.1, "triangle", 0.06, 0.04); },
    land: () => tone(120, 55, 0.09, "sine", 0.22),
    // Danger beep: k = 0..1, how deep into the danger zone. Higher = more urgent.
    danger: (k = 0) => tone(520 + k * 700, 520 + k * 700, 0.06, "square", 0.05 + k * 0.04),
    roundWin: () => [523, 659, 784].forEach((f, i) => tone(f, f, 0.16, "square", 0.08, i * 0.09)),
    matchWin: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, f, 0.22, "triangle", 0.13, i * 0.11)),
  };

  TP.BRSound = {
    // Call from a click/keypress (browsers only allow audio after one).
    unlock() {
      if (ctx) { if (ctx.state === "suspended") ctx.resume(); return; }
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        out = ctx.createGain();
        out.gain.value = 0.8;
        out.connect(ctx.destination);
      } catch (e) { ctx = null; }
    },
    play(name, arg) { try { if (SOUNDS[name]) SOUNDS[name](arg); } catch (e) { /* audio errors never break the game */ } },
    setMuted(m) { muted = m; },
  };
})();
