# Mode 5 — NEON TURF (design, owned by the Surprise team boss)

> Surprise rule: nothing in this folder may be mentioned, shown or hinted to Reece, or written
> anywhere outside `games/mode-5/`, until the Director reveals it. Commit messages stay neutral:
> "Mode 5: work in progress, part N".

## One-line pitch
**Paint the arena in your colour. Most floor when the clock hits zero wins.**
Your rocket car is a paint roller. Drive to leave a stripe, boost to paint wider, jump and land to
splat a blob, and **close a loop back into your own turf to flood-fill everything inside it**.
Run over a rival's wet trail to pop it. 1–4 players, bots fill empty seats.

Why it's different from the other four modes: no ball, no board, no health bars, no race line.
It's a **territory game**: the score is the floor itself, it's visible to everyone at all times,
and the lead can swing in one big loop-close in the last seconds.

## Core rules (v1)

### The floor
- The arena floor is a **grid of paint cells** (`GRID = 72 × 72` cells over a ~96 × 96 unit arena,
  so one cell ≈ 1.33 units; a car is ~2 cells wide). Each cell is unpainted (0) or owned by
  player 1–4.
- **Score = % of paintable cells you own.** Shown live as a stacked colour bar at the top.

### Painting
- **Driving** on the ground paints a stripe under the car (radius ≈ 1.1 cells).
- **Boosting** paints wider (radius ≈ 1.8 cells). Boost is your paint-brush upgrade, not just speed.
- **Airborne = no paint.** But **landing** splats a blob whose radius grows with airtime
  (small hop ≈ 2 cells, big ramp jump up to ≈ 5 cells). Ramps make that a choice.
- Painting over a rival's cells **takes them** (paint is always "last car over it wins").

### Trails and loops (the signature mechanic)
- When you drive **outside your own turf**, the cells you paint are also marked as your **wet trail**
  (they're yours, drawn brighter / glowing, with a pulse).
- When you drive **back into your own (dry) turf**, the trail dries and **everything enclosed by your
  turf + trail is flood-filled in your colour** (any cells not reachable from the arena edge
  without crossing your colour). Big satisfying "FILL!" burst, sound, number pop (+X%).
- **Popping:** if **any other car drives over your wet trail**, your trail **pops**: the trail cells
  become **the popper's colour** (simple and readable), you get **stunned for 1.0 s** (spin-out,
  paint splat in their colour) and lose your boost. Readable, punishing, avoidable.
- Trails dry on their own after **6 seconds** outside your turf (they become normal turf, no fill).
  Stops a car from being punished forever and keeps the loop window tight.

**Rule refinement (M1, approved by boss):** all paint a car lays on cells that are not its own dry
turf is wet; the loop closes when the car's centre is on one of its own dry cells (the stripe reaches
ahead of the car, so "paint dry while at home" never let it leave home).

### Bumping
- Shared car bump physics (`bumpScale` 1.15). A hard hit (impact > 9) on a rival **splats** the
  victim's colour off: a blob in the **attacker's** colour where the victim was, and the victim's
  trail pops (as above). Aggression is a valid strategy.

### Pickups (spawn every ~8 s, max 2 on the field, shown with a beam)
- **Paint Bomb**: instant big splat (radius 6 cells) where you grab it.
- **Mega Roller**: 5 s of extra-wide paint (radius 3 cells) and trail can't be popped.
- **Boost Can**: refills boost to 100.
(Start with these three. Keep them few and readable.)

### Match flow
- **Round = 2:00.** Last 20 s = **OVERDRIVE**: music speeds up, paint radius ×1.35, a pickup spawns
  every 4 s. Big banner.
- **Match = best of 3 rounds** (option: 1 round / best of 3 / best of 5). Arena rotates per round.
- Countdown 3-2-1-GO with cars on spawn pads (each player starts with a small painted pad, so loops
  have somewhere to close from).
- End of round: freeze, the floor camera swoops overhead, bars animate to final %, winner banner,
  confetti. End of match: results screen with per-player stats (best fill, pops, % painted,
  distance), Rematch / Menu / ← All modes.
- **Tie-break (boss decision, M2):** if the best-of ends with a tie on round wins, play a SUDDEN-DEATH
  round between the tied players (others still play and can pop).
- **Teams option (2v2)**: teammates share a colour family and a score; a teammate's turf counts as
  your turf for loop-closing. Gives replay variety. (Milestone 3.)

### Arenas (milestone 2+; ship with 3)
1. **Plaza** — open square, four ramps near the corners, a centre pillar. Learn-the-game map.
2. **Split Level** — two raised decks joined by ramps; landing splats matter.
3. **Rings** — round arena with a ring of pillars that block loops and make cut-offs.
Arena data (bounds, obstacle footprints, ramps, spawn pads, `groundHeightAt`) lives in one data
file; obstacles mark their grid cells as **unpaintable**.

## Controls (shared Rocket Rumble controls, nothing new)
| Control | Use here |
|---|---|
| Drive / Steer | Drive and paint |
| Boost | Faster **and** wider paint (the brush) |
| Jump | Hop over trails/cars; landing splats a blob |
| Hit | **Unused in v1** (reserved) |
| Heavy | Unused |

Car tuning: `TP.modeTuning({ bumpScale: 1.15, grip: 11, maxSpeed: 17, boostMax: 26, pivot: 0.35 })`
(pivot a bit higher so tight loops feel good). Gameplay may adjust within `TP.MODE_TUNABLE` only.

## Bots (must be genuinely smart)
A bot runs a small state machine, re-planned every ~0.3 s:
- **Loop**: leave own turf, drive a rectangle/arc out into unpainted or enemy floor, come back.
  Loop size scales with difficulty and with how safe it is (enemies near → shorter loops).
- **Hunt**: if a rival's wet trail is reachable before they get home, cut it.
- **Defend/Go home**: if an enemy is closing in on my wet trail, head home by the shortest path.
- **Grab**: pickups within reach.
- **Ram**: opportunistic hard bumps on rivals with trails.
- Overdrive: bots get greedier (bigger loops).
Difficulty: Easy / Normal / Hard (reaction time, loop greed, cut-off awareness, boost use).
Bots must avoid obstacles and the arena wall (look-ahead steering).

## Look and sound
- Night arena, dark glossy floor, **neon paint** that glows (emissive floor texture from a
  `DataTexture` updated from the grid each frame — only dirty rows uploaded). Wet trails pulse
  brighter. Fill = a wave that sweeps across the enclosed area (0.4 s reveal animation).
- Perimeter light walls, low fog, rim lights in the four player colours.
- Camera: one shared angled-overhead camera that frames all cars (dolly in/out), so the whole
  floor is readable; small screens zoom out more.
- Particles: paint droplets behind each car, splats on landing, fill burst, pop splash, overdrive
  sparks. Sound: wet "splat", fill "whoosh-chord", pop "plip", countdown, overdrive siren.
- Music: an original synth track `"neon-turf"` via `TP.sfx.defineTrack` (custom step function),
  with an overdrive variation (tempo up via `TP.sfx.setTempo`).

## Teaching the rules
- Menu has a 3-panel "How to play" strip (Paint · Loop to fill · Pop trails) with tiny animated
  diagrams (CSS/canvas).
- First 6 s of round 1: big pop-up hints ("Drive out and back to FILL"), and context tips the first
  time something happens ("Your trail is WET — get home before someone pops it!").

## Done means
All of the "bar" list from the boss brief: tight feel, smart bots, menu from
`TP.Rumble.loadSetup()` saving back on Start with "← All modes", on-screen teaching, start/middle/end
+ results, particles/sound/music, works from phone to desktop sizes, no console errors,
replay value (arenas, rounds, teams, bot difficulty). Plus `games/tools/mode-5-smoke.js` passing a
full bot match.

## Code architecture (the contract between roles)
Everything hangs off `window.TP.M5` (namespace). Plain classic scripts, loaded in this order by
`index.html`:

| File | Owner | What |
|---|---|---|
| `js/config.js` | Gameplay | All tunable numbers (`TP.M5.CFG`). |
| `js/arenas.js` | Gameplay | Arena data + `groundHeightAt`, obstacle footprints, spawn pads, ramps. |
| `js/paint.js` | Gameplay | `TP.M5.PaintGrid`: cells, trails, paintCircle, loop fill, pop, counts. Emits events. |
| `js/bots.js` | Gameplay | Bot brains → same control shape as `TP.Input.get(id)`. |
| `js/match.js` | Gameplay | Round/match state machine, cars, pickups, scoring, stats. |
| `js/main.js` | Gameplay | Boot, render loop, `?demo&speed=N&rounds=N&arena=N` test hooks. |
| `js/events.js` | Gameplay | Tiny event bus `TP.M5.on(name, fn)` / `TP.M5.emit(name, data)`. |
| `js/world.js` | Art & UI | Builds the 3D scene from arena data: floor mesh + paint `DataTexture`, walls, obstacles, ramps, lights, camera rig. |
| `js/vfx.js` | Art & UI | Mode particles (droplets, splats, fill wave, pop) reacting to events. |
| `js/hud.js` | Art & UI | Score bar, timer, banners, hints, round/match results screens. |
| `js/menu.js` | Art & UI | Menu, player setup (`TP.Rumble.loadSetup/saveSetup`), options, how-to-play. |
| `js/audio.js` | Art & UI | Music track + mode sounds, all driven by events. |
| `index.html` + CSS | Art & UI | Page shell (Gameplay creates the first bare version in milestone 1). |
| `games/tools/mode-5-*.js` | QC | Smoke test and other test tools. |

**Events** (Gameplay emits, Art & UI listens): `roundCountdown {round, arena}`, `roundStart`,
`overdrive`, `roundEnd {scores, winner}`, `matchEnd {standings, stats}`, `paint {player}`,
`trailStart {player}`, `fill {player, cells, pct, cx, cz}`, `pop {victim, by, x, z}`,
`splat {player, x, z, r}`, `land {player, airtime}`, `bump {a, b, impact}`, `pickupSpawn {kind, x, z}`,
`pickup {player, kind}`, `hint {text}`.
Gameplay must never touch the DOM/scene look directly (other than the milestone-1 placeholder);
Art & UI must never change rules. Test hook state: `TP.M5.match` (phase, timeLeft, round, scores,
players) readable by QC.
