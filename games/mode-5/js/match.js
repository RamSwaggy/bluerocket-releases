/* =====================================================================
   match.js — TP.M5.Match: one match from the first countdown to the
   final results. Cars, painting rules, trails, pops, bumps, pickups,
   overdrive, the round clock and the scores all live here.

   It runs as a simple state machine, one fixed physics step at a time
   (main.js calls step(1/60) as often as needed):

     "countdown"  cars sit on their painted spawn pads, 3-2-1-GO
     "play"       the round clock runs
     "roundEnd"   cars brake to a stop on the final floor for a few seconds
     → next round's "countdown", or
     "matchEnd"   final standings are in; nothing more happens

   Read-only state for the HUD and for QC's tests (TP.M5.match):
     phase, round, rounds, timeLeft, overdrive, scores (% per player),
     roundWins, players, winner (match winner index, null until the end,
     -1 for a draw), roundWinner, standings, stats, pickups, grid, arena,
     cars.

   Events emitted (see DESIGN.md; player numbers are indices 0..3):
     roundCountdown {round, arena}         roundStart {round}
     overdrive {round}                     roundEnd {round, scores, winner, roundWins}
     matchEnd {standings, stats, winner, roundWins}
     paint {player, x, z, cells}           trailStart {player}
     fill {player, cells, pct, cx, cz}     pop {victim, by, x, z, cells}
     splat {player, x, z, r}               land {player, airtime, x, z}
     bump {a, b, impact, x, z, hard}       pickupSpawn {id, kind, x, z}
     pickup {id, player, kind, x, z}       hint {text, player?}
   Extras: dry {player, cells} (a trail dried by itself),
           countdown {n} (3, 2, 1 each second, then 0 = GO).
   `r` in splat is in world units; `cells` is a cell count.
   ===================================================================== */
window.TP = window.TP || {};
TP.M5 = TP.M5 || {};

(function () {
  "use strict";
  const CFG = TP.M5.CFG;
  const emit = (n, d) => TP.M5.emit(n, d);
  const { clamp, lerp, dist2D } = TP.util;

  TP.M5.PICKUP_KINDS = ["bomb", "mega", "boost"];
  TP.M5.PICKUP_NAMES = { bomb: "Paint Bomb", mega: "Mega Roller", boost: "Boost Can" };

  class Match {
    /* opts:
         players   [{ name, controller, level? }] × 4 (controller "bot" for CPU)
         rounds    best-of N (default CFG.rounds)
         roundTime seconds per round (default CFG.roundTime)
         arena     index of the first arena (default 0)
         botLevel  default bot difficulty */
    constructor(opts = {}) {
      this.rounds = opts.rounds || CFG.rounds;
      this.roundTime = opts.roundTime || CFG.roundTime;
      this.firstArena = opts.arena || 0;
      this.tuning = TP.modeTuning(CFG.tuning);

      // Everything 3D this match owns (the cars) hangs off this group, so
      // whichever scene draws the match just adds `root` to itself.
      this.root = new THREE.Group();

      this.players = (opts.players || []).slice(0, 4).map((s, i) => ({
        index: i,
        name: (s && s.name) || TP.DEFAULT_NAMES[i],
        controller: s && s.controller && s.controller !== "off" ? s.controller : "bot",
        level: (s && s.level) || opts.botLevel || CFG.botLevel,
        color: TP.PLAYER_COLORS[i],
        css: TP.PLAYER_CSS[i],
      }));
      while (this.players.length < 4) {
        const i = this.players.length;
        this.players.push({ index: i, name: TP.DEFAULT_NAMES[i], controller: "bot", level: opts.botLevel || CFG.botLevel, color: TP.PLAYER_COLORS[i], css: TP.PLAYER_CSS[i] });
      }
      this.isBot = this.players.map((p) => p.controller === "bot");

      this.cars = this.players.map((p) => {
        const car = new TP.Car(this.root, p);
        car.stun = 0;       // seconds of spin-out left
        car.mega = 0;       // seconds of Mega Roller left
        car.grace = 0;      // seconds until this car's trail can be popped again
        car.airT = 0;       // time spent in the air this jump
        car._surfVy = 0;    // how fast the floor under the car rises (ramps)
        return car;
      });
      this.bots = this.players.map((p, i) => (this.isBot[i] ? new TP.M5.Bot(this, this.cars[i], p.level) : null));

      // Whole-match stats, per player.
      this.stats = this.players.map(() => ({
        painted: 0,      // cells gained (stripes, splats, fills, pops)
        fills: 0,        // loops closed that filled something
        bestFill: 0,     // biggest single fill, in % of the floor
        pops: 0,         // rival trails you popped
        popped: 0,       // times your trail was popped
        pickups: 0,
        distance: 0,     // units driven
        roundPct: [],    // final % in each round
      }));
      this.roundWins = [0, 0, 0, 0];
      this.winner = null;
      this.roundWinner = null;
      this.standings = null;
      this.round = 0;
      this._hintsShown = new Set();

      this.arena = TP.M5.arenaFor(this.firstArena);
      this.grid = new TP.M5.PaintGrid(this.arena);
      this.startRound();
    }

    /* ------------------------------------------------------------------
       Round setup
       ------------------------------------------------------------------ */
    startRound() {
      this.round++;
      this.arena = TP.M5.arenaFor(this.firstArena + this.round - 1);
      this.grid.reset(this.arena);

      this.phase = "countdown";
      this.clock = CFG.countdown;
      this._lastCount = -1;
      this.timeLeft = this.roundTime;
      this.elapsed = 0;
      this.overdrive = false;
      this.pickups = [];
      this.pickupTimer = CFG.pickupEvery * 0.6; // first pickup a bit sooner
      this._pickupId = 0;
      this.trailAge = [0, 0, 0, 0];  // seconds each player's current trail has existed
      this._bumpCd = {};             // "a-b" → seconds until that pair can hard-bump again
      this.roundWinner = null;

      // Cars onto their spawn spots, each on a painted pad so a first
      // loop has somewhere to close.
      this.cars.forEach((car, i) => {
        const s = this.arena.spawns[i];
        car.placeAt(s.x, s.z, s.heading);
        car.boost = 100;
        car.stun = car.mega = car.grace = car.airT = car._surfVy = 0;
        this.grid.paintCircle(s.x, s.z, CFG.padR, i, false);
      });
      this.scores = this.players.map((p, i) => this._pct(i));
      this.bots.forEach((b) => b && b.reset());

      emit("roundCountdown", { round: this.round, arena: this.arena.id, arenaName: this.arena.name });
    }

    _pct(p) { return Math.round(this.grid.pct(p) * 10) / 10; }

    /* ------------------------------------------------------------------
       One physics step
       ------------------------------------------------------------------ */
    step(dt) {
      if (this.phase === "countdown") this._stepCountdown(dt);
      else if (this.phase === "play") this._stepPlay(dt);
      else this._stepEnded(dt);
    }

    _stepCountdown(dt) {
      this.clock -= dt;
      const n = Math.ceil(this.clock - 0.5); // 3, 2, 1 … then GO at 0.5 s left
      if (n !== this._lastCount && n >= 0) {
        this._lastCount = n;
        emit("countdown", { n: Math.max(0, n) });
      }
      for (const car of this.cars) car.syncMesh(dt);
      if (this.clock <= 0.5) {
        this.phase = "play";
        emit("roundStart", { round: this.round });
        if (this.round === 1) this._hint("Drive out of your colour and back in to FILL the loop!");
      }
    }

    _stepPlay(dt) {
      this.elapsed += dt;
      this.timeLeft = Math.max(0, this.timeLeft - dt);

      // Overdrive: the last stretch of the round.
      if (!this.overdrive && this.timeLeft <= CFG.overdriveTime) {
        this.overdrive = true;
        this.pickupTimer = Math.min(this.pickupTimer, 1);
        emit("overdrive", { round: this.round });
        this._hint("OVERDRIVE! Bigger paint, more pickups!");
      }

      // 1) Drive every car (humans and bots give the same control shape).
      for (const car of this.cars) this._driveCar(car, dt);

      // 2) Car-vs-car bumps.
      this._bumps(dt);

      // 3) Pickups.
      this._pickups(dt);

      // 4) Trails dry by themselves after a while.
      for (let p = 0; p < 4; p++) {
        if (!this.grid.hasTrail(p)) { this.trailAge[p] = 0; continue; }
        this.trailAge[p] += dt;
        if (this.trailAge[p] >= CFG.trailDry) {
          const cells = this.grid.dryTrail(p);
          this.trailAge[p] = 0;
          emit("dry", { player: p, cells });
        }
      }

      this.scores = this.players.map((pl, i) => this._pct(i));
      if (this.timeLeft <= 0) this._endRound();
    }

    /* Run one car for one step: controls → physics → arena → paint. */
    _driveCar(car, dt) {
      const p = car.index;
      let ctrl;
      if (car.stun > 0) {
        // Popped: no control while spinning out.
        car.stun = Math.max(0, car.stun - dt);
        ctrl = TP.Input.NEUTRAL;
      } else if (this.isBot[p]) {
        ctrl = this.bots[p].controls(dt);
      } else {
        ctrl = TP.Input.get(car.player.controller);
      }
      if (car.mega > 0) car.mega = Math.max(0, car.mega - dt);
      if (car.grace > 0) car.grace = Math.max(0, car.grace - dt);

      const prev = { x: car.pos.x, y: car.pos.y, z: car.pos.z, onGround: car.onGround, surfVy: car._surfVy };
      car.update(dt, ctrl, this.arena, this.tuning);
      this.arena.resolveCar(car, prev);
      this._sanity(car, prev);

      // Spin-out: the body whirls (slowing down as the stun ends) while
      // the car keeps sliding. The tyres then scrub the slide away.
      if (car.stun > 0) {
        car.heading += 14 * (car.stun / CFG.stunTime) * dt;
        car.mesh.rotation.y = car.heading;
      }

      this.stats[p].distance += Math.hypot(car.pos.x - prev.x, car.pos.z - prev.z);

      // A spinning car lays no paint (so it can't start a new trail and
      // get popped again straight away).
      if (car.stun > 0) { if (car.onGround) car.airT = 0; return; }

      // Airtime and landing splats.
      if (!car.onGround) {
        car.airT += dt;
        return; // no paint while airborne
      }
      if (!prev.onGround) {
        const air = car.airT;
        car.airT = 0;
        if (air >= CFG.landMinAir) {
          const k = clamp((air - CFG.landAir[0]) / (CFG.landAir[1] - CFG.landAir[0]), 0, 1);
          const r = lerp(CFG.landR[0], CFG.landR[1], k) * this._mul();
          emit("land", { player: p, airtime: air, x: car.pos.x, z: car.pos.z });
          this._paintCar(car, r, true);
          emit("splat", { player: p, x: car.pos.x, z: car.pos.z, r: r * this.grid.cs });
        }
      }

      // The stripe under the car: wider with boost, widest with Mega Roller.
      const r = (car.mega > 0 ? CFG.megaR : car.boosting ? CFG.boostR : CFG.paintR) * this._mul();
      this._paintCar(car, r, false);
    }

    _mul() { return this.overdrive ? CFG.overdriveMul : 1; }

    /* Safety net: if a car's state ever becomes invalid (not a number) or
       it somehow ends up under the floor, put it back where it was on the
       ground, stopped. A bad number would otherwise spread to every car
       it bumps. This should never trigger; it's a seatbelt. */
    _sanity(car, prev) {
      const ok = [car.pos.x, car.pos.y, car.pos.z, car.vel.x, car.vel.y, car.vel.z, car.heading].every(Number.isFinite);
      if (ok && car.pos.y > -1) return;
      console.warn(`[mode-5] car ${car.index} had a bad position; reset`);
      const safe = Number.isFinite(prev.x + prev.z) ? prev : this.arena.spawns[car.index];
      car.pos.set(safe.x, this.arena.groundHeightAt(safe.x, safe.z), safe.z);
      car.vel.set(0, 0, 0);
      if (!Number.isFinite(car.heading)) car.heading = 0;
      car.onGround = true;
      car.mesh.position.copy(car.pos);
    }

    /* Paint a circle under a car, applying the trail rules.

       Paint a car lays on floor that isn't already its own dry turf is
       always WET (part of its trail). Your own dry turf stays dry when you
       drive over it. Then, if the car's centre is on its own dry turf and
       it has a trail, the loop closes: the trail dries and whatever it
       walls off fills.

       (Why not paint dry while you're "at home"? Because the stripe
       reaches a little ahead of the car: the car would always be standing
       on paint it just laid, so it would never count as having left home.
       Paint-everything-wet and close-when-home has no such loophole.)

       Finally, anyone whose wet trail the paint touched gets popped. */
    _paintCar(car, r, isSplat) {
      const p = car.index, g = this.grid;
      const hadTrail = g.hasTrail(p);
      const res = g.paintCircle(car.pos.x, car.pos.z, r, p, true);
      this.stats[p].painted += res.gained;
      if (res.gained && !isSplat) emit("paint", { player: p, x: car.pos.x, z: car.pos.z, cells: res.gained });

      const home = g.isOwnDry(g.cellAt(car.pos.x, car.pos.z), p);
      if (home && g.hasTrail(p)) {
        // Back on our own colour (or just skimming its edge): close up.
        this._closeLoop(p);
      } else if (!hadTrail && g.hasTrail(p)) {
        this.trailAge[p] = 0;
        emit("trailStart", { player: p });
        if (!this.isBot[p]) this._hint("Your trail is WET: get back to your colour before someone pops it!", p);
      }
      if (res.hitWet) this._popMask(res.hitWet, p);
    }

    _closeLoop(p) {
      const f = this.grid.closeLoop(p);
      this.trailAge[p] = 0;
      if (!f.cells) return;
      const pct = Math.round((f.cells / this.grid.paintable) * 1000) / 10;
      const st = this.stats[p];
      st.fills++;
      st.painted += f.cells;
      st.bestFill = Math.max(st.bestFill, pct);
      emit("fill", { player: p, cells: f.cells, pct, cx: f.cx, cz: f.cz });
      if (!this.isBot[p]) this._hint("FILL! Bigger loops grab more floor.", p);
    }

    // Pop every player whose bit is set in `mask`, credited to `by`.
    _popMask(mask, by) {
      for (let q = 0; q < 4; q++) if (mask & (1 << q) && q !== by) this._pop(q, by);
    }

    /* Player q's trail is popped by player `by`: the trail becomes the
       popper's paint, and q spins out and loses their boost. A Mega
       Roller makes your trail un-poppable while it lasts. */
    _pop(q, by) {
      const victim = this.cars[q];
      // Can't be popped with Mega Roller on, or just after a pop (grace).
      if (victim.mega > 0 || victim.grace > 0 || !this.grid.hasTrail(q)) return;
      const res = this.grid.popTrail(q, by);
      this.trailAge[q] = 0;
      victim.stun = CFG.stunTime;
      victim.grace = CFG.stunTime + CFG.popGrace;
      victim.boost = 0;
      this.stats[by].pops++;
      this.stats[by].painted += res.cells;
      this.stats[q].popped++;
      emit("pop", { victim: q, by, x: victim.pos.x, z: victim.pos.z, cells: res.cells });
      if (!this.isBot[q]) this._hint("Popped! Rivals can cut your wet trail.", q);
    }

    /* ------------------------------------------------------------------
       Bumps
       ------------------------------------------------------------------ */
    _bumps(dt) {
      for (const k in this._bumpCd) this._bumpCd[k] -= dt;
      const hits = TP.Car.collideAll(this.cars, this.tuning);
      for (const h of hits) {
        const a = h.attacker.index, v = h.victim.index;
        const key = Math.min(a, v) + "-" + Math.max(a, v);
        const hard = h.impact > CFG.hardBump && !(this._bumpCd[key] > 0);
        const x = (h.a.pos.x + h.b.pos.x) / 2, z = (h.a.pos.z + h.b.pos.z) / 2;
        emit("bump", { a: h.a.index, b: h.b.index, attacker: a, victim: v, impact: h.impact, x, z, hard });
        if (!hard) continue;
        this._bumpCd[key] = CFG.bumpCooldown;

        // A hard hit knocks the victim's paint off: a splat in the
        // attacker's colour where the victim was, and the victim's trail
        // pops (the splat itself also pops any other trail it lands on).
        const vx = h.victim.pos.x, vz = h.victim.pos.z;
        const r = CFG.bumpSplatR * this._mul();
        const res = this.grid.paintCircle(vx, vz, r, a, false);
        this.stats[a].painted += res.gained;
        emit("splat", { player: a, x: vx, z: vz, r: r * this.grid.cs });
        this._pop(v, a);
        this._popMask(res.hitWet, a);
      }
    }

    /* ------------------------------------------------------------------
       Pickups
       ------------------------------------------------------------------ */
    _pickups(dt) {
      this.pickupTimer -= dt;
      if (this.pickupTimer <= 0) {
        this.pickupTimer = this.overdrive ? CFG.overdrivePickupEvery : CFG.pickupEvery;
        if (this.pickups.length < CFG.pickupMax + (this.overdrive ? 1 : 0)) this._spawnPickup();
      }

      for (let k = this.pickups.length - 1; k >= 0; k--) {
        const pk = this.pickups[k];
        for (const car of this.cars) {
          if (car.pos.y > 3 || dist2D(car.pos.x, car.pos.z, pk.x, pk.z) > CFG.pickupGrabR) continue;
          this.pickups.splice(k, 1);
          this._grab(car, pk);
          break;
        }
      }
    }

    // A pickup appears on open floor, away from obstacles and cars.
    _spawnPickup() {
      const A = this.arena, U = TP.util;
      for (let tries = 0; tries < 40; tries++) {
        const x = U.rand(-A.half + 8, A.half - 8), z = U.rand(-A.half + 8, A.half - 8);
        if (A.solidAt(x, z, 4)) continue;
        if (this.cars.some((c) => dist2D(c.pos.x, c.pos.z, x, z) < 10)) continue;
        if (this.pickups.some((o) => dist2D(o.x, o.z, x, z) < 14)) continue;
        const pk = { id: ++this._pickupId, kind: U.pick(TP.M5.PICKUP_KINDS), x, z };
        this.pickups.push(pk);
        emit("pickupSpawn", { id: pk.id, kind: pk.kind, x, z });
        return;
      }
    }

    _grab(car, pk) {
      const p = car.index;
      this.stats[p].pickups++;
      emit("pickup", { id: pk.id, player: p, kind: pk.kind, x: pk.x, z: pk.z });
      if (pk.kind === "boost") {
        car.boost = 100;
      } else if (pk.kind === "mega") {
        car.mega = CFG.megaTime;
      } else if (pk.kind === "bomb") {
        // A big splat right here. Like any paint you lay, it's part of
        // your trail if you're out of your own colour.
        const r = CFG.bombR * this._mul();
        this._paintCar(car, r, true);
        emit("splat", { player: p, x: car.pos.x, z: car.pos.z, r: r * this.grid.cs });
      }
    }

    /* ------------------------------------------------------------------
       End of round / match
       ------------------------------------------------------------------ */
    _endRound() {
      // Loops still open at the whistle just dry: no last-frame fills.
      for (let p = 0; p < 4; p++) if (this.grid.hasTrail(p)) this.grid.dryTrail(p);
      this.scores = this.players.map((pl, i) => this._pct(i));
      this.scores.forEach((s, i) => this.stats[i].roundPct.push(s));

      const best = Math.max(...this.scores);
      const top = this.scores.map((s, i) => (s === best ? i : -1)).filter((i) => i >= 0);
      this.roundWinner = top.length === 1 ? top[0] : -1; // -1 = a draw
      if (this.roundWinner >= 0) this.roundWins[this.roundWinner]++;

      this.phase = "roundEnd";
      this.clock = CFG.roundEndTime;
      this.pickups = [];
      emit("roundEnd", { round: this.round, scores: this.scores.slice(), winner: this.roundWinner, roundWins: this.roundWins.slice() });
    }

    _matchOver() {
      const need = Math.floor(this.rounds / 2) + 1;
      return Math.max(...this.roundWins) >= need || this.round >= this.rounds;
    }

    _endMatch() {
      // Rank by rounds won, then by total paint across all rounds.
      const total = this.stats.map((s) => s.roundPct.reduce((a, b) => a + b, 0));
      const order = [0, 1, 2, 3].sort((a, b) => this.roundWins[b] - this.roundWins[a] || total[b] - total[a]);
      this.standings = order.map((i) => ({ player: i, roundWins: this.roundWins[i], totalPct: Math.round(total[i] * 10) / 10 }));
      const [first, second] = this.standings;
      const tied = first.roundWins === second.roundWins && first.totalPct === second.totalPct;
      this.winner = tied ? -1 : first.player;
      this.phase = "matchEnd";
      emit("matchEnd", { standings: this.standings, stats: this.stats, winner: this.winner, roundWins: this.roundWins.slice() });
    }

    // roundEnd / matchEnd: brake every car to a stop on the final floor.
    _stepEnded(dt) {
      for (const car of this.cars) {
        const k = Math.exp(-5 * dt);
        car.vel.x *= k;
        car.vel.z *= k;
        car.stun = 0;
        const prev = { x: car.pos.x, y: car.pos.y, z: car.pos.z, onGround: car.onGround, surfVy: car._surfVy };
        car.update(dt, TP.Input.NEUTRAL, this.arena, this.tuning);
        this.arena.resolveCar(car, prev);
      }
      if (this.phase !== "roundEnd") return;
      this.clock -= dt;
      if (this.clock > 0) return;
      if (this._matchOver()) this._endMatch();
      else this.startRound();
    }

    // Context tips, each shown once per match (per player for personal ones).
    _hint(text, player) {
      const key = text + (player ?? "");
      if (this._hintsShown.has(key)) return;
      this._hintsShown.add(key);
      emit("hint", player === undefined ? { text } : { text, player });
    }

    dispose() {
      TP.disposeScene(this.root);
    }
  }

  TP.M5.Match = Match;
})();
