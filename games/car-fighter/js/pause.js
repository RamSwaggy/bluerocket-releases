/* =====================================================================
   pause.js — the pause menu and the move list.

   Opening it:
     Escape or P on the keyboard, or Start on any gamepad, during a match
     (versus, training or the tutorial). Not on the menus, not once the
     match is over, and not while the Controls screen is open.

   The pause card (driven by mouse, arrows or a pad, through TP.MenuNav):
     Resume ........... back to the fight (also B / Escape / Start)
     Move list ........ every move of the cars in play, with the buttons
                        each player has bound, startup frames and damage
     🎮 Controls ...... the shared rebinding screen
     Restart .......... the same match again from round 1
     Quit to menu ..... back to Car Fighter's menu
   In training it also has the training settings: what the dummy does,
   whether the super meter refills, and "Reset positions".

   While paused the fight doesn't step at all (TP.Match.setPaused), so
   the clock, stun and everything else stand still. The stage keeps
   drawing behind the card.

   main.js tells us what Restart and Quit do:
     TP.FightPause.configure({ onRestart, onQuit })
   and training.js reads/sets the training settings through the fight
   itself (fight.training, fight.setTraining, fight.resetPositions).
   ===================================================================== */
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  if (params.has("headless")) return;   // QC's fast sims draw nothing

  const UI = TP.FightUI;
  const esc = UI.esc;

  let hooks = { onRestart: null, onQuit: null };
  let paused = false;

  // The dummy's behaviours in training (fight.js's TRAINING_DUMMIES).
  const DUMMIES = [
    ["stand", "Stand still"],
    ["block", "Block everything"],
    ["jump", "Keep jumping"],
    ["attack", "Attack now and then"],
    ["bot", "Fight back (Normal bot)"],
  ];

  /* ---------- When can we pause? ---------- */
  function canPause() {
    const f = TP.Match && TP.Match.fight;
    if (!f || paused) return false;
    if (f.state.phase === "matchEnd") return false;
    // A card is already up (menu, select, results): no pausing over it.
    if (document.getElementById("overlay").classList.contains("show")) return false;
    // The Controls screen is open, or it's waiting for a key to rebind.
    if (TP.MenuNav && TP.MenuNav.modal) return false;
    if (TP.Controls && TP.Controls.capturing) return false;
    return true;
  }

  /* ---------- Pause / resume ---------- */
  function pause() {
    if (!canPause()) return;
    paused = true;
    TP.Match.setPaused(true);
    if (TP.FightSfx && TP.FightSfx.count) TP.FightSfx.count();
    showPauseCard();
  }

  function resume() {
    if (!paused) return;
    paused = false;
    UI.hideCard();
    // setPaused(false) also makes the fight ignore any button that's
    // still held from pressing "Resume", until it's let go, so the A
    // that clicked Resume doesn't also jump.
    TP.Match.setPaused(false);
  }

  // Shared look for both of our cards: no select/results layout.
  function card(html, onBack) {
    const el = UI.card(html, { onBack });
    el.className = "card pause";
    const ov = document.getElementById("overlay");
    ov.classList.remove("select-mode", "results-mode");
    return el;
  }

  function showPauseCard() {
    const fight = TP.Match.fight;
    const tr = fight && fight.training;
    const training = tr ? `
      <div class="trainset">
        <label>Dummy
          <select id="pdummy" aria-label="What the training dummy does">
            ${DUMMIES.map(([v, l]) => `<option value="${v}" ${v === tr.dummy ? "selected" : ""}>${esc(l)}</option>`).join("")}
          </select>
        </label>
        <label class="toggle"><input type="checkbox" id="pmeter" ${tr.meter ? "checked" : ""}> Refill super meter</label>
        <button class="btn ghost" id="preset">Reset positions</button>
      </div>` : "";

    const el = card(`
      <h2 class="title">Paused</h2>
      ${training}
      <div class="pausebtns">
        <button class="btn" id="presume" data-nav-primary>Resume</button>
        <button class="btn alt" id="pmoves">Move list</button>
        <button class="btn alt" data-open-controls title="Rebind keys and buttons">🎮 Controls</button>
        <button class="btn ghost" id="prestart">${tr ? "Restart training" : "Restart match"}</button>
        <button class="btn ghost" id="pquit">Quit to menu</button>
      </div>
      <p class="muted">Esc / Start / B to resume</p>`, resume);

    el.querySelector("#presume").addEventListener("click", resume);
    el.querySelector("#pmoves").addEventListener("click", () => showMoveList());
    el.querySelector("#prestart").addEventListener("click", () => {
      paused = false;
      TP.Match.setPaused(false);
      if (hooks.onRestart) hooks.onRestart();
    });
    el.querySelector("#pquit").addEventListener("click", () => {
      paused = false;
      if (hooks.onQuit) hooks.onQuit();
    });
    if (tr) {
      el.querySelector("#pdummy").addEventListener("change", (e) => fight.setTraining({ dummy: e.target.value }));
      el.querySelector("#pmeter").addEventListener("change", (e) => fight.setTraining({ meter: e.target.checked }));
      el.querySelector("#preset").addEventListener("click", () => { fight.resetPositions(); resume(); });
    }
  }

  /* =====================================================================
     Move list: built from the move tables themselves (TP.fighterMoves),
     so it can never drift from what the fight really does.
     ===================================================================== */

  // Turn a move's `input` string into button names for one player.
  // "hit*2" = the 2nd Hit of the chain; "jump>hit" = jump, then Hit;
  // "a+b" = both together (or a direction plus a button).
  function inputText(input, k) {
    const name = { hit: k.hit, heavy: k.heavy, boost: k.boost, jump: k.confirm, toward: "Toward", away: "Away" };
    const chain = input.match(/^(\w+)\*(\d)$/);
    if (chain) return Array(Number(chain[2])).fill(name[chain[1]] || chain[1]).join(", ");
    return input.split(">").map((part) =>
      part.split("+").map((b) => name[b] || b).join(" + ")).join(", then ");
  }

  // Short plain-English notes from a move's flags.
  function notes(m) {
    const n = [];
    const fl = m.flags || {};
    if (fl.signature) n.push("1 super bar");
    if (fl.launcher) n.push("launches");
    if (fl.knockdown) n.push("knocks down");
    if (fl.throw) n.push("beats block, loses to attacks");
    if (fl.armour) n.push(`armour (${fl.armour} hit)`);
    if (fl.crossup) n.push("crosses up: block the new way");
    if (fl.shockwave) n.push("shockwave");
    if (m.cost && m.cost.boost) n.push(`${m.cost.boost} boost`);
    else if (m.usesBoost && !fl.signature) n.push("uses boost");
    if (m.air) n.push("in the air");
    return n.join(" · ");
  }

  function totalDamage(m) {
    // Multi-hit: each hit's own damage, or the row's when a hit doesn't set one.
    if (Array.isArray(m.hits) && m.hits.length) return m.hits.reduce((s, h) => s + (h.damage != null ? h.damage : m.damage || 0), 0);
    return m.damage || 0;
  }

  function moveTable(fighterId, controller, seatIndex) {
    const moves = TP.fighterMoves(fighterId);
    const human = controller && controller !== "bot" && controller !== "dummy" && controller !== "off";
    // Bots and the dummy have no keys: show player 1's keyboard names.
    const k = TP.keyNames(human ? controller : "kb1");
    const rows = Object.keys(moves)
      .map((id) => moves[id])
      .filter((m) => m && m.input && !m.internal)
      .map((m) => `
        <tr>
          <td class="mn">${esc(m.name)}</td>
          <td><kbd>${esc(inputText(m.input, k))}</kbd></td>
          <td class="num">${m.startup}</td>
          <td class="num">${Math.round(totalDamage(m))}</td>
          <td class="muted">${esc(notes(m))}</td>
        </tr>`).join("");
    const def = TP.FIGHTERS[fighterId] || {};
    return `
      <section class="movelist" style="--seat:${TP.PLAYER_CSS[seatIndex]}">
        <h3>${esc(def.displayName || def.name || fighterId)}</h3>
        <table>
          <tr><th>Move</th><th>Input</th><th title="Frames before it can hit (60 = 1 second)">Startup</th><th>Damage</th><th></th></tr>
          ${rows}
        </table>
      </section>`;
  }

  function showMoveList(onBack) {
    const fight = TP.Match.fight;
    const back = onBack || showPauseCard;
    const cars = fight ? fight.state.cars : [];
    // One table per car in play (just one when it's a mirror match).
    const seen = new Set();
    const tables = cars.filter((c) => !seen.has(c.fighter) && seen.add(c.fighter))
      .map((c) => moveTable(c.fighter, c.controller, c.index)).join("");
    const el = card(`
      <h2 class="title">Move list</h2>
      <p class="muted">Hold <b>away</b> to guard · tap up / down to dodge · "Toward" and "Away" mean toward or away from the other car · Startup is in frames (60 = 1 second)</p>
      <div class="movelists">${tables}</div>
      <div class="actions">
        <button class="btn" id="mback" data-nav-primary data-nav-back>← Back</button>
      </div>`, back);
    el.querySelector("#mback").addEventListener("click", back);
  }

  /* ---------- Listening for the pause button ---------- */
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) return;
    // While paused, Escape belongs to the pause card's MenuNav (= Resume).
    if ((e.code === "Escape" || e.code === "KeyP") && !paused) {
      if (canPause()) { e.preventDefault(); pause(); }
    }
  });

  // Gamepad Start (standard button 9). We keep tracking it while paused
  // too, so the Start that resumes (via MenuNav) isn't seen as a new press.
  let startWasDown = false;
  function pollPads() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    const down = pads.some((gp) => gp.buttons[9] && gp.buttons[9].pressed);
    if (down && !startWasDown && !paused) pause();
    startWasDown = down;
    requestAnimationFrame(pollPads);
  }
  requestAnimationFrame(pollPads);

  TP.FightPause = {
    configure(h) { hooks = Object.assign(hooks, h); },
    pause, resume, showMoveList,
    get paused() { return paused; },
    inputText,   // for tests and the tutorial
  };
})();
