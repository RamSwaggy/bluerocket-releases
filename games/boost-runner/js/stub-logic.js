/* =====================================================================
   stub-logic.js — TEMPORARY stand-in for Gameplay's logic files.

   !! Delete this file (and its <script> tag) once Gameplay's real files
   !! land (course.js, runner-car.js, view.js, bots.js, round.js, br.js).
   !! main.js uses BR.createGame when it exists and only falls back here.

   It fakes the contract in js/README.md (Gameplay's data shapes) closely
   enough to build and test the look, camera and HUD:
     const game = TP.BRStub.createGame({ scene, seats, seed, winsToTake, aspect })
     game.frame(dt), game.setAspect(a), game.on(fn), game.dispose()
     game.state / roundNumber / raceTime / countdown / view / course /
       cars / wins / winsToTake / lastResult / matchWinner
     course: { seed, version, floorY, chunks, surfaces: [{ chunk, pts, oneway, thickness }], pads }
     cars: { seat, x, y, angle, onGround, boost, boosting, alive, koCause,
             inDanger, offTop, mesh, ... }
   None of the numbers here are the real game's; the physics and bots
   are deliberately crude.
   ===================================================================== */
(function () {
  "use strict";

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- Course chunks (36 units long, relative to entry height h) ----------
     solid: polylines of solid ground; oneway: thin platforms; pads: boost pads. */
  const LEN = 36;
  const CHUNKS = {
    flat: (h) => ({ solid: [[[0, h], [36, h]]], exit: h }),
    gap: (h) => ({ solid: [[[0, h], [14, h]], [[23, h], [36, h]]], exit: h }),
    ramp: (h) => ({ solid: [[[0, h], [10, h], [19, h + 3]], [[27, h], [36, h]]], exit: h }),
    step: (h) => ({ solid: [[[0, h], [18, h], [18, h + 2], [36, h + 2]]], exit: h + 2 }),
    drop: (h) => ({ solid: [[[0, h], [16, h], [16, h - 3], [36, h - 3]]], exit: h - 3 }),
    oneway: (h) => ({ solid: [[[0, h], [36, h]]], oneway: [[[9, h + 3.5], [27, h + 3.5]]], exit: h }),
    boost: (h) => ({ solid: [[[0, h], [36, h]]], pads: [[12, 18, h]], exit: h }),
  };

  function makeCourse(seed) {
    const r = rng(seed);
    const course = { seed, version: 0, floorY: -60, chunks: [], surfaces: [], pads: [], markers: [], nextX: 0, h: 0, r };
    course.addChunk = function (name) {
      if (name === "step" && course.h > 6) name = "drop";
      if (name === "drop" && course.h < -6) name = "step";
      const c = CHUNKS[name](course.h);
      const index = course.chunks.length, x = course.nextX;
      const chunk = { index, id: name, name, x0: x, x1: x + LEN, y0: course.h, y1: c.exit, difficulty: 1 };
      course.chunks.push(chunk);
      for (const pl of c.solid) course.surfaces.push({ chunk: index, pts: pl.map(([px, py]) => [x + px, py]), oneway: false });
      for (const pl of c.oneway || []) course.surfaces.push({ chunk: index, pts: pl.map(([px, py]) => [x + px, py]), oneway: true, thickness: 0.6 });
      for (const [a, b, y] of c.pads || []) course.pads.push({ chunk: index, x0: x + a, x1: x + b, y });
      course.nextX += LEN; course.h = c.exit; course.version++;
      return chunk;
    };
    const pool = ["gap", "ramp", "step", "drop", "oneway", "boost", "gap", "ramp"];
    course.addRandom = () => course.addChunk(pool[Math.floor(r() * pool.length)]);
    course.addChunk("flat"); course.addChunk("flat");
    for (let i = 0; i < 4; i++) course.addRandom();
    // First surface at or below y under x: { y, angle, oneway }.
    course.surfaceBelow = function (x, y) {
      let best = null;
      for (const s of course.surfaces) {
        for (let i = 0; i < s.pts.length - 1; i++) {
          const [x0, y0] = s.pts[i], [x1, y1] = s.pts[i + 1];
          if (x1 === x0 || x < x0 || x > x1) continue;
          const gy = y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
          if (gy <= y + 0.6 && (!best || gy > best.y)) best = { y: gy, angle: Math.atan2(y1 - y0, x1 - x0), oneway: s.oneway };
        }
      }
      return best;
    };
    // Vertical step faces block the car.
    course.wallAt = function (xPrev, x, y) {
      for (const s of course.surfaces) {
        if (s.oneway) continue;
        for (let i = 0; i < s.pts.length - 1; i++) {
          const [x0, y0] = s.pts[i], [x1, y1] = s.pts[i + 1];
          if (x0 === x1 && y1 > y0 && xPrev <= x0 && x > x0 - 0.01 && y < y1 - 0.05) return x0;
        }
      }
      return null;
    };
    return course;
  }

  function createGame(opts) {
    const scene = opts.scene;
    const params = new URLSearchParams(location.search);
    const SPEED = Math.max(0.1, Number(params.get("speed")) || 1);
    const seed = opts.seed ?? (params.has("seed") ? Number(params.get("seed")) : Date.now() % 1e6);
    const r = rng(seed * 7919);
    const listeners = [];
    const emit = (ev) => { ev.t = game.raceTime; listeners.forEach((fn) => fn(ev)); };

    const cars = opts.seats.map((s, seat) => {
      const mesh = TP.buildCarMesh(TP.PLAYER_COLORS[seat]);
      mesh.rotation.y = Math.PI / 2; // nose (+Z) along +X
      scene.add(mesh);
      const car = {
        seat, index: seat, name: s.name, color: TP.PLAYER_COLORS[seat], isBot: s.controller === "bot", controller: s.controller,
        skill: 0.75 + r() * 0.25, pos: { x: 0, y: 0 }, vx: 0, vy: 0, angle: 0, onGround: true,
        boost: 100, boosting: false, alive: true, koCause: null, koTime: 0, offScreen: 0,
        inDanger: false, offTop: false, jumps: 2, jumpHeld: false, mesh,
      };
      Object.defineProperty(car, "x", { get: () => car.pos.x });
      Object.defineProperty(car, "y", { get: () => car.pos.y });
      return car;
    });

    const game = {
      state: "countdown", roundNumber: 0, time: 0, raceTime: 0, countdown: 3,
      view: {}, course: null, cars, wins: cars.map(() => 0), winsToTake: opts.winsToTake || 3,
      lastResult: null, matchWinner: null, aspect: opts.aspect || 16 / 9, acc: 0, koOrder: [], endTimer: 0,
      cam: { x: 0, y: 0, h: 20 },
    };

    function setView() {
      const v = game.view, h = game.cam.h, w = h * game.aspect;
      Object.assign(v, {
        left: game.cam.x - w / 2, right: game.cam.x + w / 2, top: game.cam.y + h / 2, bottom: game.cam.y - h / 2,
        width: w, height: h, centerX: game.cam.x, centerY: game.cam.y, aspect: game.aspect,
        minSpeed: 4 + game.raceTime * 0.12, suddenDeath: game.raceTime > 120,
      });
      v.dangerX = v.left + w * 0.1;
    }

    function startRound() {
      game.roundNumber++;
      game.course = makeCourse(seed + game.roundNumber * 101);
      Object.assign(game, { state: "countdown", time: 0, raceTime: 0, countdown: 3, koOrder: [] });
      cars.forEach((c, i) => {
        Object.assign(c, { vx: 0, vy: 0, angle: 0, onGround: true, boost: 100, boosting: false, alive: true, koCause: null, offScreen: 0, inDanger: false, offTop: false, jumps: 2 });
        c.pos.x = 8 + (cars.length - i) * 4; c.pos.y = 0;
        c.mesh.visible = true;
      });
      game.cam = { x: 14, y: 3, h: 20 };
      setView();
      emit({ type: "round_start", round: game.roundNumber });
    }

    function bot(c) {
      const C = game.course;
      const ahead = C.surfaceBelow(c.pos.x + 3.5 + c.vx * 0.12, c.pos.y + 0.6);
      const wall = C.wallAt(c.pos.x, c.pos.x + 3, c.pos.y) !== null;
      const below = C.surfaceBelow(c.pos.x, c.pos.y);
      const behind = c.pos.x < game.view.left + game.view.width * 0.35;
      const sloppy = r() > c.skill + 0.2;
      return {
        steer: 1, pitch: c.onGround ? 0 : 0.3,
        jump: (c.onGround && (!ahead || wall || ahead.y > c.pos.y + 0.8) && !sloppy) || (!c.onGround && !below && c.vy < -2 && r() < 0.1),
        boost: (!c.onGround && !below) || (behind && c.boost > 40),
      };
    }

    function stepCar(c, ctrl, dt) {
      if (!c.alive) return;
      if (c.onGround) {
        if (ctrl.steer > 0.1) c.vx += 28 * ctrl.steer * dt;
        else if (ctrl.steer < -0.1) c.vx += 40 * ctrl.steer * dt;
        else c.vx *= Math.exp(-0.7 * dt);
      }
      c.boosting = !!ctrl.boost && c.boost > 0;
      if (c.boosting) { c.boost = Math.max(0, c.boost - 38 * dt); c.vx += Math.cos(c.angle) * 34 * dt; c.vy += Math.sin(c.angle) * 34 * dt; }
      else c.boost = Math.min(100, c.boost + 14 * dt);
      const cap = c.boosting ? 27 : 17;
      if (c.vx > cap) c.vx = TP.util.damp(c.vx, cap, 2, dt);
      if (c.vx < -9) c.vx = -9;
      if (ctrl.jump && !c.jumpHeld && c.jumps > 0) {
        c.vy = 10.5; c.jumps--; c.onGround = false;
        emit({ type: "jump", seat: c.seat, double: c.jumps === 0, x: c.pos.x, y: c.pos.y });
      }
      c.jumpHeld = !!ctrl.jump;
      if (!c.onGround) c.angle = TP.util.clamp(c.angle + (ctrl.pitch || 0) * 2.2 * dt, -1.2, 1.2);
      c.vy -= 28 * dt;
      const px = c.pos.x;
      c.pos.x += c.vx * dt; c.pos.y += c.vy * dt;
      const wx = game.course.wallAt(px, c.pos.x, c.pos.y);
      if (wx !== null) { c.pos.x = wx - 0.01; c.vx = Math.min(0, c.vx); }
      const g = game.course.surfaceBelow(c.pos.x, c.pos.y - c.vy * dt);
      const was = c.onGround;
      if (g && c.pos.y <= g.y && c.vy <= 0) {
        c.pos.y = g.y; c.vy = 0; c.onGround = true; c.jumps = 2; c.angle = g.angle;
        if (!was) emit({ type: "land", seat: c.seat, x: c.pos.x, y: c.pos.y, speed: Math.abs(c.vx), bad: false });
        for (const p of game.course.pads) {
          if (c.pos.x > p.x0 && c.pos.x < p.x1 && Math.abs(c.pos.y - p.y) < 0.3 && c.boost < 99) {
            c.boost = 100; c.vx = Math.max(c.vx, 22);
            emit({ type: "pad", seat: c.seat, x: c.pos.x, y: c.pos.y });
          }
        }
      } else if (!g || c.pos.y > g.y + 0.05) { if (was) c.jumps = Math.min(c.jumps, 1); c.onGround = false; }
    }

    function bumps() {
      for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i], b = cars[j];
        if (!a.alive || !b.alive) continue;
        const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y, d = Math.hypot(dx, dy * 2);
        if (d < 2.6 && d > 0.001) {
          const push = (2.6 - d) * 0.5;
          a.pos.x -= (dx / d) * push; b.pos.x += (dx / d) * push;
          const rel = a.vx - b.vx;
          if (Math.abs(rel) > 4) {
            emit({ type: "bump", a: a.seat, b: b.seat, attacker: rel > 0 ? a.seat : b.seat, victim: rel > 0 ? b.seat : a.seat, impact: Math.abs(rel), x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 + 0.6 });
            a.vx -= rel * 0.6; b.vx += rel * 0.6;
          }
        }
      }
    }

    function stepView(dt) {
      const alive = cars.filter((c) => c.alive);
      if (!alive.length) return;
      const lead = alive.reduce((a, b) => (b.pos.x > a.pos.x ? b : a));
      const last = alive.reduce((a, b) => (b.pos.x < a.pos.x ? b : a));
      const C = game.cam;
      C.h = TP.util.damp(C.h, TP.util.clamp(18 + (lead.pos.x - last.pos.x) * 0.25, 20, 28), 1.5, dt);
      const w = C.h * game.aspect;
      C.x = Math.max(C.x + (4 + game.raceTime * 0.12) * dt, TP.util.damp(C.x, lead.pos.x - w * 0.15, 3, dt));
      const avgY = alive.reduce((s, c) => s + c.pos.y, 0) / alive.length;
      C.y = TP.util.damp(C.y, avgY + C.h * 0.18, 1.2, dt);
      setView();
      // Keep the course a few chunks ahead of the leading edge.
      while (game.course.nextX < game.view.right + 80) {
        const ch = game.course.addRandom();
        emit({ type: "chunk_added", chunk: ch });
      }
    }

    function checkKOs(dt) {
      const v = game.view;
      for (const c of cars) {
        if (!c.alive) continue;
        const inD = c.pos.x < v.dangerX;
        if (inD !== c.inDanger) { c.inDanger = inD; emit({ type: "danger", seat: c.seat, on: inD }); }
        c.offTop = c.pos.y > v.top;
        const behind = c.pos.x < v.left, fell = c.pos.y < v.bottom;
        c.offScreen = behind || fell ? c.offScreen + dt : 0;
        if (c.offScreen >= 0.3) {
          c.alive = false; c.mesh.visible = false; c.inDanger = false;
          c.koTime = game.raceTime; c.koCause = fell ? "fell" : "behind";
          game.koOrder.push(c.seat);
          emit({ type: "ko", seat: c.seat, cause: c.koCause, x: c.pos.x, y: c.pos.y });
        }
      }
      const alive = cars.filter((c) => c.alive);
      if (alive.length <= 1) {
        const winner = alive.length ? alive[0].seat : null;
        if (winner !== null) game.wins[winner]++;
        game.lastResult = { winner, koOrder: game.koOrder.slice(), time: game.raceTime };
        game.state = "round_end"; game.endTimer = 2;
        emit({ type: "round_end", round: game.roundNumber, winner, koOrder: game.koOrder.slice(), wins: game.wins.slice() });
      }
    }

    function step(dt) {
      game.time += dt;
      if (game.state === "countdown") {
        game.countdown = Math.max(0, game.countdown - dt);
        if (game.countdown <= 0) { game.state = "race"; emit({ type: "go", round: game.roundNumber }); }
      } else if (game.state === "race" || game.state === "round_end") {
        if (game.state === "race") game.raceTime += dt;
        for (const c of cars) stepCar(c, c.isBot ? bot(c) : TP.Input.get(c.controller), dt);
        bumps();
        if (game.state === "race") { stepView(dt); checkKOs(dt); }
        else if ((game.endTimer -= dt) <= 0) {
          const champ = game.wins.findIndex((w) => w >= game.winsToTake);
          if (champ >= 0) { game.state = "match_end"; game.matchWinner = champ; emit({ type: "match_end", winner: champ, wins: game.wins.slice() }); }
          else startRound();
        }
      }
    }

    game.frame = function (dt) {
      game.acc += Math.min(0.1, dt) * SPEED;
      while (game.acc >= 1 / 60) { step(1 / 60); game.acc -= 1 / 60; }
      for (const c of cars) {
        if (!c.alive) continue;
        c.mesh.position.set(c.pos.x, c.pos.y, 0);
        c.mesh.userData.body.rotation.x = -c.angle; // nose up = negative X rotation on the yawed model
        c.mesh.userData.flame.visible = c.boosting;
        if (c.boosting) c.mesh.userData.flame.scale.set(1, 0.8 + Math.random() * 0.5, 1);
      }
    };
    game.setAspect = (a) => { game.aspect = TP.util.clamp(a, 4 / 3, 21 / 9); setView(); };
    game.on = (fn) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); };
    game.dispose = () => cars.forEach((c) => scene.remove(c.mesh));

    startRound();
    return game;
  }

  TP.BRStub = { createGame };
})();
