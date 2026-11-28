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

  /* =====================================================================
     Background music — a little chiptune loop generated on the fly.

     Four chords (C → G → Am → F, one bar each) played as:
       • kick drum on beats 1 and 3
       • hi-hat ticks on the off-beats
       • a bouncing bassline
       • an arpeggio (chord notes played one at a time) on top
     Notes are scheduled slightly ahead of time with the audio clock,
     which keeps the rhythm steady even if a frame stutters.
     ===================================================================== */
  let musicGain = null;
  let musicTimer = null;
  let nextTime = 0;     // audio-clock time of the next 16th note
  let step = 0;         // which 16th note we're on (0..63 = 4 bars)
  let bpm = 116;
  let muted = false;

  // MIDI note number → frequency in Hz.
  const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);

  /* ---------- Music tracks ----------
     Each mode can define its own track in its OWN folder with
     TP.sfx.defineTrack(name, track) and start it with
     TP.sfx.music(true, name). Nobody needs to edit this file for new music.

     A track is either the simple form:
       { bpm: 140,
         chords: [{ root: 45, notes: [57, 60, 64] }, ...],  // one chord per bar, MIDI numbers
         arp: [0, 1, 2, 1, ...],      // order the chord notes are played in (8th notes)
         lead: "square",              // arpeggio waveform (optional)
         drums: true }                // kick + hi-hat (optional, default true)
     or, for full control, a custom step function:
       { bpm: 150, step(s, t, api) { ... } }
     where s = 16th-note index, t = audio time, and api gives
     { noteAt, hatAt, hz, len } (len = one 16th note in seconds). */
  const TRACKS = {
    // Turbo Party's board loop: C → G → Am → F.
    party: {
      bpm: 116,
      chords: [
        { root: 48, notes: [60, 64, 67] }, // C
        { root: 43, notes: [59, 62, 67] }, // G
        { root: 45, notes: [57, 60, 64] }, // Am
        { root: 41, notes: [57, 60, 65] }, // F
      ],
      arp: [0, 1, 2, 1, 0, 2, 1, 2],
      lead: "square",
      drums: true,
    },
  };
  let track = TRACKS.party;

  // Same as tone() but at an exact audio-clock time, into the music bus.
  function noteAt(t, f0, f1, dur, type, vol) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(musicGain);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // Short burst of white noise through a high-pass filter = hi-hat.
  let noiseBuf = null;
  function hatAt(t, vol) {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    src.connect(hp).connect(g).connect(musicGain);
    src.start(t);
  }

  // Schedule everything that happens on one 16th-note step.
  function playStep(s, t) {
    const len = 60 / bpm / 4; // one 16th note, in seconds
    // Custom tracks do their own thing.
    if (typeof track.step === "function") {
      track.step(s, t, { noteAt, hatAt, hz, len });
      return;
    }
    const chords = track.chords;
    const arp = track.arp || [0, 1, 2, 1];
    const chord = chords[Math.floor(s / 16) % chords.length];
    const inBar = s % 16;

    if (track.drums !== false) {
      if (inBar % 8 === 0) noteAt(t, 150, 40, 0.18, "sine", 0.5);            // kick
      if (inBar % 4 === 2) hatAt(t, 0.12);                                    // hat
    }
    if (inBar % 4 === 0) noteAt(t, hz(chord.root), hz(chord.root), len * 1.8, "triangle", 0.28);       // bass
    if (inBar % 4 === 3) noteAt(t, hz(chord.root + 12), hz(chord.root + 12), len * 0.9, "triangle", 0.18);
    if (inBar % 2 === 0) {                                                    // arpeggio
      const n = chord.notes[arp[(inBar / 2) % arp.length] % chord.notes.length] + 12;
      noteAt(t, hz(n), hz(n), len * 1.6, track.lead || "square", 0.045);
    }
  }

  function scheduler() {
    // Look 150 ms ahead and schedule any notes that fall in that window.
    while (nextTime < ctx.currentTime + 0.15) {
      playStep(step, nextTime);
      nextTime += 60 / bpm / 4;
      step = (step + 1) % (16 * 64); // wraps after 64 bars; tracks use s % their own length
    }
  }

  TP.sfx = {
    unlock() {
      if (ctx) { if (ctx.state === "suspended") ctx.resume(); return; }
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        master = ctx.createGain();
        master.gain.value = 0.8;
        master.connect(ctx.destination);
        musicGain = ctx.createGain();
        musicGain.gain.value = 0.35;
        musicGain.connect(master);
      } catch (e) {
        ctx = null; // No audio support — game still works silently.
      }
    },
    play(name, arg) {
      try { if (effects[name]) effects[name](arg); } catch (e) { /* ignore audio errors */ }
    },

    /* ---------- Recorded sounds (files) ----------
       For real audio files loaded with TP.Assets ({ type: "audio" }).
       decode() turns the loaded bytes into a playable buffer (needs the
       audio unlocked first, i.e. after a click or key press).
       playBuffer() plays it; returns a handle with stop(). */
    async decode(bytes) {
      if (!ctx) return null;
      // decodeAudioData consumes the buffer, so pass a copy (the cache keeps the original).
      return ctx.decodeAudioData(bytes.slice(0));
    },
    playBuffer(buffer, opts = {}) {
      if (!ctx || !buffer) return { stop() {} };
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = !!opts.loop;
      src.playbackRate.value = opts.rate || 1;
      const g = ctx.createGain();
      g.gain.value = opts.volume ?? 0.8;
      // Music files go through the music volume; effects straight to master.
      src.connect(g).connect(opts.music ? musicGain : master);
      src.start();
      return { stop() { try { src.stop(); } catch (e) { /* already stopped */ } } };
    },

    /* The shared audio context and master volume, for modes that build
       their own synthesized sounds: connect them to `master` so the
       shared mute (M) and volume apply. Creates the context if needed;
       returns { ctx: null, master: null } if audio isn't available. */
    context() {
      TP.sfx.unlock();
      return { ctx, master };
    },

    // Register a music track (see the "Music tracks" note above).
    defineTrack(name, def) { TRACKS[name] = def; },

    /* Start/stop the background loop. Pass a track name to switch tracks
       (it also resets the tempo to that track's bpm); with no name it
       keeps the current track (Turbo Party's "party" by default). */
    music(on, name) {
      if (name && TRACKS[name] && TRACKS[name] !== track) {
        track = TRACKS[name];
        bpm = track.bpm || bpm;
        step = 0;
      }
      if (!ctx) return;
      if (on && !musicTimer) {
        nextTime = ctx.currentTime + 0.1;
        musicTimer = setInterval(scheduler, 25);
      } else if (!on && musicTimer) {
        clearInterval(musicTimer);
        musicTimer = null;
      }
    },
    // Faster for minigames, calmer on the board.
    setTempo(newBpm) { bpm = newBpm; },

    // Mute/unmute everything (bound to the M key). Returns the new state.
    toggleMute() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : 0.8;
      return muted;
    },
  };
})();
