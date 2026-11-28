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
    /* Speed ESCALATION (Reece, 2026-11-28: "late rallies get absurd but
       stay readable"). Each strike multiplies the speed AND adds a small
       step, so early rallies stay chaseable and late ones explode:
       16 → 22 → 29.3 → 38.3 → 49.2 → 62.5 → … → 210 after about 11 strikes. */
    baseSpeed: 16,       // first strike on a neutral ball (under the car's 17, so you can chase it)
    speedMult: 1.22,     // every later strike multiplies the speed by this...
    speedStep: 2.5,      // ...and then adds this
    maxSpeed: 210,       // top speed, whatever happens (about 4× a car: crosses the arena in ~0.2 s)
    smashBonus: 6,       // a Smash (strike while boosting) adds this flat amount...
    smashMult: 0.15,     // ...plus this share of the new speed, so Smashes scale with the rally
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
    flipBonus: 4,        // extra speed for a flip strike (a dodge-flip that slams into the ball)
    flipReach: 0.5,      // a flipping car "touches" the ball this much before real contact
    flipLiftDeg: 12,     // a flip strike goes along the flip, angled up this much

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
    freezeMax: 1.2,      // hit-freeze at max speed (the standoff: makes extreme speeds readable)
    freezeCurve: 1.6,    // >1 = the freeze stays short early and grows steeply near the top
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

  /* Bot difficulty. Normal is the tuned default (the fun table is
     measured against it). Easy bots react late, misread more, rarely fly
     and give up on fast balls early; Hard bots are quick, accurate, fly
     and flip a lot, and keep returning very fast balls. Every bot still
     gets a little random variety within its level. */
  const BOT_LEVELS = {
    easy: {
      reaction: [0.25, 0.4], maxReturn: [60, 100], leadErr: 0.3, aimNoise: [14, 24], fumble: 0.18,
      fumbleFast: [0.55, 0.7], needWindow: [0.5, 0.7], fumbleRally: 0.025, aerial: [0.1, 0.3],
      flipper: [0.05, 0.15], flipDodge: [0.1, 0.25], smash: 0.08,
    },
    normal: {
      reaction: [0.08, 0.2], maxReturn: [140, 230], leadErr: 0.2, aimNoise: [4, 14], fumble: 0.06,
      fumbleFast: [0.35, 0.55], needWindow: [0.3, 0.45], fumbleRally: 0.012, aerial: [0.6, 1.0],
      flipper: [0.2, 0.5], flipDodge: [0.3, 0.7], smash: 0.25,
    },
    hard: {
      reaction: [0.04, 0.09], maxReturn: [200, 260], leadErr: 0.1, aimNoise: [1, 5], fumble: 0.025,
      fumbleFast: [0.18, 0.3], needWindow: [0.18, 0.28], fumbleRally: 0.006, aerial: [0.85, 1.0],
      flipper: [0.4, 0.65], flipDodge: [0.6, 0.9], smash: 0.4,
    },
  };
  const pick = (v) => (Array.isArray(v) ? rand(v[0], v[1]) : v);

  // A bot's skill for this match: its level's numbers, with some variety.
  function makeBotSkill(level = "normal") {
    const L = BOT_LEVELS[level] || BOT_LEVELS.normal;
    return {
      level: BOT_LEVELS[level] ? level : "normal",
      smash: L.smash,              // chance it Smashes a return
      reaction: pick(L.reaction),  // seconds before reacting to a new strike
      maxReturn: pick(L.maxReturn),// fastest ball it will even try to strike back (faster = dodge)
      leadErr: L.leadErr,          // how far off its swing timing can be, per shot (seconds)
      lead: 0.08,                  // this shot's swing timing (re-rolled per shot)
      aimNoise: pick(L.aimNoise),  // degrees of sloppiness in its aim
      swingLead: rand(0.04, 0.12), // how early it swings
      jumpLead: rand(0.3, 0.42),   // jump this long before impact (peak height ≈ 0.37 s)
      fumble: L.fumble,            // chance it misreads a slow shot...
      fumbleFast: pick(L.fumbleFast), // ...plus up to this much more as the ball nears max speed
      needWindow: pick(L.needWindow), // seconds of warning it wants (freeze + travel); less = shakier
      fumbleRally: L.fumbleRally,  // ...plus this much per strike in the current rally
      aerial: pick(L.aerial),      // how keen it is to fly up to a high ball (rocket moveset)
      flipper: pick(L.flipper),    // chance it flips into a low ball instead of swiping
      flipDodge: pick(L.flipDodge),// chance it dodges by flipping sideways instead of jumping
      move: null,                  // a committed move: { kind: "flip"|"aerial", until, x, y, z }
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
        // A bounce pad under the ball kicks it up (Low Deck).
        if (C.pads) for (const pd of C.pads) {
          if (Math.hypot(p.x - pd.x, p.z - pd.z) < pd.r) { v.y = Math.max(v.y, C.padBallKick || 15); if (onBounce) onBounce({ x: 0, y: 1, z: 0 }, "pad", v.y); break; }
        }
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
      if (d >= minD) continue;
      // Dead centre (a moving pillar slid right over a resting ball): push
      // it out along the ball's motion, or +x if it's still.
      const vl = Math.hypot(v.x, v.z);
      const nx = d > 1e-4 ? dx / d : vl > 1e-4 ? -v.x / vl : 1, nz = d > 1e-4 ? dz / d : vl > 1e-4 ? -v.z / vl : 0;
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
     Arenas. Each one starts from DUEL_CFG and changes a few things:
     its shape (ceiling height, pillars) and one hazard. Everything here
     is rules; arena.js draws whatever the config says.
       movers   pillars that slide back and forth: { i (pillar index),
                axis "x"|"z", amp (units), period (seconds), phase }
       pads     floor bounce pads { x, z, r }: a car driving over one is
                launched into the air; a ball landing on one is kicked up
     ===================================================================== */
  TP.DUEL_ARENAS = {
    classic: { name: "Neon Box", blurb: "The original: two pillars for bank shots." },
    shifting: {
      name: "Shifting Pillars",
      blurb: "Three pillars slide back and forth. Bank shots move!",
      cfg: {
        pillars: true,
        pillarList: [{ x: -11, z: 0, r: 1.6 }, { x: 0, z: 0, r: 1.6 }, { x: 11, z: 0, r: 1.6 }],
        movers: [
          { i: 0, axis: "z", amp: 8, period: 7, phase: 0 },
          { i: 1, axis: "x", amp: 6, period: 9, phase: 1.6 },
          { i: 2, axis: "z", amp: 8, period: 7, phase: Math.PI },
        ],
      },
    },
    lowdeck: {
      name: "Low Deck",
      blurb: "A low ceiling and bounce pads that throw cars and balls into the air.",
      cfg: {
        arenaH: 8,
        pillars: false,
        pads: [
          { x: -12, z: -6, r: 2.2 }, { x: 12, z: 6, r: 2.2 },
          { x: -12, z: 6, r: 2.2 }, { x: 12, z: -6, r: 2.2 },
        ],
        padCarLaunch: 15,  // upward speed a pad gives a car
        padBallKick: 15,   // upward speed a pad gives a ball that lands on it
      },
    },
  };

  /* =====================================================================
     TP.Duel — one match.
       opts.players   [{ seat, name, controller }]  seat 0..3 picks the colour
       opts.lives     3 or 5
       opts.onEvent   optional (name, data) callback for main.js (toasts, sounds)
       opts.pillars   optional true/false to override DUEL_CFG.pillars for this match
       opts.mode      "stock" (default: lives, last car standing),
                      "teams" (2 vs 2 by seat: 1 & 3 against 2 & 4; a teammate's
                               ball is harmless; last TEAM standing wins),
                      "time"  (timeLimit seconds, endless respawns, most KOs
                               wins; a tie goes to sudden-death overtime),
                      "practice" (one human, a ball launcher, endless lives)
                      Sudden Death is "stock" with lives = 1.
       opts.difficulty "easy" | "normal" (default) | "hard" for every bot
       opts.timeLimit  seconds for "time" mode (default 150)
     ===================================================================== */
  class Duel {
    constructor(opts) {
      // This match's copy of the config (so a per-match pillars choice
      // doesn't change the shared defaults).
      const C = (this.cfg = Object.assign({}, TP.DUEL_CFG));
      // The arena changes some of the numbers (deep-copied, since moving
      // pillars change their own positions during the match).
      this.arenaId = TP.DUEL_ARENAS[opts.arena] ? opts.arena : "classic";
      const A = TP.DUEL_ARENAS[this.arenaId].cfg || {};
      Object.assign(C, JSON.parse(JSON.stringify(A)));
      if (typeof opts.pillars === "boolean") C.pillars = opts.pillars;
      this.onEvent = opts.onEvent || NO_HOOK;
      this.lives = opts.lives || 3;
      this.mode = ["teams", "time", "practice"].includes(opts.mode) ? opts.mode : "stock";
      this.difficulty = BOT_LEVELS[opts.difficulty] ? opts.difficulty : "normal";
      // Time mode: the clock, and whether we're in sudden-death overtime.
      this.timeLimit = opts.timeLimit || 150;
      this.clockLeft = this.mode === "time" ? this.timeLimit : 0;
      this.overtime = false;
      // Practice: how fast the launcher fires (0 = launcher off).
      this.practiceSpeed = opts.practiceSpeed ?? 30;
      this.practiceWait = 1.2;
      // Each pillar's live position (moving pillars update x/z every step;
      // bx/bz is where it rests).
      this.pillars = C.pillars ? C.pillarList.map((p) => ({ x: p.x, z: p.z, r: p.r, bx: p.x, bz: p.z })) : [];
      this.padCooldown = [];

      // Same car as every Rocket Rumble mode; Deflect Duel only lets you
      // turn more while nearly stopped, so you can aim.
      this.tuning = TP.modeTuning({ pivot: 0.8 }, { moveset: "rocket" });
      // The shared car reads these off its "world" (this duel): with the
      // rocket moveset it can fly, so it needs to know where the box is.
      // Ceiling: the roof can't go above it. Wall planes: { nx, nz, d },
      // the normal points INTO the arena, inside where nx*x + nz*z >= d.
      this.ceilingHeight = C.arenaH;
      this.wallPlanes = [
        { nx: 1, nz: 0, d: -C.arenaW / 2 }, { nx: -1, nz: 0, d: -C.arenaW / 2 },
        { nx: 0, nz: 1, d: -C.arenaD / 2 }, { nx: 0, nz: -1, d: -C.arenaD / 2 },
      ];

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
        this.bots.push(cfg.controller === "bot" ? makeBotSkill(this.difficulty) : null);
      });
      // Teams: seats 1 & 3 (team 0) against seats 2 & 4 (team 1). Every
      // other mode: everyone's on their own team.
      this.players.forEach((p) => { p.team = this.mode === "teams" ? p.seat % 2 : p.index; p.score = 0; });

      // Practice: one more "player", the ball launcher. It has no body on
      // the field (it's out from the start, so nothing collides with it or
      // counts it), it just owns the balls it fires, in its own colour.
      if (this.mode === "practice") {
        const used = new Set(this.players.map((p) => p.seat));
        const seat = [2, 3, 1, 0].find((k) => !used.has(k));
        const car = new TP.Car(this.scene, { index: seat, name: "Launcher", color: TP.PLAYER_COLORS[seat], css: TP.PLAYER_CSS[seat], controller: "bot" });
        car.placeAt(-C.arenaW / 2 + 2, -C.arenaD / 2 + 2, 0);
        car.out = true;
        car.mesh.visible = false;
        this.cars.push(car);
        const lp = { index: this.players.length, seat, name: "Launcher", css: TP.PLAYER_CSS[seat], controller: "bot", lives: 0, out: true,
          launcher: true, team: -1, score: 0, invuln: 0, dead: 0, swingT: 0, swingHit: false, cooldown: 0, pos: car.pos, airborne: false,
          kos: 0, hits: 0, bunts: 0, clashes: 0, prevHit: false, lastSteer: 0, lastThrottle: 0, buntReady: 0,
          stats: { swings: 0, strikes: 0, strikesAir: 0, strikesUp: 0, strikesDown: 0, strikesFlip: 0, smashes: 0, clashes: 0, bunts: 0, bumps: 0 } };
        Object.defineProperty(lp, "car", { value: car, enumerable: false });
        this.players.push(lp);
        this.bots.push(null);
        this.launcherIndex = lp.index;
      }

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
      this.stats = { strikes: 0, aerialStrikes: 0, flipStrikes: 0, bunts: 0, clashes: 0, bumps: 0, stalemates: 0, swings: 0 };
      // Every counted event, in order: { t, type, player, ...details }.
      // Types: swing, strike, clash, bunt, bump, ko, stalemate.
      this.events = [];
      // Stalemates since the last KO. Bots get bolder as this grows (and
      // in a 1-v-1 endgame), so a match can't stall forever.
      this.stalemateStreak = 0;
      this.lastKOt = this.time;          // match time of the last KO (bots use it)
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

      // Hit-freeze: the whole game holds still for a moment. Freeze time
      // isn't match time, so it never counts toward the stalemate clock.
      // A human who presses Hit during the freeze (reacting to the
      // standoff) gets that press remembered: it swings the moment play
      // resumes, even if they've already let go.
      if (this.freezeLeft > 0) {
        this.freezeLeft = Math.max(0, this.freezeLeft - dt);
        this._bufferHitsDuringFreeze();
        return;
      }

      this.time += dt;
      this._movePillars();
      this._stepCars(dt);
      this._stepBall(dt);
      if (this.state === "over") return;
      if (this.mode === "time") this._stepClock(dt);
      if (this.mode === "practice") this._stepLauncher(dt);
    }

    /* ---------- Arena hazards ---------- */

    // Shifting Pillars: slide each moving pillar along its axis (a smooth
    // back-and-forth on a sine wave, driven by match time).
    _movePillars() {
      const M = this.cfg.movers;
      if (!M || !this.pillars.length) return;
      for (const m of M) {
        const pl = this.pillars[m.i];
        if (!pl) continue;
        const off = m.amp * Math.sin((2 * Math.PI * this.time) / m.period + (m.phase || 0));
        if (m.axis === "x") pl.x = pl.bx + off; else pl.z = pl.bz + off;
      }
    }

    // Low Deck: a car rolling over a pad gets launched (once, then a short
    // cooldown so it can't chain-bounce on the same pad).
    _padLaunch(i, car) {
      const C = this.cfg;
      if (!C.pads || !car.onGround || (this.padCooldown[i] || 0) > this.time) return;
      for (const pd of C.pads) {
        if (Math.hypot(car.pos.x - pd.x, car.pos.z - pd.z) < pd.r) {
          car.vel.y = C.padCarLaunch || 15;
          car.onGround = false;
          this.padCooldown[i] = this.time + 0.6;
          this._log("pad", i, {});
          this.onEvent("pad", { player: this.players[i] });
          if (this.arenaLook && this.arenaLook.padPulse) this.arenaLook.padPulse(pd);
          return;
        }
      }
    }

    /* ---------- Modes ---------- */

    // Is player j's ball harmless to player i? Your own ball always is; in
    // Teams, so is a teammate's.
    _friendly(i, j) {
      if (j === null || j === undefined) return false;
      return i === j || (this.mode === "teams" && this.players[i].team === this.players[j].team);
    }

    // The players still in the match (the practice launcher never counts).
    _alive() { return this.players.filter((p) => !p.out && !p.launcher); }

    // How many cars are still in, for the bots' endgame logic.
    _aliveCount() { return this._alive().length; }

    // Time mode: count down; at zero the most KOs wins. A tie becomes
    // sudden-death overtime: the next KO that breaks the tie wins it.
    _stepClock(dt) {
      if (this.overtime) return;
      this.clockLeft = Math.max(0, this.clockLeft - dt);
      if (this.clockLeft > 0) return;
      const leader = this._timeLeader();
      if (leader !== null) this._endMatch(leader);
      else { this.overtime = true; this.onEvent("overtime"); }
    }

    // The single player with the most KOs, or null if it's a tie.
    _timeLeader() {
      const ps = this.players.filter((p) => !p.launcher);
      const best = Math.max(...ps.map((p) => p.score));
      const top = ps.filter((p) => p.score === best);
      return top.length === 1 ? top[0].index : null;
    }

    // Practice: whenever the ball is free (neutral, or the player has had
    // it for a while), fire a new one at the player from the far side at
    // the dial speed. Speed 0 = launcher off: the ball is served normally.
    _stepLauncher(dt) {
      const C = this.cfg, b = this.ball, L = this.launcherIndex;
      if (!this.practiceSpeed || this.state !== "play") return;
      const human = this.players.find((p) => !p.launcher);
      if (!human || human.dead > 0) return;
      const free = b.mode === "neutral" || (b.owner !== L && b.ownT > 2.5) || (b.owner === L && b.mode === "cooling");
      this.practiceWait = free ? this.practiceWait - dt : 1.2;
      if (this.practiceWait > 0) return;
      this.practiceWait = 1.2;
      const car = this.cars[human.index];
      // Fire from the far end, at roughly head height, straight at the car.
      const sx = car.pos.x > 0 ? -C.arenaW / 2 + 3 : C.arenaW / 2 - 3;
      const from = { x: sx, y: rand(1.2, 4), z: rand(-C.arenaD / 2 + 4, C.arenaD / 2 - 4) };
      const to = { x: car.pos.x, y: car.pos.y + C.carH / 2, z: car.pos.z };
      const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, l = Math.hypot(dx, dy, dz) || 1;
      const v = this.practiceSpeed;
      this.setBall({ pos: from, vel: { x: dx / l * v, y: dy / l * v, z: dz / l * v }, owner: L });
      this.freezeLeft = this._freezeFor(v); // the same readable standoff as a real strike
      b.lastFreeze = this.freezeLeft;
      this._log("launch", L, { speed: v });
      this.onEvent("launch", { speed: v });
    }

    // Practice speed dial (0 = launcher off).
    setPracticeSpeed(v) { this.practiceSpeed = Math.max(0, Math.min(this.cfg.maxSpeed, v)); this.practiceWait = 0.6; }

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
        this._padLaunch(i, car);
        // A new dodge-flip has started: it can strike the ball once.
        if (car.flipStarted) p.flipUsed = false;

        // Start a swipe on the moment Hit goes down. We detect the press
        // ourselves (not with hitPressed) because several fixed steps can
        // run inside one frame and a press must only count once.
        const pressed = (!!ctrl.hit && !p.prevHit) || p.hitBuffered;
        p.hitBuffered = false;
        p.prevHit = !!ctrl.hit;
        p.lastSteer = ctrl.steer || 0;
        // Strike aim (up / straight / down) comes from the "pitch" axis:
        // the stick's up/down on a gamepad, W/S (or ↑/↓) on a keyboard. On a
        // gamepad the throttle is the triggers, so holding gas must NOT aim
        // the strike up. Bots and test inputs that don't send pitch aim
        // with throttle instead.
        p.lastThrottle = (ctrl.pitch !== undefined && !this.bots[i] && !this.inputOverride[i]) ? ctrl.pitch : (ctrl.throttle || 0);
        if (pressed && p.swingT <= 0 && p.cooldown <= 0) {
          p.swingT = C.swingTime;
          p.swingHit = false;
          this.stats.swings++;
          p.stats.swings++;
          // (the ball's speed right now lets QC measure connect rate by speed)
          this._log("swing", i, { airborne: !car.onGround, ballSpeed: +this.ball.speed.toFixed(1), threat: this.ball.owner !== null && this.ball.owner !== i && this.ball.mode !== "neutral" });
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

    // During a hit-freeze nothing moves, but humans can still press Hit.
    // Remember a fresh press so it swings as soon as the freeze ends.
    _bufferHitsDuringFreeze() {
      this.players.forEach((p, i) => {
        if (p.out || p.dead > 0 || this.bots[i] || this.inputOverride[i]) return;
        const ctrl = TP.Input.get(p.controller);
        if (ctrl.hit && !p.prevHit) p.hitBuffered = true;
        p.prevHit = !!ctrl.hit;
      });
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
      // heat: 1 while owned and flying straight, falling to 0 as it cools,
      // 0 when neutral. Art uses it to soften the glow as a ball cools.
      b.heat = b.mode === "owned" ? 1 : b.mode === "cooling" ? 1 - gravityShare(b) : 0;
    }

    // A bounce happened: tell the hooks, and flash the wall in the arena
    // look (in the ball owner's colour) if it supports that.
    _bounced(normal, surface) {
      const b = this.ball;
      const pos = b.pos.clone();
      this.hooks.onBounce(pos, normal, surface);
      if (surface === "pad" && this.arenaLook && this.arenaLook.padPulse) {
        const pd = (this.cfg.pads || []).find((q) => Math.hypot(pos.x - q.x, pos.z - q.z) < q.r);
        if (pd) this.arenaLook.padPulse(pd);
      }
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
      let best = -1, bestD = Infinity, bestKind = "strike";
      this.players.forEach((p, i) => {
        if (p.out || p.dead > 0) return;
        const car = this.cars[i];
        // A dodge-flip that slams into the ball is a strike too (once per flip).
        if (car.flipping && !p.flipUsed && this._contact(car, C.flipReach)) {
          if (-1 < bestD) { best = i; bestD = -1; bestKind = "flip"; } // contact beats a swipe at range
          return;
        }
        if (p.swingT <= 0 || p.swingHit) return;
        const d = this._reach(car);
        if (d <= C.hitRange && d < bestD) { best = i; bestD = d; bestKind = "strike"; }
      });
      if (best < 0) return false;
      const ls = this.lastStrike;
      if (ls && ls.i !== best && this.time - ls.t <= C.clashWindow) this._clash(ls, best);
      else this._strike(best, bestKind);
      return true;
    }

    // Save what the ball was like before a strike (a clash puts it back).
    _ballBefore() {
      const b = this.ball;
      return { owner: b.owner, mode: b.mode, tier: b.tier, ownT: b.ownT, coolT: b.coolT, coolLen: b.coolLen, coolK0: b.coolK0, hits: b.hits };
    }

    _strike(i, kind = "strike") {
      const C = this.cfg, b = this.ball, p = this.players[i], car = this.cars[i];
      const before = this._ballBefore();
      const aerial = !car.onGround;
      const flip = kind === "flip";
      if (flip) p.flipUsed = true;

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
      let speed = fromNeutral ? C.baseSpeed : Math.min(C.maxSpeed, b.tier * C.speedMult + C.speedStep);
      // Smash: striking while boosting, with enough boost to pay for it.
      // Not on the first touch of a neutral ball: off a serve it would
      // leave faster than a car can chase.
      const smash = !fromNeutral && car.boosting && car.boost >= C.smashBoostCost;
      if (smash) {
        speed = Math.min(C.maxSpeed, speed * (1 + C.smashMult) + C.smashBonus);
        car.boost -= C.smashBoostCost;
      }
      // A flip strike hits harder.
      if (flip) speed = Math.min(C.maxSpeed, speed + C.flipBonus);

      // Aim: up / straight / down from the pitch axis (stick up/down or W/S; see _stepCars), bent sideways
      // by steering. Steering right (+1) lowers the heading (see car.js),
      // so the bend is subtracted.
      let angle = "straight", elev = 0;
      if (p.lastThrottle > C.aimDeadzone) { angle = "up"; elev = C.angleUpDeg * DEG; }
      else if (p.lastThrottle < -C.aimDeadzone) { angle = "down"; elev = -C.angleDownDeg * DEG; }
      let bend = clamp(p.lastSteer, -1, 1) * C.aimBendDeg;
      // The base direction is the way the car faces. In the air (rocket
      // moveset) that includes the nose's pitch: point the nose down at
      // the floor and a "straight" strike goes down too.
      let baseH = car.heading;
      if (aerial && typeof car.nose === "function") {
        const n = car.nose();
        if (Math.hypot(n.x, n.z) > 0.05) baseH = Math.atan2(n.x, n.z);
        elev += Math.asin(clamp(n.y, -1, 1));
      }
      // A flip strike goes the way the flip throws the car, angled up a little.
      if (flip && car.flipDir) {
        baseH = Math.atan2(car.flipDir.x, car.flipDir.z);
        elev = C.flipLiftDeg * DEG;
        angle = "flip";
        bend = 0;
      }
      elev = clamp(elev, -80 * DEG, 80 * DEG);
      const h = baseH - bend * DEG;
      const ch = Math.cos(elev);
      b.vel.set(Math.sin(h) * ch * speed, Math.sin(elev) * speed, Math.cos(h) * ch * speed);
      b.speed = speed;
      b.tier = speed;
      b.owner = i;
      b.mode = "owned";
      b.neutral = false;
      b.ownT = 0;
      b.safeUntil = 0;

      // The hit-freeze: faster ball → longer pause (steeply, near the top).
      const frac = clamp((speed - C.baseSpeed) / (C.maxSpeed - C.baseSpeed), 0, 1);
      this.freezeLeft = this._freezeFor(speed);
      b.lastFreeze = this.freezeLeft;

      const info = { kind, angle, bend: +bend.toFixed(1), aerial, flip, freeze: this.freezeLeft };
      p.stats.strikes++;
      if (aerial) p.stats.strikesAir++;
      if (angle === "up") p.stats.strikesUp++;
      if (angle === "down") p.stats.strikesDown++;
      if (flip) { p.stats.strikesFlip++; this.stats.flipStrikes = (this.stats.flipStrikes || 0) + 1; }
      if (smash) p.stats.smashes++;
      this._log("strike", i, { speed: +speed.toFixed(1), angle, aerial, flip, smash, carY: +car.pos.y.toFixed(2), from: before.owner });
      this.hooks.onHit(car, b, frac, smash, info);
      this.onEvent("hit", { player: p, speed, frac, smash, info });
    }

    // How long the hit-freeze lasts for a ball leaving at `speed`. Short
    // and snappy early in a rally; grows steeply toward freezeMax at the
    // top, so a 200+ ball gets a long, readable standoff first.
    _freezeFor(speed) {
      const C = this.cfg;
      const frac = clamp((speed - C.baseSpeed) / (C.maxSpeed - C.baseSpeed), 0, 1);
      return C.freezeMin + (C.freezeMax - C.freezeMin) * Math.pow(frac, C.freezeCurve);
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
    /* ---------- Car vs ball contact ----------
       With the rocket moveset the car can be at any angle (mid-flip,
       upside down in the air), so we use the shared engine's tilted-box
       test when it's there: TP.Car.sphereContact(car, ballPos, radius).
       Otherwise fall back to our heading-only box. Returns null (no touch)
       or { nx, ny, nz (car → ball), cx, cy, cz (contact point), wheels }. */
    _contact(car, extra = 0) {
      const C = this.cfg, b = this.ball, R = C.ballR + extra;
      if (TP.Car.sphereContact && car.quat) {
        const hit = TP.Car.sphereContact(car, b.pos, R);
        if (!hit) return null;
        return { nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z, cx: hit.point.x, cy: hit.point.y, cz: hit.point.z, wheels: hit.wheels };
      }
      const box = this._carBox(car, b.pos.x, b.pos.y, b.pos.z);
      if (box.d >= R) return null;
      return { nx: box.nx, ny: box.ny, nz: box.nz, cx: box.cx, cy: box.cy, cz: box.cz, wheels: null };
    }

    _wheelsTouch(car) {
      // The shared engine's answer when it has one: underside facing the
      // ball (within 30°) and the contact inside the wheelbase.
      if (TP.Car.sphereContact && car.quat) {
        const hit = this._contact(car);
        return !!(hit && hit.wheels);
      }
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
        if (p.out || p.dead > 0 || p.invuln > 0 || this._friendly(i, b.owner)) return;
        // True 3D: the ball sphere against the car's body box. Jumping
        // over the ball works only if you really are above it.
        if (this._contact(this.cars[i])) victims.push(i);
      });
      if (!victims.length) return false;

      const owner = b.owner;
      for (const i of victims) this._ko(i, owner);
      if (this.state === "over") return true; // a time-mode overtime KO ended it

      // Last car (or team) standing? If somehow nobody is left, the last
      // striker wins: Reece's double-KO rule.
      const alive = this._alive();
      const teamsLeft = new Set(alive.map((p) => p.team)).size;
      if (this.mode !== "time" && this.mode !== "practice" && teamsLeft <= 1) {
        // Teams: the winner is the team; we name its best player (most
        // KOs) and the results card shows the whole team.
        const winners = alive.length ? alive : [this.players[owner]];
        const best = winners.slice().sort((a, b2) => b2.kos - a.kos)[0];
        this._endMatch(best ? best.index : owner);
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
        const box = this._contact(car);
        if (!box) return;
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
      // Time mode and practice: no lives, you just respawn. Time mode
      // scores a point for the owner instead.
      const endless = this.mode === "time" || this.mode === "practice";
      if (!endless) p.lives = Math.max(0, p.lives - 1);
      if (owner) { owner.kos++; owner.score++; }
      p.knockedOut = (p.knockedOut || 0) + 1;
      this.koLog.push({ t: +this.time.toFixed(2), victim: i, owner: ownerIdx, speed: +this.ball.speed.toFixed(1) });
      this._log("ko", ownerIdx, { victim: i, speed: +this.ball.speed.toFixed(1) });
      this.stalemateStreak = 0;
      this.lastKOt = this.time;          // match time of the last KO (bots use it)

      const ownerCar = owner ? this.cars[ownerIdx] : null;
      this.hooks.onKO(car, ownerCar);
      this.onEvent("ko", { victim: p, owner, speed: this.ball.speed });

      // Off the field either for good or until respawn. `car.out` makes
      // the shared car code skip it (no driving, no bumping).
      p.swingT = 0;
      car.out = true;
      car.mesh.visible = false;
      if (!endless && p.lives <= 0) {
        p.out = true;
        this.outOrder.push(i);
      } else {
        p.dead = C.respawnDelay;
      }
      // Time-mode overtime: the first KO that breaks the tie wins.
      if (this.mode === "time" && this.overtime) {
        const leader = this._timeLeader();
        if (leader !== null) this._endMatch(leader);
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
      // Standings. Stock: winner first, then the last knocked out first.
      // Time: by KOs (then fewest times knocked out). Teams: the winning
      // team first (its best player on top), then the rest.
      let order;
      const real = this.players.filter((p) => !p.launcher);
      if (this.mode === "time") {
        order = real.slice().sort((a, b) => (b.score - a.score) || ((a.knockedOut || 0) - (b.knockedOut || 0))).map((p) => p.index);
        order = [winnerIdx, ...order.filter((k) => k !== winnerIdx)];
      } else {
        order = [winnerIdx, ...this.outOrder.slice().reverse().filter((k) => k !== winnerIdx)];
        for (const p of real) if (!order.includes(p.index)) order.push(p.index);
        if (this.mode === "teams") {
          const wt = this.players[winnerIdx].team;
          order = [...order.filter((k) => this.players[k].team === wt), ...order.filter((k) => this.players[k].team !== wt)];
        }
      }
      // Match stats for the results screen, worked out from the counted
      // events: each player's fastest strike, aerial and flip strikes,
      // bunts and returns (strikes on someone else's ball), plus the
      // match's top speed and longest rally.
      const per = this.players.map(() => ({ topSpeed: 0, aerial: 0, flips: 0, bunts: 0, returns: 0, strikes: 0 }));
      let rally = 0, bestRally = 0, topSpeed = 0;
      for (const e of this.events) {
        if (e.type === "strike" && per[e.player]) {
          const q = per[e.player];
          q.strikes++;
          q.topSpeed = Math.max(q.topSpeed, e.speed || 0);
          if (e.aerial && (e.carY || 0) > 1.2) q.aerial++;
          if (e.flip) q.flips++;
          if (e.from !== null && e.from !== undefined && e.from !== e.player) q.returns++;
          topSpeed = Math.max(topSpeed, e.speed || 0);
          rally++;
          bestRally = Math.max(bestRally, rally);
        } else if (e.type === "bunt" && per[e.player]) per[e.player].bunts++;
        else if (e.type === "ko" || e.type === "stalemate") rally = 0;
      }
      const w = this.players[winnerIdx];
      const teamNames = ["Blue & Green", "Orange & Pink"];
      this.result = {
        mode: this.mode,
        winnerTeam: this.mode === "teams" && w ? w.team : null,
        winnerTeamName: this.mode === "teams" && w ? teamNames[w.team] : "",
        winner: winnerIdx,
        topSpeed: +topSpeed.toFixed(0),
        bestRally,
        winnerName: w ? w.name : "",
        winnerCss: w ? w.css : "",
        duration: +this.time.toFixed(1),
        standings: order.map((idx, k) => {
          const p = this.players[idx];
          return { place: k + 1, index: idx, seat: p.seat, name: p.name, css: p.css, lives: p.lives, livesLeft: p.lives, kos: p.kos, hits: p.hits, team: p.team, score: p.score, knockedOut: p.knockedOut || 0, stats: per[idx] };
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

      // 0) Rocket moves take several steps (jump, release, flip / aim and
      //    boost). Once a bot commits to one it sees it through, swiping
      //    if the ball comes into reach on the way.
      if (S.move) {
        const m = S.move;
        // Give up when time's out, after a bad landing, or if an aerial
        // never left the ground (couldn't line up in time).
        if (this.time > m.until || car.tumbling || (m.kind === "aerial" && car.onGround && this.time > m.start + 1.0)) S.move = null;
        else {
          let ctrl;
          if (m.kind === "flip") {
            ctrl = TP.ai.flipAt(car, m.x, m.z, { boost: m.boost });
          } else {
            // Re-aim at where the ball is now (it may have moved).
            ctrl = TP.ai.aerialTo(car, b.pos.x, b.pos.y, b.pos.z, { lift: 0.4 });
          }
          ctrl.hit = canSwing && m.swing && reach < C.hitRange * 0.85 && this.time >= b.lockUntil;
          if (ctrl.hit) { const aim = this._botAim(i); ctrl.steer = aim.steer; ctrl.throttle = aim.throttle; }
          return ctrl;
        }
      }
      // "Mine" = harmless to me: my own ball, or (Teams) a teammate's.
      const mine = b.owner !== null && this._friendly(i, b.owner);
      const dangerous = b.mode !== "neutral" && !mine && b.owner !== null;
      // Boldness: after each stalemate since the last KO, bots return
      // faster balls and misread fewer, so a cautious owner and a cautious
      // dodger can't stall a match forever. In a 1-v-1 endgame the owner
      // also chases its own ball (see 3 below).
      const alive = this._aliveCount();
      const bold = this.stalemateStreak;
      const maxReturn = S.maxReturn + 6 * bold;
      const handle = !dangerous || b.speed <= maxReturn;

      // 1) In reach and harmless to me (neutral, or my own): hit it on.
      //    Enemy balls go through the plan below instead, so the bot's
      //    timing can be off. If another car is nearer the ball, usually
      //    let it have it (sometimes go for it anyway: a clash).
      const contested = this.players.some((q, j) => j !== i && !q.out && q.dead <= 0 && this._reach(this.cars[j]) < reach);
      // Sometimes, instead of a swipe, slam a low ball with a dodge-flip
      // (a flip strike hits harder). Decided once per approach.
      if (!dangerous && car.onGround && b.pos.y < 2.2 && this.state === "play" && !contested &&
          dist2D(car.pos.x, car.pos.z, b.pos.x, b.pos.z) < 6 && dist2D(car.pos.x, car.pos.z, b.pos.x, b.pos.z) > 3 &&
          Math.abs(TP.ai.angleTo(car, b.pos.x, b.pos.z)) < 0.5 && S.flipFor !== b.hitId) {
        S.flipFor = b.hitId;
        if (Math.random() < S.flipper) {
          S.move = { kind: "flip", x: b.pos.x, z: b.pos.z, until: this.time + 1.0, start: this.time, swing: false, boost: false };
          return this._botControls(i);
        }
      }
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
        if ((bold > 0 || alive === 2) && b.speed < 32) {
          // Line up behind it toward the other car (same as meeting a
          // free ball), so the next strike actually goes at somebody.
          return this._botMeet(i);
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
        // The reaction window: the hit-freeze the bot just watched, plus how
        // long the ball takes to reach it. A long freeze gives time to read
        // even a very fast ball; a short window makes a misread likelier.
        const window = (b.lastFreeze || 0) + Math.hypot(rx, ry, rz) / Math.max(1, b.speed);
        const rushed = 0.5 * clamp((S.needWindow - window) / S.needWindow, 0, 1);
        // Long rallies tire bots out: each strike since the serve adds a
        // little to the misread chance, so rallies end (median aim 4–12).
        const rally = S.fumbleRally * b.hits;
        // And the longer nobody has been KO'd (after 20 s), the more
        // likely a misread, so a match always ends.
        // In a 1-v-1 endgame the drought bites sooner and harder, so the
        // last two cars can't trade returns for minutes on end.
        const drought = alive === 2 ? 0.03 * Math.max(0, this.time - this.lastKOt - 10)
                                    : 0.015 * Math.max(0, this.time - this.lastKOt - 20);
        // Misread chance: a base, more for fast balls (curving up near the
        // top), more for long rallies and for a rushed window. Beatable at
        // high speed, but not hopeless.
        if (Math.random() < (S.fumble + S.fumbleFast * Math.pow(frac, 1.2) + rally + rushed) * Math.pow(0.6, bold) + drought) S.plan = "fumble";
        else if (b.speed <= maxReturn) S.plan = "return";
        else S.plan = "dodge";
      }

      const dist = Math.hypot(rx, ry, rz);
      const tImpact = (dist - (C.ballR + 1.2)) / Math.max(1, b.speed);
      const ctrl = { throttle: 0, steer: 0, boost: false, jump: false, hit: false };

      if (S.plan === "return") {
        // A high incoming ball: take off and meet it in the air (an aerial
        // return), swiping as it comes into reach.
        const yMeet = b.pos.y + b.vel.y * Math.max(0, tClose);
        const reachTop = C.strikeY + C.hitRange * 0.8;
        if (car.onGround && yMeet > reachTop + 0.3 && yMeet < C.arenaH - 1.5 && tClose > 0.35 && car.boost > 15 && Math.random() < S.aerial) {
          S.move = { kind: "aerial", until: this.time + tClose + 0.6, start: this.time, swing: true };
          return this._botControls(i);
        }
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
          // Sometimes return it as a Smash (boost held as it swipes).
          ctrl.boost = car.boost > C.smashBoostCost + 5 && Math.random() < S.smash;
        }
        return ctrl;
      }
      if (S.plan === "dodge") {
        // How high will it be when it reaches me? A low ball can be jumped
        // (time the jump so I'm near the top of it); a high one I just
        // drive out from under.
        const yAt = b.pos.y + b.vel.y * tClose;
        if (yAt < C.ballR + 0.6) {
          // A low ball: jump it... or, with time to spare, dodge-flip
          // sideways out of its line (decided once per shot).
          if (car.onGround && tImpact <= S.jumpLead + 0.25 && tImpact > S.jumpLead * 0.5 && S.flipDodgeFor !== b.hitId) {
            S.flipDodgeFor = b.hitId;
            if (Math.random() < S.flipDodge) {
              const len = Math.hypot(b.vel.x, b.vel.z) || 1;
              const side = mx * b.vel.z - mz * b.vel.x >= 0 ? 1 : -1;
              const [fx, fz] = this._inside(car.pos.x + (-b.vel.z / len) * side * 6, car.pos.z + (b.vel.x / len) * side * 6);
              S.move = { kind: "flip", x: fx, z: fz, until: this.time + 0.9, start: this.time, swing: false, boost: false };
              return this._botControls(i);
            }
          }
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
      // Fumble: it misread the shot and just sits there.
      return ctrl;
    }

    /* ---------- Meeting a gravity ball ----------
       Run the ball's flight forward (the same physics the real ball uses),
       find the first moment it's low enough to strike and I can get
       there in time, and drive to that spot. Jump if it'll be high. */
    _botMeet(i) {
      const C = this.cfg, car = this.cars[i], b = this.ball, S = this.bots[i];
      const path = this._predictBall();
      const reachTop = C.strikeY + C.hitRange * 0.8;   // highest strike from the ground

      // A high ball I can reach in time: fly up to it (an aerial), if this
      // bot is the flying sort. Scan the ball's predicted path for a point
      // that's still well above a ground strike and that I could fly to
      // before the ball gets there (drive + take-off + climb). Re-checked
      // every 0.4 s, so bots don't dither every step.
      if (car.onGround && S && this.state === "play" && car.boost > 25 && this.time >= (S.aerialCheckAt || 0)) {
        S.aerialCheckAt = this.time + 0.4;
        let spot = null;
        for (const q of path) {
          if (q.y < reachTop + 0.8 || q.y > C.arenaH - 1.5) continue;
          const tNeed = dist2D(car.pos.x, car.pos.z, q.x, q.z) / 20 + 0.3 + (q.y - reachTop) / 8;
          if (tNeed <= q.t && q.t < 2.4) { spot = q; break; }
        }
        if (spot && Math.random() < S.aerial) {
          S.move = { kind: "aerial", until: this.time + spot.t + 0.8, start: this.time, swing: true };
          return this._botControls(i);
        }
      }
      let target = path[path.length - 1];
      for (const q of path) {
        const tCar = dist2D(car.pos.x, car.pos.z, q.x, q.z) / 14 + 0.15;
        if (q.y <= reachTop + 1.6 && tCar <= q.t) { target = q; break; }
      }
      // Line up: approach the meeting spot from the far side of my target,
      // so that when I strike, I'm already facing the target (a strike
      // goes the way the car faces, bent by at most aimBendDeg).
      let gx = target.x, gz = target.z;
      const foe = this._nearestFoe(i);
      if (foe) {
        const tx = foe.pos.x - target.x, tz = foe.pos.z - target.z;
        const tl = Math.hypot(tx, tz) || 1;
        const bx = target.x - (tx / tl) * 3, bz = target.z - (tz / tl) * 3;
        // Far from the line-up spot: go there first. Close: drive through the ball.
        if (dist2D(car.pos.x, car.pos.z, bx, bz) > 2.5 && dist2D(car.pos.x, car.pos.z, target.x, target.z) > 2.5) { gx = bx; gz = bz; }
      }
      const ctrl = TP.ai.driveTo(car, ...this._inside(gx, gz), { boostDist: 9 });
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

    // The nearest opponent still on the field (their car), or null.
    _nearestFoe(i) {
      const car = this.cars[i];
      let target = null, best = Infinity;
      this.players.forEach((q, j) => {
        if (this._friendly(i, j) || q.out || q.dead > 0 || q.launcher) return;
        const d = dist2D(car.pos.x, car.pos.z, this.cars[j].pos.x, this.cars[j].pos.z);
        if (d < best) { best = d; target = this.cars[j]; }
      });
      return target;
    }

    // Aim a strike at the nearest opponent: steering for the sideways
    // bend, throttle for up / straight / down. Plus a little sloppiness.
    _botAim(i) {
      const C = this.cfg, car = this.cars[i], S = this.bots[i], b = this.ball;
      let target = null, best = Infinity;
      this.players.forEach((q, j) => {
        if (this._friendly(i, j) || q.out || q.dead > 0 || q.launcher) return;
        const d = dist2D(car.pos.x, car.pos.z, this.cars[j].pos.x, this.cars[j].pos.z);
        if (d < best) { best = d; target = this.cars[j]; }
      });
      // A long KO drought (sooner in a 1-v-1): bots get sharp, aiming
      // straight at the other car with no sloppiness, so somebody gets
      // hit and the match ends.
      const alive = this._aliveCount();
      const sharp = this.time - this.lastKOt > (alive === 2 ? 15 : 30);
      let steer = 0;
      if (target) steer = -TP.ai.angleTo(car, target.pos.x, target.pos.z) / (C.aimBendDeg * DEG);
      if (!sharp) steer += rand(-1, 1) * (S.aimNoise / C.aimBendDeg);
      if (sharp && target) {
        // Straight at it: the right elevation to reach the target's middle.
        const dx = target.pos.x - car.pos.x, dz = target.pos.z - car.pos.z;
        const dy = target.pos.y + C.carH / 2 - b.pos.y;
        const up = Math.atan2(dy, Math.hypot(dx, dz));
        const throttle = up > (C.angleUpDeg * DEG) / 2 ? 1 : up < -(C.angleDownDeg * DEG) / 2 ? -1 : 0;
        return { steer: clamp(steer, -1, 1), throttle };
      }

      // Up / straight / down. A high ball usually gets driven down into
      // the floor (a bounce shot); an airborne target gets an up shot;
      // otherwise mostly straight with some variety.
      let throttle = 0;
      const r = Math.random();
      if (b.pos.y > 3.2) throttle = r < 0.6 ? -1 : 0;
      else if (target && !target.onGround) throttle = r < 0.6 ? 1 : 0;
      else throttle = r < 0.25 ? 1 : r < 0.4 ? -1 : 0;
      return { steer: clamp(steer, -1, 1), throttle };
    }

    // Wander to a spot away from the ball (and out of its line), staying
    // off the walls. During a long KO drought bots stop running away and
    // just hold their ground, so somebody gets caught.
    _botIdle(i) {
      const car = this.cars[i], b = this.ball;
      const alive = this._aliveCount();
      if (this.time - this.lastKOt > (alive === 2 ? 20 : 40)) return { throttle: 0, steer: 0, boost: false, jump: false, hit: false };
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
      this.bots[i] = on ? makeBotSkill(this.difficulty) : null;
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
        mode: this.mode,
        arena: this.arenaId,
        difficulty: this.difficulty,
        clockLeft: +this.clockLeft.toFixed(2),
        overtime: this.overtime,
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
          team: p.team, score: p.score, launcher: !!p.launcher,
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
