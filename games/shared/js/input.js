/* =====================================================================
   input.js — turns keyboards and gamepads into one simple "controller"
   shape that the rest of the game reads.

   Every controller (keyboard 1, keyboard 2, gamepads 1–4) is polled once
   per frame and produces:

     throttle  -1..1   (forward / reverse)
     steer     -1..1   (+1 = turn right)
     pitch     -1..1   (+1 = nose up / "up"): keyboard W/S or ↑/↓, gamepad
                       left stick up/down. Modes with an aim or tilt use it
                       (e.g. air tilt). On keyboards it's the same keys as
                       throttle; on gamepads it's separate from the triggers.
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

  /* =================================================================
     REBINDABLE CONTROLS (modelled on RocketBonk's settings).

     Three profiles, each a list of actions with two binding slots:
       kb1 / kb2 ... the two keyboard players
       pad ......... one layout shared by every gamepad
     A binding is one of:
       { type: "key", code }            KeyboardEvent.code, e.g. "KeyW"
       { type: "button", index }        standard-mapping gamepad button
       { type: "axis", index, dir }     stick axis pushed past the deadzone
       null                             empty slot
     Saved to localStorage "rumble.controls.v1"; loading merges the save
     over the defaults, so actions added later still get a default.
     The rebinding SCREEN lives in controls-menu.js (loaded on demand).
     Menus themselves never use these bindings (D-pad, A, B and Start
     always drive menus), so you can't lock yourself out.
     ================================================================= */
  const KB_ACTIONS = [
    { id: "up", label: "Drive forward / aim up" },
    { id: "down", label: "Reverse / aim down" },
    { id: "left", label: "Steer left" },
    { id: "right", label: "Steer right" },
    { id: "jump", label: "Jump / confirm" },
    { id: "boost", label: "Boost" },
    { id: "hit", label: "Hit" },
    { id: "heavy", label: "Heavy" },
  ];
  const PAD_ACTIONS = [
    { id: "gas", label: "Gas" },
    { id: "reverse", label: "Reverse" },
    { id: "left", label: "Steer left" },
    { id: "right", label: "Steer right" },
    { id: "up", label: "Aim / tilt up" },
    { id: "down", label: "Aim / tilt down" },
    { id: "jump", label: "Jump / confirm" },
    { id: "boost", label: "Boost" },
    { id: "hit", label: "Hit" },
    { id: "heavy", label: "Heavy" },
  ];
  const K = (code) => ({ type: "key", code });
  const B = (index) => ({ type: "button", index });
  const A = (index, dir) => ({ type: "axis", index, dir });
  // Defaults = the original fixed layouts, so nothing changes until you rebind.
  const DEFAULTS = {
    kb1: { bindings: {
      up: [K("KeyW"), null], down: [K("KeyS"), null], left: [K("KeyA"), null], right: [K("KeyD"), null],
      jump: [K("Space"), null], boost: [K("ShiftLeft"), K("KeyF")], hit: [K("KeyE"), K("KeyJ")], heavy: [K("KeyR"), null],
    } },
    kb2: { bindings: {
      up: [K("ArrowUp"), null], down: [K("ArrowDown"), null], left: [K("ArrowLeft"), null], right: [K("ArrowRight"), null],
      jump: [K("Enter"), K("Numpad0")], boost: [K("ShiftRight"), K("ControlRight")], hit: [K("Period"), K("Numpad1")], heavy: [K("Comma"), K("Numpad2")],
    } },
    pad: {
      bindings: {
        gas: [B(7), null], reverse: [B(6), null],
        left: [A(0, -1), B(14)], right: [A(0, 1), B(15)],   // stick or D-pad
        up: [A(1, -1), null], down: [A(1, 1), null],
        jump: [B(0), null], boost: [B(1), B(4)], hit: [B(2), B(5)], heavy: [B(3), null],
      },
      deadzone: 0.18,            // stick drift below this is ignored
      steerSensitivity: 1,       // >1 = full lock with less stick
    },
  };
  const STORE = "rumble.controls.v1";
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function loadControls() {
    const s = clone(DEFAULTS);
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || "null");
      if (saved) for (const prof of Object.keys(s)) {
        if (!saved[prof]) continue;
        for (const k of Object.keys(s[prof])) if (k !== "bindings" && typeof saved[prof][k] === "number") s[prof][k] = saved[prof][k];
        const sb = saved[prof].bindings || {};
        for (const a of Object.keys(s[prof].bindings)) if (Array.isArray(sb[a])) s[prof].bindings[a] = [sb[a][0] || null, sb[a][1] || null];
      }
    } catch (e) { /* bad save: use defaults */ }
    return s;
  }
  let controls = loadControls();
  function saveControls() { try { localStorage.setItem(STORE, JSON.stringify(controls)); } catch (e) { /* fine */ } }

  /* ---------- Names for bindings (key caps and pad glyphs) ---------- */
  // PlayStation pads: Sony's vendor id 054c, or the names Windows/Chrome
  // give them. "Wireless Controller" alone is the PS4 pad's name, but
  // Xbox pads are "Xbox Wireless Controller", so rule Xbox out first.
  const isPlayStation = (padId) => !/xbox|xinput|045e/i.test(padId || "") && /054c|playstation|dualsense|dualshock|wireless controller/i.test(padId || "");
  const XBOX = ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "View", "Menu", "LS", "RS", "D-pad Up", "D-pad Down", "D-pad Left", "D-pad Right", "Xbox"];
  const PS = ["✕", "○", "□", "△", "L1", "R1", "L2", "R2", "Share", "Options", "L3", "R3", "D-pad Up", "D-pad Down", "D-pad Left", "D-pad Right", "PS", "Touchpad"];
  const KEY_NAMES = { Space: "Space", Enter: "Enter", ShiftLeft: "L-Shift", ShiftRight: "R-Shift", ControlLeft: "L-Ctrl", ControlRight: "R-Ctrl",
    AltLeft: "L-Alt", AltRight: "R-Alt", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Period: ".", Comma: ",", Slash: "/",
    Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`", Backspace: "Backspace", Tab: "Tab" };
  function firstPadId() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    return pads[0] ? pads[0].id : "";
  }
  function bindingLabel(b, padId) {
    if (!b) return "Unbound";
    if (b.type === "key") return KEY_NAMES[b.code] || b.code.replace(/^Key|^Digit/, "").replace(/^Numpad/, "Num ");
    if (b.type === "button") return ((isPlayStation(padId === undefined ? firstPadId() : padId) ? PS : XBOX)[b.index]) || "Button " + b.index;
    if (b.type === "axis") {
      const stick = b.index < 2 ? "Left Stick" : b.index < 4 ? "Right Stick" : "Axis " + b.index;
      const dir = b.index % 2 === 0 ? (b.dir < 0 ? "Left" : "Right") : (b.dir < 0 ? "Up" : "Down");
      return stick + " " + dir;
    }
    return "?";
  }

  // Human-readable labels for on-screen hints.
  TP.CONTROLLER_LABELS = {
    bot: "Bot (CPU)",
    kb1: "Keyboard 1 (WASD)",
    kb2: "Keyboard 2 (Arrows)",
    pad0: "Gamepad 1", pad1: "Gamepad 2", pad2: "Gamepad 3", pad3: "Gamepad 4",
  };
  TP.CONTROLLER_IDS = Object.keys(TP.CONTROLLER_LABELS);

  // What to call each button in hint text, per controller. Built from the
  // CURRENT bindings, so hints follow whatever the player rebound.
  TP.keyNames = function (id) {
    const isKb = id === "kb1" || id === "kb2";
    const prof = controls[isKb ? id : "pad"].bindings;
    const padId = isKb ? "" : (() => { const pads = navigator.getGamepads ? navigator.getGamepads() : []; const gp = pads && pads[Number(String(id).slice(3)) || 0]; return gp ? gp.id : ""; })();
    const L = (a) => { const s = prof[a] || []; return bindingLabel(s[0] || s[1], padId); };
    const stickSteer = prof.left[0] && prof.left[0].type === "axis" && prof.left[0].index === 0;
    return {
      confirm: L("jump"), boost: L("boost"), hit: L("hit"), heavy: L("heavy"),
      steer: !isKb && stickSteer ? "Stick" : `${L("left")} / ${L("right")}`,
      drive: isKb ? `${L("up")} / ${L("down")}` : `${L("gas")} / ${L("reverse")}`,
    };
  };

  /* ---------- Raw keyboard state ---------- */
  const down = new Set();
  // Keys that would scroll the page or trigger browser actions.
  const BLOCK = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Slash", "Period", "Comma", "Quote"]);

  window.addEventListener("keydown", (e) => {
    // Let people type in the menu's name boxes.
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) return;
    down.add(e.code);
    if (BLOCK.has(e.code)) e.preventDefault();
  });
  window.addEventListener("keyup", (e) => down.delete(e.code));
  // If the window loses focus, release everything so cars don't drive forever.
  window.addEventListener("blur", () => down.clear());

  /* ---------- Reading one controller's raw values ---------- */
  // An action is "on" if either of its two slots is.
  function readKeyboard(prof) {
    const on = (a) => (prof.bindings[a] || []).some((b) => b && b.type === "key" && down.has(b.code));
    const fb = (on("up") ? 1 : 0) - (on("down") ? 1 : 0);
    return {
      throttle: fb,
      steer: (on("right") ? 1 : 0) - (on("left") ? 1 : 0),
      pitch: fb,
      boost: on("boost"), jump: on("jump"), hit: on("hit"), heavy: on("heavy"),
    };
  }

  // A pad binding's strength, 0..1: a button's pressure, or how far a
  // stick axis is pushed in the bound direction (ignoring drift).
  function padValue(gp, b, dz) {
    if (!b) return 0;
    if (b.type === "button") return gp.buttons[b.index] ? gp.buttons[b.index].value : 0;
    if (b.type === "axis") { const v = (gp.axes[b.index] || 0) * b.dir; return v < dz ? 0 : Math.min(1, v); }
    return 0;
  }

  function readGamepad(index) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && pads[index];
    if (!gp) return { throttle: 0, steer: 0, pitch: 0, boost: false, jump: false, hit: false, heavy: false };
    const P = controls.pad;
    const val = (a) => Math.max(...(P.bindings[a] || []).map((b) => padValue(gp, b, P.deadzone)), 0);
    const steer = TP.util.clamp((val("right") - val("left")) * P.steerSensitivity, -1, 1);
    return {
      throttle: TP.util.clamp(val("gas") - val("reverse"), -1, 1),
      steer,
      pitch: TP.util.clamp(val("up") - val("down"), -1, 1),
      jump: val("jump") > 0.5, boost: val("boost") > 0.5, hit: val("hit") > 0.5, heavy: val("heavy") > 0.5,
    };
  }

  /* ---------- Capture: "press a key / button" for the rebind screen ----------
     Keys: the next keydown (Esc cancels). Pads: a button that wasn't
     already held when capture began, or a stick moved more than 0.6 from
     where it rested. Start/Options cancels on a pad. */
  let capture = null;
  function startCapture(device, done) {
    cancelCapture();
    const base = (navigator.getGamepads ? [...navigator.getGamepads()] : []).map((gp) => gp && {
      buttons: gp.buttons.map((b) => b.pressed), axes: [...gp.axes] });
    capture = { device, done, base };
    if (device === "key") {
      capture.onKey = (e) => {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.repeat) return;
        const c = capture; cancelCapture();
        c.done(e.code === "Escape" ? undefined : K(e.code));
      };
      window.addEventListener("keydown", capture.onKey, true);
    } else {
      capture.onKey = (e) => { if (e.code === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); const c = capture; cancelCapture(); c.done(undefined); } };
      window.addEventListener("keydown", capture.onKey, true);
      (function pollPad() {
        if (!capture || capture.device !== "pad") return;
        const pads = navigator.getGamepads ? [...navigator.getGamepads()] : [];
        for (let p = 0; p < pads.length; p++) {
          const gp = pads[p]; if (!gp) continue;
          const b0 = capture.base[p] || (capture.base[p] = { buttons: [], axes: [...gp.axes] });
          for (let i = 0; i < gp.buttons.length; i++) {
            // Released since capture began? Then it counts as new from now on
            // (so the A press that picked the slot can itself be bound).
            if (!gp.buttons[i].pressed) b0.buttons[i] = false;
            else if (!b0.buttons[i]) {
              const c = capture; cancelCapture();
              return c.done(i === 9 ? undefined : B(i));   // Start/Options = cancel
            }
          }
          for (let i = 0; i < gp.axes.length; i++) {
            const d = gp.axes[i] - (b0.axes[i] || 0);
            if (Math.abs(d) > 0.6) { const c = capture; cancelCapture(); return c.done(A(i, d < 0 ? -1 : 1)); }
          }
        }
        requestAnimationFrame(pollPad);
      })();
    }
  }
  function cancelCapture() {
    if (!capture) return;
    window.removeEventListener("keydown", capture.onKey, true);
    capture = null;
  }

  // Load the rebind screen on first use (so pages don't need an extra
  // <script> tag), then open it.
  const scriptBase = (document.currentScript && document.currentScript.src || "").replace(/input\.js(\?.*)?$/, "");
  function openMenu() {
    if (TP.ControlsMenu) return TP.ControlsMenu.open();
    const s = document.createElement("script");
    s.src = scriptBase + "controls-menu.js";
    s.onload = () => TP.ControlsMenu && TP.ControlsMenu.open();
    document.head.appendChild(s);
  }
  // Any element with data-open-controls opens the screen when clicked.
  document.addEventListener("click", (e) => {
    const t = e.target.closest && e.target.closest("[data-open-controls]");
    if (t) { e.preventDefault(); openMenu(); }
  });

  TP.Controls = {
    KB_ACTIONS, PAD_ACTIONS,
    get: () => controls,
    save: saveControls,
    setBinding(profile, action, slot, binding) { controls[profile].bindings[action][slot] = binding; saveControls(); },
    setValue(profile, key, v) { controls[profile][key] = v; saveControls(); },
    reset(profile) { controls[profile] = clone(DEFAULTS[profile]); saveControls(); },
    label: bindingLabel,
    isPlayStation, firstPadId,
    capture: startCapture, cancelCapture,
    get capturing() { return !!capture; },
    openMenu,
  };

  /* ---------- Per-frame polling with "just pressed" edges ---------- */
  const state = {}; // id → current processed controls
  const prev = {};  // id → last frame's raw booleans, for edge detection

  function poll() {
    for (const id of TP.CONTROLLER_IDS) {
      if (id === "bot") continue;
      const raw = id.startsWith("kb") ? readKeyboard(controls[id]) : readGamepad(Number(id.slice(3)));
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
    throttle: 0, steer: 0, pitch: 0, boost: false, jump: false, hit: false, heavy: false,
    confirmPressed: false, hitPressed: false, heavyPressed: false, leftPressed: false, rightPressed: false,
  });

  TP.Input = {
    poll,
    // Controls for a controller id. Bots (or unknown ids) get neutral input.
    get: (id) => state[id] || NEUTRAL,
    NEUTRAL,
  };
})();
