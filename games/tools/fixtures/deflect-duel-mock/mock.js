/* =====================================================================
   mock.js — QC TEST FIXTURE. A deliberately simple Deflect Duel that
   follows the agreed rules and test interface, so the QC tools can be
   checked against something before (and alongside) the real game.

   It is NOT the game and isn't shipped: no rendering, simple bots.
   It uses the real shared car physics (TP.Car + TP.modeTuning) so the
   car-feel checks are meaningful.

   Interface it implements (the same one the real duel.js agreed to):
     TP.DUEL_CFG   arenaW, arenaD, maxSpeed, baseSpeed, speedStep,
                   smashBonus, smashBoostCost, hitReach, hitWindow,
                   hitCooldown, aimBendDeg, freezeMin, freezeMax,
                   stalemateTime, invulnTime, ballRadius, pillars,
                   pillarList [{x,z,r}]
     TP.duel       players[] { name, index, lives, out, invuln, pos,
                               airborne, kos, car }
                   ball { pos, vel, speed, owner, neutral }
                   freezeLeft, state, winner, koLog[{t, victim, owner, speed}]
                   tuning, paused
                   update(dt), newMatch({players, lives, pillars}),
                   setInput(i, ctrl), setBot(i, on), placeCar(i, {x,z}, h),
                   setBall({pos, vel, owner})

   URL: ?demo (all bots) &players=N &lives=L &speed=S &test (no own loop)
        &mockbug=<name> makes the mock break one rule on purpose, so a
        test can prove it catches that bug:
          ownko      the ball KOs its own owner
          nospeedup  later hits don't speed the ball up
          nocap      speed isn't capped at maxSpeed
          nofreeze   no hit-freeze
          nojump     airborne cars still get KO'd
          noinvuln   no invulnerability after respawn
          nostale    no stalemate reset
          decay      ball slows down before the stalemate reset
          pillarhole the ball passes through pillars
          pivot      car tuning pivot left at the default
          nosave     Start doesn't save the setup
          norematch  rematch keeps old lives
   ===================================================================== */
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  const BUG = q.get("mockbug") || "";
  const V = THREE.Vector3;
  const clamp = TP.util.clamp;

  const CFG = (TP.DUEL_CFG = {
    arenaW: 44, arenaD: 28,
    maxSpeed: 40, baseSpeed: 14, speedStep: 2.5, smashBonus: 6, smashBoostCost: 30,
    hitReach: 3.6, hitWindow: 0.28, hitCooldown: 0.5, aimBendDeg: 25,
    freezeMin: 0.04, freezeMax: 0.22,
    stalemateTime: 12, invulnTime: 2, serveDelay: 0.8,
    ballRadius: 0.8, ballY: 0.9,
    pillars: true, pillarList: [{ x: -9, z: 0, r: 1.6 }, { x: 9, z: 0, r: 1.6 }],
  });

  const COLORS = [0x3b82f6, 0xf97316, 0x22c55e, 0xec4899];
  const SPAWNS = [[-16, -8], [16, 8], [-16, 8], [16, -8]];
  const world = { groundHeightAt: () => 0 };
  const scene = { add() {} };              // no rendering in the mock
  const NONE = { throttle: 0, steer: 0, boost: false, jump: false, hit: false };

  const d = (TP.duel = {
    players: [], ball: null, freezeLeft: 0, state: "serve", winner: null, koLog: [],
    tuning: TP.modeTuning(BUG === "pivot" ? {} : { pivot: 0.8 }),
    paused: q.has("test"), t: 0, stalemateResets: 0,
  });
  let inputs = [], bots = [], prevHit = [], swing = [], cooldown = [];
  let serveLeft = 0, sinceHit = 0, matchOpts = {};

  function spawn(i) {
    const [x, z] = SPAWNS[i];
    d.players[i].car.placeAt(x, z, x < 0 ? Math.PI / 2 : -Math.PI / 2);
  }

  function serve() {
    d.ball.pos.set(0, CFG.ballY, 0);
    d.ball.vel.set(0, 0, 0);
    d.ball.speed = 0; d.ball.owner = null; d.ball.neutral = true;
    d.state = "serve"; serveLeft = CFG.serveDelay; sinceHit = 0;
  }

  d.newMatch = function ({ players = 2, lives = 3, pillars = CFG.pillars, names } = {}) {
    matchOpts = { players, lives, pillars, names };
    CFG.pillars = pillars;
    const setup = names || TP.Rumble.loadSetup().slots.map((s) => s.name);
    d.players = [];
    for (let i = 0; i < players; i++) {
      const p = { name: setup[i] || TP.DEFAULT_NAMES[i], index: i, color: COLORS[i], lives, out: false, invuln: 0, kos: 0 };
      p.car = new TP.Car(scene, p);
      Object.defineProperty(p, "pos", { get: () => p.car.pos, enumerable: true });
      Object.defineProperty(p, "airborne", { get: () => !p.car.onGround, enumerable: true });
      d.players.push(p);
      spawn(i);
    }
    inputs = d.players.map(() => NONE); bots = d.players.map(() => true);
    prevHit = d.players.map(() => false); swing = d.players.map(() => null); cooldown = d.players.map(() => 0);
    d.ball = { pos: new V(), vel: new V(), speed: 0, owner: null, neutral: true };
    d.koLog = []; d.winner = null; d.freezeLeft = 0; d.t = 0; d.stalemateResets = 0;
    serve();
    hideCard();
  };
  d.setInput = (i, ctrl) => { inputs[i] = Object.assign({}, NONE, ctrl); };
  d.setBot = (i, on) => { bots[i] = !!on; };
  d.placeCar = (i, p, h = 0) => { d.players[i].car.placeAt(p.x, p.z, h); };
  d.setBall = ({ pos, vel, owner = null }) => {
    if (pos) d.ball.pos.set(pos.x, CFG.ballY, pos.z);
    if (vel) d.ball.vel.set(vel.x, 0, vel.z);
    d.ball.speed = Math.hypot(d.ball.vel.x, d.ball.vel.z);
    d.ball.owner = owner; d.ball.neutral = owner === null || owner === undefined;
    if (d.state === "serve") d.state = "play";
    sinceHit = 0;
  };

  /* ---------- Bots: chase a ball you can hit, flee your own ---------- */
  function botCtrl(p) {
    const b = d.ball, c = p.car, ctrl = Object.assign({}, NONE);
    const dx = b.pos.x - c.pos.x, dz = b.pos.z - c.pos.z, dist = Math.hypot(dx, dz);
    const want = Math.atan2(dx, dz);
    let diff = want - c.heading; while (diff > Math.PI) diff -= 2 * Math.PI; while (diff < -Math.PI) diff += 2 * Math.PI;
    if (b.owner === p.index && !b.neutral) { ctrl.throttle = -0.5; return ctrl; }
    ctrl.steer = clamp(-diff * 2, -1, 1);
    ctrl.throttle = dist > 3 ? 1 : 0.2;
    if (dist < CFG.hitReach * 0.9 && Math.abs(diff) < 0.8) ctrl.hit = true;
    if (!b.neutral && b.speed > 30 && dist < 5 && Math.random() < 0.3) ctrl.jump = true;
    return ctrl;
  }

  function freezeFor(speed) {
    if (BUG === "nofreeze") return 0;
    return CFG.freezeMin + (CFG.freezeMax - CFG.freezeMin) * clamp(speed / CFG.maxSpeed, 0, 1);
  }

  function tryHit(p, ctrl) {
    const b = d.ball, c = p.car;
    if (Math.hypot(b.pos.x - c.pos.x, b.pos.z - c.pos.z) > CFG.hitReach) return false;
    const smash = c.boosting;
    let speed;
    if (b.neutral) speed = CFG.baseSpeed;
    else speed = b.speed + (BUG === "nospeedup" ? 0 : CFG.speedStep) + (smash ? CFG.smashBonus : 0);
    if (BUG !== "nocap") speed = Math.min(speed, CFG.maxSpeed);
    if (smash) c.boost = Math.max(0, c.boost - CFG.smashBoostCost);
    const h = c.heading - (ctrl.steer || 0) * CFG.aimBendDeg * Math.PI / 180;
    b.vel.set(Math.sin(h) * speed, 0, Math.cos(h) * speed);
    b.speed = speed; b.owner = p.index; b.neutral = false;
    d.freezeLeft = freezeFor(speed);
    sinceHit = 0;
    return true;
  }

  function moveBall(dt) {
    const b = d.ball, r = CFG.ballRadius, hw = CFG.arenaW / 2 - r, hd = CFG.arenaD / 2 - r;
    if (BUG === "decay" && !b.neutral) { b.vel.multiplyScalar(1 - 0.05 * dt); b.speed = Math.hypot(b.vel.x, b.vel.z); }
    b.pos.x += b.vel.x * dt; b.pos.z += b.vel.z * dt;
    if (b.pos.x > hw) { b.pos.x = hw; b.vel.x = -Math.abs(b.vel.x); }
    if (b.pos.x < -hw) { b.pos.x = -hw; b.vel.x = Math.abs(b.vel.x); }
    if (b.pos.z > hd) { b.pos.z = hd; b.vel.z = -Math.abs(b.vel.z); }
    if (b.pos.z < -hd) { b.pos.z = -hd; b.vel.z = Math.abs(b.vel.z); }
    if (CFG.pillars && BUG !== "pillarhole") {
      for (const pl of CFG.pillarList) {
        const dx = b.pos.x - pl.x, dz = b.pos.z - pl.z, dist = Math.hypot(dx, dz), min = pl.r + r;
        if (dist < min && dist > 1e-6) {
          const nx = dx / dist, nz = dz / dist, dot = b.vel.x * nx + b.vel.z * nz;
          if (dot < 0) { b.vel.x -= 2 * dot * nx; b.vel.z -= 2 * dot * nz; }
          b.pos.x = pl.x + nx * min; b.pos.z = pl.z + nz * min;
        }
      }
    }
  }

  function checkKOs() {
    const b = d.ball;
    if (b.neutral) return;
    const victims = d.players.filter((p) => {
      if (p.out) return false;
      if (p.index === b.owner && BUG !== "ownko") return false;
      if (p.invuln > 0 && BUG !== "noinvuln") return false;
      if (p.car.pos.y > 1.2 && BUG !== "nojump") return false;   // jumped over it
      return Math.hypot(b.pos.x - p.car.pos.x, b.pos.z - p.car.pos.z) < p.car.radius + CFG.ballRadius;
    });
    if (!victims.length) return;
    for (const v of victims) {
      v.lives--;
      d.koLog.push({ t: d.t, victim: v.index, owner: b.owner, speed: b.speed });
      if (b.owner !== v.index) d.players[b.owner].kos++;
      if (v.lives <= 0) { v.out = true; v.car.out = true; v.car.pos.set(0, -50, 0); }
      else { spawn(v.index); v.invuln = CFG.invulnTime; }
    }
    const alive = d.players.filter((p) => !p.out);
    if (alive.length <= 1) {
      d.state = "over";
      d.winner = alive.length ? alive[0].index : b.owner;   // double KO: last hitter wins
      showResults();
      return;
    }
    serve();
  }

  d.update = function (dt) {
    if (!d.players.length || d.state === "over") return;
    d.t += dt;
    if (d.freezeLeft > 0) { d.freezeLeft = Math.max(0, d.freezeLeft - dt); return; }

    const ctrls = d.players.map((p, i) => (bots[i] ? botCtrl(p) : inputs[i]));
    d.players.forEach((p, i) => {
      if (p.out) return;
      const ctrl = ctrls[i];
      p.car.update(dt, ctrl, world, d.tuning);
      const hw = CFG.arenaW / 2 - p.car.radius, hd = CFG.arenaD / 2 - p.car.radius;
      p.car.pos.x = clamp(p.car.pos.x, -hw, hw); p.car.pos.z = clamp(p.car.pos.z, -hd, hd);
      p.invuln = Math.max(0, p.invuln - dt);
      cooldown[i] = Math.max(0, cooldown[i] - dt);
      // A press (not a hold) starts a swing, if not cooling down from a miss.
      if (ctrl.hit && !prevHit[i] && cooldown[i] <= 0 && !swing[i]) swing[i] = { left: CFG.hitWindow, done: false };
      prevHit[i] = !!ctrl.hit;
    });
    TP.Car.collideAll(d.players.filter((p) => !p.out).map((p) => p.car), d.tuning);

    if (d.state === "serve") { serveLeft -= dt; if (serveLeft <= 0) d.state = "play"; }

    d.players.forEach((p, i) => {
      const s = swing[i];
      if (!s || p.out) return;
      if (!s.done && d.state === "play" && tryHit(p, ctrls[i])) s.done = true;
      s.left -= dt;
      if (s.left <= 0) { if (!s.done) cooldown[i] = CFG.hitCooldown; swing[i] = null; }
    });
    if (d.freezeLeft > 0) return;    // a hit this step: freeze before the ball moves

    if (d.state === "play") {
      moveBall(dt);
      checkKOs();
      if (d.state === "play" && !d.ball.neutral && BUG !== "nostale") {
        sinceHit += dt;
        if (sinceHit >= CFG.stalemateTime) { d.stalemateResets++; serve(); }
      }
    }
  };

  /* ---------- Menu, results, rematch (just enough for the tests) ---------- */
  const $ = (id) => document.getElementById(id);
  function card(html) { $("card").innerHTML = html; $("overlay").classList.add("show"); }
  function hideCard() { $("overlay").classList.remove("show"); }
  const hubLink = `<a href="../../../index.html">← All modes</a>`;

  function showMenu() {
    const setup = TP.Rumble.loadSetup();
    card(`<h2>Deflect Duel (mock)</h2>` +
      setup.slots.map((s, i) => `<div>Seat ${i + 1}: <input class="seat-name" value="${s.name}"> <select class="seat-ctrl">${["bot", "kb1", "kb2", "pad0", "off"].map((c) => `<option${c === s.controller ? " selected" : ""}>${c}</option>`).join("")}</select></div>`).join("") +
      `<button id="start">Start</button> ${hubLink}`);
    $("start").onclick = () => {
      const slots = [...document.querySelectorAll(".seat-name")].map((el, i) => ({ name: el.value, controller: document.querySelectorAll(".seat-ctrl")[i].value }));
      if (BUG !== "nosave") TP.Rumble.saveSetup(slots);
      const active = slots.filter((s) => s.controller !== "off");
      d.newMatch({ players: Math.max(2, active.length), lives: 3, names: active.map((s) => s.name) });
    };
  }
  function showResults() {
    const w = d.players[d.winner];
    card(`<h2>${w ? w.name : "Nobody"} wins!</h2><button id="rematch">Rematch</button> ${hubLink}`);
    $("rematch").onclick = () => {
      if (BUG === "norematch") { d.state = "play"; d.winner = null; hideCard(); return; }
      d.newMatch(matchOpts);
    };
  }

  /* ---------- Start ---------- */
  if (q.has("demo")) {
    d.newMatch({ players: Number(q.get("players") || 4), lives: Number(q.get("lives") || 3) });
  } else {
    showMenu();
  }
  const speed = Number(q.get("speed") || 1);
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!d.paused) {
      // Fixed 1/60 sub-steps so speed ×8 stays stable.
      let left = dt * speed;
      while (left > 1e-6) { const s = Math.min(1 / 60, left); d.update(s); left -= s; }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
