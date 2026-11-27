/* =====================================================================
   sfx.js — tiny synthesized sound effects (no audio files needed).

   Uses the Web Audio API to make short beeps. Browsers block audio until
   the player interacts with the page, so TP.sfx.unlock() is called from
   the Start button click in the menu.
   ===================================================================== */
(function () {
  "use strict";

  let ctx = null;   // AudioContext, created on first unlock
  let master = null;

  // One short tone: frequency slides from f0 to f1 over `dur` seconds.
  function tone(f0, f1, dur, type = "square", vol = 0.15, delay = 0) {
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    // Quick fade-in and fade-out so there's no click.
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // Named effects used around the game. Each is just a couple of tones.
  const effects = {
    tick: () => tone(900, 900, 0.03, "square", 0.05),
    step: () => tone(320, 420, 0.06, "triangle", 0.12),
    coin: () => { tone(988, 988, 0.07, "square", 0.08); tone(1319, 1319, 0.12, "square", 0.08, 0.07); },
    lose: () => tone(400, 150, 0.3, "sawtooth", 0.1),
    bump: () => tone(140, 60, 0.12, "sawtooth", 0.14),
    boost: () => tone(200, 600, 0.25, "sawtooth", 0.06),
    go: () => tone(660, 1320, 0.25, "square", 0.1),
    count: () => tone(440, 440, 0.12, "square", 0.08),
    goal: () => { tone(523, 523, 0.12, "square", 0.1); tone(659, 659, 0.12, "square", 0.1, 0.12); tone(784, 784, 0.3, "square", 0.1, 0.24); },
    trophy: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.18, "triangle", 0.14, i * 0.1)); },
    fall: () => tone(600, 80, 0.6, "triangle", 0.12),
    swing: () => tone(500, 250, 0.08, "triangle", 0.06),
    // Ball hit: pitch climbs with the ball's speed (0..1 = slow..max).
    hit: (k = 0) => { const f = 220 + k * 900; tone(f, f * 1.5, 0.09, "square", 0.14); tone(f * 0.5, f * 0.3, 0.2, "sawtooth", 0.1); },
    ko: () => { tone(900, 60, 0.5, "sawtooth", 0.16); tone(300, 40, 0.6, "square", 0.1, 0.05); },
  };

  TP.sfx = {
    unlock() {
      if (ctx) return;
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        master = ctx.createGain();
        master.gain.value = 0.8;
        master.connect(ctx.destination);
      } catch (e) {
        ctx = null; // No audio support — game still works silently.
      }
    },
    play(name, arg) {
      try { if (effects[name]) effects[name](arg); } catch (e) { /* ignore audio errors */ }
    },
  };
})();
