# Deflect Duel: team project file

**Read `../TEAMS.md` first** (team structure, branches, rules), then **`DESIGN.md`** (the current
design, v2). This file is the Deflect Duel specifics. The boss keeps it up to date.


## What it is

A rocket-car take on the arena ball-deflection genre, for 2–4 local players plus bots. It's
plain JS with Three.js, uses the shared engine in `../shared/`, and runs by double-clicking
`index.html`.

Original game only: genre conventions are fine, but don't copy any existing game's names,
characters, art, music or levels.

### Design (agreed starting point)

- **Arena:** a walled, top-down rectangle (about 44 × 28), possibly with a couple of round
  pillars for bank shots. One ball hovers at bumper height.
- **Hit:** a new Hit button (already in `../shared/js/input.js`: `E`/`J`, `.`/Numpad 1,
  gamepad `X`/`RB`) does a quick spin-swipe for about 0.28 s. If the ball is within about
  3.6 units, it's sent the way the car faces, bent a little by steering (aim). A short
  cooldown after a miss.
- **Speed:** a neutral ball (after a serve) leaves the first hit at a base speed. Every hit
  after that makes it faster, up to a cap. Hitting while boosting is a **Smash**: extra speed
  for a chunk of boost.
- **Ownership:** the ball glows in the colour of whoever hit it last. If it touches **anyone
  else**, they lose a life. It passes harmlessly through its owner. You can jump over it to
  dodge.
- **Hit-freeze:** on each hit the action pauses for a moment and the camera shakes. The faster
  the ball, the longer the pause. This is the genre's signature feel.
- **After a KO:** the ball resets to a neutral serve in the middle. The KO'd car respawns
  with about 2 s of blinking invulnerability. At 0 lives you're out, and the last car
  standing wins.
- **Safety net:** if nobody hits the ball for about 12 s, it resets to a serve.
- **Bots:** chase a neutral ball. When the ball is theirs, move out of the way. When it's an
  enemy's ball heading at them, either face it and time a swing (up to a per-bot skill speed)
  or jump-dodge if it's too fast.
- **Menu:** 4 slots, each Off/Bot/Keyboard 1/Keyboard 2/Gamepad 1–4 (at least 2 active), lives
  3 or 5, then results with rematch.

## Team

| Session | Session ID | Branch |
|---|---|---|
| Deflect Duel (boss) | `session_01GHNBrrDAhFP7gZXs4Ap9TK` | `team/deflect-duel` |
| Deflect Duel · Gameplay (systems and feel) | `session_01GHNBrpQgRcR4wuJEviMDGG` | `team/deflect-duel-gameplay` |
| Deflect Duel · Art and UI (look and screens) | `session_01GHNBrqgetkZbzAJt8h3dPM` | `team/deflect-duel-art` |
| Deflect Duel · QC (playtest and checks) | `session_01GHNBrouPoebhNMp9PjrRtH` | `team/deflect-duel-qc` |

Roles reply to the boss with `send_message` to the boss session ID above.

## Who owns what

| Area | Gameplay | Art and UI |
|---|---|---|
| `js/duel.js` (to write) | ball physics, hitting, ownership, KOs, lives, respawn, hit-freeze timing, bots | arena look, ball glow and trail, swing ring, KO effects, camera shake |
| `js/main.js` (to write) | match flow and config | menu, results and rematch screens |
| `js/hud.js`, `index.html` | — | owns these |
| `js/arena.js` (to write) | — | arena meshes and lighting |
| `../shared/` (all of it) | — (ask the boss, who asks the Director) | — (ask the boss, who asks the Director) |
| `../tools/deflect-duel-*.js` | — (QC owns) | — (QC owns) |

Suggested split for the first build: Gameplay writes `duel.js`'s rules with plain placeholder
visuals, then Art and UI dresses it up. QC writes `tools/deflect-duel-smoke.js` (an all-bot
match to the end) as soon as a match can finish.

## How to test

From the `games` folder:

- `node tools/deflect-duel-smoke.js 4 8 180`: all-bot match (players, speed, timeout s,
  optional lives). Checks the rules on every frame; prints PASS/FAIL. Fails cleanly with
  "isn't playable yet" until `duel.js` and `main.js` exist.
- `node tools/turbo-party-smoke.js 2 8 200`: must still pass after any shared change.

## Current state (as of 2026-11-28)

- **First playable is merged** on `team/deflect-duel`:
  - `js/duel.js`: rules, ball, hits, Smash, aim, ownership, KOs, respawn, hit-freeze, the 12 s
    reset, pillars and bots.
  - `js/main.js`: hub setup, menu, match flow, results and rematch, plus `?demo` and `?test`.
  - `js/arena.js`: the neon arena.
  - `js/hud.js`: menu and results cards, with gamepad and arrow-key navigation.
  - The all-bot smoke test passes (4 and 2 players), and Turbo Party still passes.
- **Key numbers** (all in `TP.DUEL_CFG`): ball serve 16, +2.5 per hit, top speed 56, Smash +8.
  Cars top out at 17 (27 boosting).
- **Next:**
  - Art and UI job 2: ball glow and trail, swing ring, hit flash, KO effects, camera shake.
  - QC job 2: scripted rule tests and a many-match balance run.
  - Then a human playtest to tune the bots and speeds.

## Decisions (from Reece)

- 2026-11-27: Deflect Duel was started, then parked as work in progress so Turbo Party could
  come first.
- 2026-11-27: Set up this team, using RocketBonk's structure.
- 2026-11-27: This is now a mode of **Rocket Rumble** (one umbrella game). It uses the shared car
  feel (only `TP.MODE_TUNABLE` settings may change, via `TP.modeTuning`), the shared controls,
  and the hub's saved player setup (`TP.Rumble.loadSetup()`), with a "← All modes" link back.
  The Director owns `shared/` and the hub.
- 2026-11-27 (via the Director): **Free assets and tools only** (see `../TEAMS.md`). Every
  third-party asset needs a line in `../CREDITS.md` before the boss merges it; assets made in
  code are exempt.
- 2026-11-27: **Reece approved the build plan** and said "Director can approve for me": from
  now on the Director's approvals count as Reece's for this team. Answers (logged by the Director):
  the ball never KOs its owner; double KO → last hitter wins; stalemate = 12 s reset only (no
  speed decay); neutral serve anyone can take; aim bend about 25° (tune after first playtest);
  two round pillars, on by default behind one config flag; `js/arena.js` belongs to Art and UI;
  car tuning via `TP.modeTuning({ pivot: 0.8 })`; one bot difficulty for v1 (random skill per bot);
  ball stays flat at bumper height.
- **First playable** = launch from the hub, pick 2–4 seats and 3/5 lives, play to a winner,
  results + rematch, an all-bot match finishes with no errors, QC's smoke test passes.
- 2026-11-28 (Reece's direction, via the Director): **Design v2.** The game should feel and play
  like car-soccer mechanics crossed with an arena ball-striking fighter. That means a truly 3D
  ball (a neutral ball has gravity, an owned ball flies in straight lines), a ceiling, aimed
  strikes (up, straight or down), bunts, clashes, flip strikes, the shared engine's new "rocket
  moveset" (from the Core session), and a side-angle broadcast camera. See `DESIGN.md`. v1 stays
  on the hub as Play while v2 is built. Genre conventions only, with no other game's names or
  look.
