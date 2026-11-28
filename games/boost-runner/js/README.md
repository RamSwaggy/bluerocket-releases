# Boost Runner: game logic data shapes (Gameplay)

This is the contract between the game logic (Gameplay) and the look (Art and UI). If a shape
here needs to change, ask the boss first; don't work around it in `main.js`.

All logic is plain JS on the `TP` global (classic `<script>` tags, works from `file://`).
Everything hangs off `TP.BR` (also exposed as `window.BR` by `br.js`).

## Load order

```html
<script src="../shared/vendor/three.min.js"></script>
<script src="../shared/js/util.js"></script>
<script src="../shared/js/input.js"></script>
<script src="../shared/js/car.js"></script>
<!-- Gameplay files, in this order: -->
<script src="js/course.js"></script>
<script src="js/runner-car.js"></script>
<script src="js/view.js"></script>
<script src="js/bots.js"></script>
<script src="js/round.js"></script>
<script src="js/br.js"></script>
<!-- then Art and UI's files (camera.js, scene.js, hud.js, main.js, ...) -->
```

## World coordinates

- **x** runs along the track (screen right is +x, the way everyone races).
- **y** is up. Play happens on the flat plane **z = 0**.
- Units are the shared car's units: the car is 3 long and about 1.2 tall.
- A car's `x, y` is the point **under the middle of its wheels** (where it touches the ground).
  The middle of the body is about `y + 0.6`.
- `angle` is the car's nose angle in radians: `0` = level, facing +x; positive = nose up.

## What `main.js` does

```js
const game = BR.createGame({
  scene,                  // a THREE.Scene. Car meshes are added to it.
  seats: [                // 2–4 seats, in HUD order
    { name: "Blue",   controller: "kb1" },   // any TP.CONTROLLER_IDS id
    { name: "Orange", controller: "bot", difficulty: "normal" },
    // ...
  ],
  seed: 12345,            // optional; default is from the URL ?seed= or the clock
  winsToTake: 3,          // first to N round wins (URL ?rounds=N)
  chunk: null,            // optional chunk id to loop (URL ?chunk=)
  aspect: 16 / 9,         // screen width / height; see "view" below
});

// Every animation frame:
TP.Input.poll();                 // main.js owns polling (once per frame)
game.frame(realDtSeconds);       // runs fixed 1/60 s physics steps and updates car meshes
// then place the camera from game.view and render.

// When the canvas resizes:
game.setAspect(width / height);

// Listen for things to draw (explosions, dust, sounds, HUD):
const off = game.on((ev) => { /* see "Events" below */ });

// Leaving the mode:
game.dispose();                  // removes car meshes from the scene
```

`game.frame(dt)` clamps `dt` to 0.1 s, so a background tab doesn't explode physics. With the
`?speed=X` URL flag it runs X times faster (for testing).

## `game` (the live state; read it, don't write it)

| Field | Meaning |
|---|---|
| `game.state` | `"countdown"` (3 s, cars frozen) → `"race"` → `"round_end"` (2 s) → next round's `"countdown"`, or `"match_end"` |
| `game.roundNumber` | 1, 2, 3, ... (`game.round` is the current `Round` object; `game.snapshot().round` is the number) |
| `game.time` | seconds since this round's countdown started |
| `game.raceTime` | seconds since "GO" (0 during the countdown) |
| `game.countdown` | seconds left in the countdown (3 → 0), for "3-2-1-GO" |
| `game.view` | the view rectangle (below) |
| `game.course` | the course (below) |
| `game.cars` | array of `RunnerCar`, one per seat, same order as `seats` |
| `game.wins` | array of round wins per seat |
| `game.winsToTake` | N in "first to N" |
| `game.tuning` | the tuning object the cars run on this round (`TP.modeTuning({ bumpScale: 1.3 })`); QC compares it with `TP.CAR_TUNING` |
| `game.lastResult` | after a round: `{ winner: seat or null (draw), koOrder: [seat, ...], time }` |
| `game.matchWinner` | seat index once `state === "match_end"`, else `null` |
| (rules) | sudden death starts at race time 120 s and always ends the round by 135 s (backstop: the leader wins) |
| `game.snapshot()` | a plain JSON copy of all of the above (used by QC) |

## A car (`RunnerCar`, extends `TP.Car`)

| Field | Meaning |
|---|---|
| `car.seat` | seat index 0–3 (also `car.index`) |
| `car.name`, `car.color` | from the seat / `TP.PLAYER_COLORS` |
| `car.x`, `car.y` | position (getters on `car.pos`) |
| `car.vx`, `car.vy` | velocity, units/s |
| `car.angle` | nose angle, radians (0 = level, + = nose up) |
| `car.onGround` | touching the track |
| `car.boost`, `car.boosting` | meter 0–100, and whether the flame is on |
| `car.alive` | `false` once KO'd this round (same as `!car.out`) |
| `car.koTime`, `car.koCause` | race time of the KO, and `"behind"` (trailing edge) or `"fell"` (below the bottom) |
| `car.offScreen` | seconds it has been outside the KO edges (KO at 0.3) |
| `car.inDanger` | inside the trailing 10% of the screen (pulse ring + beep) |
| `car.offTop` | above the top edge (show an edge arrow) |
| `car.tumbling` | seconds of bad-landing tumble left (0 if none) |
| `car.dashing` | seconds left of the Hit-dash burst (for a trail effect) |
| `car.chunkIndex` | which placed chunk it's in (`game.course.chunks[i]`) |
| `car.isBot` | played by a bot |
| `car.mesh` | the shared car model. Gameplay sets its position and rotation every step; `manualBodyPose` is on, and `mesh.userData.body.rotation.x` carries the tilt (`-angle`: in the model's own frame +x tips the nose down). Gameplay hides it (`visible = false`) on a KO, so draw the explosion from the `ko` event. |

Mesh pose: `mesh.position = (x, y, 0)`, `mesh.rotation.y = +π/2` (the shared model's nose is +Z,
so this points it along +x), and the body's tilt shows `angle`. Art can add to the mesh but
shouldn't overwrite those.

## The view rectangle (`game.view`): the camera rule

```js
game.view = {
  left, right, top, bottom,   // world units, at z = 0
  width, height,              // right-left, top-bottom
  centerX, centerY,
  aspect,                     // width / height (what setAspect gave it)
  dangerX,                    // left + 10% of width: the danger zone is left..dangerX
  minSpeed,                   // how fast the trailing edge is being pushed right (units/s)
  suddenDeath,                // true after 120 s of racing
}
```

`js/camera.js` should place the THREE camera so this exact rectangle fills the screen at z = 0.
For a perspective camera with vertical FOV `fov`:
`distance = (height / 2) / Math.tan(fov / 2)` and `camera.position = (centerX, centerY, distance)`,
looking at `(centerX, centerY, 0)`. Shake and other polish go on top of that.

The view never moves left. It holds the leader at about 65% of the width, zooms out (up to a
maximum that tightens over the round) as the pack spreads, and its trailing edge is pushed right
at a minimum speed that rises over time. KOs are judged against it, so **what you see is the rule**.

`aspect` matters for the top and bottom edges (the height is `width / aspect`). Pass the real
canvas aspect; it's clamped to 4:3–21:9.

## The course (`game.course`)

Built from hand-made chunks (`js/course.js`) chained by a seeded generator. It grows to the
right while a round runs (`course.chunks.length` goes up), so draw new chunks as they appear:
check `course.version` each frame (it goes up by one whenever chunks are added), or listen for
`chunk_added` events.

```js
course = {
  seed, version,
  floorY: -60,              // solid ground is drawn filled down to this height
  chunks: [                 // placed chunks, left to right
    { index, id, name, x0, x1, y0, y1, difficulty }   // y0 = entry height, y1 = exit height
  ],
  surfaces: [               // everything you can drive on, in world units
    {
      chunk,                // index into chunks
      pts: [[x, y], ...],   // polyline, left to right (x never decreases; a repeated x = a vertical step face)
      oneway: false,        // false = solid ground, filled down to floorY. true = thin platform you can jump up through
      thickness: 0.6,       // oneway only: how thick to draw the slab (visual only)
    }
  ],
  pads: [                   // gold boost pads, lying on a surface
    { chunk, x0, x1, y }    // y at the pad's middle (pads are on flat pieces)
  ],
  markers: [                // bot hints. Not drawn in the game; handy in a debug view
    { chunk, x, action, ... }  // action: "jump" | "double" | "boost" | "dash"
  ],
}
course.heightAt(x)          // the top of the solid ground at x, or null over a gap
course.surfaceBelow(x, y)   // { y, angle, oneway, surface } for the first surface at or below y, or null
course.chunkAt(x)           // placed chunk containing x
```

**Glowing cyan edges** go on every polyline in `surfaces` (both kinds). **Gaps** are just places
where no solid surface covers that x.

## Events

`game.on(fn)` calls `fn(ev)` as things happen. The same objects are pushed to `BR.events`
(QC reads that list). Every event has `type` and `t` (race time, seconds). Most have `seat`.

| type | Extra fields | Use it for |
|---|---|---|
| `round_start` | `round` | reset the HUD, start the countdown |
| `go` | `round` | "GO!" |
| `chunk_added` | `chunk` (placed chunk object) | build that chunk's visuals |
| `chunk_enter` | `seat`, `chunk` (index), `id` | (QC) |
| `jump` | `seat`, `double` (bool), `x`, `y` | jump puff / sound |
| `land` | `seat`, `x`, `y`, `speed`, `bad` (bool) | dust; `bad` = tumble landing |
| `dash` | `seat`, `x`, `y` | dash trail / whoosh |
| `pad` | `seat`, `x`, `y` | boost-pad flash |
| `bump` | `a`, `b` (seats), `victim`, `attacker`, `impact`, `x`, `y` | sparks, sound |
| `danger` | `seat`, `on` (bool) | start/stop the danger ring and beep |
| `ko` | `seat`, `cause` (`"behind"`/`"fell"`), `x`, `y`, `chunk` (index), `id` (chunk id) | 80 ms freeze, shake, explosion, grey panel |
| `round_end` | `round`, `winner` (seat or `null` = draw), `koOrder`, `wins` | slow-mo, "BLUE TAKES THE ROUND" |
| `match_end` | `winner`, `wins` | podium |

## Controls (who reads what)

Gameplay reads the shared controls itself; main.js only calls `TP.Input.poll()` once per frame.

- Drive (screen right / left): `ctrl.steer`, plus `ctrl.throttle` on gamepads only.
- Air tilt: `ctrl.pitch` (+1 = nose up).
- Jump / double jump: `ctrl.jump`. Boost: `ctrl.boost`. Hit-dash: `ctrl.hit` (costs 20 boost meter, see `CAR_RULES.dashBoostCost`; it does nothing below that, so the HUD can grey the dash icon when `car.boost < 20`).

## Testing hooks (`window.BR`)

`BR.game` (the current game), `BR.events`, `BR.input.script(seat, [{t, steer, pitch, jump, boost, hit}, ...])`
(scripted controls for a seat; each entry holds from round time `t` until the next one),
`BR.Round` (QC can drive a single round directly), `BR.flags` (parsed URL flags),
`BR.runFor(seconds)` / `BR.runMatch(maxSeconds)` (step the game synchronously) and `BR.summary()`
(winner, wins, rounds, per-chunk clear counts). `sim.html?demo&seed=1&speed=20` runs a bot match with
nothing drawn; add `&sync` to run it in one go; add `&difficulty=easy|normal|hard`. URL flags: `?demo`, `&rounds=N`, `&speed=X`,
`&bots=2..4`, `&seed=S`, `&chunk=<id>`, `&norender`. See `br.js` for details.
