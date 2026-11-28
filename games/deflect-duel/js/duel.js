/* =====================================================================
   duel.js — the rules of Deflect Duel: arena walls and pillars, the
   ball, swinging and hitting, ownership and KOs, lives and respawns,
   the hit-freeze, the 12-second stalemate reset, and the bots.

   How a match works, in plain English:
     • One ball hovers at bumper height. It starts NEUTRAL in the middle
       (white, harmless). Anyone can drive up and hit it.
     • Hitting: press Hit to swing for a moment (swingTime). If the ball
       is within hitRange of your car while you're swinging, it's sent
       the way your car faces, bent a little left/right by your steering.
     • The first hit off a serve sends the ball at baseSpeed. Every hit
       after that adds speedStep, up to maxSpeed. Hitting while boosting
       is a SMASH: extra speed, but it costs a chunk of boost.
     • The ball now belongs to whoever hit it last (it glows their
       colour). It passes harmlessly through its owner, but if it touches
       ANYONE ELSE, they lose a life. Jumping lifts you over it.
     • Each hit pauses the action for a split second (the hit-freeze).
       The faster the ball, the longer the pause.
     • After a KO the ball goes back to a neutral serve in the middle.
       The KO'd car respawns after a moment, blinking and invulnerable.
       At 0 lives you're out. The last car standing wins.
     • If nobody hits the ball for stalemateTime seconds, it's re-served.

   Who uses what:
     • main.js creates a TP.Duel, calls duel.update(dt) every frame and
       draws duel.scene with duel.camera.
     • Art and UI dress things up through duel.hooks (called on hits,
       swings, KOs, bounces, serves, respawns and the match end) and the
       optional TP.DuelArena.build() for the arena's look.
     • QC reads window.TP.duel (this object) or TP.duel.snapshot().

   The rules run on a FIXED time step (1/120 s), whatever the frame rate.
   update(dt) just feeds time into that fixed step, so a test can call
   update() directly with any dt and get the same game.
   ===================================================================== */
(function () {
  "use strict";
  const { clamp, lerp, dist2D, wrapAngle, rand } = TP.util;

  /* =====================================================================
     Every tunable number, in one place. Art and QC read these too, so
     the names are part of the team's agreed interface.
     ===================================================================== */
  TP.DUEL_CFG = {
    /* ---------- Arena ---------- */
    arenaW: 44,          // width along X (left ↔ right on screen)
    arenaD: 28,          // depth along Z (top ↔ bottom on screen)
    wallH: 2.2,          // wall height (looks only; nothing can go over the walls)
    pillars: true,       // two round pillars for bank shots (false = open arena)
    pillarList: [        // centre and radius of each pillar
      { x: 0, z: -7.5, r: 1.8 },
      { x: 0, z: 7.5, r: 1.8 },
    ],

    /* ---------- Ball ---------- */
    ballR: 0.9,          // ball radius
    ballY: 1.1,          // hover height (bumper height). The ball never leaves it.
    baseSpeed: 16,       // speed of the first hit after a serve (under the car's 17, so you can chase it)
    speedStep: 2.5,      // added by every later hit
    maxSpeed: 56,        // top speed (even with a smash)
    smashBonus: 8,       // extra speed added by a smash (hit while boosting)
    smashBoostCost: 30,  // boost used by a smash (out of 100). Not enough boost = normal hit.
    serveDrift: 2,       // a neutral ball drifts slowly so it never sits perfectly still

    /* ---------- Hitting ---------- */
    hitRange: 3.6,       // car centre to ball centre, top-down
    swingTime: 0.28,     // how long one swing can connect
    missCooldown: 0.45,  // wait after a swing that hit nothing
    hitCooldown: 0.12,   // short wait after a swing that connected
    rehitLock: 0.1,      // after any hit, nobody can hit the ball again for this long
    aimBendDeg: 25,      // full steering bends the shot this many degrees

    /* ---------- Getting hit ---------- */
    koReach: 1.15,       // car's "body" radius for KOs (a bit smaller than its bump circle)
    jumpClear: 1.0,      // a car whose wheels are higher than this is over the ball

    /* ---------- Timers (seconds) ---------- */
    freezeMin: 0.04,     // hit-freeze at base speed
    freezeMax: 0.3,      // hit-freeze at max speed
    koFreeze: 0.35,      // pause when someone is KO'd
    stalemateTime: 12,   // no hits for this long → re-serve
    respawnDelay: 1.0,   // a KO'd car is gone this long before it respawns
    respawnInvuln: 2,    // then blinks, unhittable, for this long
    serveDelay: 1.2,     // ball sits in the middle this long before it's live
    countdown: 3,        // 3-2-1 before the first serve
  };

  // The rules always advance in slices of exactly this length.
  const FIXED_DT = 1 / 120;
  // Never simulate more than this much time in one update() call, so a
  // long stall (a background tab) can't freeze the page catching up.
  const MAX_CATCHUP = 1.0;

  const NO_HOOK = () => {};

  // One bot difficulty level, but every bot is a little different.
  function makeBotSkill() {
    return {
      reaction: rand(0.08, 0.2),   // seconds before reacting to a new hit
      maxReturn: rand(32, 46),     // fastest ball it will try to hit back
      aimNoise: rand(4, 14),       // degrees of sloppiness in its aim
      swingLead: rand(0.04, 0.12), // how early it swings
      jumpLead: rand(0.12, 0.22),  // how early it jumps a ball it can't return
      fumble: 0.1,                 // chance it misreads a slow shot...
      fumbleFast: 0.35,            // ...plus this much more at max speed
      planFor: -1, plan: "",       // decision for the current shot
    };
  }

  /* ---------- Where each car starts (by player order, not seat) ----------
     The first two spots are diagonally opposite, so a 1v1 starts fair. */
  function spawnSpot(i) {
    const C = TP.DUEL_CFG;
    const x = C.arenaW / 2 - 6, z = C.arenaD / 2 - 6;
    const spots = [[-x, z], [x, -z], [x, z], [-x, -z]];
    const [sx, sz] = spots[i % spots.length];
    // Face the middle of the arena.
    return { x: sx, z: sz, heading: Math.atan2(-sx, -sz) };
  }

  /* =====================================================================
     TP.Duel — one match.
       opts.players   [{ seat, name, controller }]  seat 0..3 picks the colour
       opts.lives     3 or 5
       opts.onEvent   optional (name, data) callback for main.js (toasts, sounds)
       opts.pillars   optional true/false to override DUEL_CFG.pillars for this match
     Axes: X runs along the 44-unit side, Z along the 28-unit side, the
     serve spot is (0, 0), and the inner wall faces are at x = ±arenaW/2
     and z = ±arenaD/2.
     ===================================================================== */
  class Duel {
    constructor(opts) {
      // This match's copy of the config (so a per-match pillars choice
      // doesn't change the shared defaults).
      const C = (this.cfg = Object.assign({}, TP.DUEL_CFG));
      if (typeof opts.pillars === "boolean") C.pillars = opts.pillars;
      this.onEvent = opts.onEvent || NO_HOOK;
      this.lives = opts.lives || 3;
      this.pillars = C.pillars ? C.pillarList : [];

      // Same car as every Rocket Rumble mode; Deflect Duel only lets you
      // turn more while nearly stopped, so you can aim.
      this.tuning = TP.modeTuning({ pivot: 0.8 });

      /* ---------- Hooks for Art and UI (and anyone else) ----------
         Each one is called at the moment named; by default they do nothing. */
      this.hooks = {
        onHit: NO_HOOK,        // (car, ball, speedFrac 0..1, smash)
        onSwing: NO_HOOK,      // (car)
        onKO: NO_HOOK,         // (victimCar, ownerCar)
        onWallBounce: NO_HOOK, // (pos, normal {x, z}) — walls and pillars
        onServe: NO_HOOK,      // ()
        onRespawn: NO_HOOK,    // (car)
        onMatchEnd: NO_HOOK,   // (result) — same object main.js gets
      };

      /* ---------- Scene and camera ---------- */
      this.scene = new THREE.Scene();
      // One fixed camera over the whole arena: everyone shares the screen.
      this.camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 400);
      this.camera.position.set(0, 36, 24);
      this.camera.lookAt(0, 0, 1.5);

      // The arena's look. Art's TP.DuelArena wins if it's loaded; it gets
      // the duel too, and may return hooks to install. Collisions never
      // come from these meshes, only from DUEL_CFG.
      this.arenaLook = null;
      if (TP.DuelArena && typeof TP.DuelArena.build === "function") {
        this.arenaLook = TP.DuelArena.build(this.scene, C, this) || null;
        if (this.arenaLook && this.arenaLook.hooks) Object.assign(this.hooks, this.arenaLook.hooks);
      } else {
        // Placeholder look: plain background, the shared lights, boxes.
        this.scene.background = new THREE.Color(0x0d1430);
        TP.addStadiumLights(this.scene, C.arenaW / 2);
        this._buildPlaceholderArena();
      }

      /* ---------- Players and their cars ----------
         `players` is the readable state (what the HUD and QC look at);
         `cars` holds the matching TP.Car for each one, same order. */
      this.players = [];
      this.cars = [];
      this.bots = [];
      opts.players.forEach((cfg, i) => {
        const seat = cfg.seat;
        const car = new TP.Car(this.scene, {
          index: seat,
          name: cfg.name,
          color: TP.PLAYER_COLORS[seat],
          css: TP.PLAYER_CSS[seat],
          controller: cfg.controller,
        });
        const s = spawnSpot(i);
        car.placeAt(s.x, s.z, s.heading);
        this.cars.push(car);
        this.players.push({
          index: i,              // position in these arrays
          seat,                  // 0..3, the menu slot (picks the colour)
          name: cfg.name,
          css: TP.PLAYER_CSS[seat],
          controller: cfg.controller,
          lives: this.lives,
          out: false,            // no lives left
          invuln: 0,             // seconds of blinking safety left
          dead: 0,               // seconds until respawn (0 = on the field)
          swingT: 0,             // seconds of swing left (0 = not swinging)
          swingHit: false,       // has this swing already connected?
          cooldown: 0,           // seconds before you can swing again
          pos: car.pos,          // live position (THREE.Vector3)
          airborne: false,       // high enough to clear the ball
          kos: 0,                // KOs scored on others
          hits: 0,               // hits landed
          prevHit: false,        // hit button state last step (edge detection)
          lastSteer: 0,          // steering this step (for aim)
        });
        // Each player also exposes its TP.Car as .car (hidden from
        // JSON.stringify, since a car holds 3D meshes).
        Object.defineProperty(this.players[i], "car", { value: car, enumerable: false });
        // Swing ring placeholder: a flat ring showing your reach while swinging.
        car.mesh.add(this._makeSwingRing(seat));
        this.bots.push(cfg.controller === "bot" ? makeBotSkill() : null);
      });
      // Test hook: controls forced from outside (setInput), per player.
      this.inputOverride = this.players.map(() => null);
      /* ---------- The ball ---------- */
      this.ball = {
        pos: new THREE.Vector3(0, C.ballY, 0),
        vel: new THREE.Vector3(),
        speed: 0,
        owner: null,     // index (into players[]) of the last hitter, or null when neutral
        neutral: true,
        hits: 0,         // hits since the last serve
        hitId: 0,        // goes up on every hit (bots use it to spot a new shot)
        lastHitT: -99,   // match time of the last hit
        lockUntil: 0,    // match time before which the ball can't be hit (rehitLock)
      };
      this.ballMesh = new THREE.Mesh(
        new THREE.SphereGeometry(C.ballR, 28, 18),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 0.3 })
      );
      this.ballMesh.castShadow = true;
      this.scene.add(this.ballMesh);

      /* ---------- Match state ---------- */
      this.state = "serve";        // "serve" | "play" | "over"
      this.countdown = opts.countdown ?? C.countdown; // nothing moves until this hits 0
      this.serveTimer = C.serveDelay;
      this.freezeLeft = 0;         // hit-freeze / KO pause remaining
      this.noHitTime = 0;          // seconds since the last hit (stalemate clock)
      this.time = 0;               // match time (excludes countdown and freezes)
      this.winner = null;          // index (into players[]) of the winner once state is "over"
      this.koLog = [];             // { t, victim, owner, speed } per KO (player indexes)
      this.outOrder = [];          // player indexes in the order they were eliminated
      this.result = null;
      this._acc = 0;               // unspent time for the fixed step

      this._serve(true);
      TP.duel = this; // readable from the console and from QC's tests
    }

    /* =====================================================================
       Time
       ===================================================================== */

    // Feed real (or test) time in; the rules advance in fixed slices.
    update(dt) {
      this._acc += Math.min(Math.max(0, dt), MAX_CATCHUP);
      while (this._acc >= FIXED_DT) {
        this._acc -= FIXED_DT;
        this.step(FIXED_DT);
      }
      this.animate(dt);
    }

    // One fixed slice of the rules.
    step(dt) {
      if (this.state === "over") { this._coastToStop(dt); return; }

      // 3-2-1: everything waits.
      if (this.countdown > 0) {
        this.countdown -= dt;
        if (this.countdown <= 0) { this.countdown = 0; this.onEvent("go"); }
        return;
      }

      // Hit-freeze: the whole game holds still for a moment.
      if (this.freezeLeft > 0) {
        this.freezeLeft = Math.max(0, this.freezeLeft - dt);
        return;
      }

      this.time += dt;
      this._stepCars(dt);
      this._stepBall(dt);
    }

    /* =====================================================================
       Cars: driving, swinging, walls, pillars, bumping
       ===================================================================== */
    _stepCars(dt) {
      const C = this.cfg;
      this.players.forEach((p, i) => {
        const car = this.cars[i];
        if (p.out) return;

        // Waiting to respawn.
        if (p.dead > 0) {
          p.dead -= dt;
          if (p.dead <= 0) this._respawn(i);
          return;
        }

        p.invuln = Math.max(0, p.invuln - dt);
        p.cooldown = Math.max(0, p.cooldown - dt);

        // Swing timer. A swing that runs out without connecting is a miss,
        // and a miss costs you a short cooldown.
        if (p.swingT > 0) {
          p.swingT -= dt;
          if (p.swingT <= 0) {
            p.swingT = 0;
            if (!p.swingHit) p.cooldown = C.missCooldown;
          }
        }

        // Humans and bots produce the same controls. (A test can force
        // a player's controls with setInput.)
        const ctrl = this.inputOverride[i] || (this.bots[i] ? this._botControls(i) : TP.Input.get(p.controller));
        car.update(dt, ctrl, this, this.tuning);
        this._keepCarInArena(car);

        // Start a swing on the moment Hit goes down. We detect the press
        // ourselves (not with hitPressed) because several fixed steps can
        // run inside one frame and a press must only count once.
        const pressed = !!ctrl.hit && !p.prevHit;
        p.prevHit = !!ctrl.hit;
        p.lastSteer = ctrl.steer || 0;
        if (pressed && p.swingT <= 0 && p.cooldown <= 0) {
          p.swingT = C.swingTime;
          p.swingHit = false;
          this.hooks.onSwing(car);
          this.onEvent("swing", { player: p });
        }
        p.airborne = car.pos.y > C.jumpClear;
      });

      // Car-vs-car bumps (shared physics), then walls again in case a bump
      // pushed someone into one.
      TP.Car.collideAll(this.cars, this.tuning);
      this.cars.forEach((car) => { if (!car.out) this._keepCarInArena(car); });
    }

    // The car physics asks for the floor height: it's flat everywhere.
    groundHeightAt() { return 0; }

    // Walls bounce cars back softly; pillars push them out of the way.
    _keepCarInArena(car) {
      const C = this.cfg;
      const limX = C.arenaW / 2 - car.radius, limZ = C.arenaD / 2 - car.radius;
      if (car.pos.x > limX) { car.pos.x = limX; car.vel.x = -Math.abs(car.vel.x) * 0.4; }
      if (car.pos.x < -limX) { car.pos.x = -limX; car.vel.x = Math.abs(car.vel.x) * 0.4; }
      if (car.pos.z > limZ) { car.pos.z = limZ; car.vel.z = -Math.abs(car.vel.z) * 0.4; }
      if (car.pos.z < -limZ) { car.pos.z = -limZ; car.vel.z = Math.abs(car.vel.z) * 0.4; }
      for (const pl of this.pillars) {
        const dx = car.pos.x - pl.x, dz = car.pos.z - pl.z;
        const d = Math.hypot(dx, dz), minD = pl.r + car.radius * 0.9;
        if (d >= minD || d < 1e-4) continue;
        const nx = dx / d, nz = dz / d;
        car.pos.x = pl.x + nx * minD;
        car.pos.z = pl.z + nz * minD;
        // Remove the part of the velocity heading into the pillar.
        const vn = car.vel.x * nx + car.vel.z * nz;
        if (vn < 0) { car.vel.x -= nx * vn * 1.4; car.vel.z -= nz * vn * 1.4; }
      }
    }

    /* =====================================================================
       Ball: serving, moving, bouncing, being hit, KOing
       ===================================================================== */
    _stepBall(dt) {
      const C = this.cfg, b = this.ball;

      // Serving: the ball waits in the middle, harmless, then goes live
      // with a slow random drift.
      if (this.state === "serve") {
        this.serveTimer -= dt;
        if (this.serveTimer <= 0) {
          this.state = "play";
          const a = rand(0, Math.PI * 2);
          b.vel.set(Math.sin(a) * C.serveDrift, 0, Math.cos(a) * C.serveDrift);
          b.speed = C.serveDrift;
        }
        return;
      }

      // Stalemate: nobody has hit it for too long → serve again.
      this.noHitTime += dt;
      if (this.noHitTime >= C.stalemateTime) {
        this.onEvent("stalemate");
        this._serve();
        return;
      }

      // Move in small sub-steps (never more than half the ball's radius at
      // a time) so even a max-speed ball can't skip through a car, a
      // pillar or a wall between two checks.
      const travel = b.speed * dt;
      const n = Math.max(1, Math.ceil(travel / (C.ballR * 0.5)));
      const sub = dt / n;
      for (let s = 0; s < n; s++) {
        // A swing that reaches the ball wins over the ball reaching you:
        // that's the whole game (deflect it before it touches you).
        if (this._tryHits()) return;
        b.pos.x += b.vel.x * sub;
        b.pos.z += b.vel.z * sub;
        this._bounceBall();
        if (this._checkKOs()) return;
      }
    }

    // A bounce happened: tell the hooks, and flash the wall in the arena
    // look (in the ball owner's colour) if it supports that.
    _bounced(normal) {
      const b = this.ball;
      const pos = b.pos.clone();
      this.hooks.onWallBounce(pos, normal);
      if (this.arenaLook && typeof this.arenaLook.flashWall === "function") {
        this.arenaLook.flashWall(pos, normal, b.owner === null ? "#ffffff" : this.players[b.owner].css);
      }
    }

    // Walls and pillars: perfect bounces (no speed lost). Normals point
    // back into the arena.
    _bounceBall() {
      const C = this.cfg, b = this.ball;
      const limX = C.arenaW / 2 - C.ballR, limZ = C.arenaD / 2 - C.ballR;
      if (b.pos.x > limX) { b.pos.x = limX; b.vel.x = -Math.abs(b.vel.x); this._bounced({ x: -1, z: 0 }); }
      if (b.pos.x < -limX) { b.pos.x = -limX; b.vel.x = Math.abs(b.vel.x); this._bounced({ x: 1, z: 0 }); }
      if (b.pos.z > limZ) { b.pos.z = limZ; b.vel.z = -Math.abs(b.vel.z); this._bounced({ x: 0, z: -1 }); }
      if (b.pos.z < -limZ) { b.pos.z = -limZ; b.vel.z = Math.abs(b.vel.z); this._bounced({ x: 0, z: 1 }); }
      for (const pl of this.pillars) {
        const dx = b.pos.x - pl.x, dz = b.pos.z - pl.z;
        const d = Math.hypot(dx, dz), minD = pl.r + C.ballR;
        if (d >= minD || d < 1e-4) continue;
        const nx = dx / d, nz = dz / d;
        b.pos.x = pl.x + nx * minD;
        b.pos.z = pl.z + nz * minD;
        // Mirror the velocity off the pillar's surface.
        const vn = b.vel.x * nx + b.vel.z * nz;
        if (vn < 0) {
          b.vel.x -= 2 * vn * nx;
          b.vel.z -= 2 * vn * nz;
          this._bounced({ x: nx, z: nz });
        }
      }
    }

    // Does any active swing reach the ball? The closest swinging car gets it.
    // Only ONE hit can happen at a time: see _hit() for how the other
    // swingers are handled, and rehitLock for the short lockout after it.
    _tryHits() {
      const C = this.cfg, b = this.ball;
      if (this.time < b.lockUntil) return false;
      let best = -1, bestD = Infinity;
      this.players.forEach((p, i) => {
        if (p.out || p.dead > 0 || p.swingT <= 0 || p.swingHit) return;
        const car = this.cars[i];
        const d = dist2D(car.pos.x, car.pos.z, b.pos.x, b.pos.z);
        if (d <= C.hitRange && d < bestD) { best = i; bestD = d; }
      });
      if (best < 0) return false;
      this._hit(best);
      return true;
    }

    _hit(i) {
      const C = this.cfg, b = this.ball, p = this.players[i], car = this.cars[i];

      // New speed: base speed off a serve, otherwise a step faster.
      let speed = b.neutral ? C.baseSpeed : Math.min(C.maxSpeed, b.speed + C.speedStep);

      // Smash: hitting while boosting, with enough boost to pay for it.
      const smash = car.boosting && car.boost >= C.smashBoostCost;
      if (smash) {
        speed = Math.min(C.maxSpeed, speed + C.smashBonus);
        car.boost -= C.smashBoostCost;
      }

      // Direction: where the car faces, bent by steering. Steering right
      // (+1) lowers the heading (see car.js), so the bend is subtracted.
      const bend = (C.aimBendDeg * Math.PI) / 180;
      const h = car.heading - clamp(p.lastSteer, -1, 1) * bend;
      b.vel.set(Math.sin(h) * speed, 0, Math.cos(h) * speed);
      b.speed = speed;
      b.owner = i;
      b.neutral = false;
      b.hits++;
      b.hitId++;
      b.lastHitT = this.time;
      this.noHitTime = 0;

      p.swingHit = true;
      p.swingT = 0;
      p.cooldown = C.hitCooldown;
      p.hits++;

      // Several cars swinging at the same ball at the same moment (say,
      // everyone at the opening serve) is ONE hit: the closest swinger
      // wins it, and everyone else's swing that could reach the ball is
      // used up (no miss penalty, they were simply beaten to it).
      // Without this, their still-running swings would hit it again on
      // the next steps and stack the speed. A short lockout covers any
      // swing that starts in the instant after.
      this.players.forEach((q, j) => {
        if (j === i || q.swingT <= 0 || q.swingHit) return;
        const c = this.cars[j];
        if (dist2D(c.pos.x, c.pos.z, b.pos.x, b.pos.z) <= C.hitRange + 0.5) {
          q.swingT = 0;
          q.swingHit = true;
          q.cooldown = C.hitCooldown;
        }
      });
      b.lockUntil = this.time + C.rehitLock;

      // The hit-freeze: faster ball → longer pause.
      const frac = clamp((speed - C.baseSpeed) / (C.maxSpeed - C.baseSpeed), 0, 1);
      this.freezeLeft = lerp(C.freezeMin, C.freezeMax, frac);

      this.hooks.onHit(car, b, frac, smash);
      this.onEvent("hit", { player: p, speed, frac, smash });
    }

    // Does the ball touch anyone who isn't its owner?
    _checkKOs() {
      const C = this.cfg, b = this.ball;
      if (b.neutral) return false; // a neutral ball is harmless
      const victims = [];
      this.players.forEach((p, i) => {
        if (p.out || p.dead > 0 || i === b.owner || p.invuln > 0) return;
        const car = this.cars[i];
        if (car.pos.y > C.jumpClear) return; // jumped over it
        const d = dist2D(car.pos.x, car.pos.z, b.pos.x, b.pos.z);
        if (d < C.koReach + C.ballR) victims.push(i);
      });
      if (!victims.length) return false;

      const owner = b.owner;
      for (const i of victims) this._ko(i, owner);

      // Last car standing? (If somehow nobody is left, the last hitter
      // wins: Reece's double-KO rule.)
      const alive = this.players.filter((p) => !p.out);
      if (alive.length <= 1) {
        this._endMatch(alive.length ? alive[0].index : owner);
      } else {
        this.freezeLeft = C.koFreeze;
        this._serve();
      }
      return true;
    }

    _ko(i, ownerIdx) {
      const C = this.cfg, p = this.players[i], car = this.cars[i];
      const owner = this.players[ownerIdx];
      p.lives = Math.max(0, p.lives - 1);
      if (owner) owner.kos++;
      this.koLog.push({ t: +this.time.toFixed(2), victim: i, owner: ownerIdx, speed: +this.ball.speed.toFixed(1) });

      const ownerCar = owner ? this.cars[ownerIdx] : null;
      this.hooks.onKO(car, ownerCar);
      this.onEvent("ko", { victim: p, owner, speed: this.ball.speed });

      // Off the field either for good or until respawn. `car.out` makes
      // the shared car code skip it (no driving, no bumping).
      p.swingT = 0;
      car.out = true;
      car.mesh.visible = false;
      if (p.lives <= 0) {
        p.out = true;
        this.outOrder.push(i);
      } else {
        p.dead = C.respawnDelay;
      }
    }

    _respawn(i) {
      const p = this.players[i], car = this.cars[i];
      const s = spawnSpot(i);
      p.dead = 0;
      p.invuln = this.cfg.respawnInvuln;
      p.prevHit = true; // a held Hit button doesn't swing the instant you appear
      car.out = false;
      car.boost = 100;
      car.placeAt(s.x, s.z, s.heading);
      car.mesh.visible = true;
      this.hooks.onRespawn(car);
      this.onEvent("respawn", { player: p });
    }

    // Put the ball back in the middle as a neutral serve.
    _serve(first = false) {
      const b = this.ball;
      b.pos.set(0, this.cfg.ballY, 0);
      b.vel.set(0, 0, 0);
      b.speed = 0;
      b.owner = null;
      b.neutral = true;
      b.hits = 0;
      this.state = "serve";
      this.serveTimer = this.cfg.serveDelay;
      this.noHitTime = 0;
      this.hooks.onServe();
      if (!first) this.onEvent("serve");
    }

    _endMatch(winnerIdx) {
      this.state = "over";
      this.winner = winnerIdx;
      this.freezeLeft = 0;
      // Standings: winner first, then everyone else, last knocked out first.
      const order = [winnerIdx, ...this.outOrder.slice().reverse().filter((k) => k !== winnerIdx)];
      for (const p of this.players) if (!order.includes(p.index)) order.push(p.index);
      const w = this.players[winnerIdx];
      this.result = {
        winner: winnerIdx,
        winnerName: w ? w.name : "",
        winnerCss: w ? w.css : "",
        duration: +this.time.toFixed(1),
        standings: order.map((idx, k) => {
          const p = this.players[idx];
          return { place: k + 1, index: idx, seat: p.seat, name: p.name, css: p.css, lives: p.lives, livesLeft: p.lives, kos: p.kos, hits: p.hits };
        }),
        koLog: this.koLog.slice(),
      };
      this.hooks.onMatchEnd(this.result);
      this.onEvent("end", this.result);
    }

    // After the match: let the winner roll to a stop.
    _coastToStop(dt) {
      this.cars.forEach((car) => {
        if (car.out) return;
        const k = Math.exp(-5 * dt);
        car.vel.x *= k;
        car.vel.z *= k;
        car.update(dt, TP.Input.NEUTRAL, this, this.tuning);
        this._keepCarInArena(car);
      });
    }

    /* =====================================================================
       Bots. They return the same control shape a human controller gives:
       { throttle, steer, boost, jump, hit }.

       Plan, in order:
         1. Neutral ball (or a serve coming): race for it, hit it toward
            the nearest opponent.
         2. Any ball within reach that I can handle: swing at it, aimed at
            the nearest opponent (re-hitting my own ball speeds it up).
         3. My own ball otherwise: it can't hurt me, so keep clear.
         4. An enemy's ball heading my way: after a short reaction delay,
            either face it and time a swing (if it's slow enough for this
            bot's skill), or jump over it at the last moment. Faster balls
            are more likely to be misread.
         5. An enemy ball that isn't coming at me: go after it if it's
            slow enough to handle, otherwise keep a safe distance.
       ===================================================================== */
    _botControls(i) {
      const C = this.cfg, b = this.ball, p = this.players[i], car = this.cars[i], S = this.bots[i];
      const bx = b.pos.x, bz = b.pos.z;
      const dist = dist2D(car.pos.x, car.pos.z, bx, bz);
      const canSwing = p.swingT <= 0 && p.cooldown <= 0;

      // 1) Neutral ball: go get it.
      if (b.neutral) {
        const ctrl = TP.ai.driveTo(car, bx, bz, { boostDist: 12 });
        ctrl.hit = false;
        if (this.state === "play" && canSwing && dist < C.hitRange * 0.85) {
          ctrl.hit = true;
          ctrl.steer = this._botAim(i);
          ctrl.boost = car.boost > C.smashBoostCost + 10 && Math.random() < 0.35; // sometimes smash
        }
        return ctrl;
      }

      // 2) Close enough to swing at, and slow enough to handle: hit it on.
      const handle = b.speed <= S.maxReturn;
      if (this.state === "play" && canSwing && handle && dist < C.hitRange * 0.8) {
        const ctrl = TP.ai.driveTo(car, bx, bz, { boostDist: 99 });
        ctrl.hit = true;
        ctrl.steer = this._botAim(i);
        return ctrl;
      }

      // 3) My own ball: it passes through me, so just stay out of the way.
      if (b.owner === i) return this._botIdle(i);

      // 4) An enemy ball. Is it coming at me? Straight-line guess: when is
      //    it closest to me, and how close does it get?
      const rx = car.pos.x - bx, rz = car.pos.z - bz;
      const v2 = b.vel.x * b.vel.x + b.vel.z * b.vel.z || 1;
      const tClose = (rx * b.vel.x + rz * b.vel.z) / v2;
      const cx = rx - b.vel.x * tClose, cz = rz - b.vel.z * tClose;
      const missBy = Math.hypot(cx, cz);
      const threat = tClose > 0 && tClose < 1.6 && missBy < C.koReach + C.ballR + 1.2;
      const reacted = this.time - b.lastHitT >= S.reaction;

      if (!threat || !reacted || p.invuln > 0.3) {
        // 5) Not coming at me. Chase it down if I can handle it, else keep clear.
        if (handle && b.speed < S.maxReturn * 0.8 && p.invuln <= 0) {
          const ctrl = TP.ai.driveTo(car, ...this._inside(bx, bz), { boostDist: 10 });
          ctrl.hit = false;
          return ctrl;
        }
        return this._botIdle(i);
      }

      // Decide once per shot: hit it back, jump it, or misread it. The
      // faster the ball, the likelier a misread.
      if (S.planFor !== b.hitId) {
        S.planFor = b.hitId;
        const frac = clamp((b.speed - C.baseSpeed) / (C.maxSpeed - C.baseSpeed), 0, 1);
        S.plan = Math.random() < S.fumble + S.fumbleFast * frac ? "fumble" : handle ? "return" : "dodge";
      }

      const ctrl = { throttle: 0, steer: 0, boost: false, jump: false, hit: false };
      if (S.plan === "return") {
        // Turn to face the ball (returns go back the way it came), roll
        // gently, and swing just before it reaches hitting range.
        const diff = TP.ai.angleTo(car, bx, bz);
        ctrl.steer = clamp(-diff * 3, -1, 1);
        ctrl.throttle = Math.abs(diff) < 0.6 ? 0.25 : 0;
        const tToRange = (dist - C.hitRange * 0.8) / Math.max(1, b.speed);
        if (canSwing && tToRange <= S.swingLead) {
          ctrl.hit = true;
          ctrl.steer = clamp(rand(-1, 1) * (S.aimNoise / C.aimBendDeg), -1, 1);
        }
        return ctrl;
      }
      if (S.plan === "dodge") {
        // Drive sideways out of its path, and jump right before impact.
        const side = cx * b.vel.z - cz * b.vel.x >= 0 ? 1 : -1;
        const len = Math.sqrt(v2);
        const tx = car.pos.x + (-b.vel.z / len) * side * 8;
        const tz = car.pos.z + (b.vel.x / len) * side * 8;
        const dctrl = TP.ai.driveTo(car, ...this._inside(tx, tz), { boostDist: 99 });
        const tImpact = (dist - (C.koReach + C.ballR)) / Math.max(1, b.speed);
        dctrl.jump = car.onGround && tImpact <= S.jumpLead;
        dctrl.hit = false;
        return dctrl;
      }
      return this._botIdle(i); // fumble: carries on as if nothing's coming
    }

    // Steering that bends a hit toward the nearest opponent (plus a little
    // sloppiness so bots aren't perfect).
    _botAim(i) {
      const C = this.cfg, car = this.cars[i], S = this.bots[i];
      let target = null, best = Infinity;
      this.players.forEach((q, j) => {
        if (j === i || q.out || q.dead > 0) return;
        const d = dist2D(car.pos.x, car.pos.z, this.cars[j].pos.x, this.cars[j].pos.z);
        if (d < best) { best = d; target = this.cars[j]; }
      });
      const bend = (C.aimBendDeg * Math.PI) / 180;
      let steer = 0;
      if (target) steer = -TP.ai.angleTo(car, target.pos.x, target.pos.z) / bend;
      steer += rand(-1, 1) * (S.aimNoise / C.aimBendDeg);
      return clamp(steer, -1, 1);
    }

    // Wander to a spot away from the ball, staying off the walls.
    _botIdle(i) {
      const car = this.cars[i], b = this.ball;
      let dx = car.pos.x - b.pos.x, dz = car.pos.z - b.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      dx /= d; dz /= d;
      const [tx, tz] = this._inside(car.pos.x + dx * 6, car.pos.z + dz * 6);
      const ctrl = TP.ai.driveTo(car, tx, tz, { arrive: 5, boostDist: 99 });
      ctrl.hit = false;
      return ctrl;
    }

    // Clamp a target point to the arena, with a margin from the walls.
    _inside(x, z) {
      const C = this.cfg, m = 5;
      return [clamp(x, -C.arenaW / 2 + m, C.arenaW / 2 - m), clamp(z, -C.arenaD / 2 + m, C.arenaD / 2 - m)];
    }

    /* =====================================================================
       Drawing (every frame). Placeholder visuals only; Art replaces or
       dresses these through hooks and TP.DuelArena.
       ===================================================================== */
    animate(dt) {
      const C = this.cfg, b = this.ball;
      this.ballMesh.position.copy(b.pos);
      // The ball glows its owner's colour; white when neutral. It blinks
      // while waiting to be served.
      const color = b.owner === null ? 0xffffff : TP.PLAYER_COLORS[this.players[b.owner].seat];
      this.ballMesh.material.color.setHex(color);
      this.ballMesh.material.emissive.setHex(color);
      this.ballMesh.visible = this.state !== "serve" || this.countdown > 0 || Math.floor(this.serveTimer * 8) % 2 === 0;

      const blink = Math.floor(performance.now() / 80) % 2 === 0;
      this.players.forEach((p, i) => {
        const car = this.cars[i];
        if (!p.out && p.dead <= 0) car.mesh.visible = p.invuln > 0 ? blink : true;
        car.syncMesh(dt);
        const ring = car.mesh.userData.swingRing;
        if (ring) {
          ring.visible = p.swingT > 0;
          ring.material.opacity = 0.65 * (p.swingT / C.swingTime);
        }
      });
      if (this.arenaLook && typeof this.arenaLook.update === "function") this.arenaLook.update(dt);
    }

    _makeSwingRing(seat) {
      const R = this.cfg.hitRange;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(R - 0.25, R, 40),
        new THREE.MeshBasicMaterial({ color: TP.PLAYER_COLORS[seat], transparent: true, opacity: 0.6, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.08;
      ring.visible = false;
      ring.name = "swingRing";
      return ring;
    }

    // Plain floor, walls and pillars, used only when Art's TP.DuelArena isn't loaded.
    _buildPlaceholderArena() {
      const C = this.cfg, W = C.arenaW, D = C.arenaD, T = 1;
      const floor = new THREE.Mesh(
        new THREE.BoxGeometry(W, 1, D),
        new THREE.MeshStandardMaterial({ color: 0x1c2550, roughness: 0.9 })
      );
      floor.position.y = -0.5;
      floor.receiveShadow = true;
      this.scene.add(floor);
      const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a4687, transparent: true, opacity: 0.85 });
      const wall = (w, d, x, z) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, C.wallH, d), wallMat);
        m.position.set(x, C.wallH / 2, z);
        m.castShadow = true;
        this.scene.add(m);
      };
      wall(W + 2 * T, T, 0, -(D / 2 + T / 2));
      wall(W + 2 * T, T, 0, D / 2 + T / 2);
      wall(T, D, -(W / 2 + T / 2), 0);
      wall(T, D, W / 2 + T / 2, 0);
      const pillarMat = new THREE.MeshStandardMaterial({ color: 0x8a93c9, roughness: 0.5 });
      for (const pl of this.pillars) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(pl.r, pl.r, C.wallH + 0.6, 28), pillarMat);
        m.position.set(pl.x, (C.wallH + 0.6) / 2, pl.z);
        m.castShadow = true;
        this.scene.add(m);
      }
    }

    /* =====================================================================
       Test hooks (QC drives these; main.js only exposes them in ?demo/?test)
       ===================================================================== */

    // Force player i's controls ({ throttle, steer, boost, jump, hit });
    // pass null to hand control back to the human or bot.
    setInput(i, ctrl) {
      this.inputOverride[i] = ctrl ? Object.assign({ throttle: 0, steer: 0, boost: false, jump: false, hit: false }, ctrl) : null;
    }

    // Turn player i into a bot (true) or take the bot away (false: the
    // player then reads its controller, or setInput).
    setBot(i, on) {
      this.bots[i] = on ? makeBotSkill() : null;
      if (on) this.players[i].controller = "bot";
    }

    // Put car i at {x, z} facing headingRad (0 = facing +Z).
    placeCar(i, pos, headingRad = 0) {
      this.cars[i].placeAt(pos.x, pos.z, headingRad);
    }

    // Put the ball anywhere: { pos: {x, z}, vel: {x, z}, owner: index or null }.
    // The ball goes live at once (a waiting serve is skipped).
    setBall({ pos, vel, owner = null } = {}) {
      const b = this.ball;
      if (pos) b.pos.set(pos.x, this.cfg.ballY, pos.z);
      if (vel) b.vel.set(vel.x, 0, vel.z);
      b.speed = Math.hypot(b.vel.x, b.vel.z);
      b.owner = owner;
      b.neutral = owner === null;
      b.hitId++;
      b.lastHitT = this.time;
      this.noHitTime = 0;
      if (this.state === "serve") { this.state = "play"; this.serveTimer = 0; }
    }

    /* =====================================================================
       For tests: a plain copy of the readable state (safe to JSON.stringify).
       ===================================================================== */
    snapshot() {
      const v = (p) => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) });
      const b = this.ball;
      return {
        state: this.state,
        countdown: +this.countdown.toFixed(2),
        time: +this.time.toFixed(2),
        freezeLeft: +this.freezeLeft.toFixed(3),
        winner: this.winner,
        koLog: this.koLog.slice(),
        ball: { pos: v(b.pos), vel: v(b.vel), speed: +b.speed.toFixed(1), owner: b.owner, neutral: b.neutral, hits: b.hits },
        players: this.players.map((p) => ({
          name: p.name, seat: p.seat, css: p.css, controller: p.controller,
          lives: p.lives, out: p.out, invuln: +p.invuln.toFixed(2), dead: +p.dead.toFixed(2),
          swingT: +p.swingT.toFixed(3), cooldown: +p.cooldown.toFixed(2),
          pos: v(p.pos), airborne: p.airborne, kos: p.kos, hits: p.hits,
        })),
      };
    }

    dispose() {
      if (this.arenaLook && typeof this.arenaLook.dispose === "function") this.arenaLook.dispose();
      TP.disposeScene(this.scene);
      if (TP.duel === this) TP.duel = null;
    }
  }

  TP.Duel = Duel;
})();
