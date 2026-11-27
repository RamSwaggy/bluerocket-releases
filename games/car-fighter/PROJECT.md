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

Not runnable yet. Once M1 lands, run these from the `games` folder, in the background:

```
node tools/car-fighter-smoke.js            # bot-vs-bot best-of-3 → PASS/FAIL (QC writes this)
node tools/car-fighter-sim.js 50           # 50 headless matches: win split, round lengths, move stats
```

In the browser: `car-fighter/index.html?demo&speed=4&seed=1`. Any change that touches
`../shared/` must also keep Turbo Party passing: `node tools/turbo-party-smoke.js 2 8 200`.

## Current state (as of 2026-11-27)

- `DESIGN.md` is signed off. The first M1 build jobs have gone to all three roles.
- Shared changes made by the Director for us:
  - the **Heavy** button in `input.js` (`heavy` / `heavyPressed`: kb1 R, kb2 comma, pad Y)
  - `car.manualBodyPose` in `car.js`, which lets us pose the car body ourselves
  - Check that they're on `claude/eager-tesla-vdhyd9` before relying on them.

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
