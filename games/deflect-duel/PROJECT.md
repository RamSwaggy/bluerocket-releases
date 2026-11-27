# Deflect Duel: team project file

**Read `../TEAMS.md` first** (team structure, branches, rules). This file is the Deflect Duel
specifics. The boss keeps it up to date.

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
| `../shared/js/input.js`, `car.js` | owns | car model only |
| `../shared/js/fx.js`, `sfx.js` | — | owns (hit/swing/KO sounds already exist) |
| `../tools/deflect-duel-*.js` | — (QC owns) | — (QC owns) |

Suggested split for the first build: Gameplay writes `duel.js`'s rules with plain placeholder
visuals, then Art and UI dresses it up. QC writes `tools/deflect-duel-smoke.js` (an all-bot
match to the end) as soon as a match can finish.

## How to test

Not playable yet. Once it is, QC adds `node tools/deflect-duel-smoke.js` here. Until then,
check that Turbo Party still passes after any change to `../shared/`:
`node tools/turbo-party-smoke.js 2 8 200`.

## Current state (as of 2026-11-27)

- **Done:** `index.html` (layout, styles, script tags) and `js/hud.js` (player chips with
  hearts, ball speed, centre text, toasts, cards). In the shared engine: the Hit button,
  hit/swing/KO sounds, and the `pivot` car setting (turning while nearly stopped, so you can
  aim; Deflect Duel should use about 0.8).
- **To build:** `js/duel.js` and `js/main.js`. See `README.md` for the checklist.

## Decisions (from Reece)

- 2026-11-27: Deflect Duel was started, then parked as work in progress so Turbo Party could
  come first.
- 2026-11-27: Set up this team, using RocketBonk's structure.
- 2026-11-27: This is now a mode of **Rocket Rumble** (one umbrella game). It uses the shared car
  feel (only `TP.MODE_TUNABLE` settings may change, via `TP.modeTuning`), the shared controls,
  and the hub's saved player setup (`TP.Rumble.loadSetup()`), with a "← All modes" link back.
  The Director owns `shared/` and the hub.
