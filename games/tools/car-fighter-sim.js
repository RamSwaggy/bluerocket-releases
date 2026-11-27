/* =====================================================================
   car-fighter-sim.js — fast, headless Car Fighter checks. It loads the
   page with &headless (no rendering), then builds its own fights with
   TP.Fight.create and steps them directly, many times faster than real
   time.

   Two modes:

   1) Bot-vs-bot statistics
        node tools/car-fighter-sim.js [matches] [seed]
        node tools/car-fighter-sim.js 50 1000
      Plays N whole matches (seeds seed, seed+1, ...) and reports:
        • win split (a mirror match should be close to 50/50)
        • average and longest round, % of rounds that went to time-out
        • damage and hit count per move, blocks per move
        • the longest combo seen
        • stuck states: a car left in one timed state far too long
        • matches that never finished, and any exceptions
      Options: --p1=rivet --p2=rivet --bot=normal --bot2=normal

   2) Frame-data check
        node tools/car-fighter-sim.js frames [seed]
      For every move in TP.MOVES: puts the two cars at a set distance,
      presses the move with scripted inputs (exactly the controls a
      human would send), steps frame by frame, and compares what really
      happened with the table: the frame the hit lands, damage, hit-stun,
      and on a blocked hit the chip damage, block-stun and frame advantage.

   Both modes take --page=<path> to point at a different page, and
   --extra=<query> to add URL options to it.

   Frame numbers: "frame" in the frames report is the move frame the hit
   landed on, counting the frame the button was pressed as frame 1.
   Per DESIGN.md §9 the first active frame is startup+1, counting
   the press frame as 1. A move that doesn't travel must hit exactly then
   (the cars start touching). A move that carries the car forward may hit
   anywhere in its active window.
   Exit code 0 = no errors and nothing out of line; 1 otherwise.

   Built against the fight-core contract in car-fighter/DESIGN.md §9.
   Needs Playwright (pre-installed in cloud sessions).
   ===================================================================== */
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

// ---- Command line ----
const flags = {};
const pos = [];
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) flags[m[1]] = m[2];
  else pos.push(a);
}
const mode = pos[0] === "frames" ? "frames" : "stats";
const matches = mode === "stats" ? Number(pos[0] || 20) : 0;
const seed = Number((mode === "stats" ? pos[1] : pos[1]) || 1000);
const pagePath = path.resolve(__dirname, "..", flags.page || "car-fighter/index.html");

/* =====================================================================
   Code that runs INSIDE the page. It is a plain function so Playwright
   can send it over; everything it needs is defined inside it.
   ===================================================================== */
function inPage(args) {
  const { mode, matches, seed, opts } = args;
  const FPS = 60;

  /* ---------- Controls ----------
     The fight takes controls in the shared input.js shape, plus the new
     Heavy button (heavy / heavyPressed). We always send every field so a
     missing one can't read as undefined inside the fight. */
  const NEUTRAL = Object.assign(
    { throttle: 0, steer: 0, boost: false, jump: false, hit: false, heavy: false,
      confirmPressed: false, hitPressed: false, heavyPressed: false, leftPressed: false, rightPressed: false },
    (TP.Input && TP.Input.NEUTRAL) || {}
  );
  NEUTRAL.heavy = NEUTRAL.heavy || false;
  NEUTRAL.heavyPressed = NEUTRAL.heavyPressed || false;
  const neutral = () => Object.assign({}, NEUTRAL);

  function newFight(p1, p2, s, rounds, roundTime) {
    // fight.js needs a scene for TP.Car's mesh; nothing is ever drawn.
    const scene = new THREE.Scene();
    return TP.Fight.create({ p1, p2, rounds: rounds || 3, roundTime: roundTime || 60, seed: s, scene });
  }

  // States that should always run out on their own. If a car sits in one
  // of these far longer than any move could take, it's a stuck state.
  const TIMED_STATES = ["attack", "hitstun", "blockstun", "knockdown", "wakeup", "thrown", "sidestep", "juggle"];
  const STUCK_FRAMES = 6 * FPS;     // 6 seconds in one timed state = stuck
  const AIR_STUCK_FRAMES = 10 * FPS; // airborne this long = probably resting on something

  /* =================================================================
     Mode 1: bot-vs-bot statistics
     ================================================================= */
  function runStats() {
    const out = {
      matches: 0, unfinished: [], exceptions: [], wins: [0, 0, 0],
      rounds: 0, roundFrames: [], timeouts: 0, draws: 0,
      moves: {}, maxCombo: 0, maxComboAt: null, stuck: [], kos: 0,
    };
    // Hard cap per match: 4 rounds of the round time, plus generous extra
    // for intros, countdowns, hit-stop and KO cards.
    const roundTime = Number(opts.roundTime || 60);
    const cap = Math.ceil((4 * roundTime + 60) * FPS);

    for (let m = 0; m < matches; m++) {
      const s = seed + m;
      let fight;
      try {
        fight = newFight(
          { fighter: opts.p1 || "rivet", controller: "bot", bot: opts.bot || "normal" },
          { fighter: opts.p2 || "rivet", controller: "bot", bot: opts.bot2 || opts.bot || "normal" },
          s, 3, roundTime
        );
        let evIndex = 0, roundStart = 0;
        // Per car: which state it's in and since which frame.
        const since = [{ key: "", frame: 0, flagged: false }, { key: "", frame: 0, flagged: false }];
        let f = 0;
        for (; f < cap && fight.state.phase !== "matchEnd"; f++) {
          fight.step([neutral(), neutral()]);
          const st = fight.state;

          // ---- stuck-state watch ----
          st.cars.forEach((c, i) => {
            const key = c.state + "|" + (c.move || "");
            if (key !== since[i].key) { since[i] = { key, frame: st.frame, flagged: false }; return; }
            const held = st.frame - since[i].frame;
            const limit = c.state === "air" ? AIR_STUCK_FRAMES : TIMED_STATES.includes(c.state) ? STUCK_FRAMES : Infinity;
            if (held > limit && !since[i].flagged && st.phase !== "matchEnd") {
              since[i].flagged = true;
              out.stuck.push(`seed ${s}: P${i + 1} stuck in "${c.state}"${c.move ? ` (move ${c.move})` : ""} for ${(held / FPS).toFixed(1)}s ` +
                `from frame ${since[i].frame}, stateFramesLeft=${c.stateFramesLeft}, pos (${c.x.toFixed(1)}, ${c.y.toFixed(1)}, ${c.z.toFixed(1)})`);
            }
          });

          // ---- combos (the state's own counter) ----
          st.cars.forEach((c) => {
            if ((c.combo || 0) > out.maxCombo) { out.maxCombo = c.combo; out.maxComboAt = `seed ${s}, frame ${st.frame}`; }
          });

          // ---- new events ----
          for (; evIndex < fight.events.length; evIndex++) {
            const e = fight.events[evIndex];
            if (e.type === "hit" || e.type === "block" || e.type === "throw") {
              const mv = (out.moves[e.move || "?"] = out.moves[e.move || "?"] || { hits: 0, blocks: 0, throws: 0, damage: 0 });
              if (e.type === "hit") mv.hits++;
              if (e.type === "block") mv.blocks++;
              if (e.type === "throw") mv.throws++;
              mv.damage += e.damage || 0;
            }
            if (e.type === "combo_end" && (e.hits || 0) > out.maxCombo) { out.maxCombo = e.hits; out.maxComboAt = `seed ${s}, frame ${e.frame}`; }
            if (e.type === "ko") out.kos++;
            if (e.type === "round_start") roundStart = e.frame;
            if (e.type === "round_end") {
              out.rounds++;
              out.roundFrames.push(e.frame - roundStart);
              const reason = String(e.reason || "");
              const timedOut = /time/i.test(reason) || (!reason && st.timer <= 0.0001);
              if (timedOut) out.timeouts++;
              if (/draw/i.test(reason) || e.winner === null || e.winner === -1 || e.winner === "draw") out.draws++;
            }
          }
        }
        if (fight.state.phase !== "matchEnd") {
          out.unfinished.push(`seed ${s}: still "${fight.state.phase}" after ${f} frames, round ${fight.state.round}, HP ${fight.state.cars.map((c) => Math.round(c.health)).join("/")}`);
        } else {
          const w = fight.state.winner;
          out.wins[w === 0 ? 0 : w === 1 ? 1 : 2]++;
        }
        out.matches++;
      } catch (err) {
        out.exceptions.push(`seed ${s}: ${err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err}`);
      }
    }
    return out;
  }

  /* =================================================================
     Mode 2: frame-data check
     ================================================================= */

  // Read one TP.MOVES row whatever the exact field names turn out to be
  // (startup/active/recovery may sit at the top level or inside .frames).
  function normMove(id, m) {
    const f = m.frames || m;
    const pick = (...names) => { for (const n of names) { if (f[n] !== undefined) return f[n]; if (m[n] !== undefined) return m[n]; } return undefined; };
    const flagsObj = Array.isArray(m.flags) ? Object.fromEntries(m.flags.map((x) => [x, true])) : (m.flags || {});
    return {
      id, name: m.name || id,
      startup: pick("startup"), active: pick("active"), recovery: pick("recovery"),
      damage: pick("damage", "dmg"), hitstun: pick("hitstun", "hitStun"), blockstun: pick("blockstun", "blockStun"),
      flags: Object.assign({}, flagsObj, { launcher: m.launcher || flagsObj.launcher, throw: m.throw || flagsObj.throw }),
      input: m.input, cost: m.superCost || m.cost, internal: isInternal(m),
      reach: m.hitbox ? (m.hitbox.x || 0) + (m.hitbox.forward || 0) + (m.hitbox.w || m.hitbox.size || 0) / 2 : undefined,
    };
  }
  // Rows marked internal: true (e.g. "landing", a recovery state with no
  // button) aren't moves a player can press, so they're left out entirely.
  const isInternal = (m) => !!(m && (m.internal || (m.flags && m.flags.internal)));
  function listMoves() {
    return allMoves().filter((mv) => !mv.internal);
  }
  function allMoves() {
    const T = TP.MOVES;
    if (!T) return [];
    if (Array.isArray(T)) return T.map((m, i) => normMove(m.id || "move" + i, m));
    // Could be { jab: {...}, ... } or { base: { jab: {...} }, rivet: {...} }.
    const vals = Object.values(T);
    if (vals.length && vals.every((v) => v && typeof v === "object" && (v.damage !== undefined || v.frames || v.startup !== undefined)))
      return Object.entries(T).map(([id, m]) => normMove(m.id || id, m));
    const base = T.base || T.rivet || T.default || vals[0];
    return Object.entries(base).map(([id, m]) => normMove(m.id || id, m));
  }

  /* Input recipe for each move. `input` on the table row wins if
     Gameplay adds one (e.g. "toward+heavy", "jump>hit", "hit*3",
     "hit+heavy", "boost+heavy"); otherwise we guess from the move's
     id/name, matching the move list in DESIGN.md §4. */
  function recipeFor(mv) {
    let s = (mv.input || "").toLowerCase();
    if (!s) {
      const n = (mv.id + " " + mv.name).toLowerCase();
      if (mv.flags.throw || /tow|hook|throw|grab/.test(n)) s = "hit+heavy";
      else if (/sig|grinder|quake|slipstream|special|super/.test(n) || mv.flags.signature) s = "boost+heavy";
      else if (/jab/.test(n)) s = "hit";
      else if (/swipe/.test(n)) s = "hit*2";
      else if (/spin/.test(n)) s = "hit*3";
      else if (/cork/.test(n)) s = "toward+heavy";
      else if (/tail|whip/.test(n)) s = "away+heavy";
      else if (/dash/.test(n)) s = "boost+hit";
      else if (/flip|kick/.test(n)) s = "jump>hit";
      else if (/drop|slam/.test(n)) s = "jump>heavy";
      else if (/ram/.test(n)) s = "heavy";
      else return null;
    }
    // Parse: "jump>X" = jump first, X once airborne; "hit*3" = press hit
    // repeatedly (a chain); "a+b" = held/pressed together.
    const r = { jumpFirst: false, repeat: 1, hold: {}, press: {} };
    if (s.startsWith("jump>")) { r.jumpFirst = true; s = s.slice(5); }
    const rep = s.match(/\*(\d+)$/);
    if (rep) { r.repeat = Number(rep[1]); s = s.replace(/\*\d+$/, ""); }
    for (const tok of s.split("+").map((t) => t.trim())) {
      if (tok === "toward" || tok === "away" || tok === "up" || tok === "down") r.hold[tok] = true;
      else if (tok === "boost") r.hold.boost = true;
      else if (tok === "hit" || tok === "heavy" || tok === "jump") r.press[tok] = true;
    }
    r.text = (r.jumpFirst ? "jump > " : "") + s + (r.repeat > 1 ? ` (x${r.repeat} chain)` : "");
    return r;
  }

  // Step with neutral input until the fight phase starts (skips intro and the 3-2-1 countdown).
  function skipToFight(fight) {
    for (let i = 0; i < 20 * FPS && fight.state.phase !== "fight"; i++) fight.step([neutral(), neutral()]);
    return fight.state.phase === "fight";
  }

  /* Which way does steer +1 move a car on the fighting line? Measured
     once rather than assumed, so "toward" and "away" are right. */
  function calibrateSteer() {
    const fight = newFight({ fighter: "rivet", controller: "kb1" }, { fighter: "rivet", controller: "kb2" }, seed, 3, 60);
    if (!skipToFight(fight)) return 1;
    const x0 = fight.state.cars[0].x;
    for (let i = 0; i < 30; i++) fight.step([Object.assign(neutral(), { steer: 1 }), neutral()]);
    const dx = fight.state.cars[0].x - x0;
    return Math.abs(dx) < 1e-3 ? 1 : Math.sign(dx);
  }

  // Put P1 on the left and P2 on the right, `dist` apart, at rest.
  // Returns the distance actually achieved after one settling frame.
  function place(fight, dist) {
    const [a, b] = fight.cars;
    if (a && a.pos && b && b.pos) {
      a.pos.set(-dist / 2, a.pos.y, 0); a.vel.set(0, 0, 0);
      b.pos.set(dist / 2, b.pos.y, 0); b.vel.set(0, 0, 0);
    }
    fight.step([neutral(), neutral()]);
    const [c1, c2] = fight.state.cars;
    return Math.hypot(c2.x - c1.x, c2.z - c1.z);
  }

  /* One scripted attempt: P1 does the move, P2 either stands still
     ("idle") or holds away to block ("block"). Returns what happened. */
  function attempt(mv, recipe, dist, defend, steerSign) {
    // Signature moves (boost+heavy) cost a super bar, so P1 starts with one
    // through the per-player `super` option (DESIGN.md §9, contract detail 3).
    const p1 = { fighter: opts.p1 || "rivet", controller: "kb1" };
    if (recipe.hold.boost && recipe.press.heavy) p1.super = 100;
    const fight = newFight(p1, { fighter: opts.p2 || "rivet", controller: "kb2" }, seed, 3, 60);
    if (!skipToFight(fight)) return { error: `never reached phase "fight" (stuck in "${fight.state.phase}")` };
    const realDist = place(fight, dist);
    const s0 = fight.state;
    const p1Right = s0.cars[0].x > s0.cars[1].x;
    // Screen direction (steer) for P1 toward P2, and for P2 away from P1.
    const towardP1 = (p1Right ? -1 : 1) * steerSign;
    const awayP2 = (p1Right ? -1 : 1) * steerSign; // P2 is on the other side, so its "away" is the same screen direction as P1's "toward"

    const evStart = fight.events.length;
    const hp0 = s0.cars[1].health;
    const res = {
      dist: realDist, moveStart: null, startMoveFrame: null, hit: null, hitRel: null,
      hpLoss: 0, stunFrames: 0, stunStates: [], attackerFree: null, defenderFree: null, otherMoves: [],
      super0: s0.cars[0].super,
    };
    let pressesDone = 0, lastPress = -99, airborneSince = null;
    // state.frame and P1's x on the step that held the latest button press.
    // The press that started the move is frame 1 of the move (contract detail 2).
    let lastPressFrame = null, lastPressX = null, hitstopSincePress = 0;

    for (let f = 0; f < 4 * FPS; f++) {
      const st = fight.state;
      const me = st.cars[0];
      const c1 = neutral();
      const c2 = neutral();

      // ---- P2: idle or block (hold away). ----
      if (defend === "block") c2.steer = awayP2;

      // ---- P1: hold modifiers, press buttons. ----
      if (recipe.hold.toward) c1.steer = towardP1;
      if (recipe.hold.away) c1.steer = -towardP1;
      if (recipe.hold.up) c1.throttle = 1;
      if (recipe.hold.down) c1.throttle = -1;
      if (recipe.hold.boost) c1.boost = true;

      let wantPress = res.moveStart === null || (recipe.repeat > pressesDone && me.move !== mv.id);
      if (recipe.jumpFirst) {
        if (f === 0) { c1.jump = true; c1.confirmPressed = true; wantPress = false; }
        else if (me.y <= 0.3 && airborneSince === null) wantPress = false;   // wait until we're actually up
        else if (airborneSince === null) airborneSince = f;
      }
      // Press at most every 4 frames (a chain needs the earlier hit to land first).
      if (wantPress && f - lastPress >= 4 && pressesDone < recipe.repeat + 6) {
        if (recipe.press.hit) { c1.hit = true; c1.hitPressed = true; }
        if (recipe.press.heavy) { c1.heavy = true; c1.heavyPressed = true; }
        if (recipe.press.jump) { c1.jump = true; c1.confirmPressed = true; }
        lastPress = f; pressesDone++;
      }
      const pressedNow = lastPress === f;
      const xBeforeStep = me.x;

      const hpBeforeStep = st.cars[1].health;
      const phaseBefore = st.phase;   // read before stepping: state may be one live object
      fight.step([c1, c2]);
      const after = fight.state;
      const a = after.cars[0], d = after.cars[1];
      if (pressedNow) { lastPressFrame = after.frame; lastPressX = xBeforeStep; hitstopSincePress = 0; }
      // Hit-stop freezes both cars (DESIGN.md §5), so those frames don't
      // count towards the move's frame number. A chain move pressed on the
      // frame the previous hit landed sits frozen through that hit-stop.
      // A step that began in hit-stop was a frozen frame.
      else if (phaseBefore === "hitstop" && !res.hit) hitstopSincePress++;

      if (a.move && a.move !== mv.id && !res.otherMoves.includes(a.move)) res.otherMoves.push(a.move);
      if (res.moveStart === null && a.move === mv.id) {
        res.moveStart = after.frame; res.startMoveFrame = a.moveFrame;
        // Count from the press that started it (falls back to the first frame the move shows).
        res.pressFrame = lastPressFrame !== null ? lastPressFrame : after.frame;
        res.pressX = lastPressX !== null ? lastPressX : a.x;
      }

      // First hit/block/throw by P1 with this move.
      if (res.moveStart !== null && !res.hit) {
        for (let i = evStart; i < fight.events.length; i++) {
          const e = fight.events[i];
          if (e.attacker === 0 && e.move === mv.id && (e.type === "hit" || e.type === "block" || e.type === "throw")) {
            res.hit = { type: e.type, damage: e.damage, stun: e.stun, frame: e.frame };
            // Move frame number of the hit, counting the press frame as frame 1.
            res.hitRel = e.frame - res.pressFrame + 1 - hitstopSincePress;
            res.hitstopFrames = hitstopSincePress;
            // How far P1 travelled between the press and the hit: a move that
            // travels (Dash Strike, lunges) may connect later in its active window.
            res.travel = Math.abs(a.x - res.pressX);
            res.hpAtHit = hpBeforeStep;
            break;
          }
        }
      }
      // After the hit: count the frames the defender spends in stun
      // (not counting hit-stop, when everything is frozen).
      if (res.hit) {
        if (["hitstun", "blockstun", "juggle", "knockdown", "thrown", "air"].includes(d.state) && res.defenderFree === null) {
          if (after.phase !== "hitstop") res.stunFrames++;
          if (!res.stunStates.includes(d.state)) res.stunStates.push(d.state);
        } else if (res.defenderFree === null && res.stunStates.length) res.defenderFree = after.frame;
        if (res.attackerFree === null && !a.move && ["idle", "walk", "block"].includes(a.state)) res.attackerFree = after.frame;
      }
      if (res.hit && res.defenderFree !== null && res.attackerFree !== null) break;
    }
    // Health lost from the moment this move connected (earlier chain hits not included).
    res.hpLoss = (res.hpAtHit !== undefined ? res.hpAtHit : hp0) - fight.state.cars[1].health;
    res.super1 = fight.state.cars[0].super;
    return res;
  }

  function runFrames() {
    const steerSign = calibrateSteer();
    const moves = listMoves();
    const report = { steerSign, rows: [], problems: 0, skipped: 0 };
    if (!moves.length) { report.fatal = "TP.MOVES is missing or empty"; return report; }

    for (const mv of moves) {
      const row = { id: mv.id, table: mv, notes: [], status: "OK" };
      const recipe = recipeFor(mv);
      if (!recipe) { row.status = "SKIP"; row.notes.push("no input recipe (add an `input` field to this row)"); report.skipped++; report.rows.push(row); continue; }
      row.input = recipe.text;
      try {
        // Try distances from close up outwards; the first that connects is used.
        const dists = mv.reach ? [Math.max(2.4, mv.reach), 2.6, 3.2, 4, 5.5, 7.5] : [2.6, 3.2, 4, 5.5, 7.5, 10];
        let hitRun = null;
        for (const d of dists) {
          const r = attempt(mv, recipe, d, mv.flags.throw ? "block" : "idle", steerSign);
          if (r.error) { row.notes.push(r.error); break; }
          if (r.hit) { hitRun = r; break; }
          if (!hitRun) hitRun = r; // keep the last miss for the report
        }
        row.hitRun = hitRun;
        const t = mv;
        if (!hitRun || hitRun.moveStart === null) {
          row.status = "FAIL";
          if (recipe.hold.boost && recipe.press.heavy && hitRun && hitRun.super0 < 100) row.notes.push(`move never started: needs a super bar, but P1 had ${hitRun.super0} even with super: 100 passed to TP.Fight.create`);
          else row.notes.push(`move never started${hitRun && hitRun.otherMoves.length ? ` (got ${hitRun.otherMoves.join(", ")} instead)` : ""}`);
        } else if (!hitRun.hit) {
          row.status = "FAIL";
          row.notes.push(`started but never connected at any distance up to ${dists[dists.length - 1]}`);
        } else {
          const h = hitRun.hit;
          /* Hit frame (contract detail 2): the first active frame is startup+1,
             counting the press frame as 1. The cars start touching, so a move
             that doesn't travel must land exactly on that frame. A move that
             carries the car forward (it moved > TRAVEL units before hitting) may
             land anywhere inside its active window. Either way the exact frame
             is reported. */
          if (t.startup !== undefined && t.active !== undefined) {
            const TRAVEL = 0.3;
            const first = t.startup + 1, last = t.startup + t.active;
            const travelled = (hitRun.travel || 0) > TRAVEL;
            if (hitRun.hitRel < first || hitRun.hitRel > last) {
              row.status = "FAIL"; row.notes.push(`hit on move frame ${hitRun.hitRel}, outside the active window ${first}-${last}`);
            } else if (hitRun.hitRel !== first && !travelled) {
              row.status = "FAIL"; row.notes.push(`hit on move frame ${hitRun.hitRel}, expected ${first}: the target was already in reach and the car didn't travel`);
            } else if (hitRun.hitRel !== first) {
              row.notes.push(`travelling move: hit on move frame ${hitRun.hitRel} (window ${first}-${last}, moved ${hitRun.travel.toFixed(2)} first)`);
            }
          }
          /* Damage. A chained move is hit N of a combo, so DESIGN.md §5 scaling
             applies: 10% less per earlier hit, floor 50%. We accept either
             reading of "10% less" (additive 0.9, 0.8 ... or compounding 0.9, 0.81 ...). */
          if (t.damage !== undefined && h.type !== "block") {
            const n = recipe.repeat;
            const scaleA = Math.max(0.5, 1 - 0.1 * (n - 1)), scaleB = Math.max(0.5, Math.pow(0.9, n - 1));
            const okA = Math.abs((h.damage || 0) - t.damage * scaleA) <= 0.5 + 0.01 * t.damage;
            const okB = Math.abs((h.damage || 0) - t.damage * scaleB) <= 0.5 + 0.01 * t.damage;
            if (!okA && !okB) { row.status = "FAIL"; row.notes.push(`event damage ${h.damage}, table ${t.damage}` + (n > 1 ? ` x combo scaling ${scaleA.toFixed(2)} = ${(t.damage * scaleA).toFixed(1)}` : "")); }
            if (Math.abs(hitRun.hpLoss - (h.damage || 0)) > 0.5 && !/sig|grinder/.test(mv.id)) {
              row.notes.push(`health dropped ${hitRun.hpLoss.toFixed(1)} but the event says ${h.damage} (multi-hit?)`);
            }
          }
          // Stun: compare event and measured with the table (not for launches/knockdowns).
          const launched = hitRun.stunStates.some((s) => s === "juggle" || s === "knockdown" || s === "air" || s === "thrown");
          if (t.hitstun !== undefined && h.type === "hit") {
            if (h.stun !== undefined && h.stun !== t.hitstun) { row.status = "FAIL"; row.notes.push(`event stun ${h.stun}, table hitstun ${t.hitstun}`); }
            if (!launched && Math.abs(hitRun.stunFrames - t.hitstun) > 1) { row.status = "FAIL"; row.notes.push(`defender was in hit-stun for ${hitRun.stunFrames} frames, table says ${t.hitstun}`); }
          }
          if (launched) row.notes.push(`defender went ${hitRun.stunStates.join(" > ")} for ${hitRun.stunFrames} frames`);
          if (h.type === "throw" || mv.flags.throw) {
            if (h.type !== "throw") { row.status = "FAIL"; row.notes.push(`expected a throw through block, got "${h.type}"`); }
          }
        }

        // ---- Blocked version (not for throws, which go through block) ----
        if (!mv.flags.throw && row.hitRun && row.hitRun.hit) {
          const b = attempt(mv, recipe, row.hitRun.dist, "block", steerSign);
          row.blockRun = b;
          if (b.hit) {
            if (b.hit.type !== "block") { row.status = "FAIL"; row.notes.push(`defender held away but the result was "${b.hit.type}", not "block"`); }
            else {
              const chip = t.damage !== undefined ? t.damage * 0.15 : undefined;
              if (chip !== undefined && Math.abs((b.hit.damage || 0) - chip) > 1) { row.status = "FAIL"; row.notes.push(`chip damage ${b.hit.damage}, expected 15% = ${chip.toFixed(1)}`); }
              if (t.blockstun !== undefined && b.hit.stun !== undefined && b.hit.stun !== t.blockstun) { row.status = "FAIL"; row.notes.push(`event block-stun ${b.hit.stun}, table ${t.blockstun}`); }
              if (t.blockstun !== undefined && Math.abs(b.stunFrames - t.blockstun) > 1) { row.status = "FAIL"; row.notes.push(`defender was in block-stun for ${b.stunFrames} frames, table says ${t.blockstun}`); }
              if (b.attackerFree !== null && b.defenderFree !== null) row.blockAdv = b.defenderFree - b.attackerFree; // + = attacker recovers first
            }
          } else row.notes.push("blocked version never connected");
        }
      } catch (err) {
        row.status = "FAIL";
        row.notes.push("exception: " + (err && err.stack ? err.stack.split("\n").slice(0, 2).join(" | ") : err));
      }
      if (row.status === "FAIL") report.problems++;
      // Trim heavy fields before sending back to Node.
      row.summary = row.hitRun && row.hitRun.hit ? {
        type: row.hitRun.hit.type, dist: row.hitRun.dist, hitRel: row.hitRun.hitRel,
        damage: row.hitRun.hit.damage, stun: row.hitRun.hit.stun, stunFrames: row.hitRun.stunFrames,
      } : null;
      delete row.hitRun; delete row.blockRun;
      report.rows.push(row);
    }
    return report;
  }

  return mode === "frames" ? runFrames() : runStats();
}

/* =====================================================================
   Node side: launch the browser, run, print the report.
   ===================================================================== */
(async () => {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE ERROR: " + m.text()); });

  const url = pathToFileURL(pagePath).href + `?headless&seed=${seed}` + (flags.extra || "");
  let ok = true;
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.TP && TP.Fight && TP.Fight.create && window.THREE, null, { timeout: 30000 });
    const t0 = Date.now();
    const opts = { p1: flags.p1, p2: flags.p2, bot: flags.bot, bot2: flags.bot2, roundTime: flags.roundTime };
    const r = await page.evaluate(inPage, { mode, matches, seed, opts });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    if (mode === "stats") {
      const avg = r.roundFrames.length ? r.roundFrames.reduce((a, b) => a + b, 0) / r.roundFrames.length / 60 : 0;
      const longest = r.roundFrames.length ? Math.max(...r.roundFrames) / 60 : 0;
      const decided = r.wins[0] + r.wins[1];
      console.log(`${r.matches} matches (seeds ${seed}-${seed + matches - 1}), ${opts.p1 || "rivet"} vs ${opts.p2 || "rivet"}, bots ${opts.bot || "normal"}/${opts.bot2 || opts.bot || "normal"}, ${secs}s wall clock`);
      console.log(`Win split: P1 ${r.wins[0]}  P2 ${r.wins[1]}  other ${r.wins[2]}` + (decided ? `   (P1 ${((100 * r.wins[0]) / decided).toFixed(0)}%)` : ""));
      console.log(`Rounds: ${r.rounds}, average ${avg.toFixed(1)}s, longest ${longest.toFixed(1)}s, time-outs ${r.rounds ? ((100 * r.timeouts) / r.rounds).toFixed(0) : 0}%, draws ${r.draws}, KOs ${r.kos}`);
      console.log(`Longest combo: ${r.maxCombo} hits${r.maxComboAt ? ` (${r.maxComboAt})` : ""}`);
      console.log("\nPer move:            hits  blocks throws   damage   dmg/hit");
      for (const [id, m] of Object.entries(r.moves).sort((a, b) => b[1].damage - a[1].damage)) {
        const n = m.hits + m.blocks + m.throws;
        console.log(`  ${id.padEnd(18)} ${String(m.hits).padStart(5)} ${String(m.blocks).padStart(7)} ${String(m.throws).padStart(6)} ${m.damage.toFixed(0).padStart(8)} ${(n ? m.damage / n : 0).toFixed(1).padStart(9)}`);
      }
      // Hard failures: exceptions, unfinished matches, stuck states.
      if (r.exceptions.length) { ok = false; console.log("\nEXCEPTIONS:\n  " + r.exceptions.join("\n  ")); }
      if (r.unfinished.length) { ok = false; console.log("\nUNFINISHED MATCHES:\n  " + r.unfinished.join("\n  ")); }
      if (r.stuck.length) { ok = false; console.log("\nSTUCK STATES:\n  " + r.stuck.slice(0, 30).join("\n  ") + (r.stuck.length > 30 ? `\n  ...and ${r.stuck.length - 30} more` : "")); }
      // Soft warnings: these don't fail the run, but are worth a look.
      const warn = [];
      if (decided >= 20 && (r.wins[0] / decided < 0.35 || r.wins[0] / decided > 0.65) && (opts.p1 || "rivet") === (opts.p2 || "rivet") && (opts.bot || "normal") === (opts.bot2 || opts.bot || "normal"))
        warn.push(`mirror match is lopsided: P1 won ${((100 * r.wins[0]) / decided).toFixed(0)}% (side bias?)`);
      if (r.rounds && r.timeouts / r.rounds > 0.5) warn.push(`${((100 * r.timeouts) / r.rounds).toFixed(0)}% of rounds timed out (bots stalling?)`);
      if (r.maxCombo > 12) warn.push(`a ${r.maxCombo}-hit combo happened: check for an infinite`);
      if (warn.length) console.log("\nWARNINGS:\n  " + warn.join("\n  "));
    } else {
      if (r.fatal) { ok = false; console.log("FATAL: " + r.fatal); }
      console.log(`Frame-data check, ${opts.p1 || "rivet"} vs ${opts.p2 || "rivet"}, seed ${seed} (steer +1 moves ${r.steerSign > 0 ? "+x" : "-x"}), ${secs}s\n`);
      console.log("Move               Input                     Table s/a/r  dmg   hs   bs | Seen: type   frame  dmg   stun  dist  blockAdv  Result");
      for (const row of r.rows) {
        const t = row.table, s = row.summary;
        const tbl = `${t.startup ?? "?"}/${t.active ?? "?"}/${t.recovery ?? "?"}`.padEnd(11) + `${String(t.damage ?? "?").padStart(4)} ${String(t.hitstun ?? "?").padStart(4)} ${String(t.blockstun ?? "?").padStart(4)}`;
        const seen = s ? `${s.type.padEnd(6)} ${String(s.hitRel).padStart(5)} ${String(s.damage ?? "?").padStart(5)} ${String(s.stun ?? s.stunFrames).padStart(5)} ${s.dist.toFixed(1).padStart(5)} ${String(row.blockAdv ?? "-").padStart(9)}` : "-".padEnd(48);
        console.log(`${row.id.padEnd(18)} ${String(row.input || "-").padEnd(25)} ${tbl} | ${seen}  ${row.status}`);
        for (const n of row.notes) console.log(`${" ".repeat(20)}- ${n}`);
      }
      console.log(`\n${r.rows.length} moves: ${r.rows.length - r.problems - r.skipped} OK, ${r.problems} FAIL, ${r.skipped} skipped.`);
      console.log("blockAdv = frames the attacker recovers before the defender after a blocked hit (negative = punishable).");
      if (r.problems || r.skipped) ok = false;
    }
  } catch (err) {
    ok = false;
    console.log("TOOL ERROR: " + err.message);
  }
  if (errors.length) { ok = false; console.log("\nERRORS:\n" + errors.join("\n")); }
  console.log(ok ? "\nRESULT: PASS" : "\nRESULT: FAIL");
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
