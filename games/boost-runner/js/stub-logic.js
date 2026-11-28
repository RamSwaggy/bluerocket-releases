/* =====================================================================
   stub-logic.js — TEMPORARY stand-in for Gameplay's logic files.

   !! Delete this file once Gameplay's real files land (runner-car.js,
   !! course.js, view.js, round.js, bots.js, br.js). It exists only so
   !! Art and UI can build the look, camera and HUD before then.

   It fakes just enough of a Boost Runner match to drive the visuals:
   a course made of line segments, four cars with very simple side-on
   physics, crude bots, a follow-the-leader view rectangle, edge KOs and
   rounds to N wins. None of the numbers here are the real game's.

   The shape it offers (what the art files read):
     const m = TP.BRStub.createMatch({ scene, players, roundsToWin, seed })
     m.update(dt, controlsBySeat)     advance the match (fixed 1/60 steps)
     m.state      "countdown" | "race" | "round_end" | "match_end"
     m.countdown  seconds left in the countdown
     m.round      1, 2, 3 ...
     m.wins       round wins per seat
     m.view       { left, right, top, bottom } visible rectangle at z = 0
     m.course     { id, segments: [{ x0, y0, x1, y1, kind }] }
                  kind: "solid" | "oneway" | "wall" | "hazard" | "boost"
     m.cars       [{ seat, pos:{x,y}, vel:{x,y}, angle, alive, boosting,
                     onGround, boost (0..100), mesh }]
     m.drainEvents()  [{ type: "countdown"|"go"|"jump"|"land"|"bump"|
                         "ko"|"round_end"|"match_end", ... }]
     m.dispose()
   ===================================================================== */
(function () {
  "use strict";

  // Tiny seeded random number generator (mulberry32), so a seed always
  // gives the same course. Returns numbers in 0..1.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- Course: chunks of line segments ----------
     Each chunk is 36 units long and is written relative to its start
     (x = 0) and entry height (h). It returns its segments and its exit
     height, so the next chunk can start where it ended. */
  const CHUNK_LEN = 36;
  const CHUNKS = {
    flat: (h) => ({ segs: [[0, h, 36, h, "solid"]], exit: h }),
    gap: (h) => ({ segs: [[0, h, 14, h, "solid"], [23, h, 36, h, "solid"]], exit: h }),
    ramp: (h) => ({
      segs: [[0, h, 10, h, "solid"], [10, h, 19, h + 3, "solid"], [27, h, 36, h, "solid"]],
      exit: h,
    }),
    step: (h) => ({
      segs: [[0, h, 18, h, "solid"], [18, h, 18, h + 2, "wall"], [18, h + 2, 36, h + 2, "solid"]],
      exit: h + 2,
    }),
    drop: (h) => ({
      segs: [[0, h, 16, h, "solid"], [16, h, 16, h - 3, "wall"], [16, h - 3, 36, h - 3, "solid"]],
      exit: h - 3,
    }),
    oneway: (h) => ({
      segs: [[0, h, 36, h, "solid"], [9, h + 3.5, 27, h + 3.5, "oneway"], [30, h, 33, h, "hazard"]],
      exit: h,
    }),
    boost: (h) => ({
      segs: [[0, h, 36, h, "solid"], [12, h, 18, h, "boost"]],
      exit: h,
    }),
  };

  function buildCourse(seed) {
    const r = rng(seed);
    const segments = [];
    let x = 0, h = 0;
    // Start with two flat chunks so the grid has room, then random chunks.
    const order = ["flat", "flat"];
    const pool = ["gap", "ramp", "step", "drop", "oneway", "boost", "gap", "ramp"];
    for (let i = 0; i < 90; i++) order.push(pool[Math.floor(r() * pool.length)]);
    for (const id of order) {
      // Keep heights in a band so the course doesn't wander off forever.
      let name = id;
      if (name === "step" && h > 6) name = "drop";
      if (name === "drop" && h < -6) name = "step";
      const c = CHUNKS[name](h);
      for (const [x0, y0, x1, y1, kind] of c.segs) {
        segments.push({ x0: x + x0, y0, x1: x + x1, y1, kind, chunk: name });
      }
      x += CHUNK_LEN;
      h = c.exit;
    }
    return { id: seed, segments, length: x };
  }

  // Height of the highest drivable surface under (x, y), or null.
  // "Under" means at most 0.6 units above the car, so it can step up
  // onto tiny lips but not teleport onto platforms overhead.
  function groundAt(course, x, y) {
    let best = null;
    for (const s of course.segments) {
      if (s.kind === "wall" || s.kind === "boost") continue;
      if (x < s.x0 || x > s.x1 || s.x1 === s.x0) continue;
      const gy = s.y0 + (s.y1 - s.y0) * ((x - s.x0) / (s.x1 - s.x0));
      if (gy <= y + 0.6 && (best === null || gy > best.y)) best = { y: gy, seg: s };
    }
    return best;
  }

  /* ---------- One match ---------- */
  function createMatch(cfg) {
    const scene = cfg.scene;
    const roundsToWin = cfg.roundsToWin || 3;
    const r = rng((cfg.seed || 1) * 7919);
    const events = [];
    const emit = (e) => events.push(e);

    const cars = cfg.players.map((p) => {
      const mesh = TP.buildCarMesh(p.color);
      // The shared car's nose points along +Z. Turn it to face screen-right (+X).
      mesh.rotation.y = Math.PI / 2;
      scene.add(mesh);
      return {
        seat: p.seat, bot: p.controller === "bot",
        // Each bot gets a "skill" so they don't all drive identically.
        skill: 0.75 + r() * 0.25,
        pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, angle: 0,
        alive: true, boosting: false, onGround: true, boost: 100,
        outTimer: 0, koTime: 0, jumpsLeft: 2, jumpHeld: false, mesh,
      };
    });

    const m = {
      state: "countdown", countdown: 3, round: 0, wins: cars.map(() => 0),
      view: { left: 0, right: 0, top: 0, bottom: 0 },
      course: null, cars, koOrder: [], roundTime: 0, roundEndTimer: 0,
      lastCount: 4, acc: 0, winner: -1,
    };

    // View rectangle: fixed 16:9 aspect, zooms out as the pack spreads.
    const ASPECT = 16 / 9;
    function setView(cx, cy, height) {
      const w = height * ASPECT;
      m.view.left = cx - w / 2; m.view.right = cx + w / 2;
      m.view.top = cy + height / 2; m.view.bottom = cy - height / 2;
    }

    function startRound() {
      m.round++;
      m.course = buildCourse((cfg.seed || 1) + m.round * 101);
      m.state = "countdown"; m.countdown = 3; m.lastCount = 4;
      m.koOrder = []; m.roundTime = 0; m.winner = -1;
      cars.forEach((c, i) => {
        Object.assign(c, { alive: true, boosting: false, onGround: true, boost: 100, outTimer: 0, jumpsLeft: 2, angle: 0 });
        c.pos.x = 6 + (cars.length - i) * 4; c.pos.y = 0;
        c.vel.x = 0; c.vel.y = 0;
        c.mesh.visible = true;
      });
      m.camX = 10; m.camY = 3; m.camH = 20;
      setView(m.camX, m.camY, m.camH);
      emit({ type: "round_start", round: m.round });
    }

    // Very rough bot brain: always drive, jump before gaps and walls,
    // boost when airborne over a gap or when behind.
    function botControls(c) {
      const ahead = groundAt(m.course, c.pos.x + 3.5 + c.vel.x * 0.12, c.pos.y + 0.6);
      const wallAhead = m.course.segments.some((s) => s.kind === "wall" && s.x0 > c.pos.x && s.x0 < c.pos.x + 3 &&
        Math.max(s.y0, s.y1) > c.pos.y + 0.6);
      const below = groundAt(m.course, c.pos.x, c.pos.y);
      const behind = c.pos.x < m.view.left + (m.view.right - m.view.left) * 0.35;
      // Bots sometimes "miss" a jump, scaled by skill — that's what makes KOs happen.
      const sloppy = r() > c.skill + 0.2;
      const wantJump = c.onGround && (!ahead || wallAhead || (ahead && ahead.y > c.pos.y + 0.8)) && !sloppy;
      return {
        steer: 1, pitch: c.onGround ? 0 : 0.3,
        jump: wantJump || (!c.onGround && !below && c.vel.y < -2 && r() < 0.1),
        boost: (!c.onGround && !below) || (behind && c.boost > 40),
        hit: false,
      };
    }

    function stepCar(c, ctrl, dt) {
      if (!c.alive) return;
      const maxSpeed = 17, boostMax = 27;
      // Drive along the track: right = accelerate, left = brake/reverse.
      if (c.onGround) {
        if (ctrl.steer > 0.1) c.vel.x += 28 * ctrl.steer * dt;
        else if (ctrl.steer < -0.1) c.vel.x += 40 * ctrl.steer * dt;
        else c.vel.x *= Math.exp(-0.7 * dt);
      }
      // Boost pushes along the nose.
      c.boosting = !!ctrl.boost && c.boost > 0;
      if (c.boosting) {
        c.boost = Math.max(0, c.boost - 38 * dt);
        c.vel.x += Math.cos(c.angle) * 34 * dt;
        c.vel.y += Math.sin(c.angle) * 34 * dt;
      } else c.boost = Math.min(100, c.boost + 14 * dt);
      const cap = c.boosting ? boostMax : maxSpeed;
      if (c.vel.x > cap) c.vel.x = TP.util.damp(c.vel.x, cap, 2, dt);
      if (c.vel.x < -9) c.vel.x = -9;

      // Jump (twice per airtime). Must release between presses.
      if (ctrl.jump && !c.jumpHeld && c.jumpsLeft > 0) {
        c.vel.y = 10.5; c.jumpsLeft--; c.onGround = false;
        emit({ type: "jump", seat: c.seat, x: c.pos.x, y: c.pos.y, double: c.jumpsLeft === 0 });
      }
      c.jumpHeld = !!ctrl.jump;

      // Air tilt.
      if (!c.onGround) c.angle = TP.util.clamp(c.angle + (ctrl.pitch || 0) * 2.2 * dt, -1.2, 1.2);

      // Gravity and movement.
      c.vel.y -= 28 * dt;
      const prevX = c.pos.x;
      c.pos.x += c.vel.x * dt;
      c.pos.y += c.vel.y * dt;

      // Walls stop you.
      for (const s of m.course.segments) {
        if (s.kind !== "wall") continue;
        const top = Math.max(s.y0, s.y1), bot = Math.min(s.y0, s.y1);
        if (prevX <= s.x0 && c.pos.x > s.x0 - 0.01 && c.pos.y < top - 0.05 && c.pos.y > bot - 2) {
          c.pos.x = s.x0 - 0.01; c.vel.x = Math.min(0, c.vel.x);
        }
      }

      // Ground.
      const g = groundAt(m.course, c.pos.x, c.pos.y - c.vel.y * dt);
      const wasGround = c.onGround;
      if (g && c.pos.y <= g.y && c.vel.y <= 0) {
        c.pos.y = g.y; c.vel.y = 0;
        c.onGround = true; c.jumpsLeft = 2;
        const s = g.seg;
        c.angle = Math.atan2(s.y1 - s.y0, s.x1 - s.x0);
        if (!wasGround) emit({ type: "land", seat: c.seat, x: c.pos.x, y: c.pos.y });
        // Boost pads refill the meter.
        for (const b of m.course.segments) {
          if (b.kind === "boost" && c.pos.x > b.x0 && c.pos.x < b.x1 && Math.abs(c.pos.y - b.y0) < 0.3) {
            c.boost = 100; c.vel.x = Math.max(c.vel.x, 22);
          }
        }
      } else if (!g || c.pos.y > g.y + 0.05) {
        if (wasGround) c.jumpsLeft = Math.min(c.jumpsLeft, 1);
        c.onGround = false;
      }
    }

    // Push overlapping cars apart (a very loose bump).
    function bumps() {
      for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i], b = cars[j];
        if (!a.alive || !b.alive) continue;
        const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
        const d = Math.hypot(dx, dy * 2);
        if (d < 2.6 && d > 0.001) {
          const push = (2.6 - d) * 0.5;
          a.pos.x -= (dx / d) * push; b.pos.x += (dx / d) * push;
          const rel = a.vel.x - b.vel.x;
          if (Math.abs(rel) > 4) {
            emit({ type: "bump", a: a.seat, b: b.seat, x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 + 0.6, strength: Math.min(1, Math.abs(rel) / 15) });
            a.vel.x -= rel * 0.6; b.vel.x += rel * 0.6;
          }
        }
      }
    }

    function stepView(dt) {
      const alive = cars.filter((c) => c.alive);
      if (!alive.length) return;
      const lead = alive.reduce((a, b) => (b.pos.x > a.pos.x ? b : a));
      const last = alive.reduce((a, b) => (b.pos.x < a.pos.x ? b : a));
      // Zoom out with the spread, 20 → 28 units tall.
      const spread = lead.pos.x - last.pos.x;
      const targetH = TP.util.clamp(18 + spread * 0.25, 20, 28);
      m.camH = TP.util.damp(m.camH, targetH, 1.5, dt);
      const w = m.camH * ASPECT;
      // Leader at 65% across. Never move backwards, and creep forwards
      // at a minimum speed that rises with time so rounds always end.
      const minSpeed = 4 + m.roundTime * 0.12;
      const target = lead.pos.x - w * 0.65 + w / 2;
      m.camX = Math.max(m.camX + minSpeed * dt, TP.util.damp(m.camX, target, 3, dt));
      const avgY = alive.reduce((s, c) => s + c.pos.y, 0) / alive.length;
      m.camY = TP.util.damp(m.camY, avgY + m.camH * 0.18, 1.2, dt);
      setView(m.camX, m.camY, m.camH);
    }

    function checkKOs(dt) {
      for (const c of cars) {
        if (!c.alive) continue;
        const behind = c.pos.x < m.view.left;
        const below = c.pos.y < m.view.bottom;
        if (behind || below) c.outTimer += dt; else c.outTimer = 0;
        if (c.outTimer >= 0.3) {
          c.alive = false; c.mesh.visible = false;
          c.koTime = m.roundTime;
          m.koOrder.push(c.seat);
          emit({ type: "ko", seat: c.seat, cause: below ? "bottom" : "behind", x: c.pos.x, y: c.pos.y });
        }
      }
      const alive = cars.filter((c) => c.alive);
      if (alive.length <= 1) {
        m.winner = alive.length ? alive[0].seat : -1;
        if (m.winner >= 0) m.wins[m.winner]++;
        m.state = "round_end"; m.roundEndTimer = 4.5;
        emit({ type: "round_end", winner: m.winner, round: m.round, koOrder: m.koOrder.slice(), wins: m.wins.slice() });
      }
    }

    function fixedStep(dt, controls) {
      if (m.state === "countdown") {
        m.countdown -= dt;
        const n = Math.ceil(m.countdown);
        if (n < m.lastCount && n > 0) { m.lastCount = n; emit({ type: "countdown", n }); }
        if (m.countdown <= 0) { m.state = "race"; emit({ type: "go" }); }
      } else if (m.state === "race" || m.state === "round_end") {
        // Cars keep moving during the round-end slow motion.
        if (m.state === "race") m.roundTime += dt;
        for (const c of cars) stepCar(c, c.bot ? botControls(c) : (controls[c.seat] || TP.Input.NEUTRAL), dt);
        bumps();
        if (m.state === "race") { stepView(dt); checkKOs(dt); }
        else {
          m.roundEndTimer -= dt;
          if (m.roundEndTimer <= 0) {
            const champ = m.wins.findIndex((w) => w >= roundsToWin);
            if (champ >= 0) { m.state = "match_end"; emit({ type: "match_end", winner: champ, wins: m.wins.slice() }); }
            else startRound();
          }
        }
      }
    }

    m.update = function (dt, controls = {}) {
      m.acc += dt;
      while (m.acc >= 1 / 60) { fixedStep(1 / 60, controls); m.acc -= 1 / 60; }
      // Copy car state onto the meshes (Gameplay's runner car will do
      // this itself). manualBodyPose-style: tilt the body by the angle.
      for (const c of cars) {
        if (!c.alive) continue;
        c.mesh.position.set(c.pos.x, c.pos.y, 0);
        // Mesh is yawed 90°, so the body's X rotation tilts the nose; negative = nose up.
        c.mesh.userData.body.rotation.x = -c.angle;
        c.mesh.userData.flame.visible = c.boosting;
        if (c.boosting) c.mesh.userData.flame.scale.set(1, 0.8 + Math.random() * 0.5, 1);
        c.mesh.userData.marker.position.y = 2.6 + Math.sin(performance.now() * 0.005 + c.seat) * 0.15;
      }
    };
    m.drainEvents = () => events.splice(0, events.length);
    m.dispose = () => cars.forEach((c) => scene.remove(c.mesh));

    startRound();
    return m;
  }

  TP.BRStub = { createMatch };
})();
