# Turbo Party: team project file

**Read `../TEAMS.md` first** (team structure, branches, rules). This file is the Turbo Party
specifics. The boss keeps it up to date.

## What it is

**A mode of Rocket Rumble** (see `../TEAMS.md`): it shares the car, controls and feel with every
other mode. Players come from the hub's saved setup, and the menu links back to the hub.

A rocket-car party board game for 1–4 local players plus bots (keyboard, gamepad or CPU). You
roll a die, drive a looping board (with a risky shortcut), collect coins, buy items and
trophies, and play a car minigame after every round. Bonus trophies are handed out at the end.
Most trophies wins. It's built in plain JS with Three.js and runs by double-clicking
`index.html`. See `README.md` for the player-facing rules and controls.

Original game only: genre conventions are fine, but don't copy any existing game's names,
characters, art, music or levels.

## Team

| Session | Session ID | Branch |
|---|---|---|
| Turbo Party (boss) | `session_01GHNBrt23mSuiGTyLcdpmqK` | `team/turbo-party` |
| Turbo Party · Gameplay (systems and feel) | `session_01GHNBrrE9ipBPBwoUZ5Axrt` | `team/turbo-party-gameplay` |
| Turbo Party · Art and UI (look and screens) | `session_01GHNBrrfMnRLjVS95iDUFgw` | `team/turbo-party-art` |
| Turbo Party · QC (playtest and checks) | `session_01GHNBrqhaxQit2X1D5DYyad` | `team/turbo-party-qc` |

Message a session with `send_message` and its session ID. Roles reply to the boss.

## Who owns what

Several files mix rules and visuals. Split them by **function**, not by file.

| Area | Gameplay | Art and UI |
|---|---|---|
| `js/board.js` | movement, fork choice, spaces' effects, events, shop and items, trophy rules, bot choices | `buildDecor`, `buildTrophy`, `makeIcon`, `buildDie`/`setDie`, camera moves, particles |
| `js/minigames/*.js` | rules, scoring, `tick`, `botControls`, tuning | `build()`, `animate()`, colours, effects, `chips()` wording |
| `js/game.js` | match flow, payouts, bonus trophies | card layouts and wording |
| `js/arena.js` | physics loop, countdown/timer logic | camera, HUD hookup, hints |
| `js/ui.js`, `js/main.js`, `index.html` | — | owns all of these (menu, HUD, cards, CSS) |
| `../shared/*` (car, input, util, fx, sfx, rumble) | **Director owns.** Ask the boss, who asks the Director. Mode tuning only through `TP.modeTuning` | same: request through the boss |
| `../tools/*` and any tests | — (QC owns) | — (QC owns) |

**Adding a minigame:** Gameplay writes the rules and bots, Art and UI does its arena look,
QC adds it to the test runs. A new file goes in `js/minigames/` and gets a `<script>` tag in
`index.html`. It registers itself in `TP.MINIGAMES`.

## How to test

From the `games` folder (run these in the background, since they take over 30 s):

```
node tools/turbo-party-smoke.js 3 8 240      # full 4-bot match → PASS/FAIL
node tools/turbo-party-minigame.js all 5     # each minigame ×5, winners/lengths/errors
```

In the browser: open `index.html`. URL options: `?demo` (4 bots), `&turns=N`, `&speed=N`,
`&minigame=<id>`. `TP.game` is exposed in the console for poking at state.

## Current state (as of 2026-11-27)

- **Board:** 30-space loop plus an 8-space Risky Shortcut. Space types: start, blue, red,
  boost, event, shop. There's a moving trophy (20 coins), 4 items (Double Dice, Turbo Dice,
  Pickpocket, Trophy Warp), a 3D die, and bonus trophies (minigame wins, coins earned,
  spaces driven).
- **Minigames (6):** Coin Rush, Sumo Ring, Goal Frenzy, Bomb Tag, King of the Hill,
  Ring Race. All run headless with no errors, and winners are spread across players.
- **Polish:** particles, procedural music (`M` mutes), car lights, nozzle and stripe,
  boost trails, intro fly-around.

## Known open items

1. **Trophy balance (needs playtesting):** in a 6-turn bot match, two players ended with
   46–49 coins and no trophies, because the trophy kept moving out of reach. The relocation
   distance was reduced from 30 to 20 as a guess. Bonus trophies can end up deciding the game.
2. **Untested:** real gamepads, and how the audio actually sounds (no speakers in cloud
   sessions). Only Reece can check these.
3. **Human-path coverage is thin:** QC tests have used a keyboard player for the die and the
   fork. The shop and item menus with a human player haven't been tested.
4. **King of the Hill:** scores are low because bots crowd the zone. That may be fine, but
   it's worth a look.

## Decisions (from Reece)

- 2026-11-27: Build it as a browser game (Three.js), local multiplayer plus bots.
- 2026-11-27: Wanted more minigames, a better board (fork, shop, bonus awards) and
  polish. All three were done in the first pass.
- 2026-11-27: Set up this team, using RocketBonk's structure.
- 2026-11-27: Turbo Party is now a mode of **Rocket Rumble** (one umbrella game, one car feel;
  minigame tuning limited to `TP.MODE_TUNABLE`). The Director owns `shared/` and the hub.
- 2026-11-27: **Free assets and tools only** (Reece's standing rule, see `../TEAMS.md`). Every
  third-party file gets a line in `../CREDITS.md`, or it isn't merged. Assets made in code are exempt.
- 2026-11-27: Reece approved the boss's first plan ("approved"). Rulings the Director made under
  that approval:
  - **Ties:** if every player ties, each gets 3 coins and nobody gets a minigame win. In a
    partial tie, each tied player gets that place's payout, and a tie for 1st counts as a win
    for each of them.
  - **Trophy relocation:** counted in spaces along the track, at least 10 spaces from the buyer,
    never on the shortcut directly ahead of the buyer. Checked with QC's 20-match before/after.
  - **Head-on knockback** (`shared/car.js`) is approved in principle. It ships together with a
    Sumo retune that keeps rounds at 20–35 s. Gameplay sends the exact change to the Director.
  - The bigger art ideas (arena backdrops, board clutter, car models) wait until jobs 1–5 are
    merged.

## Current jobs (round 1)

| # | Job | Who | Status |
|---|---|---|---|
| 1 | Trophy relocation along the track, no double buy, trophy offer after a pit-lane swap | Gameplay | **merged** (ba264be) |
| A | 20-match 6-turn balance baseline + reusable balance tool | QC | sent |
| 2 | Tie rule, Sumo determinism (same seat always wins), Sumo edge rule | Gameplay | **merged** (a8a4caa) |
| 3 | Scripted human test (shop + 4 items), rule checks, better minigame reporting | QC | after A |
| 4a | Spaces easier to tell apart, readable HUD, start-space wording | Art and UI | **merged** (663bc0f) |
| 4b | Greyed-out menu options (unaffordable shop items, unusable items) | Art and UI | **merged** (e7502c0) |
| 4c | Bugs found by job 3 | Gameplay / Art and UI | after job 3 |
| 5a | Head-on knockback + Sumo retune (rounds 20–35 s; fix early pile-ups and frequent 45 s shared-win rounds) | Gameplay → Director | Sumo retune **merged** (13702b1); car.js change sent to the Director |
| 5b | King of the Hill crowding, Goal Frenzy posts | Gameplay | sent |
| 6 | Gamepad and sound check (checklist below) | Reece | end of round |

## Art backlog (after jobs 1–5; the Director sets the order)

Art and UI's list, most value first (S ≈ 1 h, M ≈ a few hours, L ≈ half a day or more):

1. Minigame arena backdrops: stadium ring, stands, sky, a theme per game (M)
2. Board scene clean-up: floodlights, lamps, ground, trophy beam (S–M)
3. Bigger, clearer tokens on the board, with a coloured ring and a taller marker (S; coordinate with Gameplay)
4. Card and menu polish: title, minigame intro cards, podium results (M)
5. Car model refresh (M–L): **shared/, so the Director decides**
6. Particles and sound pass (M): **shared/, so the Director decides; needs Reece's ears**

## Reece's checklist: gamepad and sound (job 6)

Only you can check these: the cloud sessions have no speakers or gamepads. Open
`games/index.html` in Chrome, pick Turbo Party, and note anything odd:

1. **Gamepad:** plug one in, set a seat to it in the hub, and start a match.
   - Do the triggers drive forward and back? Does the stick steer *without* moving the car?
   - Do Jump, Boost and Hit work in a minigame (try Sumo Ring and Goal Frenzy)?
   - On the board, can you roll the die, pick the fork direction, and use the shop and item
     menus with the gamepad alone?
2. **Two gamepads, or a gamepad and a keyboard:** does each control only its own car?
3. **Sound:** is the music pleasant or grating? Are any sounds too loud (bumps, explosions,
   coins)? Does `M` mute and unmute?
4. **Feel:** anything that feels slow, confusing or unfair. Rough notes are fine.

Tell the boss what you found, and it becomes the next jobs.

