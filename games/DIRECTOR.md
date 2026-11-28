# Director handover (2026-11-28)

The handover note for the **Rocket Rumble · Director** session. Read this, then `TEAMS.md`
(rules, decisions log, roster). Reece trusts the Director to make calls. His standing focus is
**efficiency**: keep usage low.

## What Rocket Rumble is

One browser game (Three.js) with several modes. Every mode shares one rocket car, its controls
and feel (`shared/`). The hub is `index.html`. The desktop app is in `../desktop` (Electron;
`npm start`, and `npm run dist` builds a portable .exe). The release branch is
`claude/eager-tesla-vdhyd9`; only the Director pushes to it. Teams push `team/<mode>` and the
Director merges them after verifying.

## Mode status

| Mode | Hub | Team state | Next when resumed |
|---|---|---|---|
| Turbo Party | ✅ Play | **Active: one builder** (`session_01GHNBrrU9qwu2HbnfzzVvxe`) | Round 2 roadmap in its PROJECT.md: bugs, juice, board life, 14+ minigames, interaction, modes. Merge each phase when it reports. |
| Car Fighter | ✅ Play (M1, 1 car) | **Active: one builder** (`session_01GHNBrq3cBwRUWBboR2aeNr`) | Round 2 roadmap in its PROJECT.md: QC test, M2 roster + select, pause/training/tutorial, presentation, modes (4-player bracket), stages. |
| Deflect Duel | ✅ Play (v2) | **Active: boss only** | Round 3 roadmap in its PROJECT.md (feel, practice/tutorial/modes, presentation, arenas, car styles, cosmetics). |
| Boost Runner | Coming soon | **Active: one builder** (`session_01GHNBrqDAAo8qpnUjEsWJJW`) | Round 2 roadmap (in its prompt; it pastes it into PROJECT.md on team/boost-runner). Phase 0 = playable → "ready for hub": verify with the hub-listing steps above. |
| Neon Turf (mode 5) | ✅ Play (revealed 2026-11-28) | **Idle** (boss `session_01GHNBrqtCApg5LvFLes2fbo`) | Next: genre gap check if Reece asks. |
| Core (car physics) | — | **Idle** | The rocket moveset is merged (opt-in `{ moveset: "rocket" }`). Possible next job: ramps and wall driving (`world.surfaceAt` plan in `car.js` comments). |

## How to verify a merge (the cheap version)

1. `git fetch origin team/<mode>`, check the diff only touches that mode (plus `tools/`), then merge.
2. From `games/`: run that mode's smoke test and `node tools/credits-check.js <mode>`.
3. Only if `shared/` changed: also run `turbo-party-smoke.js 2 8 200`, `deflect-duel-smoke.js 4 8 180`,
   `car-fighter-smoke.js 8 180 12345` and `moveset-test.js`.
4. For a new hub listing: one quick headless look at the real page (menu + a few seconds of
   play, screenshot), then set `status: "play"` in `shared/js/rumble.js` and the `README.md` table.

## Efficiency rules (in force)

- Sessions message the Director **only** at milestones (ready to merge, ready for hub) or when blocked.
- Paused teams stay idle. Resume a mode by starting **one** fresh builder session (top model for
  design/gameplay; smaller model for QC or art polish) pointed at its `PROJECT.md`.
- Don't re-run the full cross-mode suite unless `shared/` changed.
- No scheduled check-ins. Wait for messages or Reece.
- Reece's preferences: plain-English explanations, heavy code comments, full-file outputs,
  bugs before features, and copy-pasteable commands (Windows CMD: `F:` and `cd path` as separate steps).

## Session IDs

The full roster is in `TEAMS.md`. Active ones:
- Deflect Duel boss: `session_01GHNBrrDAhFP7gZXs4Ap9TK`
- Surprise boss: `session_01GHNBrqtCApg5LvFLes2fbo`
- Core: `session_01GHNBrspisUmr33CiDjJ1pk`

## Controls (rebinding), added 2026-11-28

`shared/js/input.js` now reads rebindable bindings (Keyboard 1, Keyboard 2, one shared pad
layout; saved in localStorage `rumble.controls.v1`). The screen is `shared/js/controls-menu.js`,
lazy-loaded by input.js. Any `[data-open-controls]` button opens it, and so does pad View on any
MenuNav menu. Modeled on RocketBonk's controls menu. Tests: `tools/controls-test.js`,
`tools/menunav-qc.js`. Modes not on this branch yet (Boost Runner, mode 5) get the bindings
automatically. They only need a `data-open-controls` button in their menu. Mode key tables in
the Turbo Party, Deflect Duel and Car Fighter menus are still static text (TODO for those teams).
