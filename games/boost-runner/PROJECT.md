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

## First job (boss): design plan

Before any code, the boss writes `DESIGN.md` here with Reece: camera and perspective (2.5D
side view of 3D cars?), how the shared car physics adapts to a side-on track, the movement
toolkit, course building (hand-made sections chained together or generated), elimination and
round rules, pickups, bots, controls, and a first playable milestone. Get Reece's sign-off,
then split it into Gameplay, Art and UI, and QC jobs.

## Who owns what (once code exists)

| Area | Gameplay | Art and UI |
|---|---|---|
| Rules, physics, controls, bots, modes, balance | owns | — |
| 3D models, scenes, camera, particles, sound and music | — | owns |
| `index.html`, menus, HUD, cards (copy `../turbo-party` and `../deflect-duel` patterns) | — | owns |
| `../shared/js/car.js`, `input.js`, `util.js` | owns (car **model** belongs to Art) | car model only |
| `../shared/js/fx.js`, `sfx.js` | — | owns |
| `../tools/boost-runner-*.js`, tests | — (QC owns) | — (QC owns) |

## How to test

Nothing to run yet. As soon as a match can finish with bots, QC writes
`tools/boost-runner-smoke.js` (copy `tools/turbo-party-smoke.js`) and adds the command here. Any
change to `../shared/` must keep Turbo Party passing: `node tools/turbo-party-smoke.js 2 8 200`.

## Current state (as of 2026-11-27)

- **Not started.** Only this file exists. Team set up; the boss is drafting the design plan with Reece. No build jobs yet.

## Decisions (from Reece)

- 2026-11-27: One of four rocket-car games, alongside Turbo Party, Deflect Duel and the other
  new mode. Browser game (Three.js), local multiplayer plus bots, sharing `../shared/`.
- 2026-11-27: Set up this team, using RocketBonk's structure.
