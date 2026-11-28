/* =====================================================================
   rumble.js — the glue that makes the separate modes one game:
   ROCKET RUMBLE.

   It holds:
     • TP.Rumble.MODES  — the list of game modes the hub shows
     • the shared player setup (names + controllers), so you set up your
       players once in the hub and every mode starts with them filled in
     • links back to the hub

   The setup is kept in the browser's localStorage (per computer, per
   browser). If storage is blocked (some browsers block it for file://
   pages, or in private windows) everything still works; modes just fall
   back to their default players.
   ===================================================================== */
window.TP = window.TP || {};

(function () {
  "use strict";

  const KEY = "rocketRumble.setup.v1";

  /* ---------- Every mode in Rocket Rumble ----------
     status: "play"  = playable, shows a Play button
             "dev"   = being built, shown but locked
             "plan"  = design stage, shown but locked
     players: [min, max] people (bots fill empty slots where the mode allows). */
  const MODES = [
    {
      id: "turbo-party",
      name: "Turbo Party",
      tag: "Party board game",
      status: "play",
      players: [1, 4],
      color: "#ffcc33",
      blurb: "Roll, drive the board, buy trophies, and battle for coins in car minigames between turns.",
      path: "turbo-party/index.html",
    },
    {
      id: "deflect-duel",
      name: "Deflect Duel",
      tag: "Ball-deflection arena",
      status: "play",
      players: [2, 4],
      color: "#ff4fd8",
      blurb: "One ball that gets faster with every hit. It takes the colour of whoever touched it last, and it KOs anyone else.",
      path: "deflect-duel/index.html",
    },
    {
      id: "boost-runner",
      name: "Boost Runner",
      tag: "Side-scrolling race",
      status: "plan",
      players: [2, 4],
      color: "#34d399",
      blurb: "Everyone races on one screen. Fall behind the edge and you're out. Last car on screen takes the round.",
      path: "boost-runner/index.html",
    },
    {
      id: "car-fighter",
      name: "Car Fighter",
      tag: "1v1 fighting",
      status: "play",
      players: [1, 2],
      color: "#f87171",
      blurb: "Health bars, rounds and combos, all made from rams, flips, spins and boost dashes.",
      path: "car-fighter/index.html",
    },
  ];

  // Defaults if nothing is saved yet: player 1 on keyboard, the rest bots.
  function defaultSetup() {
    return {
      slots: (TP.DEFAULT_NAMES || ["Blue", "Orange", "Green", "Pink"]).map((name, i) => ({
        name,
        controller: i === 0 ? "kb1" : "bot",
      })),
    };
  }

  // Read the saved setup. Never throws; falls back to defaults.
  function loadSetup() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaultSetup();
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.slots) || data.slots.length !== 4) return defaultSetup();
      // Sanitize: names are short strings, controllers must be known ids.
      const known = TP.CONTROLLER_IDS || ["bot", "kb1", "kb2", "pad0", "pad1", "pad2", "pad3", "off"];
      data.slots = data.slots.map((s, i) => ({
        name: String(s && s.name || defaultSetup().slots[i].name).slice(0, 12),
        controller: known.includes(s && s.controller) || (s && s.controller) === "off" ? s.controller : "bot",
      }));
      return data;
    } catch (e) {
      return defaultSetup();
    }
  }

  // Save the setup. Silently does nothing if storage is unavailable.
  function saveSetup(slots) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ slots: slots.map((s) => ({ name: s.name, controller: s.controller })) }));
    } catch (e) { /* storage blocked: fine, just not remembered */ }
  }

  TP.Rumble = {
    NAME: "Rocket Rumble",
    MODES,
    loadSetup,
    saveSetup,
    // Relative link from a mode's index.html back to the hub.
    HUB_URL: "../index.html",
  };
})();
