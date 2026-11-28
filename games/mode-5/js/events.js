/* =====================================================================
   events.js — a tiny event bus for this mode.

   Gameplay code announces what happened ("a loop was filled", "a trail
   popped") with TP.M5.emit(name, data). The look-and-sound side
   (world, vfx, hud, audio) listens with TP.M5.on(name, fn) and reacts.
   That way the rules never reach into the visuals and the visuals never
   change the rules: they only meet here.

   The full list of events and what each carries is in DESIGN.md
   ("Events"), plus a few extras documented in match.js.
   ===================================================================== */
window.TP = window.TP || {};
TP.M5 = TP.M5 || {};

(function () {
  "use strict";

  // name → array of listener functions
  const listeners = {};

  /* Start listening. Returns a function that stops listening again,
     handy for screens that come and go. */
  TP.M5.on = function (name, fn) {
    (listeners[name] = listeners[name] || []).push(fn);
    return () => TP.M5.off(name, fn);
  };

  TP.M5.off = function (name, fn) {
    const list = listeners[name];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  };

  /* Announce an event to everyone listening. A listener that throws is
     reported in the console but can't break the game loop or stop the
     other listeners from hearing the event. */
  TP.M5.emit = function (name, data = {}) {
    const list = listeners[name];
    if (!list || !list.length) return;
    for (const fn of list.slice()) {
      try { fn(data); } catch (err) { console.error(`[mode-5] "${name}" listener failed:`, err); }
    }
  };
})();
