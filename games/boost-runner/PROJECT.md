# Boost Runner: team project file

**Read `../TEAMS.md` first** (team structure, branches, rules). This file is the Boost Runner
specifics. The boss keeps it up to date.

## What it is (pitch, not yet designed)

A rocket-car take on the side-scrolling multiplayer race genre, for 2–4 local players plus
bots. Everyone races through the same obstacle course on one shared screen. The camera
follows the leader, and anyone who falls off the edge of the screen is knocked out of the
round. Last car on screen wins the round, and first to N round wins takes the match. Cars
jump, boost, and probably use other movement tricks (wall rides, grapples or boost pads) to
take shortcuts and bump rivals off-screen. There may be pickups that mess with the cars
behind you.

Original game only: genre conventions are fine, but don't copy any existing game's names,
characters, art, music, levels or look.

## Team

| Session | Session ID | Branch |
|---|---|---|
| Boost Runner (boss) | `session_01GHNBrsk3LnQA2PCCCRSzxD` | `team/boost-runner` |
| Boost Runner · Gameplay (systems and feel) | `session_01GHNBrsNjSm8NLsDts3nDdU` | `team/boost-runner-gameplay` |
| Boost Runner · Art and UI (look and screens) | `session_01GHNBrowW48d38MRxz3z9U7` | `team/boost-runner-art` |
| Boost Runner · QC (playtest and checks) | `session_01GHNBrrLjMJWrWEvKiCzLJn` | `team/boost-runner-qc` |

Roles: message the boss at `session_01GHNBrsk3LnQA2PCCCRSzxD` when you finish a job or need something.
Above the boss: **Rocket Rumble · Director** (`session_01GHNBrs2PaPyHH8XycVBywq`), who owns `../shared/`,
the hub and the car feel. Shared changes go through the boss to the Director; roles don't edit `../shared/`.

## Design

Signed off: see **`DESIGN.md`**. The original first-job brief is kept below for history.

## First job (boss): design plan (done)

Before any code, the boss writes `DESIGN.md` here with Reece: camera and perspective (2.5D
side view of 3D cars?), how the shared car physics adapts to a side-on track, the movement
toolkit, course building (hand-made sections chained together or generated), elimination and
round rules, pickups, bots, controls, and a first playable milestone. Get Reece's sign-off,
then split it into Gameplay, Art and UI, and QC jobs.

## Who owns what

| Files (in `games/boost-runner/`) | Owner |
|---|---|
| `js/runner-car.js`, `js/course.js`, `js/view.js`, `js/round.js`, `js/bots.js`, `js/br.js`, `sim.html`, `js/README.md` | Gameplay |
| `index.html`, `js/main.js`, `js/camera.js`, `js/scene.js`, `js/hud.js`, `js/fx-br.js`, `js/music.js`, CSS | Art and UI |
| `../tools/boost-runner-*.js`, `../tools/credits-check.js`, any tests | QC |
| `DESIGN.md`, `PROJECT.md` | Boss |
| `../shared/*`, `../index.html`, `../TEAMS.md`, `../CREDITS.md` format | Director (ask through the boss) |

Course chunk **data** belongs to Gameplay. How it **looks** belongs to Art and UI, built from the same data.

## How to test

Nothing to run yet. As soon as a match can finish with bots, QC writes
`tools/boost-runner-smoke.js` (copy `tools/turbo-party-smoke.js`) and adds the command here. Any
change to `../shared/` must keep Turbo Party passing: `node tools/turbo-party-smoke.js 2 8 200`.

## Current state (as of 2026-11-27)

- **Design signed off** (`DESIGN.md`). First build jobs sent to all three roles. No game code yet.

## Decisions (from Reece)

- 2026-11-27: One of four rocket-car games, alongside Turbo Party, Deflect Duel and the other
  new mode. Browser game (Three.js), local multiplayer plus bots, sharing `../shared/`.
- 2026-11-27: Set up this team, using RocketBonk's structure.
- 2026-11-27: This is now a mode of **Rocket Rumble** (one umbrella game). It uses the shared car
  feel (only `TP.MODE_TUNABLE` settings may change, via `TP.modeTuning`), the shared controls,
  and the hub's saved player setup (`TP.Rumble.loadSetup()`), with a "← All modes" link back.
  The Director owns `shared/` and the hub.
- 2026-11-27 (standing rule, via the Director): **free assets and tools only.** Every third-party
  asset gets a line in `../CREDITS.md` (path, source URL, author, licence, credit text); no line,
  no merge. Code-generated models, sounds and music are exempt. See `../TEAMS.md`.
- 2026-11-27: **Design approved** by Reece as `DESIGN.md`: wall rides and grapple later, no pickups in
  v1, first to 3, strong bumps (`bumpScale` 1.3), "Night-shift test range" theme, tilt-and-boost as
  the core air trick. Controls (Director): drive = Steer (D/A, →/←, stick X) plus RT/LT on pads,
  air tilt = `ctrl.pitch` (W/S, ↑/↓, stick Y). The Director also approved the double jump, Hit-dash,
  bad-landing tumble and 2D bumps.
- 2026-11-27: Reece: "Approved, and the Director speaks for me." From now on, the Director's
  sign-offs count as Reece's.
