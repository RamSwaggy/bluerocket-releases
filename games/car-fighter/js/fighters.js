/* =====================================================================
   fighters.js — the three fighter cars: health, handling, move-table
   changes, signature moves, per-car rules, character-select info and
   bot habits.

   "One car feel" (TEAMS.md): every car drives like the shared Rocket
   Rumble car. Handling may only differ through TP.modeTuning() and its
   allowed settings (maxSpeed, boostMax, grip, pivot, bumpScale).
   Everything else that makes a car different is fight data.

   How a car's move table is built (TP.fighterMoves):
     1. start from a copy of the shared TP.MOVES table,
     2. apply the car's broad modifiers:
          damageMul           every move's damage × this
          startupDelta        every move's startup + this (not the throw)
          lightStartupDelta   Jab/Swipe/Spinout startup + this
          lightRecoveryDelta  Jab/Swipe/Spinout recovery + this
     3. apply `moveOverrides` (exact numbers win over the modifiers),
     4. swap in the car's own `signature` row.
   Per-car rules: `sidestep` (merged over TP.FIGHT_RULES.sidestep) and
   `knockbackMul` (how far this car gets pushed when hit).

   Numbers are DESIGN.md §6 "M2 starting numbers", tuned with QC's sims.
   ===================================================================== */
window.TP = window.TP || {};

(function () {
  "use strict";

  const LIGHTS = ["jab", "swipe", "spinout"];

  TP.FIGHTERS = {
    /* ---------- Rivet: the all-rounder ---------- */
    rivet: {
      id: "rivet",
      name: "Rivet",
      displayName: "Rivet",
      role: "All-rounder",
      blurb: "A compact coupe that does a bit of everything. Learn the game here.",
      stats: { power: 3, speed: 3, weight: 3, reach: 3 },
      health: 1000,
      tuning: {},                       // shared car defaults
      knockbackMul: 1,
      moveOverrides: {},
      // Grinder (the base TP.MOVES.signature row in moves.js): a 3-hit
      // spinning sweep. Rivet uses it as written.
      signature: {},
      bot: { superRange: [0, 4.2] },    // no special habits
    },

    /* ---------- Haulback: the heavy ---------- */
    haulback: {
      id: "haulback",
      name: "Haulback",
      displayName: "Haulback",
      role: "Heavy",
      blurb: "A box truck that's slow to start but hits like a crane. Its Ram and Corkscrew shrug off a hit.",
      stats: { power: 5, speed: 1, weight: 5, reach: 3 },
      health: 1150,                     // tuned from 1200 (QC sims: Haulback ~60%)
      tuning: { maxSpeed: 14, boostMax: 24, bumpScale: 1.3 },
      knockbackMul: 0.9,                // takes 10% less knockback
      sidestep: { frames: 26 },         // slower to dodge
      damageMul: 1.0,                   // tuned from 1.1 (QC sims: Haulback won ~70%)
      lightStartupDelta: 1,
      moveOverrides: {
        ram: { startup: 14, damage: 125, push: 16, flags: { armour: 1 } },
        corkscrew: { startup: 17, damage: 100, flags: { launcher: true, armour: 1 } },
        dash_strike: { damage: 95, drive: { from: 2, to: 14, speed: 20 } },
      },
      // Quake Drop: hops up, slams down, and the landing sends out a
      // shockwave along the floor on BOTH sides. Blockable. It misses a car
      // that's in the air (the shock box only reaches 0.8 up).
      // startup 24 = it lands on move frame 24 (measured), so the shock
      // first hits on frame 25 counting the press as frame 1.
      signature: {
        name: "Quake Drop", input: "boost+heavy", button: "heavy", usesBoost: true,
        startup: 24, active: 4, recovery: 26,
        damage: 210, hitstun: 0, blockstun: 18,
        push: 9, launch: 0, airLaunch: 0, hitstop: 10, meter: 0,
        box: null,
        shock: { frames: 4, box: { x0: -4.5, x1: 4.5, y0: -0.3, y1: 0.8, z: 2.0 } },
        impulses: [{ at: 0, vy: 12 }, { at: 19, vy: -26 }],
        cost: { super: 100 },
        cancel: [],
        flags: { signature: true, knockdown: true, shockwave: true },
      },
      // Bot habits: leans on the armoured Ram, dashes and dodges less.
      bot: { superRange: [0, 4.3], routeBias: { heavy: 4 }, dashBias: -0.05, sidestepBonus: -0.03 },
    },

    /* ---------- Skitter: the light ---------- */
    skitter: {
      id: "skitter",
      name: "Skitter",
      displayName: "Skitter",
      role: "Speedster",
      blurb: "A low wedge that slides everywhere. Weak hits, fast hands, and it's gone before you swing.",
      stats: { power: 2, speed: 5, weight: 1, reach: 2 },
      health: 950,                      // tuned from 850 (QC sims: rounds too short, Skitter too weak)
      tuning: { maxSpeed: 20, boostMax: 31, grip: 7 },
      knockbackMul: 1.05,               // takes 5% more knockback (tuned from 1.1)
      sidestep: { frames: 18 },         // quick dodge, same invulnerability
      damageMul: 0.85,
      startupDelta: -1,
      lightRecoveryDelta: -2,
      moveOverrides: {
        dash_strike: { cost: { boost: 20 }, drive: { from: 2, to: 14, speed: 28 } },
      },
      // Slipstream: an invulnerable boost dash THROUGH the opponent. On the
      // far side it skids and turns round, and the hit comes out 6 frames
      // later. It's a real cross-up: the defender's auto-face turns too, so
      // holding the NEW away blocks it. Whiffs (and is very punishable) if
      // it never gets through, e.g. against a sidestep.
      signature: {
        name: "Slipstream", input: "boost+heavy", button: "heavy", usesBoost: true,
        startup: 6, active: 24, recovery: 22,
        damage: 180, hitstun: 26, blockstun: 16,
        push: 10, launch: 0, airLaunch: 7, hitstop: 10, meter: 0,
        box: { x0: 0.3, x1: 3.0, y0: 0.0, y1: 1.5, z: 1.3 },
        drive: { from: 2, to: 16, speed: 30 },
        invuln: [0, 18],
        passThrough: [0, 20],
        crossup: { delay: 6 },
        cost: { super: 100 },
        cancel: [],
        flags: { signature: true, crossup: true },
      },
      // Bot habits: sidesteps and dashes more; Slipstream from mid range.
      bot: { superRange: [2.5, 7.5], sidestepBonus: 0.1, dashBias: 0.12 },
    },
  };

  TP.DEFAULT_FIGHTER = "rivet";
  TP.FIGHTER_IDS = Object.keys(TP.FIGHTERS);

  // Look up a fighter, falling back to Rivet for unknown ids.
  TP.fighterDef = function (id) {
    const key = id && String(id).toLowerCase();
    if (TP.FIGHTERS[key]) return TP.FIGHTERS[key];
    if (id && key !== TP.DEFAULT_FIGHTER) console.warn(`[Car Fighter] Unknown fighter "${id}", using Rivet.`);
    return TP.FIGHTERS[TP.DEFAULT_FIGHTER];
  };

  /* The full move table for one fighter (see the header for the order).
     Every row is a fresh copy, so the shared TP.MOVES is never modified. */
  TP.fighterMoves = function (id) {
    const def = TP.fighterDef(id);
    const moves = {};
    for (const [key, base] of Object.entries(TP.MOVES)) {
      const isSig = key === "signature";
      // A car's own signature row REPLACES the base one (no mixing, so
      // Quake Drop can't inherit Grinder's multi-hit list).
      const own = isSig && def.signature && Object.keys(def.signature).length ? def.signature : null;
      const row = Object.assign({}, own || base);
      row.id = key;
      row.box = row.box ? Object.assign({}, row.box) : null;
      row.flags = Object.assign({}, row.flags);
      if (row.hits) row.hits = row.hits.map((h) => Object.assign({}, h));

      if (!isSig) {
        // Broad modifiers first.
        if (def.damageMul) row.damage = Math.round(row.damage * def.damageMul);
        if (def.startupDelta && !row.flags.throw) row.startup = Math.max(1, row.startup + def.startupDelta);
        if (LIGHTS.includes(key)) {
          if (def.lightStartupDelta) row.startup = Math.max(1, row.startup + def.lightStartupDelta);
          if (def.lightRecoveryDelta) row.recovery = Math.max(1, row.recovery + def.lightRecoveryDelta);
        }
        // Then exact numbers.
        const over = def.moveOverrides[key];
        if (over) {
          Object.assign(row, over, {
            box: over.box ? Object.assign({}, row.box, over.box) : row.box,
            flags: Object.assign({}, row.flags, over.flags),
          });
        }
      }
      moves[key] = row;
    }
    return moves;
  };

  // The car physics settings for a fighter: shared defaults + allowed tweaks.
  TP.fighterTuning = function (id) {
    return TP.modeTuning(TP.fighterDef(id).tuning);
  };
})();
