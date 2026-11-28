# Deflect Duel: Design v2

**Status:** approved 2026-11-28 (Reece's direction, through the Director). Updated the same
day: **a bunt is a wheels-touch flip reset**, not a button. This replaces the
flat, top-down v1 rules. v1 stays playable on the hub while v2 is built.

**Reece's brief:** a car-soccer feel crossed with a fighting-game ball-strike game, and it
should *play* like both. In plain English: the cars and the ball move like a car-football game
(jumps, flips, flying, a ball that bounces around a closed box), and the scoring and pace work
like an arena ball-striking fighter (strike the ball to make it yours, every strike makes it
faster, and a ball you own knocks out anyone else it touches).

Genre conventions only. Nothing in code, text, art or sound may use another game's names, terms,
characters or look.

---

## 1. The arena

| | v1 | v2 |
|---|---|---|
| Shape | Flat floor and walls, seen from above | A closed **box**: floor, four walls and a **ceiling** |
| Size | 44 × 28 | 44 (x) × 28 (z) × **14 high** (y), all set in `TP.DUEL_CFG` |
| Pillars | 2, behind a flag | Kept behind the flag, now floor-to-ceiling |
| Corners | Sharp | Sharp for now, with room left for **curved ramps** where walls meet the floor (wall-riding is a later shared-engine feature) |

The serve point is the centre, at about head height.

## 2. The ball

The ball has **two modes**. You can tell which by its colour: white means neutral, and a
player's colour means owned.

**Neutral ball** (after a serve, a reset, or when an owned ball has "cooled down"):
- Normal gravity and bounce. It arcs, bounces off the floor, walls and ceiling, loses a little
  energy each bounce, and rolls along the floor.
- It can't KO anyone.

**Owned ball** (straight after a strike):
- It flies in a **straight line at its current speed**, with **no gravity**, bouncing cleanly off
  the floor, walls, ceiling and pillars, without losing speed on each bounce.
- It KOs anyone who isn't its owner. It passes harmlessly through its owner.
- **Cool-down:** if nobody strikes it for a few seconds (`ownedHold`, about 3 s), it eases back
  into gravity and slows down over `ownedFade` (about 1.5 s) until it's a neutral, floating
  ball again. That stops it ricocheting forever. The **12 s stalemate reset** still applies on
  top of this.

**Speed escalation** (Reece, 2026-11-28: "late rallies get absurd but stay readable"):
- The first strike off a serve sends the ball at about `baseSpeed` (16), slow enough to chase.
- Each strike after that **multiplies** the speed (`speedMult`, about ×1.12) **and** adds a small
  step (`speedStep`). Early rallies stay chaseable, and late rallies explode.
- The top speed (`maxSpeed`) is around **200+**, about 4× a car's top speed, so the ball crosses
  the arena in about 0.2 s.
- A **Smash** (strike while boosting) adds a bonus that scales with the current speed, and costs
  boost.
- **Hit-freeze grows hard with speed**, up to about **1–1.5 s** at the top. During a long
  freeze the camera punches in on the striker and the speed readout climbs. These standoffs are
  what make extreme speeds readable and dramatic, and they give humans time to react. Freeze
  time **doesn't count** toward the stalemate timer.
- **No tunnelling:** the ball's movement is swept or sub-stepped against cars, walls, ceiling,
  floor and pillars, so even a 200+ ball can't pass through anything.

## 3. Touching the ball

| Action | What happens |
|---|---|
| **Drive or bump into it** | A physics push, the way a car-football ball reacts. **No** speed tier and **no** ownership change. One exception: bumping a *neutral* ball makes you its owner at `baseSpeed` (it doesn't become a straight-line ball). |
| **Strike** (Hit button) | A quick swipe with a short window (`swingTime`). If the ball is in reach, it goes to the **next speed tier**, becomes **yours**, and flies in a straight line. |
| **Flip into it** | Counts as a strike, with a **power bonus** (`flipBonus`), in the flip's direction. |
| **Bunt = wheels touch** (the car touches the ball with its **underside**, all four wheels, usually in the air) | The ball **pops gently up and slows** (speed drops to `buntKeep` of what it was, about 60%). The toucher **keeps or takes ownership**. There's **no hit-freeze**, just a soft thunk and a ring. The car **gets its jump and flip back** (a *flip reset*: `car.resetAirMoves()`), so a skilled player can bunt and then flip-strike or fly again. It isn't a button: **Hit in the air with no direction is a normal straight strike**. A nose or side touch is just a bump. |
| **Clash** (two strikes on the ball within `clashWindow`, about 0.1 s) | **Both** strikers bounce away, and the ball **stays where it is**, its ownership unchanged. Big flash and shake. (This also settles "several cars hit the ball on the same frame": that's a clash, not a stacked double hit.) |

**Aiming a strike** (stick, or the keys):

| Input while striking | Angle |
|---|---|
| Up held (stick up / W) | Angled up, about 35° |
| Nothing | Straight, flat along the car's facing |
| Down held (stick down / S) | Angled down, about 35°, so it bounces off the floor |
| Left / right | Bends the shot sideways up to about 25° |

The car's facing gives the base direction. In the air, "facing" includes the car's pitch.

## 4. The car: the "rocket moveset"

This comes from the shared engine (the **Core** session builds it, and it's opt-in per mode).
Deflect Duel is its first user. The moves:

- **Double jump:** a second jump while airborne.
- **Directional flip:** jump again with a direction held, and the car flips that way with a burst
  of speed. Flipping **into the ball counts as a strike**.
- **Air control:** steer, pitch and roll in the air.
- **Aerial boost:** pitch up and boost to fly.

Car-feel rules still hold: only the `TP.MODE_TUNABLE` settings may differ per mode. Until Core's
first moves land, v2 runs on the current shared car (single jump) and gets each move as Core
pushes it.

What Deflect Duel needs to read from Core: `car.airborne`, `car.jumpsLeft` (or similar),
`car.flipping`, `car.flipDir` (a unit vector), `car.flipT`, the car's full 3D orientation, and
an event or flag when a flip starts, `car.resetAirMoves()` (gives the jump and flip back), and a
**wheels-contact test** (is the car's underside, its `down` vector, facing the ball, with the
contact point inside the wheelbase?). Until Core's test lands, Deflect Duel uses a stand-in
that checks the car's body orientation.

## 5. Camera

A **side-angle "broadcast" camera** in 3D, not top-down. It looks across the arena from one
long side, a little above floor height. It frames every live car **and the ball, including its
height**, so aerials read clearly, and it eases its zoom and position to fit them. It's tilted
enough that you can still judge depth (near wall or far wall).

To help read the 3D position, the ball has a **floor shadow or ring** straight below it, plus a
faint line to the floor when it's high. Hit-freeze, shake and Smash zoom still work.

## 6. Rules that don't change

- **Ownership KOs:** a ball you own never hurts you. An owned ball touching anyone else costs
  them a life (unless they're invulnerable or not touching it).
- **Hit-freeze and shake** scale with speed.
- **Smash** = strike while boosting.
- The **12 s stalemate reset**, lives (3 or 5), respawn invulnerability, last car standing wins,
  and a double KO goes to the last striker.
- Hub setup, the menu, results, rematch and "← All modes" all stay.

## 7. Bots

Bots must use the whole moveset, scaled by a per-bot skill:
- **Neutral ball:** read where it'll land or bounce, drive there, jump or aerial to meet it, and
  strike with a sensible angle.
- **At extreme speed:** a reaction window based on the hit-freeze plus distance, and a success
  curve that falls with speed, so they're beatable at high speed but not hopeless.
- **Their own ball:** keep clear of its line, and get ready for the return.
- **An enemy's ball coming at them:** strike it back (choosing up, straight or down) if it's
  slow enough for their skill. Otherwise **dodge**: jump over it, flip sideways out of its line,
  or meet it wheels-first to **bunt** it and slow the rally down.
- Sometimes start a clash on purpose when two bots go for the same ball.
- Stretch goal for hard bots: a deliberate **bunt, then flip-strike** combo.

## 8. What "done" looks like for v2

Reece's bar: **"just get them to a good playable level"**. v2 replaces v1 on the hub only when
it's genuinely good to play. The Director verifies it, then swaps it in.


- The rocket moveset is in. Aerials and flip-strikes work, and the bots use them.
- The speed escalation feels right, and nothing stalls.
- A full all-bot match ends with a winner, with no errors and every rule check holding.
- Bots aerial, flip and bunt, and rallies last a decent number of strikes.
- A keyboard or gamepad player can do every move and read the ball's height on screen.
- Turbo Party and the other modes still pass after any shared change.

## 9. Fun checks (QC measures these, and flags rather than fails)

- **Rally length:** strikes between KOs. Aim for a median of 4–12.
- **Aerial share:** strikes made with the car off the ground. Aim for at least 20% once
  Core's moves land.
- **Bot strike rate:** strikes attempted vs. connected (not near 0%, not near 100%).
- **Clash, bunt and flip-reset counts** per match: they should happen sometimes, not never and not
  constantly.
- **Escalation:** the median KO speed (well above base), the top speed in long rallies, and how
  often a rally reaches the top tier (sometimes, but most rallies shouldn't end at the first big
  jump).
- **Ball speed vs. car speed:** how often the ball is faster than a boosting car (27).
- **Tunnelling:** a ball at max speed never passes through a car, wall, ceiling, floor or pillar
  (this one fails, not just flags).
- Stalemate resets per match (fewer than 1).

## Tuning starting points (all in `TP.DUEL_CFG`; the team tunes them)

| Setting | Start | Meaning |
|---|---|---|
| `arenaH` | 14 | Ceiling height |
| `gravity` | about the shared car's | For a neutral ball |
| `bounce` | 0.7 | How much speed a neutral ball keeps per bounce |
| `baseSpeed` / `speedMult` / `speedStep` / `maxSpeed` | 16 / 1.12 / 1.5 / 210 | Escalating strike speed |
| `freezeMax` | 1.2 s | Hit-freeze at top speed (grows steeply with speed) |
| `ownedHold` / `ownedFade` | 3 s / 1.5 s | Owned straight-line flight, then the cool-down |
| `angleUpDeg` / `angleDownDeg` / `aimBendDeg` | 35 / 35 / 25 | Strike aim |
| `flipBonus` | +4 | Extra speed for a flip strike |
| `buntKeep` / `buntUp` | 0.6 / 6 | Bunt (wheels touch) speed kept and upward pop |
| `clashWindow` | 0.1 s | Two strikes this close together clash |
