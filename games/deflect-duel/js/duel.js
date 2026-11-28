/* =====================================================================
   duel.js — the rules of Deflect Duel (v2, see DESIGN.md): a closed 3D
   arena box, a ball that is either NEUTRAL (gravity, bounces, rolls) or
   OWNED (flies dead straight, KOs anyone but its owner), strikes aimed
   up / straight / down, bunts, clashes, lives and respawns, the
   hit-freeze, the stalemate reset, and the bots.

   How a match works, in plain English:
     • The arena is a box: floor, four walls and a ceiling. Two round
       pillars (optional) run from floor to ceiling.
     • The ball is served from the middle at about head height. A
       neutral ball (white) falls, bounces, loses a little speed each
       bounce and rolls. It can't hurt anyone.
     • STRIKE: press Hit to swipe for a moment (swingTime). If the ball
       is within hitRange of your car during the swipe, it becomes YOURS
       and flies in a dead-straight line in the direction you aimed:
         - the way the car faces,
         - angled up (Up / W held) or down (Down / S held) about 35°,
         - bent left/right by steering, up to about 25°.
       The first strike on a neutral ball sends it at baseSpeed; each
       later strike adds speedStep, up to maxSpeed. Striking while
       boosting is a SMASH: extra speed for a chunk of boost.
     • An OWNED ball keeps its speed and bounces cleanly off every
       surface. It passes through its owner, but if it touches ANYONE
       ELSE (true 3D: the ball sphere against the car's body box), they
       lose a life. Jumping over it works if you really are higher.
     • COOL-DOWN: if nobody strikes an owned ball for ownedHold seconds,
       gravity eases back in over ownedFade seconds and it slows; then
       it's neutral again. (Still owned, so still dangerous, while it
       cools.)
     • BUMP: driving into a neutral ball pushes it like a real ball. A
       hard enough bump makes you its owner at baseSpeed, but it stays a
       gravity ball (it doesn't fly straight). Bumps never change an
       owned ball: an owned ball either passes through you (yours) or
       KOs you (anyone else's).
     • BUNT (a "flip reset"): touching the ball with the car's UNDERSIDE
       (its wheels, usually landing on it from above) pops the ball gently
       up and slows it (buntKeep of its speed tier). The toucher keeps or
       takes ownership, there's no hit-freeze, and the car gets its jump
       and flip back (car.resetAirMoves(), when the shared car has it).
       It isn't a button: Hit in the air with no direction held is just a
       normal straight strike.
     • CLASH: two different cars striking the ball within clashWindow of
       each other. Both strikers bounce away, the ball stops where it is,
       and its owner goes back to whoever had it before.
     • Each strike pauses the action for a split second (hit-freeze).
       After a KO the ball is re-served; the KO'd car respawns after a
       moment, blinking and invulnerable. At 0 lives you're out. Last car
       standing wins. No strike for stalemateTime seconds → re-serve.

   Who uses what:
     • main.js creates a TP.Duel, calls duel.update(dt) every frame and
       draws duel.scene with duel.camera.
     • Art and UI dress things up through duel.hooks and the optional
       TP.DuelArena.build() for the arena's look.
     • QC reads window.TP.duel (this object) or TP.duel.snapshot(), and
       drives tests with setInput / setBot / placeCar / setBall.

   Axes: X runs along the 44-unit side, Z along the 28-unit side, Y is up.
   The serve spot is (0, serveY, 0). Inner wall faces are at x = ±arenaW/2
   and z = ±arenaD/2, the floor at y = 0 and the ceiling at y = arenaH.

   The rules run on a FIXED time step (1/120 s), whatever the frame rate.
   update(dt) just feeds time into that fixed step, so a test can call
   update() directly with any dt and get the same game.
   ===================================================================== */
(function () {
  "use strict";
  const { clamp, lerp, dist2D, rand } = TP.util;
  const DEG = Math.PI / 180;

  /* =====================================================================
     Every tunable number, in one place. Art and QC read these too, so
     the names are part of the team's agreed interface.
     ===================================================================== */
  TP.DUEL_CFG = {
    /* ---------- Arena (a closed box) ---------- */
    arenaW: 44,          // width along X
    arenaD: 28,          // depth along Z
    arenaH: 14,          // ceiling height along Y
    wallH: 2.2,          // how tall the walls are DRAWN (the real walls go up to the ceiling)
    pillars: true,       // two round floor-to-ceiling pillars (false = open arena)
    pillarList: [        // centre and radius of each pillar
      { x: 0, z: -7.5, r: 1.8 },
      { x: 0, z: 7.5, r: 1.8 },
    ],

    /* ---------- Ball: general ---------- */
    ballR: 0.75,         // ball radius (small enough that a well-timed jump clears a ball on the floor)
    serveY: 3.0,         // serve height (about head height)
    ballY: 3.0,          // old name for serveY, kept for anything still reading it
    serveDrift: 2,       // a served ball gets a tiny random sideways nudge

    /* ---------- Ball: neutral (gravity) ---------- */
    gravity: 24,         // pull on a neutral ball (the car's is 28)
    bounce: 0.7,         // share of speed a neutral ball keeps per bounce
    rollDrag: 0.5,       // how fast a ball rolling on the floor slows down
    restSpeed: 1.5,      // a floor bounce slower than this just stops bouncing (rolls)

    /* ---------- Ball: owned (straight lines) and cool-down ---------- */
    baseSpeed: 16,       // first strike on a neutral ball (under the car's 17, so you can chase it)
    speedStep: 2.5,      // added by every later strike
    maxSpeed: 56,        // top speed, whatever happens
    smashBonus: 8,       // extra speed for a Smash (strike while boosting)
    smashBoostCost: 30,  // boost a Smash costs (out of 100). Not enough boost = normal strike.
    ownedHold: 3,        // seconds an owned ball flies straight with no strike...
    ownedFade: 1.5,      // ...then over this long gravity eases back in and it slows, then it's neutral
    coolDrag: 1.2,       // how hard a cooling ball slows down

    /* ---------- Striking ---------- */
    hitRange: 3.6,       // car centre to ball centre (3D) for a strike to connect
    swingTime: 0.28,     // how long one swipe can connect
    missCooldown: 0.45,  // wait after a swipe that hit nothing
    hitCooldown: 0.12,   // short wait after a swipe that connected
    rehitLock: 0.1,      // after a clash, nobody can strike the ball for this long
    angleUpDeg: 35,      // strike angle with Up held
    angleDownDeg: 35,    // strike angle with Down held
    aimBendDeg: 25,      // full steering bends the shot this many degrees sideways
    aimDeadzone: 0.5,    // stick/keys past this count as "held" for up/down aim
    flipBonus: 4,        // extra speed for a flip strike (Stage B, when the shared car can flip)

    /* ---------- Bunt (wheels touch the ball: a flip reset) ---------- */
    buntKeep: 0.6,       // share of the speed tier the ball remembers
    buntUp: 6,           // how high the bunt pops the ball
    buntHold: 2.5,       // how long a bunted ball stays yours before it goes neutral
    buntCooldown: 0.6,   // the same car can't bunt again for this long
    buntWheelbase: 0.95, // contact must be within this share of the car's underside (on the wheels)

    /* ---------- Clash ---------- */
    clashWindow: 0.1,    // two strikes this close together (game seconds) clash
    clashPush: 14,       // how hard the two strikers are knocked away
    clashFreeze: 0.25,   // pause on a clash

    /* ---------- Bumps (driving into a neutral ball) ---------- */
    bumpRestitution: 0.6,// how springy a car is to the ball
    bumpCarry: 0.35,     // share of the car's own velocity the ball picks up
    bumpLift: 3,         // a little upward pop on a bump
    bumpOwnMin: 6,       // impact speed needed for a bump to take ownership
    bumpGrace: 0.3,      // a freshly bumped ball can't KO anyone for this long

    /* ---------- The car's body box (for KOs and bumps) ---------- */
    carHalfW: 0.95,      // half its width
    carHalfL: 1.75,      // half its length
    carOffZ: 0.15,       // box centre is this far ahead of the car's position
    carH: 1.4,           // height from the wheels to the roof
    strikeY: 0.7,        // height of the car's "strike centre" above its wheels

    /* ---------- Timers (seconds) ---------- */
    freezeMin: 0.04,     // hit-freeze at base speed
    freezeMax: 0.3,      // hit-freeze at max speed
    koFreeze: 0.35,      // pause when someone is KO'd
    stalemateTime: 12,   // no strikes for this long → re-serve
    respawnDelay: 1.0,   // a KO'd car is gone this long before it respawns
    respawnInvuln: 2,    // then blinks, unhittable, for this long
    serveDelay: 1.2,     // ball holds still at the serve spot this long before it drops
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
      reaction: rand(0.08, 0.2),   // seconds before reacting to a new strike
      maxReturn: rand(28, 42),     // fastest ball it will try to strike back
      leadErr: 0.2,                // how far off its swing timing can be, per shot (seconds)
      lead: 0.08,                  // this shot's swing timing (re-rolled per shot)
      aimNoise: rand(4, 14),       // degrees of sloppiness in its aim
      swingLead: rand(0.04, 0.12), // how early it swings
      jumpLead: rand(0.3, 0.42),   // jump this long before impact (peak height ≈ 0.37 s)
      fumble: 0.12,                // chance it misreads a slow shot...
      fumbleFast: 0.4,             // ...plus this much more at max speed
      planFor: -1, plan: "",       // decision for the current shot
    };
  }

  /* ---------- Where each car starts (by player order, not seat) ----------
     The first two spots are diagonally opposite, so a 1v1 starts fair. */
  function spawnSpot(i, C) {
    const x = C.arenaW / 2 - 6, z = C.arenaD / 2 - 6;
    const spots = [[-x, z], [x, -z], [x, z], [-x, -z]];
    const [sx, sz] = spots[i % spots.length];
    return { x: sx, z: sz, heading: Math.atan2(-sx, -sz) }; // face the middle
  }

  /* ---------- How strongly gravity acts on the ball right now ----------
     0 = owned (dead straight), 1 = neutral (full gravity). While cooling
     it eases from where it started (coolK0) up to 1. */
  function gravityShare(b) {
    if (b.mode === "owned") return 0;
    if (b.mode === "cooling") return lerp(b.coolK0, 1, clamp(b.coolT / b.coolLen, 0, 1));
    return 1;
  }

  /* =====================================================================
     moveBall — the ball's flight for one small slice of time. A plain
     function (no game state) so the bots can run it ahead to predict
     where the ball will be.
       b         { pos, vel, mode, coolK0, coolT, coolLen }
       onBounce  optional (normal {x,y,z}, surface, impactSpeed) callback
     ===================================================================== */
  function moveBall(b, dt, C, pillars, onBounce) {
    const g = gravityShare(b);
    // A gravity ball loses some speed on each bounce; a straight-line
    // (owned) ball bounces perfectly. A cooling ball is in between.
    const rest = lerp(1, C.bounce, g);
    const R = C.ballR;
    const p = b.pos, v = b.vel;

    v.y -= C.gravity * g * dt;
    p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;

    // Floor.
    if (p.y < R) {
      p.y = R;
      if (v.y < 0) {
        const hitSpeed = -v.y;
        v.y = hitSpeed * rest;
        // Too slow to bounce again: it's rolling.
        if (g > 0 && v.y < C.restSpeed) v.y = 0;
        if (onBounce && hitSpeed > 1) onBounce({ x: 0, y: 1, z: 0 }, "floor", hitSpeed);
      }
    }
    // Rolling along the floor slows it down.
    if (g > 0 && p.y <= R + 1e-3 && Math.abs(v.y) < 1e-3) {
      const k = Math.exp(-C.rollDrag * g * dt);
      v.x *= k; v.z *= k;
    }
    // Ceiling.
    if (p.y > C.arenaH - R) {
      p.y = C.arenaH - R;
      if (v.y > 0) {
        const hitSpeed = v.y;
        v.y = -hitSpeed * rest;
        if (onBounce) onBounce({ x: 0, y: -1, z: 0 }, "ceiling", hitSpeed);
      }
    }
    // Walls.
    const limX = C.arenaW / 2 - R, limZ = C.arenaD / 2 - R;
    if (p.x > limX) { p.x = limX; if (v.x > 0) { const s = v.x; v.x = -s * rest; if (onBounce) onBounce({ x: -1, y: 0, z: 0 }, "wall", s); } }
    if (p.x < -limX) { p.x = -limX; if (v.x < 0) { const s = -v.x; v.x = s * rest; if (onBounce) onBounce({ x: 1, y: 0, z: 0 }, "wall", s); } }
    if (p.z > limZ) { p.z = limZ; if (v.z > 0) { const s = v.z; v.z = -s * rest; if (onBounce) onBounce({ x: 0, y: 0, z: -1 }, "wall", s); } }
    if (p.z < -limZ) { p.z = -limZ; if (v.z < 0) { const s = -v.z; v.z = s * rest; if (onBounce) onBounce({ x: 0, y: 0, z: 1 }, "wall", s); } }
    // Pillars (floor to ceiling, so only X/Z matter): mirror off the surface.
    for (const pl of pillars) {
      const dx = p.x - pl.x, dz = p.z - pl.z;
      const d = Math.hypot(dx, dz), minD = pl.r + R;
      if (d >= minD || d < 1e-4) continue;
      const nx = dx / d, nz = dz / d;
      p.x = pl.x + nx * minD;
      p.z = pl.z + nz * minD;
      const vn = v.x * nx + v.z * nz;
      if (vn < 0) {
        v.x -= (1 + rest) * vn * nx;
        v.z -= (1 + rest) * vn * nz;
        if (onBounce) onBounce({ x: nx, y: 0, z: nz }, "pillar", -vn);
      }
    }
  }

  /* =====================================================================
     TP.Duel — one match.
       opts.players   [{ seat, name, controller }]  seat 0..3 picks the colour
       opts.lives     3 or 5
       opts.onEvent   optional (name, data) callback for main.js (toasts, sounds)
       opts.pillars   optional true/false to override DUEL_CFG.pillars for this match
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
        onHit: NO_HOOK,        // (car, ball, speedFrac 0..1, smash, info { kind, angle, bend, aerial })
        onSwing: NO_HOOK,      // (car)
        onBunt: NO_HOOK,       // (car, ball)
        onClash: NO_HOOK,      // (carA, carB, ball)
        onKO: NO_HOOK,         // (victimCar, ownerCar)
        onBounce: NO_HOOK,     // (pos, normal {x,y,z}, surface "floor"|"wall"|"ceiling"|"pillar")
        onWallBounce: NO_HOOK, // (pos, normal {x,z}) — walls and pillars only (v1 hook, kept)
        onServe: NO_HOOK,      // ()
        onRespawn: NO_HOOK,    // (car)
        onMatchEnd: NO_HOOK,   // (result) — same object main.js gets
      };

      /* ---------- Scene and camera ---------- */
      this.scene = new THREE.Scene();
      // Placeholder camera: from one long side, raised and tilted, so the
      // ball's height reads. Art's broadcast camera can replace it.
      this.camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 400);
      this.camera.position.set(0, 24, 33);
      this.camera.lookAt(0, 2, 0);

      // The arena's look. Art's TP.DuelArena wins if it's loaded; it gets
      // the duel too, and may return hooks to install. Collisions never
      // come from these meshes, only from the config.
      this.arenaLook = null;
      if (TP.DuelArena && typeof TP.DuelArena.build === "function") {
        this.arenaLook = TP.DuelArena.build(this.scene, C, this) || null;
        if (this.arenaLook && this.arenaLook.hooks) Object.assign(this.hooks, this.arenaLook.hooks);
      } else {
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
        const s = spawnSpot(i, C);
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
          swingT: 0,             // seconds of swipe left (0 = not swinging)
          swingHit: false,       // has this swipe already connected?
          cooldown: 0,           // seconds before you can swipe again
          pos: car.pos,          // live position (THREE.Vector3; y = wheels' height)
          airborne: false,       // wheels off the ground
          kos: 0,                // KOs scored on others
          hits: 0,               // strikes landed (bunts included)
          bunts: 0,              // bunts landed
          clashes: 0,            // clashes taken part in
          prevHit: false,        // hit button state last step (edge detection)
          lastSteer: 0,          // steering this step (aim: bend)
          lastThrottle: 0,       // throttle this step (aim: up / down)
          buntReady: 0,          // match time from which this car can bunt again
          // Counted per-player events (for QC's fun checks).
          stats: { swings: 0, strikes: 0, strikesAir: 0, strikesUp: 0, strikesDown: 0, strikesFlip: 0, smashes: 0, clashes: 0, bunts: 0, bumps: 0 },
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
        pos: new THREE.Vector3(0, C.serveY, 0),
        vel: new THREE.Vector3(),
        speed: 0,        // current speed (length of vel)
        tier: 0,         // speed tier: what the next strike builds on (0 = neutral)
        mode: "neutral", // "neutral" | "owned" | "cooling"
        owner: null,     // index (into players[]) of the owner, or null when neutral
        neutral: true,   // same as mode === "neutral" (v1 field, kept)
        ownT: 0,         // seconds since an owned ball was last struck
        coolT: 0, coolLen: 1, coolK0: 0, // cooling progress (see gravityShare)
        safeUntil: 0,    // match time before which it can't KO anyone (fresh bump/bunt)
        hits: 0,         // strikes since the last serve
        hitId: 0,        // goes up on every strike (bots use it to spot a new shot)
        lastHitT: -99,   // match time of the last strike
        lockUntil: 0,    // match time before which nobody can strike it (after a clash)
      };
      this.ballMesh = new THREE.Mesh(
        new THREE.SphereGeometry(C.ballR, 28, 18),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 0.3 })
      );
      this.ballMesh.castShadow = true;
      this.scene.add(this.ballMesh);
      // Placeholder height helpers: a dark disc on the floor right under
      // the ball and a faint line up to it. (Art may replace or hide them.)
      this.ballShadow = new THREE.Mesh(
        new THREE.CircleGeometry(C.ballR, 24),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false })
      );
      this.ballShadow.rotation.x = -Math.PI / 2;
      this.scene.add(this.ballShadow);
      this.ballLine = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.04, 1, 6),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 })
      );
      this.scene.add(this.ballLine);

      /* ---------- Match state ---------- */
      this.state = "serve";        // "serve" | "play" | "over"
      this.countdown = opts.countdown ?? C.countdown; // nothing moves until this hits 0
      this.serveTimer = C.serveDelay;
      this.freezeLeft = 0;         // hit-freeze / KO / clash pause remaining
      this.noHitTime = 0;          // seconds since the last strike (stalemate clock)
      this.time = 0;               // match time (excludes countdown and freezes)
      this.winner = null;          // index (into players[]) of the winner once "over"
      this.koLog = [];             // { t, victim, owner, speed } per KO (player indexes)
      this.outOrder = [];          // player indexes in the order they were eliminated
      this.stats = { strikes: 0, aerialStrikes: 0, bunts: 0, clashes: 0, bumps: 0, stalemates: 0, swings: 0 };
      // Every counted event, in order: { t, type, player, ...details }.
      // Types: swing, strike, clash, bunt, bump, ko, stalemate.
      this.events = [];
      // Stalemates since the last KO. Bots get bolder as this grows (and
      // in a 1-v-1 endgame), so a match can't stall forever.
      this.stalemateStreak = 0;
      this.result = null;
      this.lastStrike = null;      // { i, t, before } — the last strike, for clash detection
      this._pred = null;           // cached ball prediction for the bots
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
       Cars: driving, swiping, walls, pillars, bumping
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

        // Swipe timer. A swipe that runs out without connecting is a
        // miss, and a miss costs you a short cooldown.
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

        // Start a swipe on the moment Hit goes down. We detect the press
        // ourselves (not with hitPressed) because several fixed steps can
        // run inside one frame and a press must only count once.
        const pressed = !!ctrl.hit && !p.prevHit;
        p.prevHit = !!ctrl.hit;
        p.lastSteer = ctrl.steer || 0;
        p.lastThrottle = ctrl.throttle || 0;
        if (pressed && p.swingT <= 0 && p.cooldown <= 0) {
          p.swingT = C.swingTime;
          p.swingHit = false;
          this.stats.swings++;
          p.stats.swings++;
          this._log("swing", i, { airborne: !car.onGround });
          this.hooks.onSwing(car);
          this.onEvent("swing", { player: p });
        }
        p.airborne = !car.onGround;
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
      // The ceiling (only reachable once cars can fly).
      if (car.pos.y > C.arenaH - C.carH) { car.pos.y = C.arenaH - C.carH; if (car.vel.y > 0) car.vel.y = 0; }
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

    /* ---------- Car body box ----------
       The car's body, as a box that turns with the car (heading only):
       carHalfW either side, carHalfL front and back around a centre
       carOffZ ahead of the car's position, from the wheels up carH.
       Returns the closest point of that box to point (px,py,pz), the
       distance to it, and the direction from the box to the point. */
    _carBox(car, px, py, pz) {
      const C = this.cfg;
      const fx = Math.sin(car.heading), fz = Math.cos(car.heading); // forward
      const rx = -fz, rz = fx;                                       // right-hand side
      const dx = px - car.pos.x, dz = pz - car.pos.z;
      // The point in the car's own frame (right, up, forward).
      const lx = dx * rx + dz * rz, ly = py - car.pos.y, lz = dx * fx + dz * fz;
      const qx = clamp(lx, -C.carHalfW, C.carHalfW);
      const qy = clamp(ly, 0, C.carH);
      const qz = clamp(lz, C.carOffZ - C.carHalfL, C.carOffZ + C.carHalfL);
      const ex = lx - qx, ey = ly - qy, ez = lz - qz;
      const d = Math.hypot(ex, ey, ez);
      let nx, ny, nz;
      if (d > 1e-6) {
        nx = (rx * ex + fx * ez) / d; ny = ey / d; nz = (rz * ex + fz * ez) / d;
      } else {
        // The point is inside the box: push it out the top.
        nx = 0; ny = 1; nz = 0;
      }
      return { d, nx, ny, nz, cx: car.pos.x + rx * qx + fx * qz, cy: car.pos.y + qy, cz: car.pos.z + rz * qx + fz * qz };
    }

    // Straight-line distance from a car's strike centre to the ball.
    _reach(car) {
      const b = this.ball.pos;
      return Math.hypot(b.x - car.pos.x, b.y - (car.pos.y + this.cfg.strikeY), b.z - car.pos.z);
    }

    /* =====================================================================
       Ball: serving, flying, bouncing, being struck, KOing
       ===================================================================== */
    _stepBall(dt) {
      const C = this.cfg, b = this.ball;

      // Serving: the ball holds still at the serve spot, then drops as a
      // neutral ball with a tiny random nudge.
      if (this.state === "serve") {
        this.serveTimer -= dt;
        if (this.serveTimer <= 0) {
          this.state = "play";
          const a = rand(0, Math.PI * 2);
          b.vel.set(Math.sin(a) * C.serveDrift, 0, Math.cos(a) * C.serveDrift);
        }
        b.speed = b.vel.length();
        return;
      }

      // Stalemate: nobody has struck it for too long → serve again.
      this.noHitTime += dt;
      if (this.noHitTime >= C.stalemateTime) {
        this.stats.stalemates++;
        this.stalemateStreak++;
        this._log("stalemate", null, { streak: this.stalemateStreak });
        this.onEvent("stalemate");
        this._serve();
        return;
      }

      // Owned → cooling → neutral timers.
      if (b.mode === "owned") {
        b.ownT += dt;
        if (b.ownT >= C.ownedHold) this._startCooling(0, C.ownedFade);
      } else if (b.mode === "cooling") {
        b.coolT += dt;
        // A ball fading out of straight-line flight also slows down.
        if (b.coolK0 === 0) b.vel.multiplyScalar(Math.exp(-C.coolDrag * gravityShare(b) * dt));
        if (b.coolT >= b.coolLen) this._goNeutral();
      }

      // Move in small sub-steps (never more than half the ball's radius at
      // a time) so even a max-speed ball can't skip through a car, a
      // pillar or a wall between two checks.
      const travel = b.vel.length() * dt;
      const n = Math.max(1, Math.ceil(travel / (C.ballR * 0.5)));
      const sub = dt / n;
      const onBounce = (normal, surface) => this._bounced(normal, surface);
      for (let s = 0; s < n; s++) {
        // A swipe that reaches the ball wins over the ball reaching you:
        // that's the whole game (strike it before it touches you).
        if (this._tryHits()) break;
        moveBall(b, sub, C, this.pillars, onBounce);
        if (this._checkKOs()) return;
        this._carContacts();
      }

      // Never faster than maxSpeed, whatever happened.
      const sp = b.vel.length();
      if (sp > C.maxSpeed) b.vel.multiplyScalar(C.maxSpeed / sp);
      b.speed = Math.min(sp, C.maxSpeed);
    }

    // A bounce happened: tell the hooks, and flash the wall in the arena
    // look (in the ball owner's colour) if it supports that.
    _bounced(normal, surface) {
      const b = this.ball;
      const pos = b.pos.clone();
      this.hooks.onBounce(pos, normal, surface);
      if (surface === "wall" || surface === "pillar") {
        const n2 = { x: normal.x, z: normal.z };
        this.hooks.onWallBounce(pos, n2);
        if (this.arenaLook && typeof this.arenaLook.flashWall === "function") {
          this.arenaLook.flashWall(pos, n2, b.owner === null ? "#ffffff" : this.players[b.owner].css);
        }
      }
    }

    _startCooling(k0, len) {
      const b = this.ball;
      b.mode = "cooling";
      b.coolK0 = k0;
      b.coolT = 0;
      b.coolLen = len;
    }

    _goNeutral() {
      const b = this.ball;
      b.mode = "neutral";
      b.neutral = true;
      b.owner = null;
      b.tier = 0;
    }

    /* ---------- Striking ---------- */

    // Does any active swipe reach the ball? The closest swiping car gets
    // it. A second car striking within clashWindow of the last strike
    // makes a clash instead.
    _tryHits() {
      const C = this.cfg, b = this.ball;
      if (this.time < b.lockUntil) return false;
      let best = -1, bestD = Infinity;
      this.players.forEach((p, i) => {
        if (p.out || p.dead > 0 || p.swingT <= 0 || p.swingHit) return;
        const d = this._reach(this.cars[i]);
        if (d <= C.hitRange && d < bestD) { best = i; bestD = d; }
      });
      if (best < 0) return false;
      const ls = this.lastStrike;
      if (ls && ls.i !== best && this.time - ls.t <= C.clashWindow) this._clash(ls, best);
      else this._strike(best);
      return true;
    }

    // Save what the ball was like before a strike (a clash puts it back).
    _ballBefore() {
      const b = this.ball;
      return { owner: b.owner, mode: b.mode, tier: b.tier, ownT: b.ownT, coolT: b.coolT, coolLen: b.coolLen, coolK0: b.coolK0, hits: b.hits };
    }

    _strike(i) {
      const C = this.cfg, b = this.ball, p = this.players[i], car = this.cars[i];
      const before = this._ballBefore();
      const aerial = !car.onGround;

      p.swingHit = true;
      p.swingT = 0;
      p.cooldown = C.hitCooldown;
      p.hits++;
      b.hits++;
      b.hitId++;
      b.lastHitT = this.time;
      this.noHitTime = 0;
      this.lastStrike = { i, t: this.time, before };
      this.stats.strikes++;
      if (aerial) this.stats.aerialStrikes++;

      /* ---------- Next speed tier, straight-line flight ---------- */
      const fromNeutral = b.mode === "neutral" || b.tier <= 0;
      let speed = fromNeutral ? C.baseSpeed : Math.min(C.maxSpeed, b.tier + C.speedStep);
      // Smash: striking while boosting, with enough boost to pay for it.
      // Not on the first touch of a neutral ball: off a serve it would
      // leave faster than a car can chase.
      const smash = !fromNeutral && car.boosting && car.boost >= C.smashBoostCost;
      if (smash) {
        speed = Math.min(C.maxSpeed, speed + C.smashBonus);
        car.boost -= C.smashBoostCost;
      }

      // Aim: up / straight / down from the throttle axis, bent sideways
      // by steering. Steering right (+1) lowers the heading (see car.js),
      // so the bend is subtracted.
      let angle = "straight", elev = 0;
      if (p.lastThrottle > C.aimDeadzone) { angle = "up"; elev = C.angleUpDeg * DEG; }
      else if (p.lastThrottle < -C.aimDeadzone) { angle = "down"; elev = -C.angleDownDeg * DEG; }
      const bend = clamp(p.lastSteer, -1, 1) * C.aimBendDeg;
      const h = car.heading - bend * DEG;
      const ch = Math.cos(elev);
      b.vel.set(Math.sin(h) * ch * speed, Math.sin(elev) * speed, Math.cos(h) * ch * speed);
      b.speed = speed;
      b.tier = speed;
      b.owner = i;
      b.mode = "owned";
      b.neutral = false;
      b.ownT = 0;
      b.safeUntil = 0;

      // The hit-freeze: faster ball → longer pause.
      const frac = clamp((speed - C.baseSpeed) / (C.maxSpeed - C.baseSpeed), 0, 1);
      this.freezeLeft = lerp(C.freezeMin, C.freezeMax, frac);

      const info = { kind: "strike", angle, bend: +bend.toFixed(1), aerial };
      p.stats.strikes++;
      if (aerial) p.stats.strikesAir++;
      if (angle === "up") p.stats.strikesUp++;
      if (angle === "down") p.stats.strikesDown++;
      if (smash) p.stats.smashes++;
      this._log("strike", i, { speed: +speed.toFixed(1), angle, aerial, flip: false, smash });
      this.hooks.onHit(car, b, frac, smash, info);
      this.onEvent("hit", { player: p, speed, frac, smash, info });
    }

    // Two cars struck within clashWindow: both bounce away, the ball stops
    // where it is and goes back to whoever owned it before the first strike.
    _clash(first, j) {
      const C = this.cfg, b = this.ball;
      const i = first.i;
      const was = first.before;
      b.owner = was.owner;
      b.mode = was.mode;
      b.neutral = was.mode === "neutral";
      b.tier = was.tier;
      b.ownT = 0;
      b.coolT = was.coolT; b.coolLen = was.coolLen; b.coolK0 = was.coolK0;
      b.hits = was.hits;
      b.hitId++;
      b.vel.set(0, 0, 0);
      b.speed = 0;
      b.lockUntil = this.time + C.rehitLock;
      this.noHitTime = 0;
      this.lastStrike = null;

      // Knock both strikers away from the ball.
      for (const k of [i, j]) {
        const car = this.cars[k], p = this.players[k];
        let dx = car.pos.x - b.pos.x, dz = car.pos.z - b.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        dx /= d; dz /= d;
        car.vel.x = dx * C.clashPush;
        car.vel.z = dz * C.clashPush;
        car.vel.y = Math.max(car.vel.y, 5);
        car.onGround = false;
        p.swingT = 0;
        p.swingHit = true;
        p.cooldown = C.hitCooldown;
        p.clashes++;
        p.stats.clashes++;
      }
      this._log("clash", i, { other: j });
      // Anyone else mid-swipe at this ball is part of the scrum: their
      // swipe is used up (no stacking a third strike on top).
      this.players.forEach((q, k) => {
        if (q.swingT > 0 && !q.swingHit && this._reach(this.cars[k]) <= C.hitRange + 0.5) {
          q.swingT = 0; q.swingHit = true; q.cooldown = C.hitCooldown;
        }
      });
      this.stats.clashes++;
      this.freezeLeft = C.clashFreeze;
      this.hooks.onClash(this.cars[i], this.cars[j], b);
      this.onEvent("clash", { a: this.players[i], b: this.players[j] });
    }

    /* ---------- Bunt: the car's wheels touch the ball ----------
       The "underside" is the car's down direction: -car.roof() when the
       shared car has full 3D orientation, otherwise straight down. The
       touch counts when the ball sphere meets the car's body box on that
       underside, inside the wheelbase. */
    _wheelsTouch(car) {
      const C = this.cfg, b = this.ball;
      const box = this._carBox(car, b.pos.x, b.pos.y, b.pos.z);
      if (box.d >= C.ballR) return false;
      // Which way is "down" for this car?
      let ux = 0, uy = -1, uz = 0;
      if (typeof car.roof === "function") {
        const r = car.roof();
        ux = -r.x; uy = -r.y; uz = -r.z;
      }
      // Direction from the car's middle to the ball.
      const mx = car.pos.x + Math.sin(car.heading) * C.carOffZ, my = car.pos.y + C.carH / 2, mz = car.pos.z + Math.cos(car.heading) * C.carOffZ;
      const dx = b.pos.x - mx, dy = b.pos.y - my, dz = b.pos.z - mz;
      const dl = Math.hypot(dx, dy, dz) || 1;
      if ((dx * ux + dy * uy + dz * uz) / dl < 0.6) return false; // not underneath
      // The contact must be on the underside itself (not a nose or side
      // corner) and within the wheelbase.
      if (box.ny > -0.7 && typeof car.roof !== "function") return false;
      const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
      const lx = (box.cx - car.pos.x) * -fz + (box.cz - car.pos.z) * fx;
      const lz = (box.cx - car.pos.x) * fx + (box.cz - car.pos.z) * fz - C.carOffZ;
      return Math.abs(lx) <= C.carHalfW * C.buntWheelbase && Math.abs(lz) <= C.carHalfL * C.buntWheelbase;
    }

    _tryBunt() {
      const now = this.time;
      for (let i = 0; i < this.players.length; i++) {
        const p = this.players[i];
        if (p.out || p.dead > 0 || now < p.buntReady) continue;
        if (this._wheelsTouch(this.cars[i])) { this._bunt(i); return true; }
      }
      return false;
    }

    // Pop the ball gently up, slow it, make it (stay) the toucher's, and
    // give the car its air moves back. No hit-freeze.
    _bunt(i) {
      const C = this.cfg, b = this.ball, p = this.players[i], car = this.cars[i];
      const kept = Math.max(b.tier, b.speed) * C.buntKeep;
      // Up to about buntUp high, drifting along with the car a little.
      b.vel.set(car.vel.x * 0.4, Math.sqrt(2 * C.gravity * C.buntUp), car.vel.z * 0.4);
      b.owner = i;
      b.neutral = false;
      b.tier = kept;
      b.ownT = 0;
      b.hitId++;
      b.lastHitT = this.time;
      b.safeUntil = this.time + C.bumpGrace;
      this._startCooling(1, C.buntHold); // a gravity ball that stays yours for a while
      this.noHitTime = 0;
      this.lastStrike = null;
      p.buntReady = this.time + C.buntCooldown;
      p.bunts++;
      p.stats.bunts++;
      this.stats.bunts++;
      // The flip reset (when the shared car supports it).
      if (typeof car.resetAirMoves === "function") car.resetAirMoves();
      this._log("bunt", i, { kept: +kept.toFixed(1) });
      this.hooks.onBunt(car, b);
      this.onEvent("bunt", { player: p });
    }

    /* ---------- KOs ---------- */

    // Does an owned (or cooling) ball touch anyone who isn't its owner?
    _checkKOs() {
      const C = this.cfg, b = this.ball;
      if (b.mode === "neutral" || b.owner === null) return false;
      // Wheels on the ball beat everything: that's a bunt, not a KO
      // (and it works on your own ball too).
      if (this._tryBunt()) return false;
      if (this.time < b.safeUntil) return false;
      const victims = [];
      this.players.forEach((p, i) => {
        if (p.out || p.dead > 0 || i === b.owner || p.invuln > 0) return;
        // True 3D: the ball sphere against the car's body box. Jumping
        // over the ball works only if you really are above it.
        const box = this._carBox(this.cars[i], b.pos.x, b.pos.y, b.pos.z);
        if (box.d < C.ballR) victims.push(i);
      });
      if (!victims.length) return false;

      const owner = b.owner;
      for (const i of victims) this._ko(i, owner);

      // Last car standing? (If somehow nobody is left, the last striker
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

    /* ---------- Bumps: cars pushing a neutral ball ---------- */
    _carContacts() {
      const C = this.cfg, b = this.ball;
      // Owned or cooling balls never get pushed: they pass through their
      // owner and KO (or pass through invulnerable) everyone else.
      if (b.mode !== "neutral") return;
      if (this._tryBunt()) return;
      this.players.forEach((p, i) => {
        if (p.out || p.dead > 0 || b.mode !== "neutral") return;
        const car = this.cars[i];
        const box = this._carBox(car, b.pos.x, b.pos.y, b.pos.z);
        if (box.d >= C.ballR) return;
        const { nx, ny, nz } = box;
        // Push the ball out of the car.
        b.pos.set(box.cx + nx * C.ballR, Math.max(C.ballR, box.cy + ny * C.ballR), box.cz + nz * C.ballR);
        // Bounce off the car, moving with it.
        const rel = (b.vel.x - car.vel.x) * nx + (b.vel.y - car.vel.y) * ny + (b.vel.z - car.vel.z) * nz;
        if (rel >= 0) return; // already separating
        const impact = -rel;
        b.vel.x -= nx * rel * (1 + C.bumpRestitution);
        b.vel.y -= ny * rel * (1 + C.bumpRestitution);
        b.vel.z -= nz * rel * (1 + C.bumpRestitution);
        b.vel.x += car.vel.x * C.bumpCarry;
        b.vel.z += car.vel.z * C.bumpCarry;
        b.vel.y += C.bumpLift * Math.max(0.2, ny);
        this.stats.bumps++;
        p.stats.bumps++;
        this._log("bump", i, { impact: +impact.toFixed(1), took: impact >= C.bumpOwnMin });
        // A hard bump on a neutral ball makes you its owner at baseSpeed,
        // but it stays a gravity ball (it doesn't fly straight).
        if (impact >= C.bumpOwnMin) {
          b.owner = i;
          b.neutral = false;
          b.tier = C.baseSpeed;
          b.safeUntil = this.time + C.bumpGrace;
          this._startCooling(1, C.ownedFade);
          this.onEvent("bump", { player: p });
        }
      });
    }

    _ko(i, ownerIdx) {
      const C = this.cfg, p = this.players[i], car = this.cars[i];
      const owner = this.players[ownerIdx];
      p.lives = Math.max(0, p.lives - 1);
      if (owner) owner.kos++;
      this.koLog.push({ t: +this.time.toFixed(2), victim: i, owner: ownerIdx, speed: +this.ball.speed.toFixed(1) });
      this._log("ko", ownerIdx, { victim: i, speed: +this.ball.speed.toFixed(1) });
      this.stalemateStreak = 0;

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
      const s = spawnSpot(i, this.cfg);
      p.dead = 0;
      p.invuln = this.cfg.respawnInvuln;
      p.prevHit = true; // a held Hit button doesn't swipe the instant you appear
      car.out = false;
      car.boost = 100;
      car.placeAt(s.x, s.z, s.heading);
      car.mesh.visible = true;
      this.hooks.onRespawn(car);
      this.onEvent("respawn", { player: p });
    }

    // Put the ball back at the serve spot as a neutral ball.
    _serve(first = false) {
      const b = this.ball;
      b.pos.set(0, this.cfg.serveY, 0);
      b.vel.set(0, 0, 0);
      b.speed = 0;
      this._goNeutral();
      b.hits = 0;
      b.ownT = 0;
      b.safeUntil = 0;
      b.lockUntil = 0;
      this.lastStrike = null;
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
        stats: Object.assign({}, this.stats),
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
       { throttle, steer, boost, jump, hit }. Throttle doubles as the
       up/down aim on the step they strike, exactly like a human.

       Plan, in order:
         1. Ball within reach and safe to strike: strike it at the nearest
            opponent, picking up / straight / down.
         2. Neutral ball (or my own gravity ball): predict where it comes
            down to a height I can reach, get there, jump if it's high.
         3. My own straight-flying ball: keep clear of its line.
         4. An enemy ball heading at me: after a short reaction delay,
            strike it back if it's slow enough for this bot's skill;
            otherwise jump it (if it's low), sidestep, or sometimes bunt
            it. Faster balls are more likely to be misread.
         5. An enemy ball not coming at me: chase it if slow, else keep clear.
       ===================================================================== */
    _botControls(i) {
      const C = this.cfg, b = this.ball, p = this.players[i], car = this.cars[i], S = this.bots[i];
      const canSwing = p.swingT <= 0 && p.cooldown <= 0 && this.state === "play";
      const reach = this._reach(car);
      const mine = b.owner === i;
      const dangerous = b.mode !== "neutral" && !mine && b.owner !== null;
      // Boldness: after each stalemate since the last KO, and in a 1-v-1
      // endgame, bots return faster balls and misread fewer. That stops a
      // cautious owner and a cautious dodger stalling a match forever.
      const alive = this.players.filter((q) => !q.out).length;
      const bold = this.stalemateStreak + (alive === 2 ? 1 : 0);
      const maxReturn = S.maxReturn + 6 * bold;
      const handle = !dangerous || b.speed <= maxReturn;

      // 1) In reach and harmless to me (neutral, or my own): hit it on.
      //    Enemy balls go through the plan below instead, so the bot's
      //    timing can be off. If another car is nearer the ball, usually
      //    let it have it (sometimes go for it anyway: a clash).
      const contested = this.players.some((q, j) => j !== i && !q.out && q.dead <= 0 && this._reach(this.cars[j]) < reach);
      if (canSwing && !dangerous && reach < C.hitRange * 0.85 && this.time >= b.lockUntil && (!contested || Math.random() < 0.06)) {
        const ctrl = TP.ai.driveTo(car, b.pos.x, b.pos.z, { boostDist: 99 });
        const aim = this._botAim(i);
        ctrl.hit = true;
        ctrl.steer = aim.steer;
        ctrl.throttle = aim.throttle;
        ctrl.jump = false;
        ctrl.boost = car.boost > C.smashBoostCost + 10 && Math.random() < 0.3; // sometimes smash
        return ctrl;
      }

      // 2) A gravity ball that can't hurt me: go and meet it.
      if (b.mode === "neutral" || (mine && b.mode === "cooling")) return this._botMeet(i);

      // 3) My own straight-flying ball: stay out of its way... unless
      //    things have stalled, then go after it and strike it again.
      if (mine) {
        if (bold > 0) {
          const ctrl = TP.ai.driveTo(car, ...this._inside(b.pos.x, b.pos.z), { boostDist: 10 });
          ctrl.hit = false;
          return ctrl;
        }
        return this._botIdle(i);
      }

      // 4) An enemy ball. Straight-line guess (owned balls fly straight):
      //    when is it closest to my car, how close, and how high then?
      const cx = car.pos.x, cy = car.pos.y + C.carH / 2, cz = car.pos.z;
      const rx = cx - b.pos.x, ry = cy - b.pos.y, rz = cz - b.pos.z;
      const v2 = b.vel.lengthSq() || 1;
      const tClose = (rx * b.vel.x + ry * b.vel.y + rz * b.vel.z) / v2;
      const mx = rx - b.vel.x * tClose, my = ry - b.vel.y * tClose, mz = rz - b.vel.z * tClose;
      const missBy = Math.hypot(mx, my, mz);
      const threat = tClose > 0 && tClose < 1.6 && missBy < C.ballR + 2.2;
      const reacted = this.time - b.lastHitT >= S.reaction;

      if (!threat || !reacted || p.invuln > 0.3) {
        // 5) Not coming at me (yet). Chase it down if I can handle it.
        if (handle && b.speed < maxReturn * 0.8 && p.invuln <= 0) {
          const ctrl = TP.ai.driveTo(car, ...this._inside(b.pos.x, b.pos.z), { boostDist: 10 });
          ctrl.hit = false;
          return ctrl;
        }
        return this._botIdle(i);
      }

      // Decide once per shot: strike it back, bunt it, dodge it, or misread it.
      if (S.planFor !== b.hitId) {
        S.planFor = b.hitId;
        const frac = clamp((b.speed - C.baseSpeed) / (C.maxSpeed - C.baseSpeed), 0, 1);
        S.lead = S.swingLead + rand(-S.leadErr, S.leadErr * 2); // early or late this time
        if (Math.random() < (S.fumble + S.fumbleFast * frac) * Math.pow(0.6, bold)) S.plan = "fumble";
        else if (b.speed <= maxReturn) S.plan = "return";
        else S.plan = "dodge";
      }

      const dist = Math.hypot(rx, ry, rz);
      const tImpact = (dist - (C.ballR + 1.2)) / Math.max(1, b.speed);
      const ctrl = { throttle: 0, steer: 0, boost: false, jump: false, hit: false };

      if (S.plan === "return") {
        // Face the ball (a return goes back the way it came), roll
        // gently, and swipe just before it reaches striking range.
        const diff = TP.ai.angleTo(car, b.pos.x, b.pos.z);
        ctrl.steer = clamp(-diff * 3, -1, 1);
        ctrl.throttle = Math.abs(diff) < 0.6 ? 0.25 : 0;
        const tToRange = (reach - C.hitRange * 0.8) / Math.max(1, b.speed);
        if (canSwing && tToRange <= S.lead) {
          const aim = this._botAim(i);
          ctrl.hit = true;
          ctrl.steer = aim.steer;
          ctrl.throttle = aim.throttle;
        }
        return ctrl;
      }
      if (S.plan === "dodge") {
        // How high will it be when it reaches me? A low ball can be jumped
        // (time the jump so I'm near the top of it); a high one I just
        // drive out from under.
        const yAt = b.pos.y + b.vel.y * tClose;
        if (yAt < C.ballR + 0.6) {
          ctrl.jump = car.onGround && tImpact <= S.jumpLead;
          return ctrl;
        }
        const len = Math.hypot(b.vel.x, b.vel.z) || 1;
        const side = mx * b.vel.z - mz * b.vel.x >= 0 ? 1 : -1;
        const tx = car.pos.x + (-b.vel.z / len) * side * 8;
        const tz = car.pos.z + (b.vel.x / len) * side * 8;
        const d = TP.ai.driveTo(car, ...this._inside(tx, tz), { boostDist: 99 });
        d.hit = false;
        d.boost = true;
        return d;
      }
      return this._botIdle(i); // fumble: carries on as if nothing's coming
    }

    /* ---------- Meeting a gravity ball ----------
       Run the ball's flight forward (the same physics the real ball uses),
       find the first moment it's low enough to strike and I can get
       there in time, and drive to that spot. Jump if it'll be high. */
    _botMeet(i) {
      const C = this.cfg, car = this.cars[i], b = this.ball;
      const path = this._predictBall();
      const reachTop = C.strikeY + C.hitRange * 0.8;   // highest strike from the ground
      let target = path[path.length - 1];
      for (const q of path) {
        const tCar = dist2D(car.pos.x, car.pos.z, q.x, q.z) / 14 + 0.15;
        if (q.y <= reachTop + 1.6 && tCar <= q.t) { target = q; break; }
      }
      const ctrl = TP.ai.driveTo(car, ...this._inside(target.x, target.z), { boostDist: 9 });
      ctrl.hit = false;
      // Ball above my reach and close: jump to meet it.
      const near = dist2D(car.pos.x, car.pos.z, b.pos.x, b.pos.z) < 4;
      ctrl.jump = car.onGround && near && b.pos.y > reachTop - 0.4 && b.pos.y < reachTop + 2.2 && b.vel.y <= 4;
      return ctrl;
    }

    // Where the ball will be over the next ~2.5 s (every 1/30 s), as
    // [{ t, x, y, z }]. Shared by every bot, refreshed every 0.05 s.
    _predictBall() {
      if (this._pred && this.time - this._pred.at < 0.05) return this._pred.path;
      const C = this.cfg, b = this.ball;
      const sim = {
        pos: b.pos.clone(), vel: b.vel.clone(), mode: b.mode,
        coolK0: b.coolK0, coolT: b.coolT, coolLen: b.coolLen,
      };
      if (this.state === "serve") sim.vel.set(0, 0, 0);
      const path = [];
      const dt = 1 / 30;
      let wait = this.state === "serve" ? this.serveTimer : 0;
      for (let t = dt; t <= 2.5; t += dt) {
        if (wait > 0) { wait -= dt; }
        else {
          if (sim.mode === "cooling") { sim.coolT += dt; if (sim.coolT >= sim.coolLen) sim.mode = "neutral"; }
          moveBall(sim, dt, C, this.pillars, null);
        }
        path.push({ t, x: sim.pos.x, y: sim.pos.y, z: sim.pos.z });
      }
      this._pred = { at: this.time, path };
      return path;
    }

    // Aim a strike at the nearest opponent: steering for the sideways
    // bend, throttle for up / straight / down. Plus a little sloppiness.
    _botAim(i) {
      const C = this.cfg, car = this.cars[i], S = this.bots[i], b = this.ball;
      let target = null, best = Infinity;
      this.players.forEach((q, j) => {
        if (j === i || q.out || q.dead > 0) return;
        const d = dist2D(car.pos.x, car.pos.z, this.cars[j].pos.x, this.cars[j].pos.z);
        if (d < best) { best = d; target = this.cars[j]; }
      });
      let steer = 0;
      if (target) steer = -TP.ai.angleTo(car, target.pos.x, target.pos.z) / (C.aimBendDeg * DEG);
      steer += rand(-1, 1) * (S.aimNoise / C.aimBendDeg);

      // Up / straight / down. A high ball usually gets driven down into
      // the floor (a bounce shot); an airborne target gets an up shot;
      // otherwise mostly straight with some variety.
      let throttle = 0;
      const r = Math.random();
      if (b.pos.y > 3.2) throttle = r < 0.6 ? -1 : 0;
      else if (target && !target.onGround) throttle = r < 0.6 ? 1 : 0;
      else throttle = r < 0.15 ? 1 : r < 0.3 ? -1 : 0;
      return { steer: clamp(steer, -1, 1), throttle };
    }

    // Wander to a spot away from the ball (and out of its line), staying
    // off the walls.
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
       Test hooks (QC drives these; main.js exposes TP.duelTest in ?demo/?test)
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

    // Put car i at {x, z} (and optionally y) facing headingRad (0 = facing +Z).
    placeCar(i, pos, headingRad = 0) {
      this.cars[i].placeAt(pos.x, pos.z, headingRad, pos.y || 0);
      if (pos.y > 0) this.cars[i].onGround = false;
    }

    // Put the ball anywhere: { pos: {x, y, z}, vel: {x, y, z}, owner, mode }.
    // owner null → neutral; an owner → "owned" (straight line) unless mode
    // says otherwise. The ball goes live at once (a waiting serve is skipped).
    setBall({ pos, vel, owner = null, mode } = {}) {
      const C = this.cfg, b = this.ball;
      if (pos) b.pos.set(pos.x, pos.y ?? C.serveY, pos.z);
      if (vel) b.vel.set(vel.x || 0, vel.y || 0, vel.z || 0);
      b.speed = b.vel.length();
      if (owner === null) this._goNeutral();
      else {
        b.owner = owner;
        b.neutral = false;
        b.tier = Math.max(C.baseSpeed, b.speed);
        b.ownT = 0;
        if (mode === "cooling") this._startCooling(0, C.ownedFade);
        else b.mode = "owned";
      }
      b.hitId++;
      b.lastHitT = this.time;
      b.safeUntil = 0;
      b.lockUntil = 0;
      this.lastStrike = null;
      this.noHitTime = 0;
      if (this.state === "serve") { this.state = "play"; this.serveTimer = 0; }
    }

    // Record a counted event (see this.events).
    _log(type, player, extra) {
      this.events.push(Object.assign({ t: +this.time.toFixed(2), type, player }, extra));
    }

    /* =====================================================================
       Drawing (every frame). Placeholder visuals only; Art replaces or
       dresses these through hooks and TP.DuelArena.
       ===================================================================== */
    animate(dt) {
      const C = this.cfg, b = this.ball;
      this.ballMesh.position.copy(b.pos);
      // The ball glows its owner's colour; white when neutral. It blinks
      // while waiting to be served, and a cooling ball fades toward white.
      const color = new THREE.Color(b.owner === null ? 0xffffff : TP.PLAYER_COLORS[this.players[b.owner].seat]);
      if (b.mode === "cooling") color.lerp(new THREE.Color(0xffffff), clamp(b.coolT / b.coolLen, 0, 1) * 0.6);
      this.ballMesh.material.color.copy(color);
      this.ballMesh.material.emissive.copy(color);
      this.ballMesh.visible = this.state !== "serve" || this.countdown > 0 || Math.floor(this.serveTimer * 8) % 2 === 0;

      // Height helpers: shadow disc on the floor, a line up to the ball.
      const hgt = b.pos.y - C.ballR;
      this.ballShadow.position.set(b.pos.x, 0.03, b.pos.z);
      this.ballShadow.material.opacity = clamp(0.5 - hgt * 0.03, 0.15, 0.5);
      this.ballLine.visible = hgt > 1;
      this.ballLine.scale.y = Math.max(0.01, hgt);
      this.ballLine.position.set(b.pos.x, hgt / 2, b.pos.z);

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
        const m = new THREE.Mesh(new THREE.CylinderGeometry(pl.r, pl.r, C.arenaH, 28), pillarMat);
        m.position.set(pl.x, C.arenaH / 2, pl.z);
        m.castShadow = true;
        this.scene.add(m);
      }
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
        stats: Object.assign({}, this.stats),
        ball: {
          pos: v(b.pos), vel: v(b.vel), speed: +b.speed.toFixed(1), tier: +b.tier.toFixed(1),
          mode: b.mode, owner: b.owner, neutral: b.neutral, hits: b.hits,
        },
        players: this.players.map((p) => ({
          name: p.name, seat: p.seat, css: p.css, controller: p.controller,
          lives: p.lives, out: p.out, invuln: +p.invuln.toFixed(2), dead: +p.dead.toFixed(2),
          swingT: +p.swingT.toFixed(3), cooldown: +p.cooldown.toFixed(2),
          pos: v(p.pos), airborne: p.airborne, kos: p.kos, hits: p.hits, bunts: p.bunts, clashes: p.clashes,
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
  // The ball's flight, for anyone who wants to predict it (QC, Art's trails).
  TP.duelMoveBall = moveBall;
})();
