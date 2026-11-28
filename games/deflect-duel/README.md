# Deflect Duel (first playable)

A rocket-car take on the arena ball-deflection genre: cars in a walled top-down arena hit
one ball, and it gets faster with every hit. The ball takes the colour of whoever hit it
last, and if it touches anyone else, they lose a life. You can also jump over the ball to
dodge it. Last car standing wins.

## How to play

Open the Rocket Rumble hub (`games/index.html`) and pick Deflect Duel, or open `index.html` here
directly. Set each seat to a bot, Keyboard 1, Keyboard 2 or a gamepad, pick 3 or 5 lives, and press
Start. **Hit** (`E`, `.`, or gamepad `X`/`RB`) swings at the ball. Steer while you swing to aim,
and hit while boosting for a **Smash**. **Jump** dodges a ball. The last car standing wins.

## Files

- `js/duel.js`: the rules, ball, hits, KOs, bots and every tunable number (`TP.DUEL_CFG`)
- `js/main.js`: menu, match flow, results and rematch, and the `?demo` / `?test` modes
- `js/arena.js`: the arena's look, drawn in code
- `js/hud.js`: on-screen text, the menu and the results card
- Test: `node tools/deflect-duel-smoke.js 4 8 180` (from `games/`)

## Still to come

The ball glow and trail, swing ring, hit and KO effects, camera shake, and tuning after playtests.
