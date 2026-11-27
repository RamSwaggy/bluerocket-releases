/* =====================================================================
   fighters.js — the fighter cars: health, handling, move-table changes
   and each car's signature move.

   "One car feel" (TEAMS.md): every car drives like the shared Rocket
   Rumble car. Handling may only differ through TP.modeTuning() and its
   allowed settings (maxSpeed, boostMax, grip, pivot, bumpScale).
   Everything else that makes a car different is fight data: health,
   frame data, damage, and the signature move.

   M1 has Rivet only. Haulback and Skitter arrive in M2 (DESIGN §6).
   ===================================================================== */
window.TP = window.TP || {};

(function () {
  "use strict";

  TP.FIGHTERS = {
    rivet: {
      id: "rivet",
      name: "Rivet",
      role: "All-rounder",
      health: 1000,
      tuning: {},            // shared car defaults
      moveOverrides: {},     // balanced: uses TP.MOVES as written
      // Signature move "Grinder" (a multi-hit spinning sweep) is stubbed
      // for M1 as a big Ram: the default TP.MOVES.signature row.
      signature: { name: "Grinder" },
    },
  };

  TP.DEFAULT_FIGHTER = "rivet";

  // Look up a fighter, falling back to Rivet for unknown ids (e.g. ?p1=skitter in M1).
  TP.fighterDef = function (id) {
    if (TP.FIGHTERS[id]) return TP.FIGHTERS[id];
    if (id && id !== TP.DEFAULT_FIGHTER) console.warn(`[Car Fighter] Unknown fighter "${id}", using Rivet.`);
    return TP.FIGHTERS[TP.DEFAULT_FIGHTER];
  };

  /* The full move table for one fighter: a copy of TP.MOVES with that
     car's changes merged on top (row by row, field by field), so the
     shared table is never modified. */
  TP.fighterMoves = function (id) {
    const def = TP.fighterDef(id);
    const moves = {};
    for (const [key, row] of Object.entries(TP.MOVES)) {
      const over = (key === "signature" ? def.signature : def.moveOverrides[key]) || {};
      moves[key] = Object.assign({}, row, over, {
        id: key,
        // Nested objects are merged one level deep too.
        box: row.box || over.box ? Object.assign({}, row.box, over.box) : null,
        flags: Object.assign({}, row.flags, over.flags),
      });
    }
    return moves;
  };

  // The car physics settings for a fighter: shared defaults + allowed tweaks.
  TP.fighterTuning = function (id) {
    return TP.modeTuning(TP.fighterDef(id).tuning);
  };
})();
