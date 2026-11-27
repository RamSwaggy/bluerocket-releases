/* =====================================================================
   util.js — shared helpers used by every other file.

   Everything in the game hangs off one global object, `TP` ("Turbo
   Party"). We use plain <script> tags instead of ES modules so the game
   runs straight from file:// when you double-click index.html.
   ===================================================================== */
window.TP = window.TP || {};

(function () {
  "use strict";

  /* ---------- Player colours (hex for Three.js, CSS for the HUD) ---------- */
  TP.PLAYER_COLORS = [0x3b82f6, 0xf97316, 0x22c55e, 0xec4899];
  TP.PLAYER_CSS = ["#3b82f6", "#f97316", "#22c55e", "#ec4899"];
  TP.DEFAULT_NAMES = ["Blue", "Orange", "Green", "Pink"];

  /* ---------- Small maths helpers ---------- */
  const util = {
    clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),
    lerp: (a, b, t) => a + (b - a) * t,

    // Frame-rate independent smoothing. `lambda` is "how fast" (bigger =
    // snappier). Using exp() means the result is the same at 30fps or 144fps.
    damp: (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt)),

    // Wrap any angle into the range -PI..PI so "turn left or right?"
    // decisions always pick the short way round.
    wrapAngle(a) {
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      return a;
    },

    rand: (lo, hi) => lo + Math.random() * (hi - lo),
    randInt: (lo, hi) => Math.floor(lo + Math.random() * (hi - lo + 1)), // inclusive
    pick: (arr) => arr[Math.floor(Math.random() * arr.length)],
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },

    // Horizontal (x/z) distance — most game logic ignores height.
    dist2D: (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz),

    /* Turn a list of scores into ranked groups, handling ties.
       Example: scores [5, 9, 5, 1] → [[1], [0, 2], [3]]
       meaning player 1 is 1st, players 0 and 2 tie for 2nd, player 3 last. */
    rankByScore(scores) {
      const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
      const groups = [];
      for (const i of order) {
        const last = groups[groups.length - 1];
        if (last && scores[last[0]] === scores[i]) last.push(i);
        else groups.push([i]);
      }
      return groups;
    },
  };
  TP.util = util;

  /* =====================================================================
     Scheduler — lets game flow be written as simple async code, e.g.

        await TP.sched.wait(1.0);              // pause 1 second
        await TP.sched.tween(0.3, k => ...);   // animate k from 0 → 1
        await TP.sched.until(() => pressed);   // wait for a condition

     The main loop calls TP.sched.update(dt) once per frame, which is what
     moves the timers forward. Because time only advances inside update(),
     everything stays in sync with the game's own clock.
     ===================================================================== */
  class Scheduler {
    constructor() {
      this.jobs = []; // each job: { step(dt) → true when finished, resolve }
    }

    // Called once per frame by main.js.
    update(dt) {
      // Copy first: a job finishing can add new jobs during this loop.
      const current = this.jobs.slice();
      for (const job of current) {
        if (job.step(dt)) {
          this.jobs.splice(this.jobs.indexOf(job), 1);
          job.resolve();
        }
      }
    }

    // Generic: run `step(dt)` every frame until it returns true.
    run(step) {
      return new Promise((resolve) => this.jobs.push({ step, resolve }));
    }

    wait(seconds) {
      let t = 0;
      return this.run((dt) => (t += dt) >= seconds);
    }

    // Calls fn(k) every frame with k going 0 → 1 over `duration` seconds.
    tween(duration, fn) {
      let t = 0;
      return this.run((dt) => {
        t += dt;
        const k = Math.min(1, t / duration);
        fn(k);
        return k >= 1;
      });
    }

    // Resolves on the first frame `cond()` returns true.
    until(cond) {
      return this.run(() => !!cond());
    }

    // Drop every pending job (used when restarting a game).
    clear() {
      this.jobs.length = 0;
    }
  }
  TP.sched = new Scheduler();

  /* Ease curves for tweens: k in 0..1 → eased 0..1 */
  TP.ease = {
    outCubic: (k) => 1 - Math.pow(1 - k, 3),
    inOutQuad: (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2),
  };

  /* Free GPU memory for a scene we're done with (minigame arenas). */
  TP.disposeScene = function (scene) {
    scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => {
          if (m.map) m.map.dispose();
          m.dispose();
        });
      }
    });
  };

  /* Shared "stadium" lighting so every scene looks like the same game. */
  TP.addStadiumLights = function (scene, size) {
    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1f33, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(size * 0.6, size * 1.4, size * 0.5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    // The shadow camera has to cover the play area or shadows get clipped.
    const s = size * 1.1;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: size * 4 });
    sun.shadow.bias = -0.0005;
    scene.add(sun);
    return sun;
  };
})();
