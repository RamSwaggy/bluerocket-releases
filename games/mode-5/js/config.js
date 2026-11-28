/* =====================================================================
   config.js — every number that shapes this mode, in one place.

   Tweak balance here rather than hunting through the code. Units:
   distances are world units (the arena is 96 × 96), "cells" are paint
   grid squares (72 across, so one cell is about 1.33 units), and times
   are seconds.

   The URL can override a few of these for testing (see main.js):
     ?time=30   round length     ?rounds=3   best-of rounds
     ?arena=0   first arena      ?bot=hard   bot difficulty
   ===================================================================== */
window.TP = window.TP || {};
TP.M5 = TP.M5 || {};

(function () {
  "use strict";

  TP.M5.CFG = {
    /* ---------- The floor ---------- */
    GRID: 72,               // paint cells along each side of the arena

    /* ---------- Car feel ----------
       Only the settings in TP.MODE_TUNABLE may change (shared car rule).
       Pivot is a little higher than usual so tight loops feel good. */
    tuning: { bumpScale: 1.15, grip: 11, maxSpeed: 17, boostMax: 26, pivot: 0.35 },

    /* ---------- Painting (radii are in cells) ---------- */
    paintR: 1.1,            // normal stripe under a driving car
    boostR: 1.8,            // wider stripe while boosting
    megaR: 3.0,             // Mega Roller stripe
    padR: 4.0,              // the painted spawn pad each player starts on
    landMinAir: 0.3,        // airtime (s) below this doesn't splat on landing
    landR: [2, 5],          // landing splat radius: small hop → big ramp jump
    landAir: [0.5, 1.4],    // airtime range that maps onto landR
    bumpSplatR: 2.5,        // hard-bump splat (attacker's colour, where the victim was)

    /* ---------- Trails ---------- */
    trailDry: 6,            // a wet trail dries by itself after this long
    stunTime: 1.0,          // how long a popped car spins out
    popGrace: 1.0,          // after the spin-out, this long before you can be popped again
    minFill: 8,             // fills smaller than this many cells are "small" (silent)
    minPop: 6,              // trails shorter than this pop without a stun ("minor")
    hardBump: 9,            // bump impact needed for a splat + pop
    bumpCooldown: 0.5,      // the same pair can't hard-bump twice within this

    /* ---------- Pickups ---------- */
    pickupEvery: 8,         // seconds between spawns
    pickupMax: 2,           // most on the field at once
    pickupGrabR: 2.6,       // how close a car must get to grab one
    bombR: 6,               // Paint Bomb splat radius (cells)
    megaTime: 5,            // Mega Roller duration

    /* ---------- Rounds ---------- */
    roundTime: 120,         // seconds per round
    rounds: 3,              // best of 3 by default (1, 3 or 5)
    countdown: 3.5,         // 3-2-1-GO (the last half second shows GO)
    roundEndTime: 4.5,      // pause on the final floor before the next round

    /* ---------- Overdrive (the last stretch of every round) ---------- */
    overdriveTime: 20,      // seconds left when it starts
    overdriveMul: 1.35,     // paint radius multiplier
    overdrivePickupEvery: 4,

    /* ---------- Bots ---------- */
    botLevel: "normal",     // "easy" | "normal" | "hard"
  };
})();
