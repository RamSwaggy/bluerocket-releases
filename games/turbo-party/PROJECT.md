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
node tools/turbo-party-balance.js 20 6       # 20 six-turn bot matches → trophy balance report (~18 min)
node tools/turbo-party-human.js              # scripted Keyboard-1 player: hub, shop, items, fork, trophy + 14 rule checks (~4 min)
node tools/turbo-party-minigame.js all 10 [seed]  # seeded, replayable; flags ties, cap hits, console errors
node tools/credits-check.js turbo-party      # every third-party asset has a CREDITS.md line (pass the mode name!)
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
3. ~~**Human-path coverage is thin:**~~ Fixed by job 3 (`turbo-party-human.js`). QC tests have used a keyboard player for the die and the
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
- 2026-11-27: **The Director can approve for Reece** (Reece, directly to the boss: "Director can
  approve for me"). Plans and decisions approved by the Director count as Reece's approval.
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

- 2026-11-28 (Director, for Reece): **Speed-cap fix in shared car.js.** Holding the gas now tops out at
  maxSpeed (17), boost reaches 27, and head-on rams carry extra knockback that bleeds off. The car is
  a bit slower and boost matters. Turbo Party minigames need re-checking at the new speeds.
- 2026-11-28 (Director): **Bonus-trophy ties** are broken on coins; if still tied, nobody gets it.
- 2026-11-28 (Director): use the shared `TP.MenuNav.attach(card)` for gamepad/arrow menus.

## ⏸ Paused 2026-11-28: resume notes

Turbo Party was paused to save usage (Reece's call, via the Director). All three roles have stopped.

**Merged in `team/turbo-party` (5b0c3d7 and after), all passing:** jobs 1 (trophy moves 10+ spaces
along the track, one buy per turn), 2 (tie payouts, randomised Sumo, Sumo edge rule), 3 (QC: human-path
test, 14-rule referee, seeded minigame runner, balance tool), 4a/4b (readable spaces and HUD, greyed-out
menu options), 5a/5b/7/9 (Sumo retune, about 28 s rounds; KotH bot roles + seat-0 fix; Goal Frenzy goal
nets; bonus-trophy ties broken on coins), 8/8b (controller/arrow menus via shared MenuNav), and the
Director's shared changes (speed-cap fix, MenuNav, Rocket Rumble hub).

**Unfinished, not merged:**
- `team/turbo-party-gameplay` @ **790ee78**, job 10: bots plan shop and item use around trophy distance
  (Warp / Turbo / Double / Pickpocket, with a per-bot temperament), and Goal Frenzy has up to 15 s of
  golden-goal overtime (ties for 1st went from 10/20 to 5/20). The boss checked it on a merge with
  5b0c3d7: smoke PASS and human 48/48 PASS. **Not yet done:** the balance check.
- The Art and QC branches have nothing unmerged.

**Next steps on resume:**
1. Gameplay: run `node tools/turbo-party-balance.js 10 6` on job 10. Item buys should be spread across all
   4 items, with fewer "40+ coins & 0 board 🏆". Then the boss merges it, and QC does its merge check plus
   a full 20×6 for the balance table.
2. If rich players still can't reach the trophy, take a rules change to the Director (e.g. a cheaper
   Warp, or a second trophy).
3. Then: Reece's gamepad and sound checklist (job 6), then the art backlog in the Director's order.

## Current jobs (round 1)

| # | Job | Who | Status |
|---|---|---|---|
| 1 | Trophy relocation along the track, no double buy, trophy offer after a pit-lane swap | Gameplay | **merged** (ba264be) |
| A | 20-match 6-turn balance baseline + reusable balance tool | QC | **merged** (2f9e168); "after" run in progress |
| 2 | Tie rule, Sumo determinism (same seat always wins), Sumo edge rule | Gameplay | **merged** (a8a4caa) |
| 3 | Scripted human test (shop + 4 items), rule checks, better minigame reporting | QC | **merged** (79d536d) |
| 4a | Spaces easier to tell apart, readable HUD, start-space wording | Art and UI | **merged** (663bc0f) |
| 4b | Greyed-out menu options (unaffordable shop items, unusable items) | Art and UI | **merged** (e7502c0) |
| 4c | Bugs found by job 3 | Gameplay / Art and UI | after job 3 |
| 5a | Head-on knockback + Sumo retune (rounds 20–35 s; fix early pile-ups and frequent 45 s shared-win rounds) | Gameplay → Director | Sumo retune **merged** (13702b1); car.js change sent to the Director |
| 5b | King of the Hill crowding, Goal Frenzy posts | Gameplay | **merged** (1342ade) |
| 7 | Re-measure Sumo + KotH at the new car speeds, retune if needed; bonus-tie tiebreak; KotH seat-0 bias fix | Gameplay | **merged** (38b4faf) |
| 8 | Controller/arrow navigation on the menu and cards with TP.MenuNav | Art and UI | **merged** (963d366, 82c90aa: shared MenuNav fixes, workaround removed) |
| 9 | Sumo round length ≈ 28 s at the new speeds | Gameplay | **merged** (4c687dc) |
| 10 | Bot item strategy (bots only ever bought Double Dice) + Goal Frenzy tie-breaker | Gameplay | **unmerged**, partly done (790ee78), see Paused |
| 6 | Gamepad and sound check (checklist below) | Reece | end of round |

## Balance results (20 bot matches × 6 turns)

| Version | Board 🏆/match | Matches with 40+ coins & 0 board 🏆 | Bonuses changed 1st | Bonus share |
|---|---|---|---|---|
| f8dc98c (before trophy fix) | 2.35 | 14/20 | 3/20 | 60% |
| b3dca18 (trophy fix + new car speeds, old bonus-tie rule) | 2.25 | 12/20 | 8/20 | 63% |

## Feature backlog

- Pickpocket target picker (today it always robs the richest rival).

## Art backlog (after jobs 1–5; the Director sets the order)

Art and UI's list, most value first (S ≈ 1 h, M ≈ a few hours, L ≈ half a day or more):

1. Minigame arena backdrops: stadium ring, stands, sky, a theme per game (M)
2. Board scene clean-up: floodlights, lamps, ground, trophy beam (S–M)
3. Bigger, clearer tokens on the board, with a coloured ring and a taller marker (S; coordinate with Gameplay)
4. Card and menu polish: title, minigame intro cards, podium results (M)
5. Car model refresh (M–L): **shared/, so the Director decides**
6. Particles and sound pass (M): **shared/, so the Director decides; needs Reece's ears**

## Round 2 roadmap: "it works but feels bare" (Reece, 2026-11-28)

Reece: "rocket party is good, just feels bare. Compare with Mario Party, Pummel Party, Lego
Party and identify gaps: animations, more minigames, better-looking maps, more going on."
This is the Director's gap list, approved for Reece. **Genre conventions only. Never copy any
game's names, characters, boards, minigames, art or music.**

### Gaps compared with the genre

| Area | Turbo Party now | Genre standard | Gap |
|---|---|---|---|
| Minigames | 6, all free-for-all driving | 50–100+; formats 4-player, 1 vs 3, 2 vs 2, duel; skill, reaction, luck, memory | **Big** |
| Minigame framing | Starts straight away | Title card, a rules line, a controls line, a "practice / ready" check, then results with reactions | Big |
| Board look | One loop on a flat ground | Themed set pieces, moving parts, background life (crowd, lights, vehicles), sky and day/night | **Big** |
| Board gimmicks | Shortcut fork; spaces are static | Interactive landmarks (gates, ramps, a hazard that fires on a timer), traps players place, a twist at a turn threshold | Big |
| Player interaction | Pickpocket only | Duel spaces, steal-a-trophy events, attack items, traps, swapping places | Big |
| Items | 4 | 10–20, with a few aimed at rivals | Medium |
| Animation and juice | Cars slide between spaces | Hop or drive per space; coin pop-ups and counters; win and lose reactions; camera punch-ins; banners ("Player 2's turn", "Last 3 turns!") | **Big** |
| Turn flow | Roll, move, minigame | Turn banner, rank panel, live standings, an event every round, a final-turns twist | Medium |
| Ending | Bonus trophies, then results | A ceremony: reveal bonuses one at a time with a drumroll, then podium cars with confetti | Medium |
| Modes | Board only | Minigame-only mode (free play or "first to N wins"), length presets, team (2 vs 2) board | Medium |
| Boards | 1 | 3–6, each with its own gimmick | Later |
| Audio | Procedural loop | A theme per board and per minigame, stingers for events and wins | Medium (Reece's ears needed) |

### Plan (one builder, in this order; each phase ends merged and verified)

- **Phase 0: bugs first.** Finish job 10 (bot item strategy + Goal Frenzy tie-break, branch
  `team/turbo-party-gameplay` 790ee78), check trophy reachability, and only then start features.
- **Phase 1: juice and presentation** (biggest feel gain for the cost):
  - cars drive and hop space to space;
  - floating "+3" and "−3" coin pop-ups with an animated HUD counter;
  - turn banner and live rank panel;
  - camera punch-ins on events, shop and trophy buys;
  - winner and loser car reactions after minigames (spin and boost-flare for a win, a deflated
    slump for a loss);
  - minigame intro card (title, one-line rule, controls, a 3-2-1 "ready" check) and a results
    card with placings;
  - an end ceremony: bonuses revealed one at a time, then a podium with confetti.
- **Phase 2: board life.** Dress the board: stands with a waving crowd, floodlights,
  billboards, props, sky and a day-to-dusk shift as turns pass. Add moving set pieces (a
  rotating gate that changes the fork, a jump ramp over the middle), one **board hazard** that
  fires on a timer (it sweeps nearby players back), and a **"Final 3 turns"** twist (coins on
  blue/red spaces doubled, a catch-up bonus for last place).
- **Phase 3: minigames 6 → 14+, with new formats.** At least 2 × **1 vs 3**, 2 × **2 vs 2**,
  2 × **duel** (triggered by a new Duel space), and 2+ non-race types (reaction or timing,
  luck, push or survival variety). Every minigame gets bots, an intro card and smoke coverage.
  Teams are picked by blue/red space colour, genre-style but with our own rule.
- **Phase 4: interaction.** 6+ new items, including aimed ones: a trap placed on a space, a
  swap with a rival, a coin magnet, a shield, a "rocket" that knocks a rival back 3 spaces.
  Add a steal-a-trophy event space with high stakes and a short roulette. Add Duel spaces.
- **Phase 5: modes and a second board.** Minigame-only mode (first to N wins), length presets,
  then a second themed board with its own gimmick.

Each phase: smoke + minigame + human tests pass, `credits-check` passes, screenshots, then
message the Director "Turbo Party phase N: ready to merge". Shared changes (car feel, input,
sfx) still go through the Director.

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

