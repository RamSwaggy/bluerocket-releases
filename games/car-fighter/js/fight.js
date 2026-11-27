/* =====================================================================
   fight.js — THE FIGHT CORE. Two rocket cars, one fighting line, rounds.

   This file is pure game logic:
     • a fixed 60 Hz step: fight.step(inputs) advances exactly 1/60 s
     • a state machine per car (idle, walk, attack, hitstun, juggle...)
     • hit boxes, blocking, throws, stun, damage, combos, meters
     • rounds, the round timer, KOs and the match result
     • an event log (hits, blocks, KOs...) that the view and QC read
   It uses TP.Car and Three.js maths only. No rendering, camera, DOM,
   fx or sound, so it runs fast in headless simulations. All randomness
   comes from a seeded generator: same seed + same inputs = same fight.

   ---------------------------------------------------------------------
   The fighting line and screen directions
   ---------------------------------------------------------------------
   The cars fight along the world X axis, at z = 0, on flat ground (y=0).
   The car on the left faces +X, the car on the right faces -X.
   `facing` is +1 or -1: the X direction toward the opponent.

   Controls are SCREEN-relative (DESIGN §3), so the view's camera must
   show +X as screen-right:
     steer  +1 = move right on screen (+X), -1 = left (-X)
     pitch  up (> 0)   = tap to sidestep INTO the screen (-Z)
            down (< 0) = tap to sidestep OUT of the screen (+Z)
     (pitch is the shared up/down axis: W/S, arrows, or the left stick,
     so it works the same on keyboards and gamepads)
   "Toward" / "away" = steer pointing at / away from the opponent.
   Holding away blocks.

   ---------------------------------------------------------------------
   How the shared car is used ("one car feel")
   ---------------------------------------------------------------------
   • When a car is free (idle / walking / in its own jump), it is driven
     by the normal TP.Car.update with the fighter's TP.modeTuning(): our
     screen-relative input is translated into throttle (toward = gas,
     away = reverse), boost and jump. We only set its heading to face
     the opponent (auto-face, approved by the Director).
   • During moves, stun, juggles, knockdowns and throws, the fight layer
     sets car.vel itself and integrates with the car's own gravity.
   • Cars are kept apart by our own push-apart. Car.collideAll is never
     used.
   ===================================================================== */
window.TP = window.TP || {};

(function () {
  "use strict";

  const DT = 1 / 60;

  // The arena: a turntable with a rail at each end of the fighting line.
  const ARENA = {
    halfWidth: 14,     // rails at x = ±14
    zLimit: 3.5,       // furthest a sidestep can take you off the line
    startX: 5,         // round-start positions: x = -5 and +5
  };

  // Each car's body, used as the hurt box (where it can be hit) and for
  // push-apart. Cars are 3.0 long (nose to tail along X) and 1.9 wide.
  const BODY = { halfLen: 1.5, halfWid: 0.95, height: 1.4 };

  const FLAT_WORLD = { groundHeightAt: () => 0 };

  // States in which a car is under its player's control on the ground.
  const FREE = new Set(["idle", "walk", "block"]);
  // States in which a car can be thrown.
  const THROWABLE = new Set(["idle", "walk", "block"]);
  // States in which a car can block (and must be on the ground).
  const CAN_BLOCK = new Set(["idle", "walk", "block", "blockstun"]);

  const NEUTRAL = Object.freeze({ throttle: 0, steer: 0, pitch: 0, boost: false, jump: false, hit: false, heavy: false });

  // The short recovery after landing out of an air move. Not a real move
  // (no button makes it), so it isn't in TP.MOVES; each fighter gets a copy.
  const LANDING = Object.freeze({
    id: "landing", name: "Landing", input: null, button: null,
    startup: 0, active: 0, recovery: 4,
    damage: 0, hitstun: 0, blockstun: 0, push: 0, launch: 0, airLaunch: 0, hitstop: 0, meter: 0,
    box: null, cancel: [], flags: { system: true },
  });
  const BUTTONS = ["hit", "heavy", "boost", "jump", "up", "down"];

  /* ---------- Seeded random numbers (mulberry32) ----------
     A tiny, fast generator. makeRng(seed)() returns 0..1, the same
     sequence every time for the same seed. */
  function makeRng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const headingFor = (facing) => (facing > 0 ? Math.PI / 2 : -Math.PI / 2);
  const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

  /* =====================================================================
     TP.Fight.create(opts) — see the contract in DESIGN.md §9.
     ===================================================================== */
  function create(opts = {}) {
    const RULES = TP.FIGHT_RULES;
    const seed = (opts.seed ?? 12345) >>> 0;
    const rng = makeRng(seed);
    const rounds = Math.max(1, opts.rounds || 3);
    const roundTime = Math.max(1, opts.roundTime || 60);
    const scene = opts.scene || new THREE.Scene();

    const events = [];
    const listeners = [];

    // `activeFrame` counts frames that aren't hit-stop. Button presses
    // are time-stamped with it, so a press made during a freeze is still
    // fresh when the freeze ends.
    let activeFrame = 0;
    let hitstopLeft = 0;
    let afterHitstop = "fight";

    /* ---------- The public state (plain data, read-only for others) ---------- */
    const state = {
      frame: 0,
      phase: "intro",          // intro | countdown | fight | hitstop | roundEnd | matchEnd
      phaseFramesLeft: RULES.introFrames,
      round: 1,
      rounds,
      roundTime,
      suddenDeath: false,
      timer: roundTime,        // seconds left in the round
      roundWins: [0, 0],
      roundResults: [],        // { round, winner (0|1|null = draw), reason, health, frames }
                               // reason: "KO" | "time-out" | "draw" | "double-KO"
      winner: null,            // at matchEnd: 0 or 1, or null for a drawn match
      seed,
      cars: [],
    };

    /* ---------- One fighter (internal) ---------- */
    function makeFighter(p, index) {
      p = p || {};
      const def = TP.fighterDef(p.fighter);
      const car = new TP.Car(scene, { index, color: TP.PLAYER_COLORS[index] });
      const controller = p.controller || "bot";
      const f = {
        index,
        id: def.id,
        def,
        moves: Object.assign(TP.fighterMoves(def.id), { landing: LANDING }),
        tuning: TP.fighterTuning(def.id),
        car,
        controller,
        bot: null,
        maxHealth: def.health,
        health: def.health,
        // Optional starting meter (tests, training mode). Kept between rounds.
        super: Math.max(0, Math.min(RULES.superMax, Number(p.super) || 0)),
        state: "idle",
        move: null,
        moveFrame: 0,
        moveSerial: 0,          // counts moves started (bots use it to tell moves apart)
        moveConnected: false,   // this move hit or was blocked (unlocks cancels)
        moveBlocked: false,
        stateFramesLeft: 0,
        facing: index === 0 ? 1 : -1,
        // Combo bookkeeping. Victim side: hits taken in the current combo.
        comboTaken: 0,
        comboDamage: 0,
        airHits: 0,             // hits taken while airborne in this combo (juggle limit)
        wallBounced: false,     // one wall bounce per combo
        fallInvuln: false,      // knocked out of a juggle: can't be hit until landing
        // Attacker side: hits landed in the combo currently being dealt.
        comboCount: 0,
        armourLeft: 0,
        throwImmune: 0,
        sidestepDir: 0,
        thrown: null,
        wantJump: false,
        prev: { hit: false, heavy: false, boost: false, jump: false, up: false, down: false },
        buf: {},
        inp: { held: {}, sx: 0, toward: false, away: false },
        ctrl: NEUTRAL,
      };
      for (const b of BUTTONS) f.buf[b] = -9999;
      if (controller === "bot") {
        f.bot = TP.FightBot.create({
          level: p.bot || "normal",
          seed: (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0,
          index,
        });
      }
      return f;
    }

    const fighters = [makeFighter(opts.p1, 0), makeFighter(opts.p2, 1)];
    const cars = fighters.map((f) => f.car);

    /* ---------- Events ---------- */
    function emit(type, data) {
      const ev = Object.assign({ frame: state.frame, type }, data);
      events.push(ev);
      for (const fn of listeners) {
        try { fn(ev); } catch (e) { console.error("[Car Fighter] onEvent listener failed:", e); }
      }
      return ev;
    }

    /* ---------- Round setup ---------- */
    function resetRound() {
      for (const f of fighters) {
        const x = f.index === 0 ? -ARENA.startX : ARENA.startX;
        f.facing = f.index === 0 ? 1 : -1;
        f.car.placeAt(x, 0, headingFor(f.facing));
        f.car.boost = 100;
        f.car.boosting = false;
        f.health = f.maxHealth;
        f.state = "idle";
        f.move = null;
        f.moveFrame = 0;
        f.moveConnected = f.moveBlocked = false;
        f.stateFramesLeft = 0;
        f.comboTaken = f.comboDamage = f.airHits = f.comboCount = 0;
        f.wallBounced = f.fallInvuln = false;
        f.armourLeft = 0;
        f.throwImmune = 0;
        f.thrown = null;
        f.wantJump = false;
        for (const b of BUTTONS) f.buf[b] = -9999;
        // super meter carries over between rounds (DESIGN §7)
      }
      state.timer = roundTime;
      state.phase = "intro";
      state.phaseFramesLeft = RULES.introFrames;
      hitstopLeft = 0;
    }

    /* =================================================================
       Input: held buttons → presses (edges) → a short buffer
       ================================================================= */
    function readInput(f, c, buffer) {
      c = c || NEUTRAL;
      const held = {
        hit: !!c.hit,
        heavy: !!c.heavy,
        boost: !!c.boost,
        jump: !!c.jump,
        up: (c.pitch || 0) > 0.5,
        down: (c.pitch || 0) < -0.5,
      };
      // A press is either the input layer's own "just pressed" flag, or
      // our own edge (held now, not held last step). Both mean the same press.
      const pressed = {
        hit: !!c.hitPressed || (held.hit && !f.prev.hit),
        heavy: !!c.heavyPressed || (held.heavy && !f.prev.heavy),
        boost: held.boost && !f.prev.boost,
        jump: !!c.confirmPressed || (held.jump && !f.prev.jump),
        up: held.up && !f.prev.up,
        down: held.down && !f.prev.down,
      };
      if (buffer) for (const b of BUTTONS) if (pressed[b]) f.buf[b] = activeFrame;
      f.prev = held;

      const sx = (c.steer || 0) > 0.3 ? 1 : (c.steer || 0) < -0.3 ? -1 : 0;
      f.inp = { held, sx, toward: sx !== 0 && sx === f.facing, away: sx !== 0 && sx === -f.facing };
    }

    const buffered = (f, b) => activeFrame - f.buf[b] <= RULES.bufferFrames;
    const consume = (f, b) => { f.buf[b] = -9999; };

    /* =================================================================
       Choosing and starting moves
       ================================================================= */

    // Which move do the buffered buttons ask for? `from` = the move being
    // cancelled (for the light chain), or null from neutral.
    function chooseMove(f, inAir, from) {
      const hitB = buffered(f, "hit");
      const heavyB = buffered(f, "heavy");
      if (!hitB && !heavyB) return null;

      if (inAir) return heavyB ? "drop_slam" : "flip_kick";

      // Hit + Heavy pressed together = Tow Hook (throw).
      if (hitB && heavyB && Math.abs(f.buf.hit - f.buf.heavy) <= RULES.throwPairFrames) return "tow_hook";

      const boostOn = f.inp.held.boost || buffered(f, "boost");
      const sig = f.moves.signature;
      if (heavyB && boostOn && f.super >= ((sig.cost && sig.cost.super) || 0)) return "signature";
      if (hitB && boostOn && f.car.boost >= f.moves.dash_strike.cost.boost) return "dash_strike";

      if (heavyB) return f.inp.toward ? "corkscrew" : f.inp.away ? "tailwhip" : "ram";
      // Light chain: Jab → Swipe → Spinout.
      if (from === "jab") return "swipe";
      if (from === "swipe") return "spinout";
      return "jab";
    }

    function startMove(f, id) {
      const m = f.moves[id];
      const car = f.car;
      f.state = "attack";
      f.move = id;
      f.moveFrame = 0;
      f.moveSerial++;
      f.slamLanded = false;
      f.moveConnected = false;
      f.moveBlocked = false;
      f.stateFramesLeft = TP.moveFrames(m);
      f.armourLeft = (m.flags && m.flags.armour) || 0;
      if (m.cost) {
        if (m.cost.boost) car.boost = Math.max(0, car.boost - m.cost.boost);
        if (m.cost.super) f.super = Math.max(0, f.super - m.cost.super);
      }
      // Use up the buttons this move was made from.
      if (m.button === "hit" || m.button === "both") consume(f, "hit");
      if (m.button === "heavy" || m.button === "both") consume(f, "heavy");
      if (m.usesBoost) consume(f, "boost");
      car.boosting = false;
    }

    // A move that never touched anything announces a whiff when it ends.
    function endMove(f) {
      const m = f.moves[f.move];
      if (m && !f.moveConnected && (m.box || (m.flags && m.flags.throw))) {
        emit("whiff", { attacker: f.index, move: f.move, damage: 0, stun: 0, x: f.car.pos.x, y: f.car.pos.y, z: f.car.pos.z });
      }
      f.move = null;
      f.moveFrame = 0;
      f.armourLeft = 0;
    }

    function startSidestep(f, dir) {
      f.state = "sidestep";
      f.move = null;
      f.moveFrame = 0;
      f.sidestepDir = dir;
      f.stateFramesLeft = RULES.sidestep.frames;
      consume(f, "up");
      consume(f, "down");
    }

    /* What a car decides to do this frame, from its buffered input. */
    function act(f) {
      const car = f.car;

      if (f.state === "attack") {
        const m = f.moves[f.move];
        // Kara-throw: a throw pressed a frame or two late still comes out,
        // turning the Jab/Ram that started on the first button into Tow Hook.
        if ((f.move === "jab" || f.move === "ram") && f.moveFrame <= 2 && buffered(f, "hit") && buffered(f, "heavy") &&
            Math.abs(f.buf.hit - f.buf.heavy) <= RULES.throwPairFrames) {
          startMove(f, "tow_hook");
          return;
        }
        // Cancels: only once the move has hit or been blocked.
        if (!f.moveConnected || f.moveFrame < m.startup) return;
        if (m.cancel.includes("jump") && buffered(f, "jump") && car.onGround) {
          // Jump-cancel (Corkscrew → juggle). Same jump strength as the shared car.
          consume(f, "jump");
          endMove(f);
          f.state = "air";
          car.vel.y = f.tuning.jump;
          car.vel.x = f.facing * 3;
          car.onGround = false;
          return;
        }
        const next = chooseMove(f, !car.onGround, f.move);
        if (next && m.cancel.includes(next)) startMove(f, next);
        return;
      }

      if (FREE.has(f.state) && car.onGround) {
        if (buffered(f, "up") || buffered(f, "down")) {
          // Up = into the screen (-Z), down = out of the screen (+Z).
          startSidestep(f, buffered(f, "up") ? -1 : 1);
          return;
        }
        const id = chooseMove(f, false, null);
        if (id) { startMove(f, id); return; }
        if (buffered(f, "jump")) { consume(f, "jump"); f.wantJump = true; }
        return;
      }

      if (f.state === "air") {
        const id = chooseMove(f, true, null);
        if (id) startMove(f, id);
      }
    }

    /* =================================================================
       Movement
       ================================================================= */

    // Fight-layer integration (used whenever Car.update is not): gravity
    // from the shared car's tuning, flat ground at y = 0, ground friction.
    // Returns true on the frame the car lands.
    function integrate(f, friction) {
      const car = f.car;
      const T = f.tuning;
      let landed = false;
      if (!car.onGround) car.vel.y -= T.gravity * DT;
      car.pos.addScaledVector(car.vel, DT);
      if (car.pos.y <= 0 && car.vel.y <= 0) {
        landed = !car.onGround;
        car.pos.y = 0;
        car.vel.y = 0;
        car.onGround = true;
      } else if (car.pos.y > 0.001) {
        car.onGround = false;
      }
      if (car.onGround && friction) car.vel.x *= Math.exp(-friction * DT);
      // The boost bar refills exactly as it does in Car.update.
      car.boosting = false;
      car.boost = Math.min(100, car.boost + T.boostRegen * DT);
      car.heading = headingFor(f.facing);
      car.syncMesh(DT, 0);
      return landed;
    }

    // Free movement: the shared car, driven with translated controls.
    function driveFree(f, o) {
      const car = f.car;
      car.heading = headingFor(f.facing);
      let throttle = 0;
      const vF = car.vel.x * f.facing; // speed toward the opponent
      if (car.onGround) {
        if (f.inp.toward) throttle = 1;
        else if (f.inp.away) throttle = -1;
        else if (vF > 0.6) throttle = -1;      // let go: brake to a stop with the car's own brakes
        else if (vF < -0.6) throttle = 1;
        else car.vel.x = 0;                    // close enough to stopped: stop (no endless creeping)
      }
      const boost = f.inp.held.boost && !f.inp.away;
      const jump = f.wantJump;
      if (jump) car._jumpHeld = false;          // our own buffered press, not the car's held-button check
      f.wantJump = false;
      const wasAir = !car.onGround;
      car.update(DT, { throttle, steer: 0, boost, jump }, FLAT_WORLD, f.tuning);
      car.heading = headingFor(f.facing);

      // Name the state for the view/HUD.
      if (!car.onGround) f.state = "air";
      else {
        const oppThreat = o.state === "attack" && o.move && o.moveFrame < o.moves[o.move].startup + o.moves[o.move].active;
        if (f.inp.away && oppThreat) f.state = "block";
        else if (Math.abs(car.vel.x) > 0.5 || f.inp.sx) f.state = "walk";
        else f.state = "idle";
        if (wasAir) updateFacing(f, o);        // turn round on landing after a cross-up
      }
    }

    function moveAttack(f) {
      const m = f.moves[f.move];
      const car = f.car;
      const t = f.moveFrame;
      if (m.drive && t >= m.drive.from && t < m.drive.to) car.vel.x = f.facing * m.drive.speed;
      // Air moves with `hang` hover during startup (a cartoon pause before the dive)...
      if (m.flags.hang && t < m.startup && !car.onGround) { car.vel.y = 0; car.vel.x *= 0.8; }
      // ...and `startVel` is the push given on frame `startVel.at` (default: the first frame).
      if (m.startVel && t === (m.startVel.at || 0)) {
        if (m.startVel.vx !== undefined) car.vel.x = f.facing * m.startVel.vx;
        if (m.startVel.vy !== undefined) { car.vel.y = m.startVel.vy; car.onGround = false; }
      }
      const landed = integrate(f, m.drive && t < m.drive.to ? 0 : 10);
      if (landed && m.air) {
        if (f.move === "drop_slam" && t < m.startup + m.active) {
          // The slam hits the floor. This frame still counts (it can hit
          // what's under it); recovery starts next frame (see advanceMove).
          f.slamLanded = true;
          car.vel.x = 0;
        } else if (f.move !== "drop_slam") {
          // Landed out of another air move: short landing recovery.
          endMove(f);
          f.move = "landing";
          f.moveFrame = 0;
          car.vel.x *= 0.3;
        }
      }
    }

    // Victims and other states the player doesn't control.
    function moveLoose(f) {
      const car = f.car;
      const airborne = !car.onGround;
      const landed = integrate(f, airborne ? 0 : f.state === "ko" ? 3 : 5);
      switch (f.state) {
        case "hitstun":
        case "blockstun":
          if (--f.stateFramesLeft <= 0) becomeFree(f);
          break;
        case "juggle":
          if (landed) knockDown(f);
          break;
        case "knockdown":
          if (--f.stateFramesLeft <= 0) {
            f.state = "wakeup";
            f.stateFramesLeft = RULES.wakeupFrames;
          }
          break;
        case "wakeup":
          if (--f.stateFramesLeft <= 0) {
            becomeFree(f);
            f.throwImmune = RULES.throwCooldown;
          }
          break;
        // "ko" just lies there until the round ends.
      }
    }

    function moveSidestep(f) {
      const S = RULES.sidestep;
      const done = S.frames - f.stateFramesLeft; // frames elapsed
      f.car.vel.z = done < S.moveFrames ? f.sidestepDir * S.speed : 0;
      integrate(f, 10);
      f.car.pos.z = Math.max(-ARENA.zLimit, Math.min(ARENA.zLimit, f.car.pos.z));
      if (--f.stateFramesLeft <= 0) { f.car.vel.z = 0; becomeFree(f); }
    }

    function moveThrown(f) {
      const t = f.thrown;
      const car = f.car;
      t.t++;
      const k = Math.min(1, t.t / t.frames);
      // An arc over the thrower's roof, landing on the far side.
      car.pos.x = t.fromX + (t.toX - t.fromX) * k;
      car.pos.y = Math.sin(Math.PI * k) * 3.2;
      car.vel.set(0, 0, 0);
      car.onGround = false;
      car.heading = headingFor(f.facing);
      car.syncMesh(DT, 0);
      if (k >= 1) {
        car.pos.y = 0;
        car.onGround = true;
        f.thrown = null;
        knockDown(f);
      }
    }

    function knockDown(f) {
      f.state = "knockdown";
      f.stateFramesLeft = RULES.knockdownFrames;
      f.fallInvuln = false;
      f.car.vel.x *= 0.3;
    }

    // Back under the player's control: any combo on this car is over.
    function becomeFree(f) {
      f.state = f.car.onGround ? "idle" : "air";
      f.move = null;
      f.moveFrame = 0;
      endCombo(f);
    }

    function endCombo(victim) {
      const att = fighters[1 - victim.index];
      if (victim.comboTaken >= 2) {
        emit("combo_end", {
          attacker: att.index, victim: victim.index, move: null,
          hits: victim.comboTaken, damage: victim.comboDamage, stun: 0,
          x: victim.car.pos.x, y: victim.car.pos.y, z: victim.car.pos.z,
        });
      }
      victim.comboTaken = 0;
      victim.comboDamage = 0;
      victim.airHits = 0;
      victim.wallBounced = false;
      victim.fallInvuln = false;
      att.comboCount = 0;
    }

    function moveFighter(f, o) {
      switch (f.state) {
        case "idle": case "walk": case "block": case "air":
          driveFree(f, o); break;
        case "attack": moveAttack(f); break;
        case "sidestep": moveSidestep(f); break;
        case "thrown": moveThrown(f); break;
        default: moveLoose(f);
      }
      // Drift back onto the fighting line (everyone except a car mid-sidestep).
      if (f.state !== "sidestep") {
        f.car.vel.z = 0;
        f.car.pos.z = TP.util.damp(f.car.pos.z, 0, RULES.zDrift, DT);
      }
    }

    // Count a move's frame and finish it when its time is up.
    function advanceMove(f) {
      if (f.state !== "attack") return;
      const m = f.moves[f.move];
      f.moveFrame++;
      if (f.slamLanded) {
        // An "active until it lands" move has landed: jump to its recovery.
        f.slamLanded = false;
        if (f.moveFrame < m.startup + m.active) f.moveFrame = m.startup + m.active;
      }
      f.stateFramesLeft = Math.max(0, TP.moveFrames(m) - f.moveFrame);
      if (f.moveFrame >= TP.moveFrames(m)) {
        // An air move that times out in the air (rare) falls as "air".
        endMove(f);
        f.state = f.car.onGround ? "idle" : "air";
      }
    }

    /* =================================================================
       Keeping cars apart, rails, facing
       ================================================================= */
    function separate() {
      const [a, b] = fighters;
      if (a.state === "thrown" || b.state === "thrown") return;
      const pa = a.car.pos, pb = b.car.pos;
      if (Math.abs(pa.y - pb.y) >= 1.3) return;            // one is over the other
      if (Math.abs(pa.z - pb.z) >= BODY.halfWid * 2) return; // sidestepped past
      let dx = pb.x - pa.x;
      const min = BODY.halfLen * 2;
      if (Math.abs(dx) >= min) return;
      const dir = dx !== 0 ? sign(dx) : a.facing;           // which way to push b
      const overlap = min - Math.abs(dx);
      const limit = ARENA.halfWidth - BODY.halfLen;
      // Normally split the push; if one is pinned on a rail, the other takes it all.
      let pushA = overlap / 2, pushB = overlap / 2;
      if (Math.abs(pa.x - dir * pushA) > limit) { pushB = overlap; pushA = 0; }
      else if (Math.abs(pb.x + dir * pushB) > limit) { pushA = overlap; pushB = 0; }
      pa.x -= dir * pushA;
      pb.x += dir * pushB;
    }

    function rails(f) {
      const car = f.car;
      const limit = ARENA.halfWidth - BODY.halfLen;
      if (Math.abs(car.pos.x) <= limit) return;
      const side = sign(car.pos.x);
      car.pos.x = side * limit;
      const intoWall = car.vel.x * side > 0;
      if (!intoWall) return;
      // Wall bounce: a hard knockback into the rail bounces back once per combo.
      if ((f.state === "hitstun" || f.state === "juggle") && !f.wallBounced &&
          Math.abs(car.vel.x) >= RULES.wallBounceMinSpeed && !f.fallInvuln) {
        car.vel.x = -car.vel.x * 0.5;
        car.vel.y = Math.max(car.vel.y, 8);
        car.onGround = false;
        f.state = "juggle";
        f.wallBounced = true;
      } else {
        car.vel.x = 0;
      }
    }

    function updateFacing(f, o) {
      const d = o.car.pos.x - f.car.pos.x;
      if (Math.abs(d) > 0.2) f.facing = sign(d);
      f.car.heading = headingFor(f.facing);
    }

    /* =================================================================
       Hits
       ================================================================= */
    function invulnerable(v) {
      if (v.state === "knockdown" || v.state === "wakeup" || v.state === "thrown" || v.state === "ko") return true;
      if (v.fallInvuln) return true;
      if (v.state === "sidestep" && RULES.sidestep.frames - v.stateFramesLeft < RULES.sidestep.invulnFrames) return true;
      return false;
    }

    // Does attacker `a`'s current move touch victim `v` this frame?
    function detect(a, v) {
      if (a.state !== "attack") return null;
      const m = a.moves[a.move];
      if (a.moveConnected) return null;
      const t = a.moveFrame;
      if (t < m.startup || t >= m.startup + m.active) return null;
      if (m.flags.throw) return detectThrow(a, v, m);
      if (!m.box || invulnerable(v)) return null;

      const pa = a.car.pos, pv = v.car.pos;
      const bx0 = pa.x + a.facing * m.box.x0, bx1 = pa.x + a.facing * m.box.x1;
      const hx0 = Math.min(bx0, bx1), hx1 = Math.max(bx0, bx1);
      const hy0 = pa.y + m.box.y0, hy1 = pa.y + m.box.y1;
      const hz0 = pa.z - m.box.z, hz1 = pa.z + m.box.z;
      // The victim's hurt box: its body.
      const ux0 = pv.x - BODY.halfLen, ux1 = pv.x + BODY.halfLen;
      const uy0 = pv.y, uy1 = pv.y + BODY.height;
      const uz0 = pv.z - BODY.halfWid, uz1 = pv.z + BODY.halfWid;
      if (hx1 < ux0 || hx0 > ux1 || hy1 < uy0 || hy0 > uy1 || hz1 < uz0 || hz0 > uz1) return null;
      return {
        kind: "hit", a, v, m, moveId: a.move,
        x: (Math.max(hx0, ux0) + Math.min(hx1, ux1)) / 2,
        y: (Math.max(hy0, uy0) + Math.min(hy1, uy1)) / 2,
        z: (Math.max(hz0, uz0) + Math.min(hz1, uz1)) / 2,
      };
    }

    // Throws ignore block, but lose to any attack (an attacking car can't be grabbed).
    function detectThrow(a, v, m) {
      const pa = a.car.pos, pv = v.car.pos;
      if (Math.abs(pv.x - pa.x) > m.range || Math.abs(pv.y - pa.y) > 0.8 || Math.abs(pv.z - pa.z) > 1.6) return null;
      if (!THROWABLE.has(v.state) || !v.car.onGround || v.throwImmune > 0 || invulnerable(v)) return null;
      return { kind: "throw", a, v, m, moveId: a.move, x: (pa.x + pv.x) / 2, y: 0.8, z: (pa.z + pv.z) / 2 };
    }

    let pendingHitstop = 0;

    function applyThrow(r) {
      const { a, v, m } = r;
      a.moveConnected = true;
      const dmg = Math.round(m.damage * scaleFor(v));
      v.health -= dmg;
      v.comboTaken++;
      v.comboDamage += dmg;
      a.comboCount = v.comboTaken;
      gainMeter(a, v, m.meter);
      // Fly over the thrower and land behind it.
      const limit = ARENA.halfWidth - BODY.halfLen;
      const toX = Math.max(-limit, Math.min(limit, a.car.pos.x - a.facing * (BODY.halfLen * 2 + 0.4)));
      v.state = "thrown";
      v.move = null;
      v.thrown = { fromX: v.car.pos.x, toX, t: 0, frames: 36 };
      pendingHitstop = Math.max(pendingHitstop, m.hitstop);
      emit("throw", { attacker: a.index, victim: v.index, move: r.moveId, damage: dmg, stun: 36, x: r.x, y: r.y, z: r.z });
    }

    function scaleFor(v) {
      return Math.max(RULES.scalingFloor, 1 - RULES.scalingStep * v.comboTaken);
    }

    function gainMeter(a, v, amount) {
      a.super = Math.min(RULES.superMax, a.super + amount);
      v.super = Math.min(RULES.superMax, v.super + amount * RULES.takenMeterRate);
    }

    function applyHit(r) {
      const { a, v, m } = r;
      a.moveConnected = true;
      // r.moveId, not a.move: in a trade the other hit may already have
      // interrupted this attacker's move.
      const at = { attacker: a.index, victim: v.index, move: r.moveId, x: r.x, y: r.y, z: r.z };

      // Blocked: holding away, on the ground, able to guard.
      if (CAN_BLOCK.has(v.state) && v.car.onGround && v.inp.away) {
        a.moveBlocked = true;
        const dmg = Math.max(1, Math.round(m.damage * RULES.chip));
        v.health -= dmg;
        v.state = "blockstun";
        v.move = null;
        v.stateFramesLeft = m.blockstun;
        v.car.vel.x = a.facing * m.push * RULES.blockPushScale;
        a.super = Math.min(RULES.superMax, a.super + m.meter * 0.5);
        pendingHitstop = Math.max(pendingHitstop, Math.max(2, m.hitstop - 1));
        emit("block", Object.assign(at, { damage: dmg, stun: m.blockstun }));
        return;
      }

      const dmg = Math.round(m.damage * scaleFor(v));
      v.health -= dmg;
      v.comboTaken++;
      v.comboDamage += dmg;
      a.comboCount = v.comboTaken;
      gainMeter(a, v, m.meter);
      pendingHitstop = Math.max(pendingHitstop, m.hitstop);

      // Armour (Haulback's Ram/Corkscrew in M2): take the damage, keep attacking.
      if (v.state === "attack" && v.armourLeft > 0) {
        v.armourLeft--;
        emit("hit", Object.assign(at, { damage: dmg, stun: 0, armoured: true }));
        return;
      }

      const car = v.car;
      const wasAirborne = !car.onGround;
      if (v.state === "attack") { v.move = null; v.moveFrame = 0; }
      let stun;

      if (wasAirborne && v.airHits >= RULES.juggleLimit) {
        // Juggle limit reached: this hit knocks them out of the air, and they
        // can't be hit again until they land.
        v.airHits++;
        v.state = "juggle";
        v.fallInvuln = true;
        car.vel.x = a.facing * 4;
        car.vel.y = -10;
        stun = 0;
      } else if (wasAirborne || m.launch > 0 || m.flags.knockdown) {
        if (wasAirborne) v.airHits++;
        v.state = "juggle";
        car.vel.x = a.facing * m.push;
        // In the air: a small pop keeps the juggle going (a knockdown move
        // like Drop Slam spikes them down instead). On the ground: the
        // move's launch, or a little hop for a knockdown move.
        car.vel.y = wasAirborne
          ? (m.flags.knockdown ? -8 : m.airLaunch)
          : Math.max(m.launch, m.flags.knockdown ? 4 : 0);
        car.onGround = false;
        stun = 0;
      } else {
        v.state = "hitstun";
        v.stateFramesLeft = m.hitstun;
        car.vel.x = a.facing * m.push;
        stun = m.hitstun;
      }
      emit("hit", Object.assign(at, { damage: dmg, stun }));
    }

    /* =================================================================
       Rounds
       ================================================================= */
    const pct = (f) => f.health / f.maxHealth;

    function endRound(winner, reason) {
      if (winner === null) { state.roundWins[0]++; state.roundWins[1]++; }
      else state.roundWins[winner]++;
      const result = {
        round: state.round, winner, reason,
        health: fighters.map((f) => Math.max(0, f.health)),
        frames: Math.round((roundTime - state.timer) * 60),
      };
      state.roundResults.push(result);
      emit("round_end", Object.assign({ attacker: winner, move: null, damage: 0, stun: 0 }, result));
      state.phaseFramesLeft = RULES.roundEndFrames;
    }

    function afterRound() {
      const need = Math.floor(rounds / 2) + 1;
      const [w0, w1] = state.roundWins;
      if (Math.max(w0, w1) >= need && w0 !== w1) return endMatch(w0 > w1 ? 0 : 1);
      if (state.round >= rounds + RULES.maxSuddenDeath) return endMatch(null);
      state.round++;
      state.suddenDeath = state.round > rounds;
      resetRound();
    }

    function endMatch(winner) {
      state.winner = winner;
      state.phase = "matchEnd";
      state.phaseFramesLeft = 0;
      emit("match_end", { attacker: winner, winner, move: null, damage: 0, stun: 0, roundWins: state.roundWins.slice() });
    }

    function checkKO(lastHitBy) {
      const down = fighters.filter((f) => f.health <= 0);
      if (!down.length) return false;
      for (const v of down) {
        v.health = 0;
        v.state = "ko";
        v.move = null;
        v.car.vel.x = -v.facing * 7;
        v.car.vel.y = 9;
        v.car.onGround = false;
        const a = fighters[1 - v.index];
        emit("ko", { attacker: a.index, victim: v.index, move: lastHitBy[a.index] || null, damage: 0, stun: 0,
          x: v.car.pos.x, y: v.car.pos.y, z: v.car.pos.z });
      }
      if (down.length === 2) endRound(null, "double-KO");
      else endRound(1 - down[0].index, "KO");
      hitstopLeft = Math.max(pendingHitstop, RULES.koHitstop);
      afterHitstop = "roundEnd";
      state.phase = "hitstop";
      return true;
    }

    /* =================================================================
       One fight frame
       ================================================================= */
    function fightFrame() {
      activeFrame++;
      const [f0, f1] = fighters;
      for (const f of fighters) readInput(f, f.ctrl, true);

      act(f0); act(f1);
      moveFighter(f0, f1); moveFighter(f1, f0);
      separate();
      rails(f0); rails(f1);

      // Hits: both are detected first, then applied, so trades are fair.
      pendingHitstop = 0;
      const results = [detect(f0, f1), detect(f1, f0)];
      const lastHitBy = [null, null];
      if (results[0] && results[1] && results[0].kind === "throw" && results[1].kind === "throw") {
        // Both grabbed at once: the throws clash and nothing happens.
        results[0] = results[1] = null;
      }
      for (const r of results) {
        if (!r) continue;
        lastHitBy[r.a.index] = r.moveId;
        if (r.kind === "throw") applyThrow(r); else applyHit(r);
      }

      advanceMove(f0); advanceMove(f1);
      for (const f of fighters) {
        if (f.throwImmune > 0 && f.state !== "knockdown" && f.state !== "wakeup") f.throwImmune--;
        if (FREE.has(f.state) && f.car.onGround) updateFacing(f, fighters[1 - f.index]);
      }

      if (checkKO(lastHitBy)) return;

      state.timer = Math.max(0, state.timer - DT);
      if (state.timer <= 0) {
        // Time out: higher health percentage wins; equal is a draw (both get the round).
        const d = pct(f0) - pct(f1);
        endRound(Math.abs(d) < 1e-9 ? null : d > 0 ? 0 : 1, Math.abs(d) < 1e-9 ? "draw" : "time-out");
        state.phase = "roundEnd";
        return;
      }
      if (pendingHitstop > 0) {
        hitstopLeft = pendingHitstop;
        afterHitstop = "fight";
        state.phase = "hitstop";
      }
    }

    // After a KO or time-out: physics continue, nobody can act or be hit.
    function settleFrame() {
      for (const f of fighters) {
        readInput(f, NEUTRAL, false);
        if (f.state === "attack") { moveAttack(f); advanceMove(f); }
        else moveFighter(f, fighters[1 - f.index]);
      }
      separate();
      rails(fighters[0]); rails(fighters[1]);
    }

    function syncIdle() {
      for (const f of fighters) { f.car.heading = headingFor(f.facing); f.car.syncMesh(DT, 0); }
    }

    /* ---------- fight.step(inputs): exactly one 1/60 s frame ---------- */
    function step(inputs) {
      if (state.phase === "matchEnd") { state.frame++; settleFrame(); writeState(); return; }
      state.frame++;

      // Controls: humans from `inputs`, bots think for themselves.
      for (const f of fighters) {
        f.ctrl = f.bot ? f.bot.think(fight, f.index) : (inputs && inputs[f.index]) || NEUTRAL;
      }

      switch (state.phase) {
        case "intro":
        case "countdown":
          // Cars wait on their marks. Read input only to track held buttons,
          // so something held through the countdown doesn't fire on "FIGHT".
          for (const f of fighters) readInput(f, f.ctrl, false);
          syncIdle();
          if (--state.phaseFramesLeft <= 0) {
            if (state.phase === "intro") {
              state.phase = "countdown";
              state.phaseFramesLeft = RULES.countdownFrames;
            } else {
              state.phase = "fight";
              state.phaseFramesLeft = 0;
              emit("round_start", { attacker: null, move: null, damage: 0, stun: 0, round: state.round, suddenDeath: state.suddenDeath });
            }
          }
          break;

        case "hitstop":
          // Frozen. Presses still go into the buffer (stamped with the
          // paused activeFrame, so they're fresh when play resumes).
          for (const f of fighters) readInput(f, f.ctrl, true);
          if (--hitstopLeft <= 0) state.phase = afterHitstop;
          break;

        case "fight":
          fightFrame();
          break;

        case "roundEnd":
          settleFrame();
          if (--state.phaseFramesLeft <= 0) afterRound();
          break;
      }
      writeState();
    }

    /* ---------- Copy internals into the public plain-data state ---------- */
    function writeState() {
      for (const f of fighters) {
        const c = state.cars[f.index] || (state.cars[f.index] = {});
        const p = f.car.pos, v = f.car.vel;
        c.index = f.index;
        c.fighter = f.id;
        c.name = f.def.name;
        c.controller = f.controller;
        c.x = p.x; c.y = p.y; c.z = p.z;
        c.vx = v.x; c.vy = v.y; c.vz = v.z;
        c.facing = f.facing;
        c.health = Math.max(0, f.health);
        c.maxHealth = f.maxHealth;
        c.super = f.super;
        c.boost = f.car.boost;
        c.state = f.state;
        c.move = f.state === "attack" ? f.move : null;
        c.moveFrame = f.state === "attack" ? f.moveFrame : 0;
        c.stateFramesLeft = f.stateFramesLeft;
        c.combo = f.comboCount;
        const r = c.health / c.maxHealth;
        c.damageLevel = r > 0.75 ? 0 : r > 0.5 ? 1 : r > 0.25 ? 2 : 3;
        c.onGround = f.car.onGround;
      }
    }

    const fight = {
      cars,
      state,
      events,
      step,
      onEvent(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
      rng,
      arena: ARENA,
      body: BODY,
      rules: RULES,
      // Internal: for our own bot (bot.js) and QC debugging only. Not part of the contract.
      _fighters: fighters,
    };

    resetRound();
    writeState();
    return fight;
  }

  TP.Fight = {
    create, makeRng, DT, BODY,
    // The play space, for the view's camera and stage (DESIGN §9):
    // rails at x = ±halfX, sidesteps reach z = ±halfZ, floor at minY, and
    // maxY is about the highest a car gets (launch + juggle pops + a jump).
    ARENA: { halfX: ARENA.halfWidth, halfZ: ARENA.zLimit, minY: 0, maxY: 8 },
  };
})();
