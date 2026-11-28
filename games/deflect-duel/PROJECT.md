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

**`team/deflect-duel` now holds v2** (see `DESIGN.md`). The hub's Play card still points at v1
on the base branch until the Director verifies v2 and swaps it in.

**Team:** efficiency mode. The boss builds alone; Gameplay, Art and UI, and QC are stopped.

**v2 has:**
- A 3D ball in a closed box with a ceiling. A neutral ball has gravity; an owned ball flies in
  straight lines, then cools back to neutral.
- Aimed strikes (up, straight or down, plus a sideways bend), clash, the wheels-touch bunt
  (flip reset), and 3D KOs.
- Speed escalation: ×1.22 + 2.5 per strike, up to 210. The hit-freeze grows up to 1.2 s, and a
  Hit pressed during a freeze is remembered.
- The rocket moveset: double jump, flips, air control and flying. Flip strikes; aerial strikes
  aim with the car's nose.
- Bots that fly to high balls, return high shots in the air, flip-strike, flip-dodge, Smash, and
  react according to speed.
- Art's broadcast camera and effects.

**Tests (from `games/`):**
- `node tools/deflect-duel-smoke.js 4 8 240`: a whole all-bot match.
- `node tools/deflect-duel-rules.js`: 11 pass. The skipped tests are v2 plans not built yet.
- `node tools/deflect-duel-fun.js 50 4 3`: the fun table. Last run:
  - rallies: median 5–6 strikes
  - median KO speed: about 29
  - rallies reaching top speed: about 6%
  - aerial strikes: about 31% (7–9% of all strikes are real flying aerials)
  - per match: about 3 flip strikes, 1.6 clashes and 1 flip reset
  - no stalemates, seats fair, nothing stuck

**Still open:**
- Human playtest feel. In particular, on a keyboard W both drives forward and aims a strike up.
- The tunables in `TP.DUEL_CFG`.

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
- 2026-11-28 (Reece, via the Director): "Bunting should be a flip reset (touching with 4 wheels)."
  A bunt is no longer a button. When the car touches the ball with its underside (all four
  wheels), the ball pops up gently and slows, the toucher keeps or takes ownership, there's no
  hit-freeze, and the car gets its jump and flip back. Hit in the air with no direction is a
  normal straight strike. `DESIGN.md` is updated.
- 2026-11-28 (Reece, via the Director):
  - **Keep the neutral-bump rule:** bumping a neutral ball makes you its owner at base speed.
  - **Speeds should escalate the way the genre does.** Each strike multiplies the speed (about
    ×1.12) plus a small step, up to a top speed around 200+. Hit-freeze grows up to about 1–1.5 s,
    with a camera punch-in and a speed readout that climbs. Freeze time doesn't count toward the
    stalemate timer. The ball's collision is swept, so it can't tunnel. Bots get speed-aware
    reactions.
  - **The bar is "just get them to a good playable level".** v2 replaces v1 on the hub only once
    it's genuinely good to play (moveset, aerials, flip-strikes, bots using them, escalation, no
    stalls). The Director verifies, then swaps it in.
- 2026-11-28 (Director, Reece's call): **Efficiency mode.** The boss builds the rest of v2 alone,
  keeps testing lean, and messages the new Director (`session_01GHNBrpeLU9EhxDWu9Qk78E`) only at
  milestones or when blocked.
- 2026-11-28 (boss, accepting Gameplay's Stage A calls):
  - The ball radius is 0.75, so a timed jump clears a floor ball.
  - A clash puts the ball back as it was before the first strike, with zero velocity.
  - A hard bump on a neutral ball makes you its owner as a gravity ball, with a 0.3 s no-KO
    grace.
  - A cooling ball still KOs until it turns neutral.
  - No Smash off a neutral ball.
  - Strike aim uses the pitch axis (stick up/down or W/S), not the gas trigger.
