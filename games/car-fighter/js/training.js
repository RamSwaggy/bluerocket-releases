/* =====================================================================
   training.js — Training mode's on-screen readout, and the tutorial.

   Both run on top of a TRAINING fight (fight.js with opts.training):
   no clock, nobody gets KO'd, health refills when a combo ends, and the
   right-hand car is a dummy whose behaviour the pause menu sets.

   TRAINING (free practice):
     A panel under the HUD shows what the dummy is doing, your last hit
     (move and damage), your current / best combo (hits and damage), and
     a reminder that Esc / Start opens the settings and the move list.

   TUTORIAL (6 short lessons, in order):
     1 Move     walk left and right
     2 Dodge    tap up / down to sidestep, twice
     3 Guard    hold away while the dummy attacks: block 3 hits
     4 Combo    Hit, Hit, Hit: land the 3-hit chain
     5 Throw    the dummy blocks now: throw it (Hit + Heavy up close)
     6 Signature  a full super bar: Boost + Heavy
   Each lesson names the buttons the player has actually bound
   (TP.keyNames), says what to do in one line, and moves on by itself
   once it's done. At the end: carry on in free training, or go back to
   the menu.

   main.js calls:
     TP.FightTraining.begin(fight, { tutorial, controller, onMenu })
     TP.FightTraining.end()            (when the fight goes away)
   ===================================================================== */
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  if (params.has("headless")) return;

  const UI = TP.FightUI;
  const esc = UI.esc;
  const $ = (id) => document.getElementById(id);

  const DUMMY_NAMES = {
    stand: "standing still", block: "blocking", jump: "jumping",
    attack: "attacking now and then", bot: "fighting back",
  };

  let run = null;   // the current training session (see begin)

  /* ---------- The tutorial's lessons ---------- */
  // Each lesson: what the dummy does, the line to show (k = the player's
  // key names), how much needs doing (goal), and how progress is counted:
  //   onEvent(ev, run) and/or onFrame(state, run) add to run.progress.
  const LESSONS = [
    {
      title: "Move",
      dummy: "stand",
      goal: 8,
      text: (k) => `Drive left and right with <kbd>${esc(k.steer)}</kbd>. Your car always faces the other one.`,
      // Count distance actually walked (in car-body units).
      onFrame(s, r) {
        const c = s.cars[0];
        if (r.lastX !== undefined && (c.state === "walk" || c.state === "idle")) r.progress += Math.abs(c.x - r.lastX);
        r.lastX = c.x;
      },
    },
    {
      title: "Dodge",
      dummy: "stand",
      goal: 2,
      text: (k) => `Tap <kbd>${esc(k.drive)}</kbd> to sidestep into or out of the screen. Hits pass you by. Dodge twice.`,
      onFrame(s, r) {
        const st = s.cars[0].state;
        if (st === "sidestep" && r.lastState !== "sidestep") r.progress++;
        r.lastState = st;
      },
    },
    {
      title: "Guard",
      dummy: "attack",
      goal: 3,
      text: () => `The dummy attacks now. Hold <b>away</b> from it (the direction pointing away) to guard. Block 3 hits.`,
      onEvent(ev, r) { if (ev.type === "block" && ev.victim === 0) r.progress++; },
    },
    {
      title: "Combo",
      dummy: "stand",
      goal: 1,
      text: (k) => `Walk up close and press <kbd>${esc(k.hit)}</kbd> three times: Jab, Swipe, Spinout. A move only chains if the one before it connected.`,
      onEvent(ev, r) {
        if (ev.attacker === 0 && (ev.type === "hit" || ev.type === "block") && ev.move === "spinout") r.progress++;
      },
    },
    {
      title: "Throw",
      dummy: "block",
      goal: 1,
      text: (k) => `The dummy blocks everything now, so attacks won't get through. Get right up close and press <kbd>${esc(k.hit)}</kbd> + <kbd>${esc(k.heavy)}</kbd> together to throw it.`,
      onEvent(ev, r) { if (ev.type === "throw" && ev.attacker === 0) r.progress++; },
    },
    {
      title: "Signature",
      dummy: "stand",
      goal: 1,
      meter: true,
      text: (k, sig) => `Your super bar is full. Press <kbd>${esc(k.boost)}</kbd> + <kbd>${esc(k.heavy)}</kbd> for your car's signature move, <b>${esc(sig)}</b>. It costs 1 bar.`,
      onEvent(ev, r) {
        if (ev.attacker === 0 && (ev.type === "hit" || ev.type === "block") && ev.move === "signature") r.progress++;
      },
    },
  ];

  /* ---------- The panel ---------- */
  function panel() {
    let el = $("coach");
    if (!el) {
      el = document.createElement("div");
      el.id = "coach";
      el.className = "layer";
      document.body.appendChild(el);
    }
    return el;
  }

  function moveName(id) {
    const m = run && run.moves[id];
    return m ? m.name : id;
  }

  function keys() {
    return TP.keyNames(run.controller);
  }

  /* Free training: dummy, last hit, combo, and the pause hint. */
  function drawTraining() {
    const tr = run.fight.training || {};
    const last = run.lastHit ? `${esc(moveName(run.lastHit.move))} <b>${Math.round(run.lastHit.damage)}</b>${run.lastHit.type === "block" ? " (blocked)" : ""}` : "–";
    const combo = run.combo.hits >= 2 ? `<b>${run.combo.hits}</b> hits · <b>${Math.round(run.combo.damage)}</b>` : "–";
    const best = run.best.hits >= 2 ? `${run.best.hits} hits · ${Math.round(run.best.damage)}` : "–";
    panel().innerHTML = `
      <div class="box">
        <div class="hd">TRAINING <span class="muted">· dummy ${esc(DUMMY_NAMES[tr.dummy] || tr.dummy || "")}${tr.meter ? " · meter refills" : ""}</span></div>
        <div class="row"><span>Last hit</span><span>${last}</span></div>
        <div class="row"><span>Combo</span><span>${combo}</span></div>
        <div class="row"><span>Best combo</span><span>${best}</span></div>
        <div class="ft"><kbd>Esc</kbd> / <kbd>Start</kbd> pause: dummy settings, move list</div>
      </div>`;
  }

  /* Tutorial: the lesson, its progress, and a tick when it's done. */
  function drawLesson() {
    const L = LESSONS[run.lesson];
    const sig = moveName("signature");
    const pct = Math.min(1, run.progress / L.goal);
    const count = L.goal > 1 && L.title !== "Move" ? ` ${Math.min(L.goal, Math.floor(run.progress))} / ${L.goal}` : "";
    panel().innerHTML = `
      <div class="box lesson ${run.doneAt ? "done" : ""}">
        <div class="hd">TUTORIAL ${run.lesson + 1} / ${LESSONS.length} · <b>${esc(L.title)}</b>${run.doneAt ? " ✓" : ""}</div>
        <p>${L.text(keys(), sig)}</p>
        <div class="bar"><i style="width:${(pct * 100).toFixed(0)}%"></i></div>
        <div class="ft">${run.doneAt ? "Nice!" : esc(count.trim())} <span class="muted">· <kbd>Esc</kbd> / <kbd>Start</kbd> pause</span></div>
      </div>`;
  }

  function startLesson(i) {
    run.lesson = i;
    run.progress = 0;
    run.doneAt = 0;
    run.lastX = undefined;
    run.lastState = undefined;
    const L = LESSONS[i];
    run.fight.setTraining({ dummy: L.dummy, meter: !!L.meter });
    // Fresh start for each lesson: both cars back on their marks.
    if (i > 0) run.fight.resetPositions();
    drawLesson();
  }

  function finishTutorial() {
    run.tutorial = false;
    TP.Match.setPaused(true);
    const el = UI.card(`
      <h2 class="title">Tutorial complete!</h2>
      <p class="tagline">That's the whole toolkit: move, dodge, guard, combo, throw and signature.
        The move list in the pause menu has the rest (launchers, air moves, Dash Strike).</p>
      <div class="actions">
        <button class="btn ghost" id="tmenu">Menu</button>
        <button class="btn" id="tfree" data-nav-primary>Keep practising</button>
      </div>`, { onBack: () => el.querySelector("#tfree").click() });
    el.className = "card pause";
    el.querySelector("#tfree").addEventListener("click", () => {
      UI.hideCard();
      run.fight.setTraining({ dummy: "stand", meter: true });
      TP.Match.setPaused(false);
      drawTraining();
    });
    el.querySelector("#tmenu").addEventListener("click", () => { if (run.onMenu) run.onMenu(); });
  }

  /* ---------- Feeding the readout ---------- */
  function onEvent(ev) {
    if (!run) return;
    if (run.tutorial) {
      const L = LESSONS[run.lesson];
      if (L.onEvent && !run.doneAt) { L.onEvent(ev, run); drawLesson(); }
      return;
    }
    // Free training: only the player's (P1's) attacks count.
    if (ev.attacker !== 0) return;
    if (ev.type === "hit" || ev.type === "block" || ev.type === "throw") {
      run.lastHit = { move: ev.move, damage: ev.damage, type: ev.type };
      // Hits and throws carry the dummy's combo so far (fight.js puts it
      // on the event). A blocked hit isn't a combo.
      if (ev.type !== "block") run.combo = { hits: ev.combo || 1, damage: ev.comboDamage || ev.damage || 0 };
      if (run.combo.hits > run.best.hits || (run.combo.hits === run.best.hits && run.combo.damage > run.best.damage)) {
        run.best = { hits: run.combo.hits, damage: run.combo.damage };
      }
      drawTraining();
    }
  }

  function tick() {
    if (!run) return;
    const s = run.fight.state;
    if (run.tutorial && !TP.Match.isPaused()) {
      const L = LESSONS[run.lesson];
      if (!run.doneAt) {
        if (L.onFrame) L.onFrame(s, run);
        if (run.progress >= L.goal) { run.doneAt = performance.now(); if (TP.FightSfx && TP.FightSfx.chime) TP.FightSfx.chime(); }
        // Redraw the bar a few times a second, not every frame.
        if (L.onFrame && (++run.frames % 6 === 0 || run.doneAt)) drawLesson();
      } else if (performance.now() - run.doneAt > 1200) {
        if (run.lesson + 1 < LESSONS.length) startLesson(run.lesson + 1);
        else finishTutorial();
      }
    } else if (!run.tutorial && run.panelDummy !== (run.fight.training || {}).dummy + "|" + (run.fight.training || {}).meter) {
      // The pause menu changed the settings: show the new ones.
      run.panelDummy = (run.fight.training || {}).dummy + "|" + (run.fight.training || {}).meter;
      drawTraining();
    }
    requestAnimationFrame(tick);
  }

  TP.FightTraining = {
    begin(fight, opts = {}) {
      TP.FightTraining.end();
      const p1 = fight.state.cars[0];
      run = {
        fight,
        tutorial: !!opts.tutorial,
        controller: opts.controller || p1.controller || "kb1",
        onMenu: opts.onMenu,
        moves: TP.fighterMoves(p1.fighter),
        lesson: 0, progress: 0, doneAt: 0, frames: 0,
        lastHit: null, combo: { hits: 0, damage: 0 }, best: { hits: 0, damage: 0 },
        panelDummy: "",
      };
      run.off = fight.onEvent(onEvent);
      panel().classList.add("show");
      if (run.tutorial) startLesson(0); else drawTraining();
      requestAnimationFrame(tick);
    },
    end() {
      if (run && run.off) run.off();
      run = null;
      const el = $("coach");
      if (el) { el.classList.remove("show"); el.innerHTML = ""; }
    },
    get active() { return !!run; },
    get lesson() { return run ? run.lesson : -1; },   // for tests
    LESSONS,
  };
})();
