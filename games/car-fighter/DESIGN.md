# Car Fighter: design

**Status:** signed off 2026-11-27. Reece passed approvals to the Rocket Rumble Director
("keep going, I trust you"), and the Director confirmed every pick below. This file is the
source of truth for the build. If something here turns out wrong in playtesting, the boss
changes it here first, then sends jobs.

Car Fighter is a mode of **Rocket Rumble**. It drives the same rocket car as every other mode
(see "One car feel" in `../TEAMS.md`). The fighting (attacks, combos, stun, health) is a layer
on top of the car.

---

## 1. Pitch

A 1v1 side-on fighter between two rocket cars. It's set at night in the
**Scrapyard Floodlight League**: a steel turntable in a junkyard, lit by crane floodlights. Hit
with rams, swipes, flips and boost dashes. Block, sidestep and throw. Juggle cars in the air.
Knock the other car's health to zero, or have more left when the 60-second clock runs out.
Best of 3 rounds.

It's crunchy cartoon violence, on cars only: panels dent, parts fly off, the car smokes. It's
played by 1 player vs a bot (Easy / Normal / Hard) or by 2 players on one machine. Bot vs bot
is the demo, and it's also what the tests run.

**Originality rule:** genre conventions are fine (health bars, rounds, combos, juggles,
throws). Copying any existing fighting game is not: no character, move or stage names,
iconic poses, or look. Every name in this file is ours.

---

## 2. Camera

The view is **side-on 3D**. Both cars sit on one fighting line, roughly the X axis, and
always face each other.

- The camera looks at the midpoint between the cars, from the side, slightly high. It zooms
  out as they separate, so both always fit, with headroom for juggles.
- It never rotates while players are steering, so left and right on screen stay left and
  right. When the cars cross over each other, they swap facing. The camera doesn't move.
- Extra moves for the camera (Art and UI's call to tune): a short push-in on a heavy hit, a
  close-up cut for a special, and a slow-motion orbit on the KO.
- **Sidestep** moves a car a short way into or out of the screen, off the fighting line. The
  line then quietly drifts back to centre on both cars, so the fight never ends up rotated.

## 3. Controls

All of these are the shared Rocket Rumble controls from `shared/js/input.js`. **Heavy** is the
one new button, added by the Director for this mode.

| Button | kb1 | kb2 | Gamepad |
|---|---|---|---|
| Steer (left / right on screen) | A / D | ← / → | Left stick X, D-pad |
| Up / down (`ctrl.pitch`) | W / S | ↑ / ↓ | Left stick up / down, D-pad up / down if the shared input adds it |
| Drive (`ctrl.throttle`) | W / S | ↑ / ↓ | RT / LT (not used for fighting in v1) |
| Jump | Space | Enter | A |
| Boost | Left Shift / F | Right Shift | B / LB |
| Hit (light attack) | E | . | X / RB |
| **Heavy** (heavy attack) | **R** | **,** | **Y** |

**What they do in a fight** (the Director approved "steer becomes screen-relative
movement" as Car Fighter's control mode):

- **Left / right** moves the car along the line on screen. "Toward" and "away" depend on which
  side you're on. **Holding away blocks**, as long as you're not attacking.
- **Tapping up or down** (read from `ctrl.pitch`, which works the same on keyboards and gamepads) sidesteps into or out of the screen. Hits miss you for a moment,
  then there's a short recovery. Holding up or down does nothing else in v1.
- **Jump** hops. You can steer in the air a little, just like the shared car.
- **Boost** gives a short burst of speed along the line toward where you're pointing on the
  stick. It uses the shared boost bar.
- Facing is automatic. The car always points at the opponent.

In plain words: drive your car left and right like a fighter walking, hold back to guard,
tap up or down to dodge, and use the two attack buttons, in combination with a direction,
for different moves.

## 4. Move list (v1, the same for every car)

Every move is a **row in a data table** (`js/moves.js`), not hand-written code:

- frames: startup, active and recovery (at 60 per second)
- damage
- hit-stun and block-stun
- knockback, as a push speed and an upward launch speed
- a hit box relative to the car
- the moves it can cancel into
- meter gained
- flags: launcher, overhead, throw, armour

Fighter cars differ by changing numbers in this table, plus one special each.

| Input | Move (our names) | What it does |
|---|---|---|
| Hit, Hit, Hit | **Jab → Swipe → Spinout** | Fast light chain, low damage. The start of most combos. |
| Heavy | **Ram** | A heavy forward hit with big pushback. Punishable if blocked. |
| Toward + Heavy | **Corkscrew** | **Launcher**: knocks them into the air for a juggle. Slow startup. |
| Away + Heavy | **Tailwhip** | A 180° spin that pushes them away and gets them off you. |
| Boost + Hit | **Dash Strike** | Closes distance fast or ends a combo. Costs 25 boost. |
| Jump, then Hit | **Flip Kick** | An air hit, good for juggles. |
| Jump, then Heavy | **Drop Slam** | A diving slam that ends a juggle with a knockdown. |
| Hit + Heavy together, up close | **Tow Hook** (throw) | Flips them over you. It goes through block but loses to any attack. |
| Boost + Heavy (1 super bar) | **Signature move** | Each car's own special (see §6). |

**Blocking:**
- A blocked hit does 15% chip damage.
- The blocking car goes into block-stun, which is shorter than hit-stun.
- It's pushed back a little.

There's no high or low guard in v1: any block stops any hit except a throw. The guessing
game is block versus throw versus sidestep.

## 5. Combos, stun and the rules against infinites

- A move can only **cancel** into the next if it hit or was blocked. A miss never chains.
  - Allowed chains: light → light → light, light → Heavy, Corkscrew or Dash Strike, and air
    Hit → Drop Slam.
- **Hit-stop:** both cars freeze briefly when a hit lands, so it's felt. It's about 3 frames
  for a light hit, 6 for a heavy and 10 for a signature move. The round clock doesn't run
  during hit-stop.
- **Hit-stun:** the time set per move, during which the victim can't act.
- **Damage scaling:** each hit after the first in a combo does 10% less, down to a floor of
  50%.
- **Juggle limit:** after 3 hits in the air, the next hit knocks them out of the juggle, onto
  the ground. They can't be hit until they land.
- **Wall bounce:** a big knockback into the arena rail bounces them back once per combo.
- **Wake-up:** a knocked-down car gets 30 frames of invulnerability while it stands up, so
  you can't knock it down again the instant it rises.
- **Throws** have a 20-frame cooldown on the victim, so you can't throw the same car twice in
  a row.

## 6. Fighter cars (3)

Each car has a body shape of its own, built by Art in `car-fighter/js`. Every car is
**painted in its player's colour** (P1 blue, P2 orange, as in every mode), with its own trim
and spark colour. Handling differs only through `TP.modeTuning({...})`: `maxSpeed`,
`boostMax`, `grip`, `pivot` and `bumpScale`. Everything else is fight data.

| Car | Body | Health | Handling | Fight traits | Signature move |
|---|---|---|---|---|---|
| **Rivet** (all-rounder) | Compact coupe | 1000 | shared defaults | balanced move table | **Grinder**: a multi-hit spinning sweep |
| **Haulback** (heavy) | Box truck | 1200 | lower `maxSpeed`, higher `bumpScale` | Ram and Corkscrew have 1 hit of armour, slower startup | **Quake Drop**: jumps and lands with a ground shockwave |
| **Skitter** (light) | Low wedge | 850 | higher `maxSpeed` and `boostMax`, lower `grip` | faster moves, short sidestep recovery, less damage | **Slipstream**: a boost dash through the opponent that ends behind them, then a hit |

**M2 starting numbers** (Gameplay's plan, accepted 2026-11-28, to be tuned with QC's sims).
**Tuned since** (Gameplay `383d4e8`):
- Haulback: 1150 HP, damage ×1.0.
- Skitter: 950 HP, knockback ×1.05.
- Health in the table above is superseded by these values.

Measured by the boss at Normal, both seat orders:
- Rivet beats Haulback about 45% of the time.
- Rivet beats Skitter about 41%.
- Haulback beats Skitter about 57%.
- Hard beats Normal about 75%.

The starting numbers were:

- **Haulback:**
  - Handling: `maxSpeed 14`, `boostMax 24`.
  - Damage ×1.1, light attacks start 1 frame slower.
  - Ram: startup 14, 125 damage, 1 hit of armour. Corkscrew: startup 17, 1 hit of armour.
  - Sidestep lasts 26 frames. Takes 10% less knockback.
  - Quake Drop: startup 24, 210 damage, a shockwave that hits both sides and knocks down. It
    can be blocked, and it misses an opponent in the air.
- **Skitter:**
  - Handling: `maxSpeed 20`, `boostMax 31`, `grip 7`.
  - Damage ×0.85. Every move except the throw starts 1 frame faster, and light attacks
    recover 2 frames faster.
  - Dash Strike costs 20 boost. Sidestep lasts 18 frames. Takes 10% more knockback.
  - Slipstream: an invulnerable boost dash through the opponent, then a hit (180 damage)
    about 6 frames after the pass.
  - **It is a real cross-up, not unblockable.** After the pass, the defender's auto-face
    flips, so the defender blocks it by holding the new "away".
- **Rivet:** Grinder is a 3-hit spin, hitting on frames 11, 17 and 23 for 70 + 70 + 90.
- **Bot targets:**
  - Hard beats Normal about 75% of the time. Normal beats Easy about 80%.
  - Every car pairing at Normal lands at 40–60%.
  - Average round 25–40 s, with fewer than 10% time-outs.

Skitter can't have an extra jump: jump height is part of the shared car feel. Its air
mobility comes from Slipstream instead.

## 7. Health, meters and rounds

- **Health:** 1000 by default (see the table per car). The HUD shows it as a bar, not a
  number.
- **Boost bar:** the shared car's own boost bar, with its usual drain and refill. It's spent
  on Dash Strike and normal boosting.
- **Super meter:** 3 segments of 100 each.
  - You gain meter from dealing damage, and from taking it at half the rate.
  - A signature move costs 1 segment.
  - It **carries over between rounds** and resets each match.
  - A 3-segment super is planned for milestone 3.
- **Rounds:** 60 seconds each, **best of 3**, with a 3-2-1-FIGHT countdown.
- **Time-out:** the car with the higher health percentage wins the round. Equal health means
  a draw, and both cars get a round. If the match is tied after 3 rounds, a sudden-death
  4th round is played.
- **Double KO** (both reach 0 on the same frame): a draw round, with the same rule as above.
- Each round resets position, health, stun and boost. Super meter carries over.

## 8. Bots

There's one bot brain. Difficulty is a set of numbers, not separate code. The bot sends the
**same controls a human does** (the `input.js` shape), so it can't cheat with frame-perfect
blocks beyond its reaction time.

| | Easy | Normal | Hard |
|---|---|---|---|
| Reaction delay | 450 ms | 250 ms | 120 ms |
| Block chance | 15% | 45% | 70% |
| Punishes a blocked heavy | rarely | sometimes | usually |
| Longest combo it tries | 2 hits | 3–4 hits | full routes |
| Spacing and throws | walks in, mashes | keeps some range | holds its range, throws players who block a lot |

Bots also need to **stop stalling**: if a round is about to time out, the losing bot plays
more aggressively.

## 9. Code layout and ownership

All of this lives in `games/car-fighter/`. Our team doesn't edit `games/shared/`. Requests go
to the Director through the boss.

| File | Owner | What it is |
|---|---|---|
| `index.html` | Art and UI | The page, script tags, CSS, HUD and menu markup |
| `js/moves.js` | Gameplay | Move tables (data) and the chain/cancel table |
| `js/fighters.js` | Gameplay | The 3 cars' stats: health, `modeTuning` overrides, move-table changes, signature moves |
| `js/fight.js` | Gameplay | **The fight core.** A fixed 60 Hz step, the state machine per car, hit detection, stun, damage, meters, rounds, timer and the event log. It uses `TP.Car` and Three.js **maths only**: no rendering, camera, DOM, fx or sound, so it runs fast with `&headless`. |
| `js/bot.js` | Gameplay | The bot brain and the difficulty table |
| `js/match.js` | Gameplay | Glue: reads URL options and the hub setup, creates the fight, runs the fixed-step loop (with `?speed`), and calls the view |
| `js/view.js` | Art and UI | Scene, stage, side-on camera, car meshes and posing (uses `car.manualBodyPose`), damage looks |
| `js/bodies.js` | Art and UI | The 3 fighter body shapes, painted in the player's colour |
| `js/fx-fight.js`, `js/sfx-fight.js` | Art and UI | Hit sparks, impact rings, block flashes, debris and smoke; crunch, clang and whoosh sounds, stings and the fight music. These are first versions here. The Director moves good ones into `shared/` later. |
| `js/ui.js`, `js/main.js` | Art and UI | Menu (starts from `TP.Rumble.loadSetup()`, saves on Start, "← All modes" link), character select, HUD, round and KO cards, results |
| `../tools/car-fighter-*.js` | QC | Smoke test and sim/combo tools |

### The fight-core contract (Gameplay ↔ Art ↔ QC)

Gameplay writes this, and Art and QC build against it. Any change to it goes through the boss.

```js
// Created by match.js. fight.js uses THREE maths and TP.Car, but never renders or touches the DOM.
const fight = TP.Fight.create({
  p1: { fighter: "rivet", controller: "kb1" },   // controller: "kb1" | "kb2" | "padN" | "bot"
  p2: { fighter: "rivet", controller: "bot", bot: "normal" },
  rounds: 3, roundTime: 60, seed: 12345,
  scene,               // TP.Car needs a scene for its mesh. view.js later dresses car.mesh with a fighter body.
});
fight.cars;           // the two TP.Car objects (view.js reads .mesh, sets manualBodyPose)
fight.step(inputs);   // advance exactly one 1/60 s frame. inputs = [p1Controls, p2Controls] in
                      // the input.js shape (incl. heavy/heavyPressed); bots fill their own.
fight.state;          // plain data, read-only for others:
  // { frame, phase: "intro"|"countdown"|"fight"|"hitstop"|"roundEnd"|"matchEnd",
  //   round, timer, roundWins: [0,0], roundResults: [...], winner,
  //   cars: [{ x, y, z, vx, vy, vz, facing, health, maxHealth, super, boost,
  //            state: "idle"|"walk"|"block"|"attack"|"hitstun"|"blockstun"|"air"|"juggle"|
  //                   "knockdown"|"wakeup"|"thrown"|"sidestep"|"ko",
  //            move, moveFrame, stateFramesLeft, combo, damageLevel }] }
fight.events;         // log since start: { frame, type: "hit"|"block"|"whiff"|"throw"|
                      //   "combo_end"|"ko"|"round_start"|"round_end"|"match_end",
                      //   attacker, move, damage, stun, x, y, z }
fight.onEvent(fn);    // Art and UI hook for sparks, sounds and camera kicks
TP.MOVES, TP.FIGHTERS // the data tables, readable by tests
TP.Fight.ARENA        // { halfX, halfZ, minY, maxY }: the playable bounds, for QC's checks
```

**Contract details** (settled 2026-11-27 from QC's questions):

1. Every `TP.MOVES` row has an `input` string. Examples: `"hit"`, `"hit*2"` (2nd chain hit),
   `"hit*3"`, `"heavy"`, `"toward+heavy"`, `"away+heavy"`, `"boost+hit"`, `"jump>hit"`,
   `"jump>heavy"`, `"hit+heavy"` (throw), `"boost+heavy"` (signature).
2. `startup: N` means N frames of windup. The move's **first active frame is frame N+1**,
   counting the frame the button is pressed as frame 1.
3. `TP.Fight.create` takes an optional `super` per player (e.g. `p1: { ..., super: 100 }`),
   so tests can start with meter. It's also useful for training mode later.
4. `onEvent(fn)` takes **any number of listeners**. Tests should still read `fight.events`.
5. `round_end` events carry `winner` (0, 1, or `null` for a draw) and
   `reason: "KO" | "time-out" | "draw" | "double-KO"`. `combo_end` carries `hits` and
   `damage`.

`fight.js` drives each car's position with the shared `TP.Car` physics and
`TP.modeTuning(...)`:

- Outside moves, driving, jumping and boosting go through the normal `Car.update`.
- During a move, the move's own numbers set `car.vel`. The Director approved this as
  fight-layer movement.
- Pushing the cars apart is our own code. We don't call `Car.collideAll`.

`match.js` exposes the fight as `window.TP.fight` for tests.

**URL options:**

| Option | Values |
|---|---|
| `?demo` | bot vs bot |
| `&speed=N` | game speed multiplier |
| `&seed=N` | seed for random rolls |
| `&rounds=N` | number of rounds |
| `&roundTime=S` | round length in seconds |
| `&p1=` / `&p2=` | `rivet`, `haulback` or `skitter` |
| `&bot=` | `easy`, `normal` or `hard` (`&bot2=` sets the second bot) |
| `&headless` | skip rendering, for fast simulations |

## 10. Milestones

**M1: first playable (the current goal).** A bot-vs-bot best-of-3 that QC's smoke test plays
to the end, and that one human on kb1 can play against the bot.

| Role | What's in M1 |
|---|---|
| Gameplay | `fight.js`, `moves.js` (the full v1 move list), `match.js`, a Normal-difficulty bot. Rivet only (both cars), with Rivet's signature move stubbed as a big Ram. |
| Art and UI | `index.html`, a simple turntable stage, the side-on camera, both cars using the shared car mesh in player colours, HUD (health, super, round pips, timer), FIGHT/KO/results cards, a basic menu (hub setup, "← All modes"), and placeholder hit sparks. |
| QC | `tools/car-fighter-smoke.js` and `tools/car-fighter-sim.js` (headless N-match stats), plus a frame-data check of `TP.MOVES` against what actually happens. |

**M2: the real fight.**
- Gameplay: all 3 cars with their stats and signature moves, Easy/Normal/Hard bots, tuning
  the move table from QC's numbers.
- Art and UI: the 3 body shapes, flips and rolls, damage looks (dents, flying parts, smoke),
  hit-stop and shake, a combo counter, character select, sounds and fight music.
- QC: golden replays and combo sweeps (no infinites, no stuck states).

**M3: extras.** A training mode, a 3-segment super, more stages (car-park rooftop, car wash),
and moving fx and sfx into `shared/` (a Director call).
