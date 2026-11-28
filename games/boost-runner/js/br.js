/* =====================================================================
   br.js — glue and testing hooks: URL flags, creating a game, the fixed
   1/60 s step, and the window.BR object QC drives.

   URL flags (all optional):
     ?demo          all seats are bots and the match starts by itself
     &rounds=N      first to N round wins (default 3)
     &speed=X       run the game X times faster (default 1)
     &bots=2..4     how many cars in a demo (default 4)
     &seed=S        the match seed (same seed → same courses, same bots, same winner)
     &chunk=<id>    loop one chunk on its own (start, then that chunk again and again)
     &norender      don't draw anything (main.js / sim.html check BR.flags.norender)
     &difficulty=easy|normal|hard   demo bot level (default normal)

   window.BR:
     BR.game            the current Match (see js/README.md for its fields)
     BR.events          every event so far this match (BR.game.events)
     BR.flags           the parsed URL flags
     BR.input.script(seat, [{t, steer, pitch, jump, boost, hit}, ...])
                        scripted controls: each entry holds from round time t
                        (seconds since that round's countdown started) until
                        the next entry. `steer` (or `drive`) is the drive axis.
     BR.input.clear(seat?)
     BR.Round           new BR.Round(BR.game, {number, seed, chunk})
     BR.createGame(opts) make a new match (and make it BR.game)
     BR.runFor(seconds) step the current game synchronously (no rendering)
     BR.runMatch(maxSeconds) step until the match ends; returns BR.summary()
     BR.summary()       a plain report: winner, wins, rounds, chunk stats
   ===================================================================== */
window.TP = window.TP || {};
TP.BR = TP.BR || {};

(function () {
  "use strict";
  const BR = TP.BR;
  const STEP = 1 / 60;

  /* ---------- URL flags ---------- */
  function parseFlags(search) {
    const q = new URLSearchParams(search || (typeof location !== "undefined" ? location.search : ""));
    const num = (k, d) => (q.has(k) && q.get(k) !== "" && isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
    return {
      demo: q.has("demo"),
      rounds: Math.max(1, Math.round(num("rounds", 3))),
      speed: Math.max(0.1, num("speed", 1)),
      bots: Math.min(4, Math.max(2, Math.round(num("bots", 4)))),
      seed: q.has("seed") ? num("seed", 1) >>> 0 : null,
      chunk: q.get("chunk") || null,
      norender: q.has("norender"),
      difficulty: q.get("difficulty") || "normal",
    };
  }
  BR.parseFlags = parseFlags;
  BR.flags = parseFlags();

  /* ---------- Scripted input (QC) ---------- */
  const scripts = {};
  BR.input = {
    script(seat, entries) {
      scripts[seat] = (entries || []).slice().sort((a, b) => a.t - b.t);
      if (BR.game) BR.game.scripts = scripts;
    },
    clear(seat) {
      if (seat === undefined) for (const k of Object.keys(scripts)) delete scripts[k];
      else delete scripts[seat];
    },
    scripts,
  };

  /* ---------- Making a game ----------
     opts: { scene, seats, seed, winsToTake, chunk, aspect, speed }.
     Missing options fall back to the URL flags. In ?demo every seat is a bot. */
  BR.createGame = function (opts = {}) {
    const f = BR.flags;
    let seats = opts.seats;
    if (!seats || f.demo) {
      const n = opts.seats ? opts.seats.length : f.bots;
      seats = [];
      for (let i = 0; i < n; i++) seats.push({ name: TP.DEFAULT_NAMES[i], controller: "bot", difficulty: f.difficulty });
    }
    if (BR.game) BR.game.dispose();
    const seed = opts.seed !== undefined ? opts.seed : f.seed !== null ? f.seed : (Date.now() % 1000000000);
    const game = new BR.Match({
      scene: opts.scene,
      seats,
      seed,
      winsToTake: opts.winsToTake || f.rounds,
      chunk: opts.chunk !== undefined ? opts.chunk : f.chunk,
      aspect: opts.aspect || 16 / 9,
      speed: opts.speed || f.speed,
      scripts,
    });
    BR.game = game;
    BR.events = game.events;
    return game;
  };

  /* ---------- Synchronous stepping (headless tests) ---------- */
  BR.runFor = function (seconds) {
    const g = BR.game;
    const n = Math.round(seconds / STEP);
    for (let i = 0; i < n && !g.finished; i++) g.step(STEP);
    return g.snapshot();
  };

  BR.runMatch = function (maxSeconds = 3600) {
    const g = BR.game;
    const n = Math.round(maxSeconds / STEP);
    for (let i = 0; i < n && !g.finished; i++) g.step(STEP);
    return BR.summary();
  };

  BR.summary = function () {
    const g = BR.game;
    if (!g) return null;
    const allIds = Object.keys(BR.CHUNKS).filter((id) => id !== "start");
    const neverCleared = allIds.filter((id) => !(g.stats[id] && g.stats[id].clearedByBot > 0));
    return {
      finished: g.finished,
      seed: g.seed,
      winner: g.matchWinner,
      winnerName: g.matchWinner !== null ? g.seats[g.matchWinner].name : null,
      wins: g.wins.slice(),
      rounds: g.results.map((r) => ({
        round: r.round, winner: r.winner, koOrder: r.koOrder, time: Math.round(r.time * 10) / 10, chunks: r.courseChunks,
      })),
      chunkStats: JSON.parse(JSON.stringify(g.stats)),
      neverCleared,
      events: g.events.length,
    };
  };

  /* ---------- The real-time loop helper (sim.html, and main.js may use it) ----------
     Calls game.frame(dt) every animation frame. `onFrame` runs after. */
  BR.loop = function (onFrame) {
    let last = performance.now();
    let stopped = false;
    function tick(now) {
      if (stopped) return;
      const dt = (now - last) / 1000;
      last = now;
      if (TP.Input && TP.Input.poll) TP.Input.poll();
      if (BR.game) BR.game.frame(dt);
      if (onFrame) onFrame(dt);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    return () => { stopped = true; };
  };

  window.BR = BR;
})();
