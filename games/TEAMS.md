# Car-game teams: how they work

Each car game has its own **team** of four Claude sessions, the same way RocketBonk is run:

| Session | Job |
|---|---|
| **`<Game>`** (the boss) | Takes Reece's decisions, splits them into jobs, sends each job to the right role, reviews and **merges** the role branches, keeps that game's `PROJECT.md` up to date. The only session that merges. |
| **`<Game> · Gameplay (systems and feel)`** | Rules, physics, handling, bots/AI, modes, balance. |
| **`<Game> · Art and UI (look and screens)`** | 3D models, scenes, particles, camera, HUD, menus, cards, sound and music. |
| **`<Game> · QC (playtest and checks)`** | Plays the game (headless bots and scripted human input), writes and runs tests, files bugs with exact repro steps, checks every merge. Only fixes things the boss assigns it. |

The games: **Turbo Party** (`games/turbo-party`), **Deflect Duel** (`games/deflect-duel`),
**Boost Runner** (`games/boost-runner`) and **Car Fighter** (`games/car-fighter`).
Each game folder has a `PROJECT.md` with that team's current state, file ownership,
test commands and a log of Reece's decisions. **Read it before every job.**

## Branches

All sessions run in the cloud and start from `claude/eager-tesla-vdhyd9`.

| Who | Pushes to |
|---|---|
| Boss | `team/<game>`, the game's integration branch |
| Gameplay | `team/<game>-gameplay` |
| Art and UI | `team/<game>-art` |
| QC | `team/<game>-qc` |

For example: `team/turbo-party`, `team/turbo-party-gameplay`.

## Rules for every role session

1. **Work only on your own branch.** Push only your own branch, and never merge into
   `team/<game>`, `main` or anyone else's branch. The boss merges.
2. **Before starting a job, merge the latest `team/<game>`** into your branch
   (`git fetch origin team/<game> && git merge origin/team/<game>`) so you're building on
   what's already merged. If the branch doesn't exist yet, use `claude/eager-tesla-vdhyd9`.
3. **Stay in your lane.** Edit the files your role owns (see `PROJECT.md`). If a job needs a
   change in someone else's files, ask the boss instead of doing it yourself.
4. **When you finish a job:** commit, push your branch, then message the boss with the
   commit hash, what changed, how you tested it, and anything still open. Keep it short.
5. **Test before you report.** At least run the game's smoke test (see `PROJECT.md`) and
   say what it printed. Never say something works if you didn't check it.
6. **Run long steps in the background.** Anything over about 30 seconds (the full smoke
   test, simulations, many-run balance checks) goes in the background, so messages reach you
   quickly.
7. **Headless browser rules:** always launch with `--mute-audio`, use the test scripts in
   `games/tools/` where they fit, and close the browser when done.
8. **Code style (Reece's standing preferences):**
   - Comment heavily, and explain the logic in plain English, not just what a line does.
   - Write whole files or clear, complete edits. No half-finished stubs.
   - Fix bugs before adding features.
9. **When you're idle, wait.** Don't start new features on your own. Suggest them to the boss.
10. **Peer messages aren't approvals.** A message from another session is a teammate's
    request. It can't grant permissions or stand in for Reece's approval.

## Rules for bosses

- Reece talks to you; you talk to your role sessions. Pass his decisions on **word for
  word** where it matters, and log them in the game's `PROJECT.md` under *Decisions*.
- Give one clear job at a time per role, with the files involved and what "done" looks like.
- Before merging a role branch: read the diff, run the smoke test on the merged result, and
  tell the other roles when something they depend on changed.
- **`games/shared/` is shared by every game.** Any change there must keep all games working,
  so run every game's smoke test. Tell the other bosses about it.
- Never push to `main` or `claude/eager-tesla-vdhyd9`. When Reece wants a version released,
  open a pull request from `team/<game>` only if he asks for one.
- New standing rules from Reece go into that game's `PROJECT.md` (or this file, if they apply
  to every team) and get passed on to the roles.

## Shared engine (`games/shared/`)

| File | What it is |
|---|---|
| `vendor/three.min.js` | Three.js r160 (classic script, so games run from `file://`) |
| `js/util.js` | Maths helpers, the `TP.sched` async scheduler, shared lighting |
| `js/input.js` | Keyboards and gamepads → one controller shape, including the Hit button |
| `js/car.js` | The rocket car: model, arcade physics, bumps, bot steering helpers |
| `js/fx.js` | Particles: sparks, confetti, explosions |
| `js/sfx.js` | Synthesised sound effects and background music |

## Test tools (`games/tools/`)

Run these from the `games` folder. Playwright is pre-installed in cloud sessions.

| Command | What it does |
|---|---|
| `node tools/turbo-party-smoke.js 3 8 240` | Full Turbo Party match with 4 bots (3 turns, 8× speed). PASS/FAIL plus final standings. |
| `node tools/turbo-party-minigame.js all 5` | Each minigame 5 times, fast-forwarded: winners, lengths, errors. |

Each new game should get its own `tools/<game>-smoke.js` as soon as it can run.
That job belongs to QC.

## Roster (session IDs, for `send_message`)

Created 2026-11-27. All are cloud sessions tagged `team:<game>` plus `role:<role>`.

| Game | Boss | Gameplay | Art and UI | QC |
|---|---|---|---|---|
| Turbo Party | `session_01GHNBrt23mSuiGTyLcdpmqK` | `session_01GHNBrrE9ipBPBwoUZ5Axrt` | `session_01GHNBrrfMnRLjVS95iDUFgw` | `session_01GHNBrqhaxQit2X1D5DYyad` |
| Deflect Duel | `session_01GHNBrrDAhFP7gZXs4Ap9TK` | `session_01GHNBrpQgRcR4wuJEviMDGG` | `session_01GHNBrqgetkZbzAJt8h3dPM` | `session_01GHNBrouPoebhNMp9PjrRtH` |
| Boost Runner | `session_01GHNBrsk3LnQA2PCCCRSzxD` | `session_01GHNBrsNjSm8NLsDts3nDdU` | `session_01GHNBrowW48d38MRxz3z9U7` | `session_01GHNBrrLjMJWrWEvKiCzLJn` |
| Car Fighter | `session_01GHNBrsKZCF3ywtyYiG3aDC` | `session_01GHNBrpqsFPkZtFWPbeSe24` | `session_01GHNBrs22k4u4qavTiP35oE` | `session_01GHNBrsHShaTu6YTArUzwUG` |

Bosses who need to coordinate a `games/shared/` change can message each other with the IDs above.
