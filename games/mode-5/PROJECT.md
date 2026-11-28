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
- Efficiency mode (Director, 2026-11-28): roles stood down; the boss builds and tests alone.
- Status: feature-complete. Final test pass on team/mode-5, then "ready for reveal" to the Director.

## READY FOR REVEAL (boss sign-off, 2026-11-28) — hand-off for the Director
- Launch: `games/mode-5/index.html` (file:// OK). Menu from `TP.Rumble.loadSetup()`, saves on Start, "← All modes"; results screen has Rematch / Menu / ← All modes.
- Hub card: `{ id: "neon-turf", name: "Neon Turf", tag: "Paint-the-floor arena", status: "play", players: [1, 4], color: "#22d3ee", blurb: "Your car is a paint roller. Loop back to your colour to flood-fill everything inside, pop rivals' wet trails, and own the most floor when the clock runs out.", path: "mode-5/index.html" }` (folder may be renamed to `neon-turf/`; all paths inside are relative).
- Sign-off tests on the final commit, all PASS: smoke 3 rounds (8/8, incl. sudden death), batch on all 3 arenas (0 stuck, 0 errors), ui all (42 checks, 0 FAIL). No `shared/` changes; all assets code-made.

## How to test (final sign-off set, from `games/`)
- `node tools/mode-5-smoke.js 3 16 600` — full best-of-3 bot match, 8 checks.
- `node tools/mode-5-ui.js all` — menu (keyboard + gamepad), pause, start/quit sweep.
- `node tools/mode-5-batch.js 6 16 120 1 [arena=N]` — balance / stuck / error batch.
- `node tools/mode-5-feel.js normal 3 8,14,20` — scripted human loops in real time.

## Decisions log
- Big fills: bots play tight by default, go big when safe / with Mega Roller / in Overdrive; hard bots seek chord loops. 10%+ fills mostly a human skill reward.
- 2026-11-27 (Director, standing rule): free assets and tools only; every third-party asset gets a neutral line in `games/CREDITS.md` (no spoilers) or it isn't merged. Our plan is all code-made (exempt).
- 2026-11-27: Concept chosen by the boss (Reece's instruction: the team decides everything and he
  gives no input). Paint-territory arena with loop fill; see DESIGN.md.

## Merge log
- Boss (parts 11–16): Space/Enter on menu buttons, focus kept on options, "Restart match" label, gamepad Start no longer re-pauses on resume/start, pop stun-lock fix (popGrace 2 s + bots leave their last victim 5 s), results card: Rematch/Menu/All-modes (keyboard, pad, touch; sticky on small screens), tie-break explanation, compact card on short screens, camera margin + lean to centre, menu footer fade, Split Level street widened (decks x ±20..48). Gameplay 374bcc0 merged (bot greed/mega/overdrive/chords, clip window, stun 0.85 s, pickup placement, seat-order fairness). QC tools updated for MenuNav.
- Gameplay 405253b + b14b4bc: spawn angles, pause freeze, sudden death (tie-break round), bot retune for real risk, roundEndTime 7 s. Smoke 3 rounds @16× PASS 8/8, 72 pops.
- Gameplay c8d2f61: BUG 1 fixed (wet trail always; close only on out→home), min fill/pop sizes.
- Art efe8e96: M2b framing, scaled FILL text, round-end reveal + side/bottom card, how-to panel, short labels, wet-trail hazard shader, MenuNav, sudden-death banner, team chips. Boss review: Split Level decks + Rings circle not drawn yet (sent).
- Gameplay ff5a73d: bot rewrite, Split Level + Rings arenas, teams 2v2, hints, asserts. Smoke on merge 3 rounds PASS 8/8 (fps 17.6 swiftshader — watch perf). Bug 1 still open.
- QC ef22ffb: smoke checks (score freeze, cars in bounds), tools/mode-5-batch.js, probe feel numbers. QC-1 found critical bug 1 (no wet trail when driving out) → Gameplay. Decisions: fill events only ≥8 enclosed cells; no stun pop for trails <6 cells; spawns angled off pillar.
- Art 412ac47: real index.html, World on main.js hand-off, menu + pause overlay, perf pass. Boss screenshot review → M2b list.
- Gameplay b70850a: core rules, Plaza, bots, match, main + bare index.html. Director shared 5f17ab7 merged. Smoke on merge: 3 rounds @16×, PASS 6/6, 214 fills, 13 pops.
- QC 10a0e5e: tools/mode-5-{lib,smoke,shots,probe}.js (test-hook contract forwarded to Gameplay).
- Art 1f58907: world/vfx/hud/audio + art-preview.html (reviewed screenshots 1280×720, 390×844, match card; no errors).
- Boss part 20: minor (tiny-trail) pops are silent (no floater, sound, splash or shake) — QC's pop ping-pong report; human re-pop chains handled by popGrace 2 s + bots leaving their last victim 5 s.
