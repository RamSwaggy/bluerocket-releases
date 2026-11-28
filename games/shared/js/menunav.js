/* =====================================================================
   menunav.js — drive any HTML menu with a gamepad (or the arrow keys),
   so couch players never need to reach for the mouse.

   Usage:
     const nav = TP.MenuNav.attach(cardElement, {
       onBack: () => { ... },   // B / Escape (optional)
     });
     ...later, when the menu goes away:
     nav.detach();

   Controls (any connected gamepad; keyboard arrows when not typing):
     D-pad / left stick ... move between buttons, dropdowns and links
                            (picks the nearest one in that direction)
     A (or Enter / Space) . press the highlighted button; on a dropdown,
                            step to its next value (wraps round)
     ← → on a dropdown .... ALSO change its value, but only when there's
                            nothing to move to on that side. (They used to
                            always change the value, which trapped players
                            in the hub's Players column and quietly
                            unassigned their controller.)
     B (or Escape) ........ back (opts.onBack, or a [data-nav-back] element)
     Start ................ press the [data-nav-primary] element (e.g. "Play")

   Mark the main action with data-nav-primary so it's highlighted first.
   Text boxes are skipped by gamepad movement (a pad can't type); they
   still work with mouse and keyboard.
   ===================================================================== */
window.TP = window.TP || {};

(function () {
  "use strict";

  const SELECTOR = 'button:not([disabled]), a[href], select:not([disabled]), input:not([disabled]):not([type="hidden"])';
  const REPEAT_DELAY = 0.38;  // seconds before a held direction repeats
  const REPEAT_RATE = 0.12;   // seconds between repeats

  // One shared style for the highlight ring, added once.
  function ensureStyle() {
    if (document.getElementById("rr-menunav-style")) return;
    const st = document.createElement("style");
    st.id = "rr-menunav-style";
    st.textContent = `
      .rr-nav-focus { outline: 3px solid #ffcc33 !important; outline-offset: 3px; box-shadow: 0 0 0 6px rgba(255,204,51,.18) !important; }
      @media (prefers-reduced-motion: no-preference) { .rr-nav-focus { transition: outline-offset .1s; } }`;
    document.head.appendChild(st);
  }

  const play = (name) => { if (TP.sfx) TP.sfx.play(name); };
  const isText = (el) => el && el.tagName === "INPUT" && !["button", "checkbox", "radio", "range"].includes(el.type);

  function attach(container, opts = {}) {
    ensureStyle();
    let current = null;
    let alive = true;
    const held = {};      // direction/button → seconds held (for repeat + edges)
    let lastTime = performance.now();
    let firstTick = true;   // on the first poll, anything already held is ignored until released

    const visible = (el) => el.offsetParent !== null || getComputedStyle(el).position === "fixed";
    const items = () => [...container.querySelectorAll(SELECTOR)].filter(visible);

    function highlight(el, sound = true) {
      if (!el) return;
      if (current) current.classList.remove("rr-nav-focus");
      current = el;
      el.classList.add("rr-nav-focus");
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (sound) play("tick");
    }

    // Start on the primary action if there is one, else the first item.
    function ensureCurrent() {
      const list = items();
      if (current && list.includes(current)) return current;
      const first = container.querySelector("[data-nav-primary]:not([disabled])") || list.find((e) => !isText(e)) || list[0];
      if (first) highlight(first, false);
      return current;
    }

    /* Spatial navigation: from the current element's centre, find the
       nearest element whose centre lies in the pressed direction. Items
       straight ahead win over ones off to the side. */
    function move(dx, dy) {
      const from = ensureCurrent();
      if (!from) return;
      const a = from.getBoundingClientRect();
      const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
      // Two passes: first only items inside a 45° cone in the pressed
      // direction (so ↓ on a mode card goes to the card below, not to a
      // nearer dropdown off to the side); if the cone is empty, anything
      // that's at least a little that way.
      let best = null, bestScore = Infinity, bestInCone = false;
      for (const el of items()) {
        if (el === from || isText(el)) continue;
        const b = el.getBoundingClientRect();
        const bx = b.left + b.width / 2, by = b.top + b.height / 2;
        const along = (bx - ax) * dx + (by - ay) * dy;     // distance in the pressed direction
        if (along <= 4) continue;                           // behind or level: skip
        const across = Math.abs((bx - ax) * dy - (by - ay) * dx); // sideways offset
        const inCone = across <= along;
        // Inside the cone: nearest wins (sideways offset counts extra).
        // Outside it: the one closest to the pressed DIRECTION wins (smallest
        // angle), so a gap in a grid, like the disabled "coming soon" card,
        // leads to the diagonal card rather than a far-off column.
        const score = inCone ? along + across * 2.5 : across / along;
        // An in-cone item always beats an out-of-cone one.
        if ((inCone && !bestInCone) || (inCone === bestInCone && score < bestScore)) {
          bestScore = score; best = el; bestInCone = inCone;
        }
      }
      if (best) highlight(best);
      return !!best;
    }

    // ← → change a dropdown's value instead of moving away from it.
    function nudgeSelect(sel, dir) {
      const n = sel.options.length;
      const i = Math.max(0, Math.min(n - 1, sel.selectedIndex + dir));
      if (i === sel.selectedIndex) return false;
      sel.selectedIndex = i;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      play("tick");
      return true;
    }

    // Arrows always try to MOVE first. Only on a dropdown with nothing to
    // move to on that side do ← → change its value instead.
    function direction(dx, dy) {
      const el = ensureCurrent();
      if (move(dx, dy)) return;
      if (el && el.tagName === "SELECT" && dx !== 0) nudgeSelect(el, dx);
    }

    function press() {
      const el = ensureCurrent();
      if (!el) return;
      // A on a dropdown: next value, wrapping from the last back to the first.
      if (el.tagName === "SELECT") { nudgeSelect(el, 1) || nudgeSelect(el, -(el.options.length)); return; }
      if (isText(el)) return;
      play("coin");
      el.click();
    }

    function back() {
      const b = container.querySelector("[data-nav-back]");
      if (opts.onBack) { play("tick"); opts.onBack(); }
      else if (b) { play("tick"); b.click(); }
    }

    function primary() {
      const p = container.querySelector("[data-nav-primary]:not([disabled])");
      if (p) { highlight(p, false); press(); }
    }

    /* ---------- Gamepad polling (its own loop, so menus work anywhere) ---------- */
    function edge(name, down, dt, repeat) {
      // -1 = "was already held when this menu appeared": ignore it until
      // it's released, so the press that opened the menu doesn't also
      // press something inside it.
      if (held[name] === -1) { if (!down) held[name] = 0; return false; }
      if (!down) { held[name] = 0; return false; }
      const t = held[name] || 0;
      held[name] = t + dt;
      if (t === 0) return true;                                     // just pressed
      if (!repeat) return false;
      // Held: fire again after the delay, then at the repeat rate.
      if (t < REPEAT_DELAY) return t + dt >= REPEAT_DELAY;
      return Math.floor((t - REPEAT_DELAY) / REPEAT_RATE) !== Math.floor((t + dt - REPEAT_DELAY) / REPEAT_RATE);
    }

    function tick(now) {
      if (!alive) return;
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;
      if (container.isConnected && visible(container)) {
        const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
        // Combine every pad: anyone can drive the menu.
        let x = 0, y = 0, a = false, b = false, start = false;
        for (const gp of pads) {
          const bt = (i) => gp.buttons[i] && gp.buttons[i].pressed;
          const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
          if (bt(14) || ax < -0.55) x = -1;
          if (bt(15) || ax > 0.55) x = 1;
          if (bt(12) || ay < -0.55) y = -1;
          if (bt(13) || ay > 0.55) y = 1;
          a = a || bt(0); b = b || bt(1); start = start || bt(9);
        }
        if (firstTick) {
          firstTick = false;
          const now = { left: x < 0, right: x > 0, up: y < 0, down: y > 0, a, b, start };
          for (const k of Object.keys(now)) if (now[k]) held[k] = -1;
        }
        if (edge("left", x < 0, dt, true)) direction(-1, 0);
        if (edge("right", x > 0, dt, true)) direction(1, 0);
        if (edge("up", y < 0, dt, true)) direction(0, -1);
        if (edge("down", y > 0, dt, true)) direction(0, 1);
        if (edge("a", a, dt, false)) press();
        if (edge("b", b, dt, false)) back();
        if (edge("start", start, dt, false)) primary();
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);

    /* ---------- Keyboard: arrows move (unless typing), Escape = back ---------- */
    function onKey(e) {
      if (!container.isConnected || !visible(container)) return;
      const typing = isText(document.activeElement);
      const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (map[e.key] && !typing && !e.altKey) {
        // Same as a gamepad: arrows move between controls; ←→ change a
        // dropdown's value only when there's nothing on that side.
        e.preventDefault();
        direction(...map[e.key]);
      } else if ((e.key === "Enter" || e.code === "NumpadEnter" || e.code === "Space") && !typing) {
        // Press it ourselves rather than relying on the browser: shared
        // input.js cancels Enter's and Space's default action in every game
        // page. Space is Keyboard 1's in-game confirm, so it confirms here too.
        e.preventDefault();
        if (!e.repeat) press();
      } else if (e.key === "Escape") {
        back();
      }
    }
    window.addEventListener("keydown", onKey);

    // Keep the highlight in sync when the mouse or Tab moves focus.
    function onFocus(e) {
      if (container.contains(e.target) && e.target.matches(SELECTOR)) {
        if (current) current.classList.remove("rr-nav-focus");
        current = e.target;
        current.classList.add("rr-nav-focus");
      }
    }
    container.addEventListener("focusin", onFocus);

    ensureCurrent();

    return {
      detach() {
        alive = false;
        window.removeEventListener("keydown", onKey);
        container.removeEventListener("focusin", onFocus);
        if (current) current.classList.remove("rr-nav-focus");
      },
      focus: (el) => highlight(el, false),
    };
  }

  TP.MenuNav = { attach };
})();
