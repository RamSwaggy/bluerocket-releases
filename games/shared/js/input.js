/* =====================================================================
   input.js — turns keyboards and gamepads into one simple "controller"
   shape that the rest of the game reads.

   Every controller (keyboard 1, keyboard 2, gamepads 1–4) is polled once
   per frame and produces:

     throttle  -1..1   (forward / reverse)
     steer     -1..1   (+1 = turn right)
     boost     bool    (held)
     jump      bool    (held)
     hit       bool    (held)  — swing/strike button (Deflect Duel etc.)
     heavy     bool    (held)  — second attack button (Car Fighter; other modes ignore it)
     confirmPressed    true only on the frame the jump/confirm button went down
     hitPressed        true only on the frame the hit button went down
     heavyPressed      true only on the frame the heavy button went down
     leftPressed / rightPressed   one-frame "menu nudge" events

   Bots don't use this file — each minigame computes bot controls itself
   in exactly the same shape, so cars can't tell humans and bots apart.
   ===================================================================== */
(function () {
  "use strict";

  /* ---------- Keyboard layouts ---------- */
  const KEYMAPS = {
    kb1: {
      up: ["KeyW"], down: ["KeyS"], left: ["KeyA"], right: ["KeyD"],
      jump: ["Space"], boost: ["ShiftLeft", "KeyF"], hit: ["KeyE", "KeyJ"], heavy: ["KeyR"],
    },
    kb2: {
      up: ["ArrowUp"], down: ["ArrowDown"], left: ["ArrowLeft"], right: ["ArrowRight"],
      jump: ["Enter", "Numpad0"], boost: ["ShiftRight", "ControlRight", "Slash"], hit: ["Period", "Numpad1"], heavy: ["Comma", "Numpad2"],
    },
  };

  // Human-readable labels for on-screen hints.
  TP.CONTROLLER_LABELS = {
    bot: "Bot (CPU)",
    kb1: "Keyboard 1 (WASD)",
    kb2: "Keyboard 2 (Arrows)",
    pad0: "Gamepad 1", pad1: "Gamepad 2", pad2: "Gamepad 3", pad3: "Gamepad 4",
  };
  TP.CONTROLLER_IDS = Object.keys(TP.CONTROLLER_LABELS);

  // What to call each button in hint text, per controller.
  TP.keyNames = function (id) {
    if (id === "kb1") return { confirm: "Space", boost: "Shift", hit: "E", heavy: "R", steer: "A / D", drive: "W / S" };
    if (id === "kb2") return { confirm: "Enter", boost: "R-Shift", hit: ".", heavy: ",", steer: "← / →", drive: "↑ / ↓" };
    return { confirm: "A", boost: "B", hit: "X", heavy: "Y", steer: "Stick", drive: "RT / LT" };
  };

  /* ---------- Raw keyboard state ---------- */
  const down = new Set();
  // Keys that would scroll the page or trigger browser actions.
  const BLOCK = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Slash", "Period", "Comma"]);

  window.addEventListener("keydown", (e) => {
    // Let people type in the menu's name boxes.
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) return;
    down.add(e.code);
    if (BLOCK.has(e.code)) e.preventDefault();
  });
  window.addEventListener("keyup", (e) => down.delete(e.code));
  // If the window loses focus, release everything so cars don't drive forever.
  window.addEventListener("blur", () => down.clear());

  const anyDown = (codes) => codes.some((c) => down.has(c));

  /* ---------- Reading one controller's raw values ---------- */
  function readKeyboard(map) {
    return {
      throttle: (anyDown(map.up) ? 1 : 0) - (anyDown(map.down) ? 1 : 0),
      steer: (anyDown(map.right) ? 1 : 0) - (anyDown(map.left) ? 1 : 0),
      boost: anyDown(map.boost),
      jump: anyDown(map.jump),
      hit: anyDown(map.hit),
      heavy: anyDown(map.heavy),
    };
  }

  function readGamepad(index) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && pads[index];
    if (!gp) return { throttle: 0, steer: 0, boost: false, jump: false, hit: false, heavy: false };

    const btn = (i) => (gp.buttons[i] ? gp.buttons[i].value : 0);
    const dead = (v) => (Math.abs(v) < 0.18 ? 0 : v); // ignore stick drift

    // Standard mapping: RT (7) = gas, LT (6) = reverse. If triggers are
    // idle we also accept the left stick's vertical axis, which helps on
    // pads that report triggers oddly.
    let throttle = btn(7) - btn(6);
    if (Math.abs(throttle) < 0.1) throttle = -dead(gp.axes[1] || 0);

    // D-pad left/right (14/15) also steers, handy for menus.
    let steer = dead(gp.axes[0] || 0);
    if (btn(14) > 0.5) steer = -1;
    if (btn(15) > 0.5) steer = 1;

    return {
      throttle: TP.util.clamp(throttle, -1, 1),
      steer,
      jump: btn(0) > 0.5,                    // A
      boost: btn(1) > 0.5 || btn(4) > 0.5,   // B or LB
      hit: btn(2) > 0.5 || btn(5) > 0.5,     // X or RB
      heavy: btn(3) > 0.5,                   // Y
    };
  }

  /* ---------- Per-frame polling with "just pressed" edges ---------- */
  const state = {}; // id → current processed controls
  const prev = {};  // id → last frame's raw booleans, for edge detection

  function poll() {
    for (const id of TP.CONTROLLER_IDS) {
      if (id === "bot") continue;
      const raw = id.startsWith("kb") ? readKeyboard(KEYMAPS[id]) : readGamepad(Number(id.slice(3)));
      const p = prev[id] || { jump: false, hit: false, heavy: false, left: false, right: false };
      const left = raw.steer < -0.5;
      const right = raw.steer > 0.5;
      state[id] = {
        ...raw,
        confirmPressed: raw.jump && !p.jump,
        hitPressed: raw.hit && !p.hit,
        heavyPressed: raw.heavy && !p.heavy,
        leftPressed: left && !p.left,
        rightPressed: right && !p.right,
      };
      prev[id] = { jump: raw.jump, hit: raw.hit, heavy: raw.heavy, left, right };
    }
  }

  const NEUTRAL = Object.freeze({
    throttle: 0, steer: 0, boost: false, jump: false, hit: false, heavy: false,
    confirmPressed: false, hitPressed: false, heavyPressed: false, leftPressed: false, rightPressed: false,
  });

  TP.Input = {
    poll,
    // Controls for a controller id. Bots (or unknown ids) get neutral input.
    get: (id) => state[id] || NEUTRAL,
    NEUTRAL,
  };
})();
