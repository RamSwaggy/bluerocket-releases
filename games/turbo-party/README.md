# Turbo Party

A rocket-car party board game. Up to 4 players (keyboard, gamepad, or CPU bots) roll a die,
drive around a looping board, collect coins, buy items and trophies. After every round everyone
plays a car minigame for coins. At the end, bonus trophies are handed out, and then
**most trophies wins** (coins break ties). Press `M` at any time to mute.

This is the first of four planned car-sports modes (see `../README.md`).

## How to play

**Just double-click `index.html`.** It runs straight from the file in any modern browser
(Chrome, Edge, Firefox). No install, no server, no internet needed: Three.js is bundled in
`../shared/vendor/`. Keep the whole `games` folder together, because Turbo Party loads the
shared car code from `../shared/`.

If your browser blocks local files for some reason, serve the folder instead:

```
F:
cd \path\to\bluerocket-releases\games\turbo-party
npx http-server -p 8080
```

Then open http://localhost:8080.

### Controls

| Controller | Drive | Steer | Jump / Confirm | Boost |
|---|---|---|---|---|
| Keyboard 1 | `W` / `S` | `A` / `D` | `Space` | `Left Shift` (or `F`) |
| Keyboard 2 | `↑` / `↓` | `←` / `→` | `Enter` | `Right Shift` (or `/`) |
| Gamepad | `RT` gas, `LT` reverse | Left stick / D-pad | `A` | `B` or `LB` |

On the board, Jump/Confirm makes your car hit the die. Steer left/right picks options such as "Buy" or
"Skip". Gamepads only show up after you press a button on them.

### The board

| Space | Effect |
|---|---|
| White (start) | Passing it gives a +5 lap bonus |
| Blue `+` | +3 coins |
| Red `−` | −3 coins |
| Orange arrow | Boost pad: zoom 3 more spaces |
| Teal diamond | Random event: sponsor deal, flat tyre, pit-lane swap or toll booth |
| Purple crate | Shop: buy one item (you can hold 2) |
| 🏆 Trophy (gold beam) | Drive onto or past it with 20+ coins to buy it (one per turn). It then moves at least 10 spaces further along the track. |

**The Risky Shortcut.** At the red sign, the bottom of the loop, you choose: the main road, or a
shortcut straight across the middle. The shortcut is about half the distance, but it's packed
with red and event spaces and skips the start line's lap bonus.

**Items** are used at the start of your turn, before you roll:

| Item | Price | Effect |
|---|---|---|
| 🎲 Double Dice | 5 | Roll two dice and add them |
| ⚡ Turbo Dice | 4 | Your roll is always 6–10 |
| 🧲 Pickpocket | 7 | Steal 8 coins from the richest rival |
| 🌀 Trophy Warp | 14 | Teleport to the space just before the trophy |

**Bonus trophies** (can be switched off in the menu) go to the player with the most minigame
wins, the most coins earned, and the most spaces driven. Ties all get one.

### Minigames (coins paid by place: 10 / 6 / 3 / 0)

- **Coin Rush** (30 s): grab coins. Ram rivals hard to knock 2 of their coins loose.
- **Sumo Ring** (45 s): bump everyone off a floating ring that shrinks. Last car standing wins.
- **Goal Frenzy** (60 s): 4-way car soccer. Defend the goal in your colour. +1 for scoring, −1 for conceding.
- **Bomb Tag**: bump a rival to pass the ticking bomb. Whoever holds it when it blows is out. Last car left wins.
- **King of the Hill** (40 s): score while you're the only car in the glowing zone. It moves every 8 seconds.
- **Ring Race**: 4 laps around a ring track, with boost pads. The others get 8 seconds after the winner finishes.

A minigame won't come up again within two rounds of being played.

## Testing options

Add these to the end of the address bar, for example `index.html?demo&turns=3`:

- `?demo` skips the menu and plays a match with 4 bots (2 turns by default)
- `&turns=N` sets the number of turns in demo mode
- `&speed=3` runs the game faster
- `&minigame=sumo-ring` only plays that minigame (`coin-rush`, `sumo-ring`, `goal-frenzy`,
  `bomb-tag`, `king-of-the-hill` or `ring-race`)

## Code layout

All files are plain scripts that share one global object, `TP`. ES modules weren't used
because they can't load from `file://`, and double-click-to-play matters more here.

| File | What it does |
|---|---|
| `../shared/js/util.js` | Maths helpers, the **scheduler** (`await TP.sched.wait(1)`) that game flow is written with, shared lighting |
| `../shared/js/input.js` | Keyboards and gamepads → one controller shape (`throttle`, `steer`, `boost`, `jump`, …) |
| `../shared/js/car.js` | **Shared car**: model, arcade physics, car-vs-car bumps, bot steering helpers |
| `js/arena.js` | Base class for minigames: countdown, timer, physics sub-steps, camera, results |
| `js/minigames/*.js` | One file per minigame. Each one registers itself in `TP.MINIGAMES`. |
| `js/board.js` | Board track and shortcut, spaces, shop and items, trophy, 3D die, movement, space effects |
| `js/game.js` | Match flow: turns → minigame → payouts → bonus trophies → final standings |
| `js/ui.js` | All on-screen text (HUD, cards, prompts) |
| `../shared/js/sfx.js` | Synthesised sound effects and background music (no audio files) |
| `../shared/js/fx.js` | Particle effects: sparks, coin bursts, confetti, explosions |
| `js/main.js` | Renderer, main loop, title menu |

### Adding a minigame

1. Copy `js/minigames/coin-rush.js` to a new file and change the rules.
2. Add a `<script>` tag for it in `index.html` after the other minigames.

It joins the random rotation automatically.
