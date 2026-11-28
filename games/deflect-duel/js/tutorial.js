/* =====================================================================
   tutorial.js — Deflect Duel's practice room and its short tutorial.

   PRACTICE ROOM (plain English): you, alone in the arena, with a ball
   launcher on the far wall. It fires balls at you at the speed on the
   dial, so you can practise returning fast shots, jumping and flipping
   out of the way, flying, and bunting. You can't run out of lives.
     • Speed dial: keys 0–5 (0 = launcher off, 1 = slow … 5 = top speed),
       or press Heavy (R / , / pad Y) to step through the speeds.
     • Leave with Escape or the Menu button on the side card.

   TUTORIAL: the same room, with a list of steps that each wait for you to
   actually do the move (the rules record every strike, bunt and flip, so
   we just watch those). Each step can be skipped with Heavy. It takes
   about 60–90 seconds:
     1. Strike        drive to the ball, press Hit
     2. Aim up        hold Up while you hit
     3. Aim down      hold Down while you hit (it bounces off the floor)
     4. Return        the launcher fires: hit it back before it touches you
     5. Double jump   jump, then jump again in the air
     6. Flip strike   jump, then jump again holding a direction, into the ball
     7. Bunt          land on the ball with your wheels: it pops up and
                      your jump and flip come back
     8. Clash         (just read this one: two strikes at once cancel out)

   Used by main.js:
     TP.DuelPractice.start(duel, { tutorial, controller, onExit })
     TP.DuelPractice.update(dt)    once per frame while it's running
     TP.DuelPractice.stop()
   ===================================================================== */
(function () {
  "use strict";

  // The speed dial: key 0..5 → launcher speed (0 = off).
  const DIAL = [0, 16, 40, 80, 140, 210];

  const STEPS = [
    {
      title: "Strike",
      text: "Drive to the ball and press <b>Hit</b> to strike it. Every strike makes it faster, and it turns your colour.",
      launcher: 0,
      done: (ev) => ev.type === "strike",
    },
    {
      title: "Aim up",
      text: "Hold <b>Up</b> while you press <b>Hit</b> to send it upward. It bounces off the ceiling.",
      launcher: 0,
      done: (ev) => ev.type === "strike" && ev.angle === "up",
    },
    {
      title: "Aim down",
      text: "Hold <b>Down</b> while you press <b>Hit</b> to drive it into the floor so it bounces up.",
      launcher: 0,
      done: (ev) => ev.type === "strike" && ev.angle === "down",
    },
    {
      title: "Return it",
      text: "The launcher is firing at you! Its ball knocks you out if it touches you. <b>Hit it back</b> first. Steer to bend your shot.",
      launcher: 22,
      done: (ev, ctx) => ev.type === "strike" && ev.from === ctx.launcher,
    },
    {
      title: "Double jump",
      text: "Press <b>Jump</b>, then <b>Jump</b> again in the air. Jumping is how you dodge a ball you can't return.",
      launcher: 0,
      check: (ctx) => ctx.car.doubleJumped,
    },
    {
      title: "Flip strike",
      text: "Jump, then press <b>Jump</b> again <b>while holding a direction</b>: your car flips. Flip <b>into</b> the ball for a powerful strike.",
      launcher: 0,
      done: (ev) => ev.type === "strike" && ev.flip,
    },
    {
      title: "Bunt",
      text: "Jump and <b>land on the ball with your wheels</b>. It pops up gently, stays yours, and your jump and flip come back for another move.",
      launcher: 0,
      done: (ev) => ev.type === "bunt",
    },
    {
      title: "Clash",
      text: "If two players strike the ball at the same moment, it's a <b>CLASH</b>: both bounce away and the ball stays put. Watch for it in a real duel!",
      launcher: 0,
      autoNext: 7,
    },
  ];

  let st = null; // the running practice / tutorial, or null

  // The player's real key/button for Heavy (they may have rebound it).
  const heavyKey = () => {
    try { return TP.HUD.esc(TP.keyNames(st.duel.players[st.human].controller).heavy || "Heavy"); } catch (e) { return "Heavy"; }
  };

  // Put a fresh neutral ball in front of the player for the step to use.
  function freshBall(duel) {
    const car = duel.cars[st.human];
    const h = car.heading;
    duel.setBall({ pos: { x: car.pos.x + Math.sin(h) * 7, y: 3, z: car.pos.z + Math.cos(h) * 7 }, vel: { x: 0, z: 0 }, owner: null });
  }

  function showStep() {
    const s = STEPS[st.step];
    if (!s) {
      TP.HUD.center("YOU'RE READY!", "Back to the menu for a real duel, or stay and practise", "#ffe14d");
      TP.HUD.hint(`Practice room: launcher speed <kbd>0</kbd>–<kbd>5</kbd> or <kbd>${heavyKey()}</kbd> · <kbd>Esc</kbd> menu`);
      st.tutorial = false;
      st.duel.setPracticeSpeed(40);
      TP.sched.wait(3).then(() => { if (st && !st.tutorial) TP.HUD.center(""); });
      return;
    }
    st.duel.setPracticeSpeed(s.launcher);
    if (!s.launcher) freshBall(st.duel);
    st.stepT = 0;
    TP.HUD.center(`${st.step + 1}/${STEPS.length}  ${s.title}`, "", "#ffe14d");
    TP.sched.wait(1.6).then(() => { if (st && st.tutorial) TP.HUD.center(""); });
    TP.HUD.hint(`<b>${st.step + 1}. ${s.title}:</b> ${s.text} &nbsp; <span class="muted">(<kbd>${heavyKey()}</kbd> skips · <kbd>Esc</kbd> menu)</span>`);
  }

  function nextStep() {
    TP.sfx.play("trophy");
    TP.HUD.toast("✔ " + STEPS[st.step].title, "#7dff9a", 1.0);
    st.step++;
    showStep();
  }

  TP.DuelPractice = {
    DIAL,
    STEPS,
    get active() { return !!st; },

    start(duel, { tutorial = false, onExit } = {}) {
      st = {
        duel, tutorial, onExit,
        human: duel.players.findIndex((p) => !p.launcher),
        step: 0, stepT: 0, seen: duel.events.length, prevHeavy: false,
      };
      if (tutorial) showStep();
      else TP.HUD.hint(`Practice room: launcher speed <kbd>0</kbd>–<kbd>5</kbd> or <kbd>${heavyKey()}</kbd> · endless lives · <kbd>Esc</kbd> menu`);
    },

    stop() { st = null; },

    // Number keys set the launcher speed (practice and tutorial alike,
    // except that the tutorial picks its own speed for each step).
    dial(k) {
      if (!st || st.tutorial || !(k >= 0 && k < DIAL.length)) return;
      st.duel.setPracticeSpeed(DIAL[k]);
      TP.HUD.toast(DIAL[k] ? `Launcher: ${DIAL[k]}` : "Launcher off", "#ffe14d", 0.8);
    },

    update(dt) {
      if (!st) return;
      const duel = st.duel;
      const p = duel.players[st.human];
      const ctrl = TP.Input.get(p.controller);

      // Heavy: skip a tutorial step, or step the practice speed dial.
      const heavy = !!ctrl.heavy;
      if (heavy && !st.prevHeavy) {
        if (st.tutorial) nextStep();
        else {
          const k = (DIAL.indexOf(duel.practiceSpeed) + 1) % DIAL.length;
          duel.setPracticeSpeed(DIAL[k]);
          TP.HUD.toast(DIAL[k] ? `Launcher: ${DIAL[k]}` : "Launcher off", "#ffe14d", 0.8);
        }
      }
      st.prevHeavy = heavy;
      if (!st.tutorial) return;

      // Watch the counted events for the move this step wants.
      const s = STEPS[st.step];
      if (!s) return;
      st.stepT += dt;
      const ctx = { launcher: duel.launcherIndex, car: duel.cars[st.human], human: st.human };
      const fresh = duel.events.slice(st.seen);
      st.seen = duel.events.length;
      const mine = fresh.filter((e) => e.player === st.human || e.type === "bunt");
      if (s.done && mine.some((e) => s.done(e, ctx))) { nextStep(); return; }
      if (s.check && s.check(ctx)) { nextStep(); return; }
      if (s.autoNext && st.stepT >= s.autoNext) { nextStep(); return; }
      // Steps that need a ball in front of you: if it's wandered off (or
      // turned neutral far away), put a new one in front of you.
      if (!s.launcher && s.done && st.stepT > 8 && duel.ball.mode === "neutral") { freshBall(duel); st.stepT = 4; }
    },
  };
})();
