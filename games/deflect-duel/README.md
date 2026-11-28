# Deflect Duel (v2 in progress on team/deflect-duel; v1 on the hub)

A rocket-car take on the arena ball-deflection genre: cars in a walled top-down arena hit
one ball, and it gets faster with every hit. The ball takes the colour of whoever hit it
last, and if it touches anyone else, they lose a life. You can also jump over the ball to
dodge it. Last car standing wins.

## How to play (v2)

Open the Rocket Rumble hub (`games/index.html`) or this folder's `index.html`. Set up 2–4 seats,
pick 3 or 5 lives, and press Start.

- **Hit** (`E`, `.`, or gamepad `X`/`RB`) strikes the ball. Hold **up** (W or stick up) to aim
  up, **down** to aim down, and steer to bend it. Every strike makes the ball faster.
- **Boost while striking** gives a **Smash**.
- **Jump twice** for a double jump. **Jump again while holding a direction** to flip; flipping
  into the ball is a powerful strike. In the air, tilt the car and boost to fly.
- Touch the ball with your **wheels** to bunt it: it pops up, stays yours, and your jump and
  flip come back.
- The ball glows in the colour of whoever struck it last, and knocks out anyone else it
  touches. Last car standing wins.

## Files

- `js/duel.js`: the rules, ball, hits, KOs, bots and every tunable number (`TP.DUEL_CFG`)
- `js/main.js`: menu, match flow, results and rematch, and the `?demo` / `?test` modes
- `js/arena.js`: the arena's look, drawn in code
- `js/hud.js`: on-screen text, the menu and the results card
- Tests (from `games/`): `node tools/deflect-duel-smoke.js 4 8 240`, `node tools/deflect-duel-rules.js`, `node tools/deflect-duel-fun.js 50 4 3`

## Still to come

Tuning after human playtests (bot difficulty, speeds, aim feel).
