# Boost Runner: design (v1)

A mode of **Rocket Rumble**. Read `../TEAMS.md` and `PROJECT.md` first.

**Status:** Approved by Reece, 2026-11-27. Building the first playable (section 9).

## The game in one paragraph

Two to four rocket cars, driven by local players and bots, race side-on through one shared obstacle
course on one screen. The camera follows the leader. Fall behind the trailing edge, or drop
off the bottom of the screen, and you're knocked out (KO) for that round. Last car on screen
wins the round, and first to **3 round wins** takes the match. The core skill is jumping,
then tilting the car's nose and boosting to fly over gaps, while bumping rivals off-screen.

## 1. Camera and look (Art and UI)

- **Perspective** camera, side-on, with a narrow field of view (about 35°) and set well back.
  The cars look 3D, and the scenery has depth and parallax, but play happens on a flat plane (z = 0).
- **Follow:** the leader is held at about 65% of the screen width, so you can see what's coming.
  Height follows the course smoothly, lagging a little so jumps don't shake the screen. The
  camera **never moves backwards**.
- **Zoom:** backs out as the pack spreads, up to a set maximum.
- **One "view" rectangle is the rule.** `js/view.js` (Gameplay) works out, every physics step,
  the visible rectangle in world units (`left`, `right`, `top`, `bottom`) from the follow and zoom
  rules above. It's plain maths, with no Three.js, so it runs headless for QC, and KOs use it.
  `js/camera.js` (Art and UI) places the Three.js camera so that exactly this rectangle fills the
  screen at z = 0, then adds shake and other polish on top. What you see is the rule. Art and UI
  can ask the boss to change the follow and zoom numbers.
- **Danger edge:** a red-orange glow on the trailing 10% of the screen. A car inside it gets a
  pulsing ring and a rising beep. A car that goes off the top or bottom gets an arrow in its
  colour pinned to the screen edge.
- **KO:** an 80 ms freeze, a small shake, an explosion where the car left, and that player's
  HUD panel greys out with "KO".
- **Theme, "Night-shift test range"** (original): a rocket-test facility at dusk, with gantries, fuel
  tanks and cranes against an indigo-to-ember sky, on 2–3 scenery layers that scroll at
  different speeds. Steel and concrete track with **glowing cyan edges on every surface you can drive on**.
  Hazards have black and yellow stripes, and boost pads are gold. Player colours never
  appear in the scenery.
- **Car:** the shared `buildCarMesh`, turned side-on. Set `car.manualBodyPose = true` so
  the air tilt shows on the body.

## 2. Controls (Director ruling, 2026-11-27)

Same buttons as every mode, and no new bindings.

| Action | Keyboard 1 | Keyboard 2 | Gamepad |
|---|---|---|---|
| Accelerate (screen right) / brake and reverse (screen left) | D / A | → / ← | Stick X, or RT / LT |
| Tilt the nose in the air (up/down) | W / S | ↑ / ↓ | Stick Y |
| Jump (press again in the air for a double jump) | Space | Enter / Numpad 0 | A |
| Boost (thrust along the nose) | Left Shift / F | Right Shift / Right Ctrl / / | B or LB |
| Hit (dash and bump) | E / J | . (full stop) / Numpad 1 | X or RB |

*In code:* driving along the track = `ctrl.steer`, plus `ctrl.throttle` (on pads that's RT/LT;
on keyboards it's W/S, so the mode **ignores throttle on keyboards** and reads it only for pads).
Air tilt = `ctrl.pitch` (new shared axis, 7b279cb: W/S, ↑/↓, or stick Y only). Holding RT in the
air tilts nothing, and on keyboard W isn't gas, so it only tilts when you mean to.
If any of this feels wrong in playtests, the Director decides.

## 3. The runner car: how it keeps the shared car feel

*Plain English:* it's the same car as in every other mode, with the same speed, jump and boost. It's
just stuck on a side-on track.

- **File:** `js/runner-car.js`, a subclass of `TP.Car`. It replaces `update()` with a 2D version:
  position x (along), y (up), and the car's **angle**. It keeps the shared model and boost meter.
- **Tuning:** `TP.modeTuning({ bumpScale: 1.3 })`. Every car number is **read from that object
  while the game runs, with no copies**: accel 28, brake 40, reverseMax 9, drag 0.7, maxSpeed 17,
  boostAccel 34, boostMax 27, boostDrain 38, boostRegen 14, jump 10.5, gravity 28, airTurnRate 2.2.
  `grip` and `pivot` do nothing side-on.
- **Ground:** the car finds the track with short raycasts against the course's line and arc
  pieces, lines itself up with the slope, and launches naturally off crests and ramp lips. Gravity
  pulls along slopes (28·sin θ), so a 30° ramp still climbs at 14 units/s².
- **What the shared numbers give us:**
  - **Jump:** about 2.0 units high and 0.75 s in the air. It clears a gap of about 12 units at speed 17,
    or about 20 at 27. The car is 3 units long. Course pieces are sized from these numbers.
  - **Air tilt:** at 2.2 rad/s that's about 95° per jump. Enough to fix a landing or point the nose up,
    but no free backflips.
  - **Boost:** 34 is more than gravity's 28, so boosting nose-up climbs slowly, and at about 55° the
    car hovers. A full meter lasts 2.6 s and refills in about 7 s. That's the "rocket hop" over gaps,
    and it needs no new values.

**New rules that live only in this mode** (approved by the Director, 2026-11-27):

| Rule | Value | Notes |
|---|---|---|
| Double jump | one per airtime, the same 10.5 as the shared jump | resets on landing |
| Hit-dash | instant 10.5 burst along the nose | one per airtime, about 1 s cooldown on the ground. The main knock-off move |
| Bad landing | more than about 50° off the surface | short tumble plus speed loss |
| Car-vs-car bumps | 2D copy of `collideAll`'s maths, `bumpScale` 1.3 | same "pop" cap as shared |
| Jump buffer / coyote time | about 0.1 s each | press timing only, not a car number |

## 4. Courses (Gameplay builds them, Art and UI dresses them)

- **Hand-made chunks**, about one screen long each, written as plain JS data: line and arc segments,
  hazards, one-way platforms, boost pads, an entry and exit height, a difficulty rating, and bot hints
  (jump and boost markers).
- Each round, a **seeded** generator chains them together, getting harder over the round. The same
  seed always gives the same course.
- **First chunk set (v1):** flat, gap, ramp, step-up, one-way platform, plus one boost-pad chunk.
- Art and UI builds the visuals from the **same data** that Gameplay uses for collision, so they can't drift apart.

## 5. Rounds and KOs (Gameplay)

- **KO:** behind the trailing edge or below the bottom edge for **0.3 s** in a row. The grace time
  stops unfair flicker KOs. The leader can't KO themselves off the leading edge, because the camera follows them.
- **Last car on screen wins the round.** If everyone left is KO'd in the same frame, the round
  is a draw (no point awarded) and the next round starts.
- **Rounds always end:** the camera's minimum speed rises over time, and the maximum zoom tightens.
  Target round length is 45–90 s. After 120 s there's a hard backstop (sudden death: the edge closes
  in quickly).
- **Match:** first to 3 round wins. KO'd players watch until the round ends, with no respawns.
- **Catch-up (light):** cars further back get slightly faster boost regen. This is a mode rule;
  QC checks it doesn't change the shared numbers.

## 6. Bots (Gameplay)

They follow each chunk's racing line and its jump/boost markers, and fall back to a short raycast
ahead to spot gaps. They dash when a rival is just ahead. Reaction delay and timing jitter scale with
difficulty (easy / normal / hard). They output the same control shape as a human.

## 7. Screens, HUD and sound (Art and UI)

- **Menu:** starts from `TP.Rumble.loadSetup()`, saves back with `saveSetup()` on Start,
  and has a "← All modes" link to `TP.Rumble.HUB_URL`. Seats set to "off" are played by bots.
  The style matches the hub.
- **HUD:** a slim panel per player along the top, with name, controller, round-win pips (●●○) and a
  boost bar. "Round N" at top centre.
- **Round start:** 3-2-1-GO. **Round end:** slow motion on the last car, "BLUE TAKES THE
  ROUND", the pips fill in, a KO-order card, and about 2 s to the next round.
  **Match end:** podium, confetti, wins table, Rematch / Menu.
- **Music:** a faster original track (about 140 bpm, minor key) in `js/`, using
  `TP.sfx.defineTrack("boost-runner", …)` and `TP.sfx.music(true, "boost-runner")`.
  **Effects:** built in the mode folder first. New shared effects go to the Director through the boss.

## 8. Testing hooks (QC needs these from day one)

- **URL flags:** `?demo` (all bots, auto-start), `&rounds=N`, `&speed=X`, `&bots=2..4`,
  `&seed=S`, `&chunk=<id>` (loop one chunk on its own), `&norender`.
- **Determinism:** one seeded RNG for the course and the bots, with no `Math.random()` in game logic, and
  a fixed 1/60 s physics step separate from rendering.
- **`window.BR`:** `BR.game` (round, round state, time, camera edges, and for each car: id, seat, x, y,
  velocity, alive, chunk, KO time and cause, wins), `BR.events` (ko, round_end, bump,
  chunk_enter, jump, land), and `BR.input.script(seat, [{t, …}])` for scripted human input.
- **A `Round` class QC can drive directly:** `new Round(game, opts)`, `.update(dt)`, `.state`,
  `.result()`, `.dispose()`.
- **Planned tools:** `tools/boost-runner-smoke.js` (full match PASS/FAIL),
  `boost-runner-balance.js` (many seeded rounds), `boost-runner-chunk.js` (can every chunk be cleared).

## 9. First playable milestone

1 human (keyboard 1) plus 3 bots. The runner car with drive, tilt, jump and double jump, boost, Hit-dash and bumps.
The 6 v1 chunks chained by seed. Follow camera with zoom and the danger edge. Edge KOs. Rounds to 3 with a
plain match-end card. Placeholder test-range look with the sky and 2 scenery layers, HUD pips, countdown,
and the new music track. The `window.BR` hooks, and QC's smoke test passing.

**Not in v1:** pickups, wall rides, grapple, more themes, training.

## 10. Job split (first round of jobs)

- **Gameplay:** `js/runner-car.js`, `js/course.js` (chunk data and the seeded chainer), `js/view.js`
  (follow/zoom/edge maths), `js/round.js` (KOs, rounds, match), `js/bots.js`, `js/br.js` (the
  `window.BR` hooks, URL flags, fixed step), and `sim.html`, a bare page that loads only the
  logic, for headless runs. Publishes the data shapes (car state, course segments, view, events)
  in `js/README.md` early, so Art and UI can build against them.
- **Art and UI:** `index.html`, `js/main.js` (menu, hub setup, render loop), `js/camera.js`,
  `js/scene.js` (theme, building the course look from the course data), `js/hud.js`, `js/fx-br.js`
  (trails, dust, KO), `js/music.js` (the track). Starts on the scene, camera and menu against a
  stub course, then switches to Gameplay's real data.
- **QC:** `tools/boost-runner-smoke.js` (against the `window.BR` hooks as soon as a round runs),
  `tools/credits-check.js`, then the section 8 checks and the shared-car-feel check.
