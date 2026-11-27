# Car Fighter: team project file

**Read `../TEAMS.md` first** (team structure, branches, rules). This file is the Car Fighter
specifics. The boss keeps it up to date.

## What it is (pitch, not yet designed)

A rocket-car take on the 3D one-on-one fighting game genre: two cars in an arena, each with a
health bar, fighting in timed rounds (best of 3). Attacks come from car movement: rams, flips,
spins, boost dashes, aerial slams and the like, chained into combos. There are blocks or
dodges, throws or grabs, juggles, a super meter, and maybe several "fighter" cars with
different move lists and stats. It's for 1–2 local players plus a bot opponent.

Original game only: genre conventions are fine, but don't copy any existing game's names,
characters, art, music, levels or look.

## Team

| Session | Branch |
|---|---|
| Car Fighter (boss) | `team/car-fighter` |
| Car Fighter · Gameplay (systems and feel) | `team/car-fighter-gameplay` |
| Car Fighter · Art and UI (look and screens) | `team/car-fighter-art` |
| Car Fighter · QC (playtest and checks) | `team/car-fighter-qc` |

## First job (boss): design plan

Before any code, the boss writes `DESIGN.md` here with Reece: camera (side-on 3D like the
genre, or arena view), how fighting moves map to car controls and buttons (`input.js` has
drive, steer, jump, boost and hit), the move list and combo system, hit detection and
hit-stun, health/super/round rules, the fighter roster (how many cars, how they differ), bot
difficulty, and a first playable milestone. Get Reece's sign-off, then split it into
Gameplay, Art and UI, and QC jobs.

## Who owns what (once code exists)

| Area | Gameplay | Art and UI |
|---|---|---|
| Rules, physics, controls, bots, modes, balance | owns | — |
| 3D models, scenes, camera, particles, sound and music | — | owns |
| `index.html`, menus, HUD, cards (copy `../turbo-party` and `../deflect-duel` patterns) | — | owns |
| `../shared/js/car.js`, `input.js`, `util.js` | owns (car **model** belongs to Art) | car model only |
| `../shared/js/fx.js`, `sfx.js` | — | owns |
| `../tools/car-fighter-*.js`, tests | — (QC owns) | — (QC owns) |

## How to test

Nothing to run yet. As soon as a match can finish with bots, QC writes
`tools/car-fighter-smoke.js` (copy `tools/turbo-party-smoke.js`) and adds the command here. Any
change to `../shared/` must keep Turbo Party passing: `node tools/turbo-party-smoke.js 2 8 200`.

## Current state (as of 2026-11-27)

- **Not started.** Only this file exists.

## Decisions (from Reece)

- 2026-11-27: One of four rocket-car games, alongside Turbo Party, Deflect Duel and the other
  new mode. Browser game (Three.js), local multiplayer plus bots, sharing `../shared/`.
- 2026-11-27: Set up this team, using RocketBonk's structure.
