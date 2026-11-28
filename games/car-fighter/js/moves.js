/* =====================================================================
   moves.js — Car Fighter's move list and fight rules, as DATA.

   Nothing in here runs. fight.js reads these tables, so tuning the fight
   means changing numbers here (or per car in fighters.js), not code.
   QC's frame-data check reads them too (TP.MOVES, TP.FIGHT_RULES).

   Frames are logic frames at 60 per second.

   Each move row:
     name        what players see (our own names, see DESIGN.md §4)
     input       how it's done, for people and tests (DESIGN §9 contract
                 detail 1): "hit", "hit*2" (2nd chain hit), "toward+heavy",
                 "jump>hit" (jump, then hit), "hit+heavy" (together) ...
     button      which attack button starts it: "hit", "heavy" or "both"
     air         true = only usable in the air (after a jump)
     startup     frames of windup before the hit box comes out. Counting
                 the frame the button is pressed as frame 1, the first
                 active frame is frame startup+1 (contract detail 2)
     active      frames the hit box is out
     recovery    frames after that before the car can act again
                 (a move that hits or is blocked can CANCEL into the next
                 move during active/recovery; see `cancel`)
     Total length = startup + active + recovery (TP.moveFrames).
     damage      health taken on a clean hit (before combo scaling)
     hitstun     frames the victim can't act after a grounded hit
     blockstun   frames a blocking victim is stuck after blocking it
     push        knockback speed along the fighting line (units/second)
     launch      upward speed given to the victim (> 0 = a launcher)
     airLaunch   small pop given when it hits someone already in the air
     hitstop     frames both cars freeze when it connects (it "lands")
     meter       super meter the attacker gains on hit (victim gets half)
     box         hit box, relative to the car: x0..x1 forward from the
                 car's centre along its facing (negative = behind),
                 y0..y1 up from the car's base, z = half-width
     drive       optional { from, to, speed }: during these move frames
                 the move itself sets the car's speed along its facing
                 (fight-layer movement, approved by the Director)
     startVel    optional { vx, vy, at }: speed set on move frame `at`
                 (default 0, the first frame)
     cancel      moves (or "jump") this one can cancel into, but only
                 after it hit or was blocked. A miss never chains.
     cost        optional { boost } or { super } paid when it starts
     flags       launcher / knockdown / overhead / throw / armour (hits
                 absorbed) / hang (air move hovers during its startup)
   ===================================================================== */
window.TP = window.TP || {};

(function () {
  "use strict";

  // Moves a light attack is allowed to cancel into (DESIGN §5:
  // "light → light → light, light → Heavy, Corkscrew or Dash Strike").
  // Tailwhip is the third Heavy-button move, so lights may cancel into it too.
  const LIGHT_ENDERS = ["ram", "corkscrew", "tailwhip", "dash_strike"];

  TP.MOVES = {
    /* ---------- Light chain: Hit, Hit, Hit ---------- */
    jab: {
      name: "Jab", input: "hit", button: "hit",
      startup: 4, active: 3, recovery: 8,
      damage: 40, hitstun: 14, blockstun: 9,
      push: 3, launch: 0, airLaunch: 5, hitstop: 3, meter: 8,
      box: { x0: 0.8, x1: 2.7, y0: 0.2, y1: 1.4, z: 1.0 },
      drive: { from: 0, to: 6, speed: 3 },        // a tiny step in
      cancel: ["swipe", ...LIGHT_ENDERS],
      flags: {},
    },
    swipe: {
      name: "Swipe", input: "hit*2", button: "hit",
      startup: 5, active: 3, recovery: 10,
      damage: 45, hitstun: 15, blockstun: 10,
      push: 3.5, launch: 0, airLaunch: 5, hitstop: 3, meter: 9,
      box: { x0: 0.5, x1: 2.8, y0: 0.1, y1: 1.5, z: 1.3 },
      drive: { from: 0, to: 7, speed: 3 },
      cancel: ["spinout", ...LIGHT_ENDERS],
      flags: {},
    },
    spinout: {
      name: "Spinout", input: "hit*3", button: "hit",
      startup: 7, active: 4, recovery: 16,
      damage: 60, hitstun: 20, blockstun: 12,
      push: 9, launch: 0, airLaunch: 6, hitstop: 4, meter: 12,
      box: { x0: -1.0, x1: 3.0, y0: 0.0, y1: 1.5, z: 1.5 },
      drive: { from: 0, to: 10, speed: 4 },
      cancel: [...LIGHT_ENDERS],
      flags: {},
    },

    /* ---------- Heavy-button moves ---------- */
    ram: {                       // Heavy: big pushback, punishable if blocked (−12)
      name: "Ram", input: "heavy", button: "heavy",
      startup: 12, active: 5, recovery: 22,
      damage: 110, hitstun: 24, blockstun: 14,
      push: 14, launch: 0, airLaunch: 7, hitstop: 6, meter: 18,
      box: { x0: 1.0, x1: 2.9, y0: 0.1, y1: 1.4, z: 1.1 },
      drive: { from: 4, to: 17, speed: 11 },
      cancel: [],
      flags: {},
    },
    corkscrew: {                 // Toward + Heavy: the launcher. Jump-cancel on hit to juggle.
      name: "Corkscrew", input: "toward+heavy", button: "heavy",
      startup: 15, active: 4, recovery: 20,
      damage: 90, hitstun: 0, blockstun: 14,
      push: 2.5, launch: 13, airLaunch: 10, hitstop: 6, meter: 16,
      box: { x0: 0.8, x1: 2.8, y0: 0.0, y1: 2.4, z: 1.1 },
      drive: { from: 8, to: 19, speed: 6 },
      cancel: ["jump"],
      flags: { launcher: true },
    },
    tailwhip: {                  // Away + Heavy: 180° spin, hits both sides, shoves them off you
      name: "Tailwhip", input: "away+heavy", button: "heavy",
      startup: 10, active: 5, recovery: 18,
      damage: 80, hitstun: 22, blockstun: 13,
      push: 13, launch: 0, airLaunch: 7, hitstop: 6, meter: 14,
      box: { x0: -2.9, x1: 2.9, y0: 0.0, y1: 1.4, z: 1.4 },
      cancel: [],
      flags: {},
    },

    /* ---------- Boost moves ---------- */
    dash_strike: {               // Boost + Hit: fast charge along the line. Costs 25 boost.
      name: "Dash Strike", input: "boost+hit", button: "hit", usesBoost: true,
      startup: 6, active: 8, recovery: 16,
      damage: 85, hitstun: 20, blockstun: 12,
      push: 10, launch: 0, airLaunch: 7, hitstop: 5, meter: 14,
      box: { x0: 1.0, x1: 2.9, y0: 0.1, y1: 1.4, z: 1.1 },
      drive: { from: 2, to: 14, speed: 24 },
      cost: { boost: 25 },
      cancel: [],
      flags: {},
    },

    /* ---------- Air moves (after a jump) ---------- */
    flip_kick: {                 // Jump, then Hit
      name: "Flip Kick", input: "jump>hit", button: "hit", air: true,
      startup: 5, active: 6, recovery: 12,
      damage: 55, hitstun: 16, blockstun: 10,
      push: 2, launch: 0, airLaunch: 6, hitstop: 4, meter: 10,
      box: { x0: 0.3, x1: 2.6, y0: -1.0, y1: 1.3, z: 1.2 },
      cancel: ["drop_slam"],
      flags: { overhead: true },
    },
    drop_slam: {                 // Jump, then Heavy: dive down, knockdown. Active until it lands.
      name: "Drop Slam", input: "jump>heavy", button: "heavy", air: true,
      startup: 8, active: 40, recovery: 14,
      damage: 100, hitstun: 0, blockstun: 14,
      push: 4, launch: 4, airLaunch: 4, hitstop: 7, meter: 16,
      box: { x0: -0.5, x1: 2.4, y0: -1.2, y1: 0.9, z: 1.2 },
      startVel: { vx: 5, vy: -20, at: 8 },     // hangs for its startup, then dives
      cancel: [],
      flags: { knockdown: true, overhead: true, hang: true },
    },

    /* ---------- Throw: Hit + Heavy together, up close ---------- */
    tow_hook: {
      name: "Tow Hook", input: "hit+heavy", button: "both",
      startup: 5, active: 2, recovery: 20,
      damage: 120, hitstun: 0, blockstun: 0,
      push: 0, launch: 0, airLaunch: 0, hitstop: 4, meter: 16,
      range: 3.6,                // centre-to-centre distance it can grab from
      box: null,                 // throws don't use a hit box (see fight.js detectThrow)
      cancel: [],
      flags: { throw: true },
    },

    /* ---------- Signature move (Boost + Heavy, 1 super bar) ----------
       Each fighter replaces this row with its own (fighters.js).
       This default is Rivet's M1 stub: a big Ram. */
    signature: {
      name: "Signature", input: "boost+heavy", button: "heavy", usesBoost: true,
      startup: 10, active: 8, recovery: 24,
      damage: 220, hitstun: 30, blockstun: 16,
      push: 16, launch: 0, airLaunch: 8, hitstop: 10, meter: 0,
      box: { x0: 0.8, x1: 3.0, y0: 0.0, y1: 1.6, z: 1.3 },
      drive: { from: 6, to: 22, speed: 13 },
      cost: { super: 100 },
      cancel: [],
      flags: { signature: true },
    },

  };

  /* =====================================================================
     Fight rules (DESIGN §5 and §7). One place for every global number.
     ===================================================================== */
  TP.FIGHT_RULES = {
    chip: 0.15,              // a blocked hit still does 15% of its damage
    blockPushScale: 0.6,     // blocked hits push back 60% as far
    scalingStep: 0.10,       // each hit after the first in a combo does 10% less...
    scalingFloor: 0.50,      // ...down to half damage
    juggleLimit: 3,          // after 3 hits in the air, the next one ends the juggle
    knockdownFrames: 24,     // lying on the floor after a juggle/slam/throw (can't be hit)
    wakeupFrames: 30,        // standing back up, invulnerable
    throwCooldown: 20,       // after waking up, can't be thrown again for this long
    bufferFrames: 6,         // a button press is remembered this long
    throwPairFrames: 3,      // Hit and Heavy within this many frames = a throw
    sidestep: { frames: 22, invulnFrames: 12, moveFrames: 10, speed: 13 },
    zDrift: 3,               // how fast both cars drift back onto the fighting line
    wallBounceMinSpeed: 8,   // knockback at least this fast bounces off the rail (once per combo)
    koHitstop: 20,           // the freeze on the knockout hit
    takenMeterRate: 0.5,     // super meter gained when getting hit, vs. dealing it
    superPerBar: 100,
    superMax: 300,
    introFrames: 60,         // "ROUND 1" banner
    countdownFrames: 180,    // 3-2-1, then FIGHT
    roundEndFrames: 150,     // KO / time-out pause before the next round
    maxSuddenDeath: 3,       // extra rounds before a tied match is called a draw
  };

  // Total length of a move in frames.
  TP.moveFrames = (m) => m.startup + m.active + m.recovery;
})();
