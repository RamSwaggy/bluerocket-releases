/* =====================================================================
   bot.js — the Car Fighter bot. One brain, with difficulty as numbers.

   The bot outputs exactly the same controls a human does (the input.js
   shape: steer, throttle, boost, jump, hit, heavy and the *Pressed
   flags), so it can't do anything a player couldn't.

   It sees its opponent LATE: every decision about the other car uses
   where that car was `reactFrames` ago (Normal: 15 frames = 250 ms).
   So it can't block a fast Jab on reaction, only slower moves, or by
   already guarding, just like a person.

   How it thinks, each frame, in order:
     1. Stunned, knocked down, thrown? Nothing to do.
     2. Mid-combo? Press the next button of its combo plan once the
        current move has connected (cancels only work after a hit/block).
     3. In the air? Finish a jump-in or juggle plan.
     4. Defence: the other car is attacking and close. Roll ONCE per
        enemy move whether to block it, sidestep it, or eat it.
     5. Punish: the other car is stuck in a long recovery up close
        (whiffed or blocked heavy). Roll once whether to punish.
     6. Neutral: an "intent" picked every 10-35 frames (approach, guard,
        hold, retreat, jump in, dash in), and attacks when in range.
   When it's losing near time-out, it gets more aggressive and blocks
   less, so rounds don't stall.
   ===================================================================== */
window.TP = window.TP || {};

(function () {
  "use strict";

  /* ---------- Difficulty table (DESIGN §8) ----------
     reactFrames    reaction delay in 60 Hz frames (450 / 250 / 120 ms)
     blockChance    chance to block a seen attack
     sidestepChance chance to sidestep a seen attack instead
     punishChance   chance to punish a long recovery up close
     maxComboHits   longest combo it will try
     aggression     0..1, how often it chooses to go in and attack
     spacing        0..1, how much it likes to hold its range instead
     throwVsBlocker chance to throw an opponent who has been blocking a lot
     juggleChance   chance to go for the launcher-juggle route
     specialChance  chance to use a full super bar when in range
     All three are tuned with QC's sims (Rivet mirror, both seat orders):
     Hard beats Normal about 75%, Normal beats Easy about 80% (DESIGN §6). */
  TP.BOT_LEVELS = {
    easy: {
      reactFrames: 27, blockChance: 0.15, sidestepChance: 0.02, punishChance: 0.1,
      maxComboHits: 2, aggression: 0.7, spacing: 0.1, throwVsBlocker: 0.05,
      juggleChance: 0.0, specialChance: 0.3,
    },
    normal: {
      reactFrames: 15, blockChance: 0.45, sidestepChance: 0.08, punishChance: 0.5,
      maxComboHits: 4, aggression: 0.55, spacing: 0.5, throwVsBlocker: 0.3,
      juggleChance: 0.4, specialChance: 0.6,
    },
    hard: {
      reactFrames: 7, blockChance: 0.65, sidestepChance: 0.12, punishChance: 0.75,
      maxComboHits: 5, aggression: 0.5, spacing: 0.8, throwVsBlocker: 0.55,
      juggleChance: 0.75, specialChance: 0.8,
    },
  };

  // Combo routes, as button steps. "jump" is a jump-cancel, not a hit.
  const ROUTES = [
    { steps: ["hit", "hit", "hit"], weight: 3 },                       // Jab, Swipe, Spinout
    { steps: ["hit", "hit", "heavy"], weight: 3 },                     // ... into Ram
    { steps: ["hit", "hit"], weight: 2 },
    { steps: ["hit", "heavy"], weight: 2 },
    { steps: ["hit", "dash"], weight: 1, needBoost: true },            // ... into Dash Strike
    { steps: ["heavy"], weight: 1 },                                   // a lone Ram
    { steps: ["hit", "heavyToward", "jump", "airHit", "airHeavy"], weight: 3, juggle: true },
    { steps: ["heavyToward", "jump", "airHit", "airHeavy"], weight: 1, juggle: true },
  ];
  const hitsIn = (steps) => steps.filter((s) => s !== "jump").length;

  const FREE = new Set(["idle", "walk", "block"]);

  function create({ level = "normal", seed = 1, index = 0 } = {}) {
    const L = TP.BOT_LEVELS[level] || TP.BOT_LEVELS.normal;
    const rng = TP.Fight.makeRng(seed);

    const history = [];      // snapshots of the opponent, newest last
    let plan = null;         // { steps, i } — the combo being executed
    let intent = "approach";
    let intentFrames = 0;
    let attackCooldown = 0;
    let defendedSerial = -1; // which enemy move we've already rolled defence for
    let defence = null;      // "block" | "sidestep" | null for that move
    let punishedSerial = -1;
    let oppBlocks = 0;       // recent blocks by the opponent (to spot a turtle)
    let eventIndex = 0;
    let wasFree = true;      // were we free last frame? (to spot getting up from stun)
    let hesitate = 0;        // frames to stand still after getting up (breaks mirror loops)
    let jumpSerial = 0;      // counts the opponent's jumps, as the bot saw them
    let seenWasAir = false;
    let airDefendedSerial = -1;
    let airDefence = null;   // "block" | "antiair" | null for that jump

    function blank() {
      return {
        throttle: 0, steer: 0, pitch: 0, boost: false, jump: false, hit: false, heavy: false,
        confirmPressed: false, hitPressed: false, heavyPressed: false, leftPressed: false, rightPressed: false,
      };
    }

    // Set the controls for one combo/plan step. `toward` is the X direction of the opponent.
    function pressStep(out, step, toward) {
      switch (step) {
        case "hit": case "airHit": out.hit = out.hitPressed = true; break;
        case "heavy": case "airHeavy": out.heavy = out.heavyPressed = true; break;
        case "heavyToward": out.steer = toward; out.heavy = out.heavyPressed = true; break;
        case "heavyAway": out.steer = -toward; out.heavy = out.heavyPressed = true; break;
        case "dash": out.boost = true; out.hit = out.hitPressed = true; break;
        case "super": out.boost = true; out.heavy = out.heavyPressed = true; break;
        case "throw": out.hit = out.hitPressed = true; out.heavy = out.heavyPressed = true; break;
        case "jump": out.jump = out.confirmPressed = true; break;
      }
    }

    // Should we spend a super bar on the signature move right now? Only in
    // the car's own range, and not always: it saves meter unless it has
    // two bars, or the hit would (nearly) finish the round.
    function wantSuper(me, op, dist) {
      if (me.super < 100) return false;
      const H = habits(me);
      const range = H.superRange || [0, 4.2];
      if (dist < range[0] || dist > range[1]) return false;
      if (me.super >= 200 || op.health <= 260) return rng() < L.specialChance;
      return rng() < L.specialChance * 0.3;
    }

    const habits = (me) => (TP.fighterDef(me.fighter).bot || {});

    function pickRoute(me, F, dist, op) {
      if (op && wantSuper(me, op, dist)) return ["super"];
      // A turtle up close: throw them.
      if (oppBlocks >= 2 && dist < 3.7 && rng() < L.throwVsBlocker) { oppBlocks = 0; return ["throw"]; }
      // Pinned near a rail with the opponent close: Tailwhip shoves them off.
      if (Math.abs(me.x) > 9.5 && Math.sign(me.x) !== Math.sign(me.facing) && dist < 4 && rng() < 0.35) return ["heavyAway"];
      const options = ROUTES.filter((r) =>
        hitsIn(r.steps) <= L.maxComboHits &&
        (!r.needBoost || me.boost >= 25) &&
        (!r.juggle || L.juggleChance > 0));
      let total = 0;
      const bias = habits(me).routeBias || {};
      const weights = options.map((r) => {
        let w = r.juggle ? r.weight * L.juggleChance * 2 : r.weight;
        // Per-car habit: e.g. Haulback likes routes ending in its armoured Ram.
        if (bias.heavy && r.steps[r.steps.length - 1] === "heavy") w += bias.heavy;
        total += w;
        return w;
      });
      let roll = rng() * total;
      for (let k = 0; k < options.length; k++) {
        roll -= weights[k];
        if (roll <= 0) return options[k].steps.slice();
      }
      return ["hit", "hit"];
    }

    function chooseIntent(dist, aggr, me) {
      const r = rng();
      if (dist > 8) {
        const dash = 0.1 + (habits(me).dashBias || 0);
        intent = r < 0.65 ? "approach" : r < 0.65 + dash && me.boost >= 40 ? "dash" : r < 0.85 ? "jumpin" : "hold";
      } else if (dist > 4.3) {
        if (r < aggr) intent = rng() < 0.2 ? "jumpin" : "approach";
        else if (r < aggr + L.spacing * 0.35) intent = "hold";
        else intent = "guard";
      } else {
        intent = r < aggr ? "attack" : r < aggr + 0.25 ? "guard" : "retreat";
      }
      intentFrames = 10 + Math.floor(rng() * 25);
    }

    /* ---------- think(fight, i): this frame's controls for car i ---------- */
    function think(fight, i) {
      const S = fight.state;
      const out = blank();
      const me = S.cars[i], op = S.cars[1 - i];
      if (!me || !op) return out;
      const F = fight._fighters[i];
      const O = fight._fighters[1 - i];

      // Remember what the opponent was doing this frame.
      history.push({ state: op.state, move: op.move, moveFrame: op.moveFrame, serial: O.moveSerial, x: op.x, y: op.y });
      if (history.length > 64) history.shift();
      const seen = history[Math.max(0, history.length - 1 - L.reactFrames)];

      // Learn from events: is the opponent blocking our stuff a lot?
      for (; eventIndex < fight.events.length; eventIndex++) {
        const e = fight.events[eventIndex];
        if (e.attacker !== i) continue;
        if (e.type === "block") oppBlocks = Math.min(6, oppBlocks + 1);
        else if (e.type === "hit") oppBlocks = Math.max(0, oppBlocks - 1);
      }

      if (S.phase !== "fight") { if (S.phase !== "hitstop") plan = null; return out; }

      const toward = Math.sign(seen.x - me.x) || me.facing;
      const dist = Math.abs(seen.x - me.x);
      if (attackCooldown > 0) attackCooldown--;

      // Count the opponent's jumps (as seen, i.e. late).
      const seenAir = seen.state === "air" || (seen.state === "attack" && O.moves[seen.move] && O.moves[seen.move].air);
      if (seenAir && !seenWasAir) jumpSerial++;
      seenWasAir = seenAir;

      // Just got up from a hit, knockdown or block: rethink from scratch,
      // after a short random pause. Two identical bots would otherwise do
      // the same thing on the same frame forever.
      const free = FREE.has(me.state);
      if (free && !wasFree) {
        intentFrames = 0;
        hesitate = Math.floor(rng() * 14);
      }
      wasFree = free;

      // Losing near the end of the round: press harder, guard less.
      const behind = S.timer < 15 && me.health / me.maxHealth < op.health / op.maxHealth;
      const H = habits(me);
      const aggr = behind ? 0.95 : Math.min(0.95, L.aggression + (H.aggressionBonus || 0));
      const sidestepChance = L.sidestepChance + (H.sidestepBonus || 0);
      const blockChance = behind ? L.blockChance * 0.4 : L.blockChance;

      /* 1. Can't act. */
      if (!FREE.has(me.state) && me.state !== "attack" && me.state !== "air") {
        if (me.state !== "juggle" || !plan) plan = null;
        return out;
      }

      /* 2. Mid-move: continue the combo plan once this move connects. */
      if (me.state === "attack") {
        if (plan && plan.i < plan.steps.length && F.moveConnected) {
          if (F.moveBlocked && rng() < 0.7) { plan = null; return out; }  // usually stop on block
          const step = plan.steps[plan.i];
          if (step === "airHit") return out;                             // wait until airborne
          pressStep(out, step, toward);
          plan.i++;
        }
        return out;
      }

      /* 3. In the air: jump-ins and juggles. */
      if (me.state === "air") {
        if (plan && plan.i < plan.steps.length && plan.steps[plan.i] === "airHit") {
          const dx = Math.abs(op.x - me.x), dy = op.y - me.y;
          // Swing when the target is close, or we're already falling.
          if ((dx < 3.6 && dy > -1.5 && dy < 2) || (me.vy < -6 && dx < 4.5)) {
            pressStep(out, "airHit", toward);
            plan.i++;
          }
        }
        return out;
      }

      // From here on the car is free on the ground. A plan that has run
      // (finished, missed or was blocked) is over: back off or guard for a
      // moment, like a player resetting after a combo.
      if (plan && (plan.i > 0 || plan.steps[0] === "airHit")) {
        plan = null;
        intent = rng() < 0.5 ? "guard" : "retreat";
        intentFrames = 15 + Math.floor(rng() * 30 * (1.2 - aggr));
      }

      /* 4a. Defence against a jump-in: guard, or knock them out of the air. */
      if (seenAir && dist < 7) {
        if (jumpSerial !== airDefendedSerial) {
          airDefendedSerial = jumpSerial;
          const r = rng();
          airDefence = r < blockChance ? "block" : r < blockChance + L.juggleChance * 0.6 ? "antiair" : null;
        }
        if (airDefence === "antiair" && dist < 4.6 && seen.y > 0.6) {
          airDefence = null;
          pressStep(out, "heavyToward", toward);          // Corkscrew reaches up
          attackCooldown = 20;
          return out;
        }
        if (airDefence === "block") { out.steer = -toward; return out; }
      }

      if (hesitate > 0) { hesitate--; return out; }

      /* 4b. Defence against ground attacks. */
      if (seen.state === "attack" && seen.move) {
        const m = O.moves[seen.move];
        const reach = (m.box ? m.box.x1 : m.range || 3) + 1.5;
        if (seen.serial !== defendedSerial) {
          defendedSerial = seen.serial;
          const r = rng();
          defence = m.flags.throw ? null : r < blockChance ? "block" : r < blockChance + sidestepChance ? "sidestep" : null;
        }
        const coming = seen.moveFrame < m.startup + m.active && dist < reach + 3;
        if (coming && defence === "block") { out.steer = -toward; return out; }
        if (coming && defence === "sidestep" && seen.moveFrame < m.startup) {
          defence = null;
          out.pitch = rng() < 0.5 ? 1 : -1;      // tap up or down: sidestep
          return out;
        }
        /* 5. Punish a long recovery up close. */
        const framesLeft = TP.moveFrames(m) - seen.moveFrame;
        if (seen.moveFrame >= m.startup + m.active && framesLeft >= 8 && dist < 4.3 && seen.serial !== punishedSerial) {
          punishedSerial = seen.serial;
          if (rng() < L.punishChance) {
            plan = { steps: pickRoute(me, F, dist, op), i: 0 };
          }
        }
      }

      /* 6. Neutral. */
      if (!plan) {
        if (--intentFrames <= 0) chooseIntent(dist, aggr, me);
        const inRange = dist < 4.0;
        // A signature that works from mid range (Skitter's Slipstream).
        // (Checked every frame, so it only rolls 1 frame in 15 on average.)
        if (!inRange && attackCooldown <= 0 && (H.superRange || [0])[0] > 0 && rng() < 0.07 && wantSuper(me, op, dist)) {
          plan = { steps: ["super"], i: 0 };
        }
        // In range: attack, but not every frame. `aggr` sets how keen it is.
        const keen = intent === "attack" ? 0.35 : intent === "approach" ? 0.2 : 0.03;
        if (plan) { /* chosen above */ }
        else if (inRange && attackCooldown <= 0 && rng() < keen * (0.5 + aggr)) {
          plan = { steps: pickRoute(me, F, dist, op), i: 0 };
        } else if (intent === "dash" && dist > 5 && dist < 11 && me.boost >= 25 && attackCooldown <= 0) {
          plan = { steps: ["dash"], i: 0 };
        } else if (intent === "jumpin" && dist > 3.5 && dist < 8.5 && me.vx * toward > 6) {
          // Jump while running in, then swing on the way down.
          pressStep(out, "jump", toward);
          out.steer = toward;
          plan = { steps: ["airHit", "airHeavy"], i: 0 };
          intentFrames = 40;
          return out;
        }
      }

      if (plan && plan.i === 0) {
        pressStep(out, plan.steps[0], toward);
        plan.i = 1;
        attackCooldown = Math.round((50 + rng() * 60) * (1.4 - aggr));
        return out;
      }

      // Footwork.
      switch (intent) {
        case "approach": case "jumpin": case "attack": case "dash":
          if (dist > 2.8) out.steer = toward;
          break;
        case "retreat":
          out.steer = -toward;
          break;
        case "guard":
          if (dist < 7) out.steer = -toward; // holding away = blocking
          break;
        case "hold":
          break;
      }
      return out;
    }

    return { level, think };
  }

  TP.FightBot = { create };
})();
