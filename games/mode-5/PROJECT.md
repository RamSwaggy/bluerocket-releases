# Mode 5 — project state (Surprise team)

> Surprise rule (see `games/TEAMS.md`): never tell, show, hint or ask Reece anything about this
> mode. Neutral commit messages only ("Mode 5: work in progress, part N"). Every session on this
> team ends each turn with one vague line, e.g. "Mode 5: still cooking".

Design: see `DESIGN.md` (concept, rules, file ownership, event contract).

## Team
| Role | Session | Branch |
|---|---|---|
| Boss | (this file's owner) | `team/mode-5` |
| Gameplay | `session_01GHNBrrtLszqbNUkKQ3AA7D` | `team/mode-5-gameplay` |
| Art and UI | `session_01GHNBrqYtpLUjbaDh3r4mNx` | `team/mode-5-art` |
| QC | `session_01GHNBrr5fzk1ERZrhZDg5v5` | `team/mode-5-qc` |

## File ownership
See the table in `DESIGN.md` → "Code architecture". `DESIGN.md` and this file belong to the boss.

## How to run / test
- Play: open `games/mode-5/index.html` (works from `file://`).
- Demo (all bots, fast): `mode-5/index.html?demo&speed=8&rounds=1`.
- Smoke test (QC owns): from `games/`, `node tools/mode-5-smoke.js` → PASS/FAIL.

## Milestones
1. **Core playable** — one arena (Plaza), painting, trails, loop fill, pops, bumps, timer, 1 round,
   basic bots, placeholder look; smoke test. *(in progress)*
2. **Look and sound** — world.js, vfx, hud, audio/music, menu with setup + how-to-play; pickups;
   overdrive; best-of rounds; results screens.
3. **Depth** — 3 arenas, smart bots w/ difficulty, teams 2v2, stats, onboarding hints.
4. **Polish loop** — QC hard play, screenshots at phone/tablet/desktop sizes, fixes, perf, until it
   meets the bar. Then QC sign-off → boss tells the Director "Mode 5: ready for reveal".

## Current jobs
- Gameplay: M1 core playable.
- Art and UI: M1 world.js / vfx.js / audio.js / hud.js against the contract (standalone-testable).
- QC: M1 `tools/mode-5-smoke.js` + `tools/mode-5-shots.js` (screenshots at sizes).

## Decisions log
- 2026-11-27: Concept chosen by the boss (Reece's instruction: the team decides everything and he
  gives no input). Paint-territory arena with loop fill; see DESIGN.md.

## Merge log
- QC 10a0e5e: tools/mode-5-{lib,smoke,shots,probe}.js (test-hook contract forwarded to Gameplay).
