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
| Turbo Party | ✅ Play | **Paused** | Trophy reachability. Bots never bought Trophy Warp; job 10 (bot item strategy + Goal Frenzy tie-break) was in progress. If that's not enough, decide a rule change (cheaper Warp or a 2nd trophy). |
| Car Fighter | ✅ Play (M1, 1 car) | **Paused** | M2: two more cars (Haulback, Skitter), signatures, Easy/Hard bots, sfx/music, damage looks, character select. |
| Deflect Duel | ✅ Play (v2) | **Active: boss only** | v2 merged on the hub (7c5ded7). Next: Reece's feel check, then Easy/Hard bots. |
| Boost Runner | Coming soon | **Paused** | Logic done (bot rounds, fair seats). Job 3 (bot difficulty spread, softer squeeze) was in progress. Art/menus not merged yet. Put it on the hub when it's playable and verified. |
| Surprise (mode 5) | Not listed | **Active: boss only** | **No-spoilers rule** (`TEAMS.md`). Never describe, show or ask Reece about it. Reveal only when the Surprise boss says "Mode 5: ready for reveal" and the Director has verified it. |
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
