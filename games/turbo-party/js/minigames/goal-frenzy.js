/* =====================================================================
   Goal Frenzy — 4-way car soccer, 60 seconds.
   A square arena with a goal on every side; each player guards one.
   Knock the ball into a rival's goal: +1 for you (whoever touched it
   last), -1 for the goal's owner. Own goals just cost you the point.

   Golden goal: if two or more players are tied for 1st when the 60
   seconds are up, play goes on for up to OVERTIME more seconds and ends
   the moment a goal breaks that tie. (A goal that leaves the top still
   tied, e.g. one trailing player scoring on another, doesn't end it.)
   If nobody breaks the tie in time, the tie stands.
   ===================================================================== */
(function () {
  "use strict";
  const { clamp, dist2D } = TP.util;

  const HALF = 22;       // arena is 44 × 44
  const GOAL_HALF = 6;   // goal mouth is 12 wide
  const BALL_R = 1.5;
  const CAR_HIT_R = 1.4; // car's "bumper sphere" for ball contact
  const OVERTIME = 15;   // max seconds of golden-goal overtime

  // Which side each player defends. n = direction from the goal INTO the arena.
  const SIDES = [
    { axis: "z", sign: 1 },   // player 0: south (nearest the camera)
    { axis: "z", sign: -1 },  // player 1: north
    { axis: "x", sign: 1 },   // player 2: east
    { axis: "x", sign: -1 },  // player 3: west
  ];
  // Goal centre on the boundary for a side.
  const goalCenter = (s) => (s.axis === "x" ? { x: s.sign * HALF, z: 0 } : { x: 0, z: s.sign * HALF });

  class GoalFrenzy extends TP.Arena {
    constructor(game) {
      super(game, { title: "Goal Frenzy", duration: 60, size: HALF, camera: { y: 46, z: 38, lookZ: 3 } });
      this.score = this.players.map(() => 0);
      this.lastTouch = null;
      this.ballPause = 0; // seconds the ball stays frozen after a goal
      this.overtime = false;  // in golden-goal overtime?
      this.tieBroken = false; // set when an overtime goal breaks the tie
      this.resetBall();
    }

    // True if two or more players share the top score.
    topTied() {
      const best = Math.max(...this.score);
      return this.score.filter((x) => x === best).length > 1;
    }

    // The round ends early only when an overtime goal breaks the tie.
    isOver() { return this.overtime && this.tieBroken; }

    build() {
      this.buildBoxArena(HALF, 0x1f6f4a, 0x2a3566, GOAL_HALF);

      // A coloured goal frame + net box for each player's side.
      SIDES.forEach((s, i) => {
        const css = TP.PLAYER_COLORS[i];
        const mat = new THREE.MeshStandardMaterial({ color: css, emissive: css, emissiveIntensity: 0.35, transparent: true, opacity: 0.55 });
        const depth = 4;
        const g = new THREE.Group();
        // Back of the net.
        const back = new THREE.Mesh(new THREE.BoxGeometry(GOAL_HALF * 2, 4, 0.3), mat);
        back.position.set(0, 2, depth);
        g.add(back);
        // Sides and roof.
        for (const sx of [-1, 1]) {
          const side = new THREE.Mesh(new THREE.BoxGeometry(0.3, 4, depth), mat);
          side.position.set(sx * GOAL_HALF, 2, depth / 2);
          g.add(side);
        }
        const roof = new THREE.Mesh(new THREE.BoxGeometry(GOAL_HALF * 2, 0.3, depth), mat);
        roof.position.set(0, 4, depth / 2);
        g.add(roof);
        // Floor patch inside the goal (so the ball has something to roll on).
        const floor = new THREE.Mesh(new THREE.BoxGeometry(GOAL_HALF * 2, 1, depth), new THREE.MeshStandardMaterial({ color: 0x14402b }));
        floor.position.set(0, -0.5, depth / 2);
        g.add(floor);

        // The group is built facing +Z; rotate it to the right side.
        const c = goalCenter(s);
        g.position.set(c.x, 0, c.z);
        g.rotation.y = s.axis === "z" ? (s.sign > 0 ? 0 : Math.PI) : (s.sign > 0 ? Math.PI / 2 : -Math.PI / 2);
        this.scene.add(g);
      });

      // The ball.
      this.ball = {
        mesh: new THREE.Mesh(
          new THREE.SphereGeometry(BALL_R, 32, 20),
          new THREE.MeshStandardMaterial({ color: 0xf2f5ff, roughness: 0.35, emissive: 0x1a2140 })
        ),
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
      };
      this.ball.mesh.castShadow = true;
      this.scene.add(this.ball.mesh);
    }

    resetBall() {
      // Drop the ball in from above the middle with a tiny random nudge.
      this.ball.pos.set(0, 8, 0);
      this.ball.vel.set((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2);
      this.lastTouch = null;
    }

    spawn(i) {
      // In front of your own goal, facing the middle.
      const s = SIDES[i];
      const d = HALF - 6;
      const x = s.axis === "x" ? s.sign * d : 0;
      const z = s.axis === "z" ? s.sign * d : 0;
      return { x, z, heading: Math.atan2(-x, -z) };
    }

    clampCar(car) { this.clampToBox(car, HALF); }

    tick(dt) {
      const b = this.ball;

      // Time's up with a tie for 1st? Golden-goal overtime. (The arena
      // counts timeLeft down just before tick and ends the round right
      // after it, so topping the clock up here keeps play going.)
      if (!this.overtime && this.timeLeft <= 0 && this.topTied()) {
        this.overtime = true;
        this.timeLeft = OVERTIME;
        TP.UI.toast("Tied for 1st — GOLDEN GOAL! Next goal that breaks the tie wins");
        TP.sfx.play("go");
      }

      if (this.ballPause > 0) {
        this.ballPause -= dt;
        if (this.ballPause <= 0) this.resetBall();
        return;
      }

      /* ---------- Ball physics ---------- */
      b.vel.y -= 22 * dt;
      b.pos.addScaledVector(b.vel, dt);

      // Bounce on the floor, with rolling friction.
      if (b.pos.y < BALL_R) {
        b.pos.y = BALL_R;
        if (b.vel.y < 0) b.vel.y = -b.vel.y * 0.6;
        if (b.vel.y < 1) b.vel.y = 0;
        const fr = Math.exp(-0.4 * dt);
        b.vel.x *= fr; b.vel.z *= fr;
      }

      /* ---------- Walls and goals ----------
         For each axis: if the ball reaches the boundary inside the goal
         mouth (and low enough to fit under the crossbar) it can go in;
         otherwise it bounces off the wall. Once its centre is past the
         goal line it's committed: it can only go in (see below). */
      for (const axis of ["x", "z"]) {
        const other = axis === "x" ? "z" : "x";
        const p = b.pos[axis];

        // Ball's centre already past the goal line (so it came in through
        // the mouth)? Then the pitch-wall rule below must not apply: that's
        // what used to snap a ball sitting in the goal back out onto the
        // pitch when it drifted near a post. Instead the goal's side nets
        // and roof hold it in, and it rolls on until it's fully over the
        // line, which is the goal.
        if (Math.abs(p) > HALF) {
          const lim = GOAL_HALF - BALL_R; // side nets, measured to the ball's centre
          if (Math.abs(b.pos[other]) > lim) {
            b.pos[other] = Math.sign(b.pos[other]) * lim;
            b.vel[other] *= -0.5;
          }
          if (b.pos.y > 4 - BALL_R) { // the roof of the net
            b.pos.y = 4 - BALL_R;
            if (b.vel.y > 0) b.vel.y *= -0.5;
          }
          // Committed: a ball more than half over the line always keeps
          // rolling in (at least 2 units/s), so it can't stall on the line
          // or be dragged back out by a defender's bumper. Cars can't enter
          // the goal, so nobody could clear it properly anyway.
          if (b.vel[axis] * Math.sign(p) < 2) b.vel[axis] = Math.sign(p) * 2;
          if (Math.abs(p) > HALF + BALL_R) {
            const owner = SIDES.findIndex((s) => s.axis === axis && s.sign === Math.sign(p));
            this.onGoal(owner);
            return;
          }
          continue;
        }

        const inMouth = Math.abs(b.pos[other]) < GOAL_HALF - BALL_R * 0.5 && b.pos.y < 4;
        if (Math.abs(p) > HALF - BALL_R && !inMouth) {
          b.pos[axis] = Math.sign(p) * (HALF - BALL_R);
          b.vel[axis] *= -0.8;
        }
      }

      /* ---------- Car → ball contact ---------- */
      for (const car of this.cars) {
        const cx = car.pos.x, cy = car.pos.y + 0.7, cz = car.pos.z;
        const dx = b.pos.x - cx, dy = b.pos.y - cy, dz = b.pos.z - cz;
        const d = Math.hypot(dx, dy, dz);
        const minD = BALL_R + CAR_HIT_R;
        if (d >= minD || d < 1e-4) continue;
        const nx = dx / d, ny = dy / d, nz = dz / d;

        // Push the ball out of the car.
        b.pos.set(cx + nx * minD, cy + ny * minD, cz + nz * minD);

        // Bounce off the car, then add a "kick" from the car's speed into
        // the ball. The extra lift makes shots feel punchy.
        const rel = (b.vel.x - car.vel.x) * nx + (b.vel.y - car.vel.y) * ny + (b.vel.z - car.vel.z) * nz;
        if (rel < 0) {
          b.vel.x -= nx * rel * 1.5;
          b.vel.y -= ny * rel * 1.5;
          b.vel.z -= nz * rel * 1.5;
        }
        const carSpeed = car.speed2D();
        b.vel.x += car.vel.x * 0.35;
        b.vel.z += car.vel.z * 0.35;
        b.vel.y += Math.max(0, ny) * 3 + carSpeed * 0.12;

        // Cap ball speed so it stays readable on screen.
        const sp = b.vel.length();
        if (sp > 38) b.vel.multiplyScalar(38 / sp);
        this.lastTouch = car.index;
      }
    }

    onGoal(owner) {
      const scorer = this.lastTouch;
      this.score[owner] -= 1;
      if (scorer !== null && scorer !== owner) {
        this.score[scorer] += 1;
        TP.UI.toast(`${this.players[scorer].name} scores on ${this.players[owner].name}!`);
      } else {
        TP.UI.toast(`Own goal, ${this.players[owner].name}!`);
      }
      TP.sfx.play("goal");
      this.fx.explosion(this.ball.pos.clone(), TP.PLAYER_COLORS[scorer !== null && scorer !== owner ? scorer : owner]);
      // Freeze the ball out of sight, then re-drop it.
      this.ball.pos.set(0, -50, 0);
      this.ball.vel.set(0, 0, 0);
      this.ballPause = 1.4;
      if (this.overtime && !this.topTied()) this.tieBroken = true;
    }

    animate() {
      this.ball.mesh.position.copy(this.ball.pos);
      // Fake rolling: spin based on horizontal velocity.
      this.ball.mesh.rotation.x += this.ball.vel.z * 0.02;
      this.ball.mesh.rotation.z -= this.ball.vel.x * 0.02;
    }

    botControls(car) {
      const b = this.ball.pos;
      const bv = this.ball.vel;
      const side = SIDES[car.index];
      const g = goalCenter(side);
      const ballToGoal = dist2D(b.x, b.z, g.x, g.z);

      // Is the ball rolling toward my goal?
      const toGoalX = g.x - b.x, toGoalZ = g.z - b.z;
      const heading = (bv.x * toGoalX + bv.z * toGoalZ) / (Math.hypot(toGoalX, toGoalZ) || 1);
      const threat = ballToGoal < 15 || (heading > 6 && ballToGoal < 26);

      let tx, tz;
      if (this.ballPause > 0) {
        // Ball is resetting: wait between my goal and the centre.
        tx = g.x * 0.55; tz = g.z * 0.55;
        return TP.ai.driveTo(car, tx, tz, { arrive: 4 });
      }

      if (threat) {
        // DEFEND: get to the goal side of the ball, then clear it.
        const carToGoal = dist2D(car.pos.x, car.pos.z, g.x, g.z);
        if (carToGoal < ballToGoal - 1) {
          tx = b.x; tz = b.z; // I'm already goal-side: hit it away
        } else {
          tx = g.x + (b.x - g.x) * 0.3; tz = g.z + (b.z - g.z) * 0.3; // get back
        }
      } else {
        // ATTACK the rival goal nearest the ball (never my own).
        let tg = null, best = Infinity;
        SIDES.forEach((s, i) => {
          if (i === car.index) return;
          const c = goalCenter(s);
          const d = dist2D(b.x, b.z, c.x, c.z);
          if (d < best) { best = d; tg = c; }
        });
        // Line up behind the ball relative to that goal, then drive through it.
        const dx = tg.x - b.x, dz = tg.z - b.z;
        const len = Math.hypot(dx, dz) || 1;
        const behindX = b.x - (dx / len) * 3, behindZ = b.z - (dz / len) * 3;
        const lined = dist2D(car.pos.x, car.pos.z, behindX, behindZ) < 3.5;
        tx = lined ? b.x : behindX;
        tz = lined ? b.z : behindZ;
      }

      // Keep targets inside the walls.
      tx = clamp(tx, -HALF + 2, HALF - 2);
      tz = clamp(tz, -HALF + 2, HALF - 2);
      const ctrl = TP.ai.driveTo(car, tx, tz, { boostDist: 10 });

      // Jump at a bouncing ball that's right in front of us.
      const near = dist2D(car.pos.x, car.pos.z, b.x, b.z) < 4.5;
      ctrl.jump = near && b.y > 2.6 && b.y < 6 && Math.abs(TP.ai.angleTo(car, b.x, b.z)) < 0.5;
      return ctrl;
    }

    scores() { return this.score.slice(); }
    chips() {
      return this.players.map((p, i) => ({ name: p.name, css: p.css, value: (this.score[i] > 0 ? "+" : "") + this.score[i] }));
    }
  }

  TP.MINIGAMES.push({
    id: "goal-frenzy",
    name: "Goal Frenzy",
    cls: GoalFrenzy,
    blurb: "Four goals, one ball, 60 seconds. Guard the goal in your colour and smash the ball into everyone else's. Score: +1. Get scored on: -1. Tied for 1st at the end? Golden goal!",
  });
})();
