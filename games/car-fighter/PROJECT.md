# Car Fighter: team project file

**Read `../TEAMS.md` first** (team structure, branches, rules). This file is the Car Fighter
specifics. The boss keeps it up to date.

## What it is

A side-on 1v1 rocket-car fighter, and a mode of **Rocket Rumble**. Two cars fight on a junkyard
turntable at night (the "Scrapyard Floodlight League"), with health bars, 60-second rounds and
best of 3. There are light and heavy attacks, combos, juggles, blocks, sidesteps, throws, a
super meter and 3 fighter cars (Rivet, Haulback, Skitter). It's 1 player vs a bot, or 2
players locally.

**The full design is in [`DESIGN.md`](DESIGN.md). Read it before every job.**

Original game only: genre conventions are fine, but don't copy any existing game's names,
characters, art, music, levels or look.

## Team

| Session | Session ID | Branch |
|---|---|---|
| Car Fighter (boss) | `session_01GHNBrsKZCF3ywtyYiG3aDC` | `team/car-fighter` |
| Car Fighter · Gameplay (systems and feel) | `session_01GHNBrpqsFPkZtFWPbeSe24` | `team/car-fighter-gameplay` |
| Car Fighter · Art and UI (look and screens) | `session_01GHNBrs22k4u4qavTiP35oE` | `team/car-fighter-art` |
| Car Fighter · QC (playtest and checks) | `session_01GHNBrsHShaTu6YTArUzwUG` | `team/car-fighter-qc` |

Message the boss with `send_message` to `session_01GHNBrsKZCF3ywtyYiG3aDC`.

## Milestones

See `DESIGN.md` §10. **Current goal: M1, the first playable.** A bot-vs-bot best-of-3 that
`tools/car-fighter-smoke.js` plays to the end, and that one human on kb1 can play against the
bot.

## Who owns what

Our team **doesn't edit `../shared/`**. That belongs to the Director
(`session_01GHNBrs2PaPyHH8XycVBywq`). Send requests through the boss.

| File (in `games/car-fighter/`) | Owner |
|---|---|
| `js/fight.js`, `js/moves.js`, `js/fighters.js`, `js/bot.js`, `js/match.js` | Gameplay |
| `index.html`, `js/view.js`, `js/bodies.js`, `js/fx-fight.js`, `js/sfx-fight.js`, `js/ui.js`, `js/main.js` | Art and UI |
| `../tools/car-fighter-*.js` and any tests | QC |
| `DESIGN.md`, `PROJECT.md`, `README.md` | Boss |

The **fight-core contract** in `DESIGN.md` §9 (`TP.Fight.create`, `step`, `state`, `events`,
`onEvent`, the URL options) is what Gameplay, Art and QC build against. Changes to it go
through the boss.

## How to test

Run these from the `games` folder, in the background. Exit code 0 means PASS, 1 means FAIL.

```
node tools/car-fighter-smoke.js 8 180 12345   # [speed] [maxSeconds] [seed]: bot vs bot in the real page
node tools/car-fighter-sim.js 50 1000         # [matches] [seed]: headless bot-vs-bot stats
                                              #   options: --p1= --p2= --bot= --bot2=
node tools/car-fighter-sim.js frames 7        # frame-data check of every TP.MOVES row
node tools/car-fighter-human.js               # real menu + kb1 key presses for every move type (~3 min, background)
```

All three also take `--page=<path>` and `--extra="&opt=.."`.

The tools exist, but they can't pass until the M1 game code lands. In the browser:
`car-fighter/index.html?demo&speed=4&seed=1`. Any change that touches `../shared/` must also
keep Turbo Party passing: `node tools/turbo-party-smoke.js 2 8 200`.

## Current state (as of 2026-11-28)

- `DESIGN.md` is signed off. The first M1 build jobs have gone to all three roles.
- QC job 1 is merged (`aff8559`): `tools/car-fighter-smoke.js` and `tools/car-fighter-sim.js`
  (stats and frame data). Tested only against a stub so far.
- Gameplay job 1 and its follow-up are merged (`8a3daf0`, `d8ea725`): `moves.js`,
  `fighters.js`, `fight.js`, `bot.js`, `match.js`, the full v1 move list, rounds and a Normal
  bot. It follows the §9 contract, including the `input` field, the `super` option and
  `TP.Fight.ARENA`. The boss checked it with a scratch page:
  - Sim of 200 matches: PASS, P1 49% / P2 51%, average round 26 s, no time-outs.
  - Frame-data check: PASS, all 11 moves.
- Art job 1 is merged (`cd053fd`): `index.html`, `view.js` (turntable stage, side-on camera,
  car posing), `fx-fight.js`, `ui.js` (HUD and cards) and `main.js` (menu). There are no
  third-party assets. **`?demo` works**: `node tools/car-fighter-smoke.js 8 180 12345` gives
  PASS (P2 2-0 by KO, 5664 frames checked, no errors).
- Art's rebuild is merged (`fec85cf`). **The menu works:** with no query string it shows the
  menu, no fight runs until Fight!, then keyboard 1 plays the bot (holding D moves P1 right).
  Smoke test: PASS. Boss checked it with Playwright, no errors.
- **M1 is code-complete.** The shared update `5f17ab7` is merged (speed-cap fix, `TP.MenuNav`,
  `assets.js`). Boss re-ran everything on the real page on 2026-11-28, and all pass:
  - smoke on seeds 12345 and 777
  - sim 200 (P1 45%, average round 26 s)
  - frames 11/11
- **M2 started 2026-11-28.** Gameplay JOB 3: the cars, signatures and bots. Art JOB 3: bodies,
  sfx and music, damage looks, combo counter, character select, MenuNav. **M1 is on the base branch**
  (`claude/eager-tesla-vdhyd9` at `79161cb`), and the hub card says **Play**.
- Gameplay JOB 3 (M2) is merged (`383d4e8`):
  - all 3 cars and their signatures (Grinder, Quake Drop, Slipstream cross-up)
  - Easy, Normal and Hard bots
  - display info for character select
  Smoke test with Haulback vs Skitter: PASS. All pairings are within 40–60%.
- Art JOB 3 (M2) is merged (`5ce0465`):
  - 3 bodies (`bodies.js`) and damage looks (dents, then flying parts, then smoke)
  - combo counter and signature flash
  - synthesised sfx and fight music (`sfx-fight.js`)
  - character select, and TP.MenuNav on every menu
  Boss check: smoke PASS (haulback vs skitter, and skitter vs rivet on Hard), screenshots of
  select and fight look right, no errors.
- QC's frames tool needs updates for per-car tables, multi-hit moves and cross-ups (QC JOB 3).
- Gameplay JOB 4 is merged (`125c279`, `014d7f1`). Boss check: frames PASS 15/15 on all three
  cars. Gameplay's sim gave Normal pairings 47–54%.
  - The throw works with staggered presses.
  - Health is now Rivet 1050, Haulback 1120, Skitter 975.
  - New `wall_bounce` and `knockdown` events, and `TP.Match.setTimeScale`.
- Art JOB 4 (polish) is merged (`56febfe`):
  - hit flash vs block pulse
  - wall-bounce and knockdown dust
  - KO slow-mo
  - round-intro pan, SUPER READY, victory spotlight
  - a reduce-flashing option
  Boss check: smoke PASS, victory screenshot OK, no errors. The loser's SUPER READY tag on the
  results screen is fixed (`db3d3f5`).
- QC JOB 4: update `car-fighter-human.js` for the M2 menu (character select), then do a full
  re-run. Art JOB 4: the polish pass.
- QC JOB 2 is merged (`a2b5ecf`): `tools/car-fighter-human.js`. 10 of 11 PASS.
  The throw bug it found is now fixed (see above).
- (old) Waiting on QC's scripted human-input check (JOB 2, re-sent after QC hit its usage limit).
  Then the boss tells the Director to switch the hub card to Play, and M2 starts.

## Decisions (from Reece)

- 2026-11-27: One of four rocket-car games, alongside Turbo Party, Deflect Duel and the other
  new mode. Browser game (Three.js), local multiplayer plus bots, sharing `../shared/`.
- 2026-11-27: Set up this team, using RocketBonk's structure.
- 2026-11-27: This is now a mode of **Rocket Rumble** (one umbrella game). It uses the shared car
  feel (only `TP.MODE_TUNABLE` settings may change, via `TP.modeTuning`), the shared controls,
  and the hub's saved player setup (`TP.Rumble.loadSetup()`), with a "← All modes" link back.
  The Director owns `shared/` and the hub.
- 2026-11-27 (via the Director, after Reece said "keep going, I trust you"), design
  sign-off. The full design is in `DESIGN.md`:
  - side-on camera
  - simple "direction + button" specials
  - 3 cars, with original names and a theme of our choosing
  - crunchy damage (dents, flying parts; cartoon violence on cars only)
  - 60-second rounds, best of 3, training mode later
  - must-haves: a bot with Easy/Normal/Hard, and local 2-player
  - no-gos: anything copied from existing fighting games (character or move names, iconic
    poses, stages)
  - a Heavy button added to the shared controls (kb1 R, kb2 comma, pad Y)
- 2026-11-27 (Director): moves may set `car.vel` while they last (that's fight-layer
  movement). Outside moves, driving, jumping and boosting go through the normal `Car.update`
  with `TP.modeTuning()`.
- 2026-11-27 (Director): auto-face is OK, with steer becoming screen-relative movement and
  sidestep, as Car Fighter's control mode.
- 2026-11-27 (Director): new fx, sfx and fighter bodies are built inside `car-fighter/js`
  first. The Director moves good ones into `shared/` later.
- 2026-11-27 (Reece, via the Director): **free assets and tools only.** CC0, CC-BY and other
  free licences are allowed; paid, NonCommercial, NoDerivatives, unlicensed and engine-locked
  assets are not. Every third-party asset gets a line in `../CREDITS.md` (path, source URL,
  author, licence, credit text). No line means no merge. Assets made in code are exempt. See
  `../TEAMS.md`.
