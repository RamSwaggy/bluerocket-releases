# Deflect Duel (work in progress, not playable yet)

A rocket-car take on the arena ball-deflection genre: cars in a walled top-down arena hit
one ball, and it gets faster with every hit. The ball takes the colour of whoever hit it
last, and if it touches anyone else, they lose a life. You can also jump over the ball to
dodge it. Last car standing wins.

## Done so far

- `index.html`: page layout, styles, and script loading (uses the shared engine in `../shared/`)
- `js/hud.js`: on-screen text (player chips with lives, ball speed, callouts, menu/result cards)
- In the shared engine: a **Hit** button in `../shared/js/input.js` (`E`/`J`, `.`/Numpad 1,
  gamepad `X`/`RB`), hit/swing/KO sounds in `sfx.js`, and a `pivot` setting in `car.js` so
  cars can turn while nearly stopped

## Still to build

- `js/duel.js`: arena, ball physics (speeds up per hit, bounces off walls), swing-to-hit with
  aim from steering, ball ownership and KOs, hit-freeze plus camera shake, respawns and
  invulnerability, bots (intercept, swing timing, jump-dodge)
- `js/main.js`: menu (2–4 players, lives), main loop, results and rematch screen
