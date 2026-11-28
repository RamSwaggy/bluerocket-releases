/* =====================================================================
   match.js — the glue between the page and the fight core.

   It:
     • reads the URL options (DESIGN §9):
         ?demo           bot vs bot
         &speed=N        game speed multiplier (default 1)
         &seed=N         seed for every random roll (default: random)
         &rounds=N       rounds (default 3: best of 3)
         &roundTime=S    round length in seconds (default 60)
         &p1= / &p2=     rivet | haulback | skitter (M1: Rivet only)
         &bot=           easy | normal | hard (&bot2= sets the second bot)
         &headless       no rendering, for fast simulations
         &training       training mode (dummy in seat 2; see fight.js)
                         &dummy=stand|block|jump|attack|bot
     • reads the hub's saved players (TP.Rumble.loadSetup(), seats 0–1;
       "off" means a bot takes that seat),
     • creates the fight and runs it with a FIXED 60 Hz step: real time
       (times `speed`) goes into an accumulator and the fight advances in
       whole 1/60 s steps, so the fight plays the same at any frame rate,
     • calls the view if Art's TP.FightView exists:
         TP.FightView.init(scene, fight)   once per fight
         TP.FightView.frame(state, dt, fight)   every rendered frame
       so the fight runs before the view lands, and headless.

   Exposes window.TP.fight (the current fight) and TP.Match:
     TP.Match.start(overrides)  start a new fight (the menu calls this)
     TP.Match.stop()            stop the loop
     TP.Match.runFrames(n)      advance n frames immediately (tests)
     TP.Match.runToEnd(max)     run until the match ends (headless sims)
     TP.Match.setTimeScale(s)   visual slow-motion: 0.25 = quarter speed,
                                1 = normal (resets on start; headless and
                                runFrames ignore it)
     TP.Match.setPaused(on)     pause / resume (pause.js): while paused no
                                fight step runs, the stage keeps drawing.
                                On resume, buttons still held from the
                                pause menu are ignored until let go.
     TP.Match.isPaused()
     TP.Match.options           the options in use
   A page whose menu starts the fight itself sets
   `TP.MATCH_MANUAL_START = true` before this script; otherwise the fight
   starts as soon as the page has loaded.
   ===================================================================== */
window.TP = window.TP || {};

(function () {
  "use strict";

  const DT = 1 / 60;
  const params = new URLSearchParams(location.search);

  function num(name, def) {
    const v = parseFloat(params.get(name));
    return Number.isFinite(v) ? v : def;
  }
  function str(name, def) {
    const v = params.get(name);
    return v ? v.toLowerCase() : def;
  }

  function readOptions() {
    const bot = str("bot", "normal");
    return {
      demo: params.has("demo"),
      headless: params.has("headless"),
      speed: Math.max(0.05, num("speed", 1)),
      seed: params.has("seed") ? (num("seed", 1) >>> 0) : Math.floor(Math.random() * 1e9),
      rounds: Math.max(1, Math.round(num("rounds", 3))),
      roundTime: Math.max(5, num("roundTime", 60)),
      p1: str("p1", "rivet"),
      p2: str("p2", "rivet"),
      bot,
      bot2: str("bot2", bot),
      training: params.has("training") ? { dummy: str("dummy", "stand"), meter: true } : null,
    };
  }

  // Who controls each seat: the hub's saved setup, "off" = bot, ?demo = both bots.
  function seatControllers(o) {
    if (o.demo) return ["bot", "bot"];
    let slots = null;
    try { slots = TP.Rumble && TP.Rumble.loadSetup().slots; } catch (e) { slots = null; }
    const pick = (i, def) => {
      const c = slots && slots[i] && slots[i].controller;
      if (!c || c === "off") return i === 0 ? def : "bot";
      return c;
    };
    return [pick(0, "kb1"), pick(1, "bot")];
  }

  /* ---------- Human input, latched between fight steps ----------
     A press shorter than one fight step (or one that lands on a render
     frame where no fight step runs) must not be lost, so "just pressed"
     flags are OR-ed together until a step uses them. */
  const latched = [{}, {}];
  // After a resume: per seat, the buttons that were held at that moment.
  // Each one reads as "not held" until it's released once.
  const HELD_KEYS = ["jump", "hit", "heavy", "boost"];
  let ignoreHeld = [{}, {}];
  function readHumans(controllers) {
    const out = [null, null];
    for (let i = 0; i < 2; i++) {
      const id = controllers[i];
      if (id === "bot" || id === "dummy" || !TP.Input) continue;
      let c = TP.Input.get(id);
      const ign = ignoreHeld[i];
      if (Object.keys(ign).length) {
        c = Object.assign({}, c);
        for (const k of HELD_KEYS) {
          if (!ign[k]) continue;
          if (c[k]) c[k] = false; else delete ign[k];   // let go: back to normal
        }
        c.confirmPressed = c.confirmPressed && !ign.jump;
        c.hitPressed = c.hitPressed && !ign.hit;
        c.heavyPressed = c.heavyPressed && !ign.heavy;
      }
      const L = latched[i];
      for (const k of ["confirmPressed", "hitPressed", "heavyPressed", "leftPressed", "rightPressed"]) L[k] = L[k] || !!c[k];
      out[i] = Object.assign({}, c, L);
    }
    return out;
  }
  function clearLatch() { latched[0] = {}; latched[1] = {}; }

  // The same controls with every one-frame "just pressed" flag switched
  // off (null stays null: that seat is a bot).
  const PRESS_FLAGS = ["confirmPressed", "hitPressed", "heavyPressed", "leftPressed", "rightPressed"];
  function withoutPresses(c) {
    if (!c) return c;
    const out = Object.assign({}, c);
    for (const k of PRESS_FLAGS) out[k] = false;
    return out;
  }

  let current = null; // { fight, scene, options, controllers, timer, running }
  let timeScale = 1;  // see setTimeScale
  let paused = false; // see setPaused

  function start(overrides = {}) {
    stop();
    const o = Object.assign(readOptions(), overrides);
    const controllers = overrides.controllers || seatControllers(o);
    const scene = overrides.scene || new THREE.Scene();
    const fight = TP.Fight.create({
      p1: { fighter: o.p1, controller: controllers[0], bot: o.bot },
      p2: { fighter: o.p2, controller: controllers[1], bot: o.bot2 },
      rounds: o.rounds,
      roundTime: o.roundTime,
      seed: o.seed,
      training: o.training || null,
      scene,
    });
    current = { fight, scene, options: o, controllers, running: true, acc: 0, last: performance.now(), handle: null };
    timeScale = 1;   // slow-motion always resets with a new fight
    paused = false;
    TP.fight = fight;
    TP.Match.options = o;
    TP.Match.fight = fight;

    const view = !o.headless && TP.FightView ? TP.FightView : null;
    if (view && view.init) view.init(scene, fight);
    current.view = view;

    schedule(current);
    return fight;
  }

  function schedule(run) {
    if (!run.running) return;
    const tick = (now) => frame(run, typeof now === "number" ? now : performance.now());
    // Headless runs use timers (they keep going in background tabs);
    // the real game uses animation frames.
    if (run.options.headless || !run.view) run.handle = setTimeout(() => tick(performance.now()), 4);
    else run.handle = requestAnimationFrame(tick);
  }

  function frame(run, now) {
    if (!run.running || run !== current) return;
    const realDt = Math.min(0.1, Math.max(0, (now - run.last) / 1000));
    run.last = now;
    // timeScale (slow-motion) only changes how fast real time feeds the
    // fixed steps, so the fight itself stays exactly the same. Headless
    // runs ignore it.
    run.acc += realDt * run.options.speed * (run.options.headless ? 1 : timeScale);

    if (TP.Input) TP.Input.poll();
    if (paused) {
      // Keep polling (so presses made in the pause menu are used up
      // there), keep drawing, but don't move the fight on at all.
      run.acc = 0;
      clearLatch();
      if (run.view && run.view.frame) run.view.frame(run.fight.state, 0, run.fight);
      schedule(run);
      return;
    }
    const humans = readHumans(run.controllers);

    // Fixed steps. Cap the work per frame so a slow machine can't spiral.
    const maxSteps = Math.ceil(run.options.speed * 6) + 4;
    let steps = 0;
    while (run.acc >= DT && steps < maxSteps) {
      // On a slow or 30 Hz screen one rendered frame runs 2+ fight steps.
      // A "just pressed" flag must reach only the FIRST of them; feeding
      // it to every step turned one tap into several presses (a single
      // Hit could chain Jab into Swipe on its own). Held buttons and
      // sticks still go to every step.
      run.fight.step(steps === 0 ? humans : humans.map(withoutPresses));
      clearLatch();
      run.acc -= DT;
      steps++;
    }
    if (steps >= maxSteps) run.acc = 0;

    if (run.view && run.view.frame) run.view.frame(run.fight.state, realDt, run.fight);
    schedule(run);
  }

  function stop() {
    if (!current) return;
    current.running = false;
    if (current.handle !== null) {
      clearTimeout(current.handle);
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(current.handle);
    }
  }

  // Test helpers: advance the current fight right now, without waiting for real time.
  function runFrames(n) {
    if (!current) return null;
    for (let k = 0; k < n && current.fight.state.phase !== "matchEnd"; k++) current.fight.step([null, null]);
    return current.fight.state;
  }
  function runToEnd(maxFrames = 60 * 60 * 20) {
    return runFrames(maxFrames);
  }

  // Visual slow-motion (e.g. 0.25 on a KO). 1 = normal. Clamped to 0..4.
  function setTimeScale(s) {
    const v = Number(s);
    timeScale = Number.isFinite(v) ? Math.max(0, Math.min(4, v)) : 1;
    return timeScale;
  }

  function setPaused(on) {
    on = !!on;
    if (on === paused) return paused;
    paused = on;
    if (!on && current && TP.Input) {
      // Whatever is held right now pressed "Resume" (or is left over from
      // the menu): ignore it until it's released. Poll first: Resume is
      // usually pressed inside a keydown handler, before the game loop has
      // polled that same key, so the last poll wouldn't show it held yet.
      TP.Input.poll();
      ignoreHeld = current.controllers.map((id) => {
        const ign = {};
        if (id === "bot" || id === "dummy") return ign;
        const c = TP.Input.get(id);
        for (const k of HELD_KEYS) if (c[k]) ign[k] = true;
        return ign;
      });
      current.last = performance.now();   // no time jump after the pause
    }
    return paused;
  }

  TP.Match = {
    start, stop, runFrames, runToEnd, readOptions, setTimeScale, getTimeScale: () => timeScale,
    setPaused, isPaused: () => paused,
    options: null, fight: null,
  };

  window.addEventListener("load", () => {
    if (!TP.MATCH_MANUAL_START) start();
  });
})();
