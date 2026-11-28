# Boost Runner: team project file

**Read `../TEAMS.md` first** (team structure, branches, rules). This file is the Boost Runner
specifics. The boss keeps it up to date.

## What it is (pitch, not yet designed)

A rocket-car take on the side-scrolling multiplayer race genre, for 2–4 local players plus
bots. Everyone races through the same obstacle course on one shared screen. The camera
follows the leader, and anyone who falls off the edge of the screen is knocked out of the
round. Last car on screen wins the round, and first to N round wins takes the match. Cars
jump, boost, and probably use other movement tricks (wall rides, grapples or boost pads) to
take shortcuts and bump rivals off-screen. There may be pickups that mess with the cars
behind you.

Original game only: genre conventions are fine, but don't copy any existing game's names,
characters, art, music, levels or look.

## Team

| Session | Session ID | Branch |
|---|---|---|
| Boost Runner (boss) | `session_01GHNBrsk3LnQA2PCCCRSzxD` | `team/boost-runner` |
| Boost Runner · Gameplay (systems and feel) | `session_01GHNBrsNjSm8NLsDts3nDdU` | `team/boost-runner-gameplay` |
| Boost Runner · Art and UI (look and screens) | `session_01GHNBrowW48d38MRxz3z9U7` | `team/boost-runner-art` |
| Boost Runner · QC (playtest and checks) | `session_01GHNBrrLjMJWrWEvKiCzLJn` | `team/boost-runner-qc` |

Roles: message the boss at `session_01GHNBrsk3LnQA2PCCCRSzxD` when you finish a job or need something.
Above the boss: **Rocket Rumble · Director** (`session_01GHNBrs2PaPyHH8XycVBywq`), who owns `../shared/`,
the hub and the car feel. Shared changes go through the boss to the Director; roles don't edit `../shared/`.

## Design

Signed off: see **`DESIGN.md`**. The original first-job brief is kept below for history.

## First job (boss): design plan (done)

Before any code, the boss writes `DESIGN.md` here with Reece: camera and perspective (2.5D
side view of 3D cars?), how the shared car physics adapts to a side-on track, the movement
toolkit, course building (hand-made sections chained together or generated), elimination and
round rules, pickups, bots, controls, and a first playable milestone. Get Reece's sign-off,
then split it into Gameplay, Art and UI, and QC jobs.

## Who owns what

| Files (in `games/boost-runner/`) | Owner |
|---|---|
| `js/runner-car.js`, `js/course.js`, `js/view.js`, `js/round.js`, `js/bots.js`, `js/br.js`, `sim.html`, `js/README.md` | Gameplay |
| `index.html`, `js/main.js`, `js/camera.js`, `js/scene.js`, `js/hud.js`, `js/fx-br.js`, `js/music.js`, CSS | Art and UI |
| `../tools/boost-runner-*.js`, `../tools/credits-check.js`, any tests | QC |
| `DESIGN.md`, `PROJECT.md` | Boss |
| `../shared/*`, `../index.html`, `../TEAMS.md`, `../CREDITS.md` format | Director (ask through the boss) |

Course chunk **data** belongs to Gameplay. How it **looks** belongs to Art and UI, built from the same data.

## How to test

From the `games` folder:

```
node tools/credits-check.js          # free-assets rule; run before every merge -> PASS/FAIL
```

`credits-check.js` defaults to `boost-runner` (pass other mode folders as arguments). It exits 1 on
MISSING (an asset file with no `../CREDITS.md` row) or BAD-LICENCE. STALE and FLAGGED are
warnings for the boss to look at.

```
node tools/boost-runner-smoke.js 3 8 240 1     # every merge: full 4-bot match in sim.html -> PASS/FAIL
node tools/boost-runner-balance.js 500 1       # ~40 s, run in the background: seats, round length, KOs
```

Smoke extra args: `[seed] [page]`, e.g. `... 3 8 240 42 index.html` once the full game page exists.
It prints the KO order per round, and the same seed gives the same match at any speed. It also checks
that the mode's car tuning (`game.tuning`) differs from `TP.CAR_TUNING` only in `TP.MODE_TUNABLE` keys.
The balance tool reports wins per seat, round length, KOs by cause and chunk, and stuck cars.

In the browser: `sim.html?demo&seed=N` (logic only, no rendering). URL flags: `demo`, `rounds`, `speed`,
`bots`, `seed`, `chunk`, `sync`.

Any change to `../shared/` must keep Turbo Party passing: `node tools/turbo-party-smoke.js 2 8 200`.

## Current state (as of 2026-11-28)

**PAUSED 2026-11-28** (Reece's call via the Director, to save usage). See the resume notes below.

- **Merged and passing on `team/boost-runner`:**
  - **Game logic (Gameplay):** runner car, course chunks and seeded chainer, view/edge maths, rounds and match,
    bots, `window.BR` hooks, `sim.html`. A full 4-bot match is deterministic by seed. The Hit-dash costs 20 boost
    meter, and the bump clamp is in.
  - **Look (Art and UI):** `index.html` with the Night-shift test range scene, camera, HUD, cards, effects, music,
    and a menu using the hub setup and `TP.MenuNav`. `index.html?demo` plays a full match on the real logic.
  - **Tests (QC):** `credits-check.js`, `boost-runner-smoke.js` (with the stuck rule: a pile-up is a warning,
    a trap is a fail), `boost-runner-balance.js`.
- **Checks on the merged tip:** smoke PASS on `sim.html` and `index.html` (seed 1), credits-check PASS,
  car-feel tuning check PASS.
- **Balance today (500 seeds):** fair seats (23-28% each), rounds 78-87 s, but **79% of KOs are "behind"**:
  the camera squeeze decides most rounds, because bots clear about 97% of chunks. The step chunk is the deadliest (5%).

## Paused 2026-11-28: resume notes

**Unfinished, not merged:**
- `team/boost-runner-gameplay` @ `1d0a5bb` (**WIP**, JOB 3 bot/squeeze retune). Done: bot skill spread
  (easy/normal/hard), bots boost only with a reason, back off and re-jump after a bump at a step face, squeeze
  min speed 22 by 90 s. **Not tuned:** median round 117 s, 46% of rounds reach sudden death, step KO 6.3%,
  3 stuck cars (seeds 92, 241). It over-corrected: the squeeze is now too soft for the weaker bots.
  JOB 3 targets (30 seeds, 4 normal bots): round p50 60-75 s, p90 at or under 90 s, under 5% sudden death,
  at least 35% "fell" KOs, median pack vx at or under 19, seats within ±10%, every chunk ≥80% cleared by normal
  and ≥95% by hard.

**Known small issues (Art and UI):**
- The HUD panels of cars KO'd last round stay grey during the next round's countdown.
- The round-win card hasn't been checked at speed 1 on the real logic (at speed 4 it only flashes).
- The sky gradient and the "P1" edge arrow on the round-win card were flagged on the stub; recheck on the real logic.
- Commit `375636f` on the art branch has a wrong message (it's the stub-to-real-logic swap, not a sky fix).

**Next steps to playable for Reece:**
1. Gameplay finishes JOB 3 from `1d0a5bb` to the targets above. QC checks it independently with
   `node tools/boost-runner-balance.js 500 1`, plus smoke seeds 1, 2, 7, 34, 42, 92, 241.
2. Art and UI fixes the grey-panel carry-over, checks the round-win card at speed 1, and sends screenshots
   (outside the repo).
3. QC runs the smoke on `index.html` with a scripted human seat (keyboard 1) to cover a human path.
4. Boss merges, then asks the Director to move the hub card off "Coming soon", and Reece plays
   `boost-runner/index.html` (1 human + 3 bots).

## Round 2 roadmap: genre gap check (Reece, 2026-11-28)

Reece asked for the same gap check as the other modes. Reference genre: side-scrolling shared-screen multiplayer racers, where everyone races on one screen and falling off its edge is a KO. **Use genre conventions only. Never copy any game's names, characters, levels, items, art or music.** The logic, bots, look and menu all exist, but Boost Runner **isn't playable on the hub yet**, and DESIGN.md left pickups, wall rides, grapples, more themes and training out of v1.

### Gaps compared with the genre

| Area | Boost Runner now | Genre standard | Gap |
|---|---|---|---|
| Playable | "Coming soon"; JOB 3 balance WIP; small HUD and card bugs | On the hub | **Blocker** |
| Movement depth | Jump, boost, Hit-dash, boost pads | A swing or grapple to anchor points, wall jumps or rides, slides, speed carried through slopes; mastering movement *is* the game | **Big** |
| Pickups | None | Item boxes with about 6–10 items (a projectile, a dropped obstacle, a speed burst, a shield, a "freeze the leader"), weighted toward players behind | **Big**: this is the main source of chaos and comebacks |
| Courses | 6 chunk types, chained by seed, 1 theme | Dozens of hand-built tracks or many chunk types, several themes, branching routes (safe or fast) | Big |
| Squeeze and endgame | The camera squeeze decides 79% of KOs | Sudden death shrinks the screen; most KOs come from mistakes and rival play, not the timer | Medium (JOB 3) |
| Interaction | Bump and Hit-dash | Bumps, items, traps triggered by the leader, and stealing the lead | Medium |
| Modes | Rounds, first to N | Time trial with a ghost, a practice or chunk trainer, a tournament, teams | Medium |
| Presentation | Night-shift test range, effects, music | A leader crown, KO bursts, near-miss flashes, a round-end replay or podium, announcer, character cosmetics | Medium |
| Level editor | None | Common in the genre | Later |

### Plan (one builder, in this order; each phase ends merged and verified)

- **Phase 0: playable.** Finish JOB 3 from `team/boost-runner-gameplay` 1d0a5bb to its targets (in the resume notes). Fix the grey-panel carry-over and check the round-win card at speed 1. Cover a scripted keyboard-1 human path. Make every menu pass `tools/menunav-qc.js`, and add the Controls button (`data-open-controls`). Then message the Director: **"Boost Runner: ready for hub"**.
- **Phase 1: movement depth.** An original tether or grapple to anchor points (swing and release with momentum), wall jumps, and a low slide under bars. New chunks that need them, and bots that use them.
- **Phase 2: pickups.** Item boxes and about 6 items (aimed back, dropped forward, self buff, leader-only hazard), weighted toward players behind; bots use them; balance runs.
- **Phase 3: courses.** 6 → 20+ chunk types, 2 more themes, branching safe and fast routes, and shortcuts that need the new moves.
- **Phase 4: modes and presentation.** Time trial with a ghost, a chunk trainer, a leader crown, KO bursts, near-miss flashes, round-end podium, announcer callouts.
- **Phase 5: later.** A tournament, teams, and a simple level editor.

Each phase: smoke + balance + chunk tests pass, `credits-check` passes, screenshots, then message the Director "Boost Runner phase N: ready to merge". Shared changes go through the Director.

**Round 2 staffing (2026-11-28):** one builder session (Rocket Rumble · Boost Runner · Builder) does gameplay, art, UI and
QC, works on `team/boost-runner` only, and reports to the Director (`session_01GHNBrpeLU9EhxDWu9Qk78E`) at the end
of each phase. `team/boost-runner-gameplay` 1d0a5bb and the release branch (`claude/eager-tesla-vdhyd9`) are merged in.

## Decisions (from Reece)

- 2026-11-27: One of four rocket-car games, alongside Turbo Party, Deflect Duel and the other
  new mode. Browser game (Three.js), local multiplayer plus bots, sharing `../shared/`.
- 2026-11-27: Set up this team, using RocketBonk's structure.
- 2026-11-27: This is now a mode of **Rocket Rumble** (one umbrella game). It uses the shared car
  feel (only `TP.MODE_TUNABLE` settings may change, via `TP.modeTuning`), the shared controls,
  and the hub's saved player setup (`TP.Rumble.loadSetup()`), with a "← All modes" link back.
  The Director owns `shared/` and the hub.
- 2026-11-27 (standing rule, via the Director): **free assets and tools only.** Every third-party
  asset gets a line in `../CREDITS.md` (path, source URL, author, licence, credit text); no line,
  no merge. Code-generated models, sounds and music are exempt. See `../TEAMS.md`.
- 2026-11-27: **Design approved** by Reece as `DESIGN.md`: wall rides and grapple later, no pickups in
  v1, first to 3, strong bumps (`bumpScale` 1.3), "Night-shift test range" theme, tilt-and-boost as
  the core air trick. Controls (Director): drive = Steer (D/A, →/←, stick X) plus RT/LT on pads,
  air tilt = `ctrl.pitch` (W/S, ↑/↓, stick Y). The Director also approved the double jump, Hit-dash,
  bad-landing tumble and 2D bumps.
- 2026-11-27: Reece: "Approved, and the Director speaks for me." From now on, the Director's
  sign-offs count as Reece's.
- 2026-11-28 (Director, for Reece): the **Hit-dash costs 20 boost meter** (`CAR_RULES.dashBoostCost`), so it's a
  tool, not free speed (dash spam measured 16.8 vs 17 on gas).
- 2026-11-28 (Director, for Reece): **bumps keep `bumpScale` 1.3 (strong shove), but each bump is clamped so
  the pair's combined forward speed can't increase.** The victim is shoved hard and the hitter pays for it.
  This keeps "strong bumps" without pushing cars past the shared speed ceiling.
