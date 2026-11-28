/* =====================================================================
   round.js — one round (countdown, race, KOs, winner) and the match
   that runs rounds until someone has N round wins.

   Plain English rules:
     • KO: be behind the trailing edge, or below the bottom edge, for
       0.3 s in a row. (The short grace time stops unfair flicker KOs.)
     • The last car still on screen wins the round and gets a point.
     • If everyone left is KO'd in the same step, the round is a draw:
       no point, and the next round starts.
     • First to N round wins (default 3) takes the match. KO'd cars sit
       out until the round ends; no respawns.
     • Catch-up (light): cars further back get a little extra boost
       regen. It's added on top; the shared boostRegen number is
       untouched.
   ===================================================================== */
window.TP = window.TP || {};
TP.BR = TP.BR || {};

(function () {
  "use strict";
  const { RNG, hashSeed, Course, View, Bot, RunnerCar } = TP.BR;

  const ROUND_RULES = {
    countdown: 3,        // seconds of 3-2-1 before GO (cars frozen)
    koGrace: 0.3,        // seconds outside the KO edges before a KO
    endTime: 2,          // seconds of "round over" before the next round
    catchUp: 0.25,       // the last car gets +25% boost regen, the leader +0%
    spawnGap: 5,         // spacing of the starting grid (units)
    lookAhead: 150,      // build the course at least this far past the right edge
    maxRoundTime: 135,   // absolute backstop: sudden death (from 120 s) ends rounds within a few seconds
  };
  TP.BR.ROUND_RULES = ROUND_RULES;

  /* =====================================================================
     Round. QC can drive one directly:
        const r = new BR.Round(BR.game, { number: 1 });
        while (r.state !== "done") r.update(1 / 60);
        r.result();
     ===================================================================== */
  class Round {
    /* game — the Match (needs cars, seats, seed, aspect, emit, controlsFor)
       opts — { number, seed, chunk } (all optional) */
    constructor(game, opts = {}) {
      this.game = game;
      this.number = opts.number || 1;
      this.seed = opts.seed !== undefined ? opts.seed >>> 0 : hashSeed(game.seed, "round", this.number);
      this.T = TP.modeTuning({ bumpScale: 1.3 }); // read fresh from the shared car each round
      this.rng = new RNG(hashSeed(this.seed, "round-logic"));

      this.course = new Course(this.seed, { chunk: opts.chunk !== undefined ? opts.chunk : game.chunk });
      this.view = new View(game.aspect);

      this.state = "countdown";
      this.time = 0;          // since the countdown started
      this.raceTime = 0;      // since GO
      this.endT = 0;
      this.koOrder = [];
      this.winner = undefined; // seat, null (draw), or undefined (not decided)
      this.stats = {};         // chunk id → { entered, cleared, clearedByBot }

      // Starting grid in a seeded order, so nobody always starts in front.
      const order = game.cars.map((c) => c.seat);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng.next() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      this.bots = {};
      order.forEach((seat, k) => {
        const car = game.cars[seat];
        car.reset(6 + k * ROUND_RULES.spawnGap, 0);
        car.chunkIndex = 0;
        const s = game.seats[seat];
        if (car.isBot) this.bots[seat] = new Bot(car, this.rng.fork("bot" + seat), s.difficulty || "normal");
      });
      this.course.ensure(200);
      this.view.reset(6 + (order.length - 1) * ROUND_RULES.spawnGap, this.course);
      this.course.ensure(this.view.right + ROUND_RULES.lookAhead);
      // Tell listeners about the chunks that already exist.
      for (const c of this.course.chunks) this.emit("chunk_added", { chunk: c });
      // ...and about every chunk added from now on.
      this.course.onChunkAdded = (c) => this.emit("chunk_added", { chunk: c });
    }

    get countdown() { return Math.max(0, ROUND_RULES.countdown - this.time); }

    emit(type, fields) { this.game.emit(type, Object.assign({ round: this.number }, fields), this); }

    aliveCars() { return this.game.cars.filter((c) => c.alive); }

    /* One fixed step (1/60 s). */
    update(dt) {
      if (this.state === "done") return;
      this.time += dt;
      const cars = this.game.cars;

      if (this.state === "countdown") {
        for (const c of cars) c.syncMesh(dt);
        if (this.time >= ROUND_RULES.countdown) {
          this.state = "race";
          this.emit("go", {});
        }
        return;
      }

      this.raceTime += dt;
      const course = this.course, view = this.view, T = this.T;
      const emit = (type, f) => this.emit(type, f);
      const alive = this.aliveCars();

      // Controls (scripted, bot or human), then physics.
      const ctx = { course, view, cars, dt, T, time: this.time };
      for (const car of alive) {
        const input = this.game.controlsFor(car, this, ctx);
        car.step(dt, input, course, T, emit);
      }

      // Car-vs-car bumps.
      for (const h of RunnerCar.collide2D(alive, T, course)) this.emit("bump", h);

      // Grow the course and move the view.
      course.ensure(view.right + ROUND_RULES.lookAhead);
      view.update(dt, alive.filter((c) => c.alive), this.raceTime, course);

      // Catch-up: rank by distance, the furthest back gets the most extra regen.
      const ranked = alive.slice().sort((a, b) => b.x - a.x);
      ranked.forEach((c, i) => { c.regenBonus = ranked.length > 1 ? (ROUND_RULES.catchUp * i) / (ranked.length - 1) : 0; });

      // Chunk tracking (for events and for "has every chunk been cleared").
      for (const car of alive) {
        const ci = course.chunkIndexAt(car.x);
        if (ci >= 0 && ci !== car.chunkIndex) {
          if (ci === car.chunkIndex + 1) {
            const prev = course.chunks[car.chunkIndex];
            const st = this.statFor(prev.id);
            st.cleared++;
            if (car.isBot) st.clearedByBot++;
          }
          car.chunkIndex = ci;
          const c = course.chunks[ci];
          this.statFor(c.id).entered++;
          this.emit("chunk_enter", { seat: car.seat, chunk: ci, id: c.id });
        }
      }

      if (this.state === "race") this.checkKOs(dt, alive);
      else if (this.state === "end") {
        this.endT += dt;
        if (this.endT >= ROUND_RULES.endTime) this.state = "done";
      }
    }

    statFor(id) {
      if (!this.stats[id]) this.stats[id] = { entered: 0, cleared: 0, clearedByBot: 0 };
      return this.stats[id];
    }

    checkKOs(dt, alive) {
      const v = this.view;
      const kos = [];
      for (const car of alive) {
        const cx = car.x, cy = car.y + 0.6;   // middle of the body
        const behind = cx < v.left;
        const fell = cy < v.bottom;
        car.offTop = cy > v.top;
        const danger = cx < v.dangerX;
        if (danger !== car.inDanger) {
          car.inDanger = danger;
          this.emit("danger", { seat: car.seat, on: danger });
        }
        if (behind || fell) {
          car.offScreen += dt;
          if (car.offScreen >= ROUND_RULES.koGrace) kos.push({ car, cause: fell ? "fell" : "behind" });
        } else {
          car.offScreen = 0;
        }
      }
      for (const { car, cause } of kos) {
        car.out = true;
        car.koTime = this.raceTime;
        car.koCause = cause;
        car.inDanger = false;
        car.mesh.visible = false;
        this.koOrder.push(car.seat);
        const ch = this.course.chunks[car.chunkIndex];
        this.emit("ko", { seat: car.seat, cause, x: car.x, y: car.y, chunk: car.chunkIndex, id: ch ? ch.id : null });
      }

      const left = this.aliveCars();
      const tooLong = this.raceTime >= ROUND_RULES.maxRoundTime;
      if (left.length <= 1 || tooLong) {
        // One left = winner. None left (all KO'd in the same step) = draw.
        // The backstop (should never happen) gives it to the leader.
        let winner = null;
        if (left.length === 1) winner = left[0].seat;
        else if (left.length > 1) winner = left.slice().sort((a, b) => b.x - a.x)[0].seat;
        this.winner = winner;
        this.state = "end";
        this.game.onRoundEnd(this);
      }
    }

    result() {
      return {
        round: this.number,
        seed: this.seed,
        winner: this.winner === undefined ? undefined : this.winner,
        koOrder: this.koOrder.slice(),
        time: this.raceTime,
        chunks: JSON.parse(JSON.stringify(this.stats)),
        courseChunks: this.course.chunks.length,
      };
    }

    dispose() {
      this.course.onChunkAdded = null;
    }
  }
  TP.BR.Round = Round;

  /* =====================================================================
     Match — the whole game: rounds until someone has `winsToTake` wins.
     This is the object main.js holds (BR.createGame returns one).
     ===================================================================== */
  class Match {
    constructor(opts = {}) {
      this.scene = opts.scene || { add() {}, remove() {} };
      this.seats = (opts.seats || []).map((s, i) => ({
        name: s.name || TP.DEFAULT_NAMES[i],
        controller: s.controller || "bot",
        difficulty: s.difficulty || "normal",
      }));
      this.seed = (opts.seed !== undefined ? Number(opts.seed) : 1) >>> 0;
      this.winsToTake = Math.max(1, opts.winsToTake || 3);
      this.chunk = opts.chunk || null;
      this.aspect = opts.aspect || 16 / 9;
      this.speed = opts.speed || 1;
      this.scripts = opts.scripts || {};   // seat → [{t, ...controls}]
      this.events = opts.events || [];
      this.listeners = [];
      this.maxEvents = 50000;

      this.cars = this.seats.map((s, i) => new RunnerCar(this.scene, {
        index: i, name: s.name, color: TP.PLAYER_COLORS[i], isBot: s.controller === "bot",
      }));
      this.wins = this.seats.map(() => 0);
      this.results = [];
      this.stats = {};          // chunk id → totals over the whole match
      this.matchWinner = null;
      this.finished = false;
      this.roundNumber = 0;
      this.acc = 0;
      this.startRound();
    }

    /* ---------- Events ---------- */
    on(fn) {
      this.listeners.push(fn);
      return () => { this.listeners = this.listeners.filter((f) => f !== fn); };
    }
    emit(type, fields, round) {
      const r = round || this.round;
      const ev = Object.assign({ type, t: r ? r.raceTime : 0 }, fields);
      this.events.push(ev);
      if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
      for (const fn of this.listeners) {
        try { fn(ev); } catch (e) { console.error(e); }
      }
    }

    /* ---------- Rounds ---------- */
    startRound() {
      if (this.round) this.round.dispose();
      this.roundNumber++;
      this.lastResult = this.lastResult || null;
      this.emit("round_start", { round: this.roundNumber, t: 0 });
      this.round = new Round(this, { number: this.roundNumber });
    }

    // Called by the Round the moment it's decided.
    onRoundEnd(round) {
      if (round.winner !== null && round.winner !== undefined) this.wins[round.winner]++;
      const res = round.result();
      this.results.push(res);
      this.lastResult = res;
      for (const [id, st] of Object.entries(res.chunks)) {
        const m = this.stats[id] || (this.stats[id] = { entered: 0, cleared: 0, clearedByBot: 0 });
        m.entered += st.entered; m.cleared += st.cleared; m.clearedByBot += st.clearedByBot;
      }
      this.emit("round_end", { round: round.number, winner: round.winner, koOrder: res.koOrder, wins: this.wins.slice() }, round);
    }

    // Controls for one car this step: a script beats a bot beats a human.
    controlsFor(car, round, ctx) {
      const script = this.scripts[car.seat];
      if (script && script.length) {
        let cur = null;
        for (const e of script) { if (e.t <= round.time) cur = e; else break; }
        const e = cur || {};
        return { drive: e.drive !== undefined ? e.drive : e.steer || 0, pitch: e.pitch || 0, jump: !!e.jump, boost: !!e.boost, hit: !!e.hit };
      }
      const bot = round.bots[car.seat];
      if (bot) return bot.think(ctx);
      const id = this.seats[car.seat].controller;
      const c = TP.Input && TP.Input.get ? TP.Input.get(id) : null;
      if (!c) return { drive: 0, pitch: 0, jump: false, boost: false, hit: false };
      // Drive = steer (D/A, arrows, stick X), plus the triggers on gamepads only
      // (on keyboards throttle is W/S, which is the air tilt here).
      const pad = id.startsWith("pad");
      const drive = TP.util.clamp((c.steer || 0) + (pad ? c.throttle || 0 : 0), -1, 1);
      return { drive, pitch: c.pitch || 0, jump: !!c.jump, boost: !!c.boost, hit: !!c.hit };
    }

    /* One fixed 1/60 s step of the whole game. */
    step(dt) {
      if (this.finished) return;
      const r = this.round;
      r.update(dt);
      if (r.state === "done") {
        const target = this.wins.some((w) => w >= this.winsToTake);
        const tooMany = this.roundNumber >= this.winsToTake * 4 + 6; // endless draws backstop
        if (target || tooMany) {
          let best = 0;
          this.wins.forEach((w, i) => { if (w > this.wins[best]) best = i; });
          this.matchWinner = best;
          this.finished = true;
          this.emit("match_end", { winner: best, wins: this.wins.slice() });
        } else {
          this.startRound();
        }
      }
    }

    /* Call once per animation frame with real elapsed seconds. Runs as many
       fixed steps as that time covers (times `speed`). */
    frame(realDt) {
      const STEP = 1 / 60;
      this.acc += Math.min(Math.max(realDt, 0), 0.1) * this.speed;
      let n = 0;
      const maxSteps = Math.ceil(0.1 * this.speed * 60) + 2;
      while (this.acc >= STEP && n < maxSteps) {
        this.step(STEP);
        this.acc -= STEP;
        n++;
      }
      return n;
    }

    setAspect(a) {
      this.aspect = a;
      this.round.view.setAspect(a);
    }

    /* ---------- What main.js and QC read ---------- */
    get state() {
      if (this.finished) return "match_end";
      const s = this.round.state;
      return s === "end" || s === "done" ? "round_end" : s;
    }
    get time() { return this.round.time; }
    get raceTime() { return this.round.raceTime; }
    get countdown() { return this.round.countdown; }
    get view() { return this.round.view; }
    // The tuning object the cars run on this round (TP.modeTuning({bumpScale: 1.3})).
    get tuning() { return this.round.T; }
    get course() { return this.round.course; }

    snapshot() {
      const v = this.view.rect();
      return {
        state: this.state, round: this.roundNumber, time: this.time, raceTime: this.raceTime,
        countdown: this.countdown, seed: this.seed, winsToTake: this.winsToTake,
        wins: this.wins.slice(), matchWinner: this.matchWinner, view: v,
        lastResult: this.lastResult,
        cars: this.cars.map((c) => ({
          id: c.seat, seat: c.seat, name: c.name, bot: c.isBot,
          x: c.x, y: c.y, vx: c.vx, vy: c.vy, angle: c.angle, onGround: c.onGround,
          boost: c.boost, boosting: c.boosting, alive: c.alive,
          chunk: c.chunkIndex, chunkId: (this.course.chunks[c.chunkIndex] || {}).id,
          koTime: c.koTime, koCause: c.koCause, offScreen: c.offScreen, inDanger: c.inDanger,
          tumbling: c.tumbling, wins: this.wins[c.seat],
        })),
        chunks: this.course.chunks.length,
      };
    }

    dispose() {
      for (const c of this.cars) if (this.scene.remove) this.scene.remove(c.mesh);
      this.listeners = [];
      if (this.round) this.round.dispose();
    }
  }
  TP.BR.Match = Match;
})();
