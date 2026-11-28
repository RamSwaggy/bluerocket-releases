/* =====================================================================
   announcer.js — short callouts over the fight: text that slams in on
   one player's side, plus a synthesised "announcer" blip (no voice
   recordings: every sound is made in code, so there's nothing to credit).

   All the words are our own (DESIGN.md's originality rule):
     FIRST HIT        the first hit of a round
     CRUNCHY!         a combo of 4–5 hits
     TOTALLED!        a combo of 6+ hits
     WALL SPLAT!      a hit bounces a car off the rail
     TOWED!           a throw lands
     ON FUMES!        a car drops under 25% health (once per round)
     NOT A SCRATCH!   a round won with full health
     BY A BOLT!       a round won with under 10% health left
   The callout shows on the side of the player who earned it (the
   attacker, or the round's winner); ON FUMES! shows on the car that's
   in trouble.

   view.js calls TP.FightAnnouncer.attach(fight) once per fight. It only
   reads fight events and fight.state; it never changes the fight.
   ===================================================================== */
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  if (params.has("headless")) return;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // How loud each callout is, as a "tier" for the blip (0 small .. 2 big).
  const TIER = { first: 0, crunchy: 1, totalled: 2, splat: 1, towed: 1, fumes: 0, scratch: 2, bolt: 2 };

  let run = null;   // { fight, off, firstHitDone, fumes: [bool, bool], round, timer }

  function layer() {
    let el = $("callout");
    if (!el) {
      el = document.createElement("div");
      el.id = "callout";
      el.className = "layer";
      document.body.appendChild(el);
    }
    return el;
  }

  /* Slam one callout in on `side` (0 = left / P1, 1 = right / P2). */
  function say(key, text, side, sub) {
    const el = layer();
    el.style.setProperty("--seat", TP.PLAYER_CSS[side] || "#fff");
    el.className = "layer " + (side ? "right" : "left");
    el.innerHTML = `<div class="word">${esc(text)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}`;
    void el.offsetWidth;            // restart the slam-in animation
    el.classList.add("show");
    clearTimeout(run && run.timer);
    if (run) run.timer = setTimeout(() => el.classList.remove("show"), 1150);
    if (TP.FightSfx && TP.FightSfx.callout) TP.FightSfx.callout(TIER[key] || 0);
  }

  function onEvent(ev) {
    if (!run) return;
    const s = run.fight.state;

    // New round: reset the once-per-round callouts.
    if (s.round !== run.round) {
      run.round = s.round;
      run.firstHitDone = false;
      run.fumes = [false, false];
    }

    switch (ev.type) {
      case "round_start":
        run.firstHitDone = false;
        run.fumes = [false, false];
        break;
      case "hit":
        if (!run.firstHitDone) {
          run.firstHitDone = true;
          say("first", "FIRST HIT", ev.attacker);
        }
        break;
      case "throw":
        run.firstHitDone = true;
        say("towed", "TOWED!", ev.attacker);
        break;
      case "wall_bounce": {
        const who = ev.attacker != null ? ev.attacker : 1 - ev.victim;
        say("splat", "WALL SPLAT!", who);
        break;
      }
      case "combo_end":
        if (ev.hits >= 6) say("totalled", "TOTALLED!", ev.attacker, `${ev.hits} hits · ${Math.round(ev.damage)} damage`);
        else if (ev.hits >= 4) say("crunchy", "CRUNCHY!", ev.attacker, `${ev.hits} hits`);
        break;
      case "round_end": {
        // Not in training (it has no rounds to win).
        if (s.training || ev.winner == null || !Array.isArray(ev.health)) break;
        const c = s.cars[ev.winner];
        const frac = ev.health[ev.winner] / (c ? c.maxHealth : 1000);
        if (frac >= 0.999) say("scratch", "NOT A SCRATCH!", ev.winner);
        else if (frac < 0.1) say("bolt", "BY A BOLT!", ev.winner);
        break;
      }
    }

    // Low health, once per round per car (checked after any damage).
    if ((ev.type === "hit" || ev.type === "throw" || ev.type === "block") && !s.training) {
      for (let i = 0; i < 2; i++) {
        const c = s.cars[i];
        // state.cars is written after the step, so read the live fighter.
        const f = run.fight._fighters && run.fight._fighters[i];
        const hp = f ? f.health : c.health;
        const max = f ? f.maxHealth : c.maxHealth;
        if (!run.fumes[i] && hp > 0 && hp / max < 0.25) {
          run.fumes[i] = true;
          // Let a bigger callout from this same hit (combo, splat) win.
          setTimeout(() => { if (run) say("fumes", "ON FUMES!", i); }, 650);
        }
      }
    }
  }

  TP.FightAnnouncer = {
    attach(fight) {
      TP.FightAnnouncer.detach();
      run = { fight, firstHitDone: false, fumes: [false, false], round: fight.state.round, timer: 0 };
      run.off = typeof fight.onEvent === "function" ? fight.onEvent(onEvent) : null;
    },
    detach() {
      if (run) { clearTimeout(run.timer); if (run.off) run.off(); }
      run = null;
      const el = $("callout");
      if (el) el.classList.remove("show");
    },
    say,   // for tests and the view
  };
})();
