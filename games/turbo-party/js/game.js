/* =====================================================================
   game.js — the overall flow of one match.

     for each turn:
        every player takes a board turn (item → roll → move → land)
        everyone plays one minigame → coins paid out by finishing place
     after the last turn: bonus trophies are handed out, then
     most trophies wins (coins break ties)

   `view` is whatever is on screen right now — the board or a minigame
   arena. main.js renders `game.view.scene` with `game.view.camera`.
   ===================================================================== */
(function () {
  "use strict";
  const { pick } = TP.util;

  // Coins paid for 1st, 2nd, 3rd, 4th in a minigame.
  const PAYOUT = [10, 6, 3, 0];
  // Coins each player gets when the WHOLE field ties (see Game.payouts).
  const ALL_TIE_PAYOUT = 3;
  const PLACE_NAMES = ["1st", "2nd", "3rd", "4th"];

  // The "Final 3 turns" twist (see Game.startFinalStretch).
  const FINAL_STRETCH = 3;            // how many turns it lasts
  const FINAL_STRETCH_MIN_TURNS = 5;  // only in matches at least this long
  const FINAL_CATCHUP = 10;           // coins for last place when it starts

  // Music speed per phase (beats per minute).
  const BOARD_BPM = 112;
  const MINIGAME_BPM = 138;

  /* End-of-game bonus trophies. Each goes to whoever has the highest
     stat; ties are broken on coins, and a tie on coins too means no
     award (see Game.bonusWinner). Skipped if nobody scored anything. */
  const BONUSES = [
    { stat: "minigameWins", title: "Minigame Ace", desc: "Most minigame wins" },
    { stat: "coinsEarned", title: "Coin Collector", desc: "Most coins earned" },
    { stat: "spacesMoved", title: "Road Tripper", desc: "Most spaces driven" },
  ];

  class Game {
    /* Turn a minigame ranking (groups of tied player indices, best first,
       e.g. [[2], [0, 1], [3]]) into who gets what. Director's ruling:
         • EVERYONE tied (e.g. 0-0-0-0, nobody did anything): each player
           gets ALL_TIE_PAYOUT coins and nobody is credited with a win —
           otherwise a dead round would hand all four a "Minigame Ace" win.
         • Partial tie: tied players all get the higher place's payout
           (two players tied for 2nd both get 2nd-place coins, and the next
           player is 4th). A tie for 1st counts as a win for each of them.
       Returns [{ index, place, gain, win }] in ranking order. Kept as a
       pure function (no side effects) so it's easy to test on its own. */
    static payouts(ranking) {
      const out = [];
      if (ranking.length === 1 && ranking[0].length > 1) {
        for (const i of ranking[0]) out.push({ index: i, place: 0, gain: ALL_TIE_PAYOUT, win: false });
        return out;
      }
      let place = 0; // 0-based place of the current group
      for (const group of ranking) {
        for (const i of group) out.push({ index: i, place, gain: PAYOUT[place], win: place === 0 });
        place += group.length; // ties use up the places they share
      }
      return out;
    }

    /* Who gets one end-of-game bonus trophy. Director's ruling:
         • the player with the highest `stat` wins it;
         • if several share the highest stat, the one with the most coins
           (right now, at the end of the match) wins it;
         • if they're STILL tied on coins, nobody gets this bonus;
         • if the best stat is 0 (nobody did the thing), nobody gets it.
       `players` is the usual player list (only .index, .coins and
       .stats are read). Returns { winner, best, tied }:
         winner — the winning player's index, or null for no award
         best   — the highest stat value
         tied   — indices of everyone who shared that highest stat
       Pure function (no side effects), so it can be tested on its own. */
    static bonusWinner(players, stat) {
      const best = Math.max(...players.map((p) => p.stats[stat]));
      const tied = players.filter((p) => p.stats[stat] === best).map((p) => p.index);
      if (best <= 0) return { winner: null, best, tied };
      if (tied.length === 1) return { winner: tied[0], best, tied };
      // Tie-break on coins.
      const coinsOf = (i) => players.find((p) => p.index === i).coins;
      const most = Math.max(...tied.map(coinsOf));
      const rich = tied.filter((i) => coinsOf(i) === most);
      return { winner: rich.length === 1 ? rich[0] : null, best, tied };
    }

    /* config = { turns, bonuses, slots: [{ name, controller }, ×4] } */
    constructor(config) {
      this.turns = config.turns;
      this.bonuses = config.bonuses !== false;
      this.players = config.slots.map((s, i) => ({
        index: i,
        name: s.name || TP.DEFAULT_NAMES[i],
        controller: s.controller,
        color: TP.PLAYER_COLORS[i],
        css: TP.PLAYER_CSS[i],
        coins: 10,
        trophies: 0,
        space: 0,
        items: [],   // item ids from TP.ITEMS (max 2)
        stats: { minigameWins: 0, coinsEarned: 0, spacesMoved: 0, redSpaces: 0 },
      }));
      this.humans = this.players.filter((p) => p.controller !== "bot");
      this.board = new TP.Board(this);
      this.view = this.board;
      this.lastMinigames = []; // recently played ids, to avoid repeats
    }

    update(dt) {
      this.view.update(dt);
    }

    /* Wait until any human presses confirm (or the card is clicked), or
       until `timeout` seconds pass. With no humans, uses `botTimeout`. */
    waitForAnyone(timeout, botTimeout = 2.5) {
      const limit = this.humans.length ? timeout : botTimeout;
      let t = 0;
      let clicked = false;
      const card = document.getElementById("overlay");
      const onClick = () => { clicked = true; };
      card.addEventListener("click", onClick);
      return TP.sched.run((dt) => {
        t += dt;
        const pressed = this.humans.some((p) => TP.Input.get(p.controller).confirmPressed);
        const done = pressed || clicked || t >= limit;
        if (done) card.removeEventListener("click", onClick);
        return done;
      });
    }

    confirmHint() {
      if (!this.humans.length) return "";
      const keys = [...new Set(this.humans.map((p) => TP.keyNames(p.controller).confirm))];
      return `Press ${keys.map((k) => `<kbd>${k}</kbd>`).join(" / ")} or click to continue`;
    }

    /* ------------------------------------------------------------------
       The whole match
       ------------------------------------------------------------------ */
    async run() {
      const ui = TP.UI;
      ui.showPlayers(true);
      ui.setPlayers(this.players);
      TP.sfx.setTempo(BOARD_BPM);
      TP.sfx.music(true);

      // Intro: swoop around the board, then settle on the overview.
      this.board.orbit = true;
      ui.center("TURBO PARTY", `Most trophies after ${this.turns} turns wins · trophies cost ${TP.TROPHY_COST} coins`, "#ffcc33");
      await TP.sched.wait(2.6);
      ui.center("");
      this.board.orbit = false;
      this.board.focusOverview();
      ui.toast("Tip: the red sign marks a risky shortcut across the middle!", 2.6);
      await TP.sched.wait(1.6);

      for (let turn = 1; turn <= this.turns; turn++) {
        ui.turnLabel(`TURN ${turn} / ${this.turns}`);
        // The sky drifts from afternoon (turn 1) to night (last turn).
        this.shiftSky(this.turns > 1 ? (turn - 1) / (this.turns - 1) : 0);
        if (turn === this.turns - FINAL_STRETCH + 1 && this.turns >= FINAL_STRETCH_MIN_TURNS) {
          await this.startFinalStretch();
        } else if (turn === this.turns) {
          ui.banner("FINAL TURN!", "Last chance for trophies", "#f87171", 1.2);
          await TP.sched.wait(1.6);
        }
        for (const p of this.players) await this.board.takeTurn(p);

        this.board.focusOverview();
        await TP.sched.wait(0.6);
        // The board's moving parts: Spark Cannon countdown, swing gate.
        await this.board.roundEnd();
        await this.minigameRound();
      }
      await this.finale();
    }

    /* Ease the sky from its current time of day to `k` over 3 seconds
       (doesn't hold up the game). */
    shiftSky(k) {
      const from = this.board.timeOfDay || 0;
      TP.sched.tween(3, (u) => this.board.setTimeOfDay(from + (k - from) * u));
    }

    /* ------------------------------------------------------------------
       The "Final 3 turns" twist (genre staple, our own rules):
         • a banner and a crowd cheer announce it;
         • from now on blue spaces give +6 and red spaces take −6
           (board.finalStretch);
         • CATCH-UP BONUS: whoever is in last place right now (fewest
           trophies, then fewest coins; ties all get it) receives
           FINAL_CATCHUP coins, so nobody is out of it going into the end.
       Only in matches of FINAL_STRETCH_MIN_TURNS turns or more, so short
       games aren't all twist.
       ------------------------------------------------------------------ */
    async startFinalStretch() {
      const ui = TP.UI;
      const board = this.board;
      board.focusOverview();
      ui.banner(`FINAL ${FINAL_STRETCH} TURNS!`, "Blue and red spaces now count double", "#f87171", 1.6);
      TP.partySfx.play("drumroll", 1.0);
      board.crowdCheer(2);
      await TP.sched.wait(2.2);
      board.finalStretch = true;
      const places = TP.UI.places(this.players);
      const worst = Math.max(...places);
      const last = this.players.filter((p, i) => places[i] === worst);
      if (last.length < this.players.length) {
        for (const p of last) {
          board.punchIn(p, 1.4);
          ui.banner("CATCH-UP BONUS", `${p.name} is in last place: +${FINAL_CATCHUP} coins!`, p.css, 1.2);
          await TP.sched.wait(0.6);
          board.addCoins(p, FINAL_CATCHUP, `Catch-up bonus! +${FINAL_CATCHUP} coins`);
          await TP.sched.wait(1.4);
        }
        board.focusOverview();
      }
    }

    /* ------------------------------------------------------------------
       One minigame: intro card → play → payout card
       ------------------------------------------------------------------ */
    async minigameRound() {
      const ui = TP.UI;
      // Pick a minigame not played in the last couple of rounds.
      const recent = this.lastMinigames.slice(-Math.min(2, TP.MINIGAMES.length - 1));
      const choices = TP.MINIGAMES.filter((m) => !recent.includes(m.id));
      const def = pick(choices.length ? choices : TP.MINIGAMES);
      this.lastMinigames.push(def.id);

      ui.setPlayers(this.players);
      TP.UI.banner("MINIGAME TIME!", "", "#ffcc33", 0.9);
      await TP.sched.wait(1.1);
      await this.introCard(def);

      // Swap the screen over to the arena and play it.
      TP.sfx.setTempo(MINIGAME_BPM);
      const arena = new def.cls(this);
      this.view = arena;
      const ranking = await arena.run();
      this.view = this.board;
      arena.dispose();
      TP.sfx.setTempo(BOARD_BPM);

      // Pay out by place (rules in Game.payouts below).
      const rows = [];
      for (const r of Game.payouts(ranking)) {
        const p = this.players[r.index];
        p.coins += r.gain;
        p.stats.coinsEarned += r.gain;
        if (r.win) p.stats.minigameWins++;
        rows.push({ p, place: r.place, gain: r.gain });
      }

      ui.setPlayers(this.players);
      // Results: one row per player sliding in, best first, with a medal,
      // the coins won and a one-word reaction. The winner's row glows.
      const allTie = ranking.length === 1;
      const MEDALS = ["🥇", "🥈", "🥉", "  "];
      const MOODS = ["Champion!", "So close!", "Not bad", "Ouch…"];
      ui.card(`
        <p class="muted" style="margin:0">RESULTS</p>
        <h2>${ui.esc(def.name)}</h2>
        ${allTie ? `<p>Everyone tied! ${ALL_TIE_PAYOUT} coins each, and no winner.</p>` : ""}
        ${rows.map((r, n) => `
          <div class="result-row anim ${r.place === 0 && !allTie ? "first" : ""}" style="border-color:${r.p.css};animation-delay:${n * 0.15}s">
            <span class="medal">${allTie ? "🤝" : MEDALS[r.place]}</span>
            <span class="place">${PLACE_NAMES[r.place]}</span>
            <span class="who" style="color:${r.p.css}">${ui.esc(r.p.name)}
              <span class="muted" style="font-size:13px;font-weight:600">${allTie ? "" : MOODS[r.place]}</span></span>
            <span class="gain">${r.gain ? "+" + r.gain + " 🪙" : "—"}</span>
          </div>`).join("")}
        <p class="muted" style="margin-top:16px">${this.confirmHint() || "Back to the board…"}</p>`);
      if (rows[0]) TP.sfx.play("coin");
      await this.waitForAnyone(8, 2.5);
      ui.hideCard();
    }

    /* ------------------------------------------------------------------
       Minigame intro card with a ready check.
       Shows the format (free-for-all, 1 vs 3, ...), the kind of game, the
       length, ONE line of rules in big type, the longer description, each
       human's controls, and a row of "ready" chips, one per player.
       Humans press their confirm button to ready up (or anyone clicks the
       card to ready everyone); bots ready up by themselves after a short,
       random pause, like players nodding along. When every chip is lit,
       the game starts (the arena then does its own 3-2-1 countdown).
       Nobody is kept waiting forever: after 15 s (2.5 s with no humans)
       everyone still unready is readied automatically.
       ------------------------------------------------------------------ */
    async introCard(def) {
      const ui = TP.UI;
      const proto = def.cls && def.cls.DURATION;
      const length = def.length || (proto ? proto + " s" : "");
      const keys = [...new Set(this.humans.map((p) => TP.keyNames(p.controller).confirm))];
      const hint = this.humans.length
        ? `Press ${keys.map((k) => `<kbd>${k}</kbd>`).join(" / ")} when you're ready to continue (or click)`
        : "Bots are getting ready…";
      const card = ui.card(`
        <p class="muted" style="margin:0">MINIGAME · ROUND ${this.lastMinigames.length}</p>
        <h2>${ui.esc(def.name)}</h2>
        <div>
          <span class="mg-tag fmt">${ui.esc((def.format || "Free-for-all").toUpperCase())}</span>
          ${def.kind ? `<span class="mg-tag">${ui.esc(def.kind.toUpperCase())}</span>` : ""}
          ${length ? `<span class="mg-tag">⏱ ${ui.esc(length)}</span>` : ""}
        </div>
        ${this.teamLine(def)}
        <p class="mg-rule">${ui.esc(def.rule || def.blurb)}</p>
        <p>${ui.esc(def.blurb)}</p>
        ${this.controlsTable()}
        <div class="ready-row">${this.players.map((p) => `
          <div class="ready-chip" id="ready-${p.index}" style="--pc:${p.css}">
            <span style="color:${p.css}">${ui.esc(p.name)}</span><span class="st">…</span>
          </div>`).join("")}</div>
        <p class="muted" style="margin-top:14px">${hint}</p>`);

      const ready = this.players.map(() => false);
      // Each bot "nods" after its own random delay.
      const botAt = this.players.map(() => TP.util.rand(0.3, this.humans.length ? 2.2 : 1.6));
      const limit = this.humans.length ? 15 : 2.5;
      let clicked = false;
      const overlay = document.getElementById("overlay");
      const onClick = () => { clicked = true; };
      overlay.addEventListener("click", onClick);
      const mark = (i) => {
        if (ready[i]) return;
        ready[i] = true;
        const chip = card.querySelector("#ready-" + i);
        if (chip) { chip.classList.add("on"); chip.querySelector(".st").textContent = "READY!"; }
        TP.partySfx.play("ready");
      };
      let t = 0;
      await TP.sched.run((dt) => {
        t += dt;
        this.players.forEach((p, i) => {
          if (p.controller === "bot") { if (t >= botAt[i]) mark(i); }
          else if (TP.Input.get(p.controller).confirmPressed) mark(i);
        });
        if (clicked || t >= limit) this.players.forEach((p, i) => mark(i));
        return ready.every(Boolean);
      });
      overlay.removeEventListener("click", onClick);
      await TP.sched.wait(0.5); // a beat to see every chip lit
      ui.hideCard();
    }

    // For team minigames (1 vs 3, 2 vs 2, duels), who's against whom.
    // Free-for-alls have no teams and show nothing.
    teamLine(def) {
      if (!def.teams) return "";
      const teams = def.teams(this);
      if (!teams) return "";
      const ui = TP.UI;
      return `<div class="team-line">${teams.map((team) => team.map((i) => {
        const p = this.players[i];
        return `<span style="color:${p.css}">${ui.esc(p.name)}</span>`;
      }).join(" + ")).join(`<span class="vs">VS</span>`)}</div>`;
    }

    // Controls summary for each human, shown on minigame intro cards.
    controlsTable() {
      if (!this.humans.length) return `<p class="muted">All players are bots this game.</p>`;
      return `<table class="controls-table">${this.humans.map((p) => {
        const k = TP.keyNames(p.controller);
        return `<tr><td style="color:${p.css}">${TP.UI.esc(p.name)}</td>
          <td>drive <kbd>${k.drive}</kbd> · steer <kbd>${k.steer}</kbd> · jump <kbd>${k.confirm}</kbd> · boost <kbd>${k.boost}</kbd></td></tr>`;
      }).join("")}</table>`;
    }

    /* ------------------------------------------------------------------
       End of match: bonus trophies, then the winner
       ------------------------------------------------------------------ */
    async finale() {
      const ui = TP.UI;
      ui.turnLabel("");
      this.board.focusOverview();
      ui.banner("THE PARTY'S OVER!", "Time for the awards", "#ffcc33", 1.3);
      await TP.sched.wait(1.8);

      if (this.bonuses) {
        for (const b of BONUSES) await this.revealBonus(b);
      }

      // Rank: trophies first, coins break ties.
      const ranked = this.players.slice().sort((a, b) => b.trophies - a.trophies || b.coins - a.coins);
      const winner = ranked[0];
      const tie = ranked[1] && ranked[1].trophies === winner.trophies && ranked[1].coins === winner.coins;

      // Podium: the cars line up on a winners' stand next to the board
      // (see Board.showPodium), with confetti and a fanfare.
      ui.setPlayers(this.players);
      this.board.showPodium(ranked);
      TP.sfx.play("trophy");
      TP.partySfx.play("fanfare");
      TP.partySfx.play("cheer");
      ui.banner(tie ? "IT'S A TIE!" : `${winner.name} WINS!`, tie ? "Shared glory" : `🏆 ${winner.trophies} · 🪙 ${winner.coins}`, tie ? "#ffcc33" : winner.css, 2.0);
      await TP.sched.wait(3.2);

      const card = ui.card(`
        <p class="muted" style="margin:0">FINAL STANDINGS</p>
        <h2>${tie ? "It's a tie!" : `🏆 ${ui.esc(winner.name)} wins!`}</h2>
        ${ranked.map((p, i) => `
          <div class="result-row anim ${i === 0 ? "first" : ""}" style="border-color:${p.css};animation-delay:${i * 0.15}s">
            <span class="medal">${["🥇", "🥈", "🥉", "  "][i]}</span>
            <span class="place">${PLACE_NAMES[i]}</span>
            <span class="who" style="color:${p.css}">${ui.esc(p.name)}</span>
            <span>🏆 ${p.trophies} &nbsp; 🪙 ${p.coins}</span>
          </div>
          <div class="muted" style="font-size:13px;margin:-2px 0 6px 18px">
            ${p.stats.minigameWins} minigame wins · ${p.stats.coinsEarned} coins earned · ${p.stats.spacesMoved} spaces driven
          </div>`).join("")}
        <div class="row" style="margin-top:18px">
          <button class="btn" id="again" data-nav-primary>Play again</button>
          <a class="btn" style="background:#26305a;color:var(--text);text-decoration:none" href="${TP.Rumble.HUB_URL}" data-nav-back>← All modes</a>
        </div>`);
      card.querySelector("#again").addEventListener("click", () => location.reload());
    }

    /* One bonus trophy, revealed like an awards show:
         1. a card names the award and lists everyone's number for it;
         2. a drumroll plays while the name slot flickers through the
            players' names;
         3. the name lands on the winner (their colour), the trophy is
            added, and their car gets a close-up, confetti and a hop.
       Ties use the Director's rule (Game.bonusWinner): tied on the stat
       and on coins → nobody gets it, and the card says so.
       Nobody did the thing at all (best is 0) → skipped silently. */
    async revealBonus(b) {
      const ui = TP.UI;
      const r = Game.bonusWinner(this.players, b.stat);
      if (r.best <= 0) return;
      const fast = !this.humans.length; // bot-only matches move along quicker
      const card = ui.card(`
        <div class="bonus-card">
          <p class="muted" style="margin:0">BONUS TROPHY</p>
          <div class="big">🏆</div>
          <h2>${ui.esc(b.title)}</h2>
          <p>${ui.esc(b.desc)}</p>
          <div class="who roll" id="bonus-who">?</div>
          <div class="stat-list">${this.players.map((p) => `<span style="color:${p.css}">${ui.esc(p.name)}: ${p.stats[b.stat]}</span>`).join("")}</div>
        </div>`);
      const who = card.querySelector("#bonus-who");
      const roll = fast ? 0.9 : 1.6;
      TP.partySfx.play("drumroll", roll);
      // Flicker through the names, slowing down as the roll ends.
      let t = 0, next = 0, n = 0;
      await TP.sched.run((dt) => {
        t += dt;
        if (t >= next) {
          const p = this.players[n++ % this.players.length];
          who.textContent = p.name;
          who.style.color = p.css;
          next = t + 0.06 + (t / roll) * 0.18;
        }
        return t >= roll;
      });
      who.classList.remove("roll");
      who.classList.add("final");
      if (r.winner === null) {
        // Tied on the stat AND on coins: nobody gets it, but say so, so
        // players aren't left wondering where the trophy went.
        const names = r.tied.map((i) => this.players[i].name).join(" & ");
        who.textContent = "No award";
        who.style.color = "#9aa3b8";
        card.querySelector("p").insertAdjacentHTML("afterend",
          `<p>${ui.esc(names)} tied (${r.best}) with equal coins.</p>`);
        TP.sfx.play("lose");
        await TP.sched.wait(fast ? 1.4 : 2.4);
        ui.hideCard();
        return;
      }
      const p = this.players[r.winner];
      p.trophies++;
      who.textContent = p.name;
      who.style.color = p.css;
      if (r.tied.length > 1) {
        who.insertAdjacentHTML("afterend", `<p>Tied on ${r.best}, won on coins</p>`);
      }
      TP.sfx.play("trophy");
      TP.partySfx.play("cheer");
      ui.setPlayers(this.players);
      await TP.sched.wait(fast ? 0.8 : 1.3);
      ui.hideCard();
      // Close-up on the winner's car on the board.
      this.board.punchIn(p, 1.3);
      this.board.fx.confetti(this.board.tokens[p.index].pos, { count: 40 });
      await this.board.cheerHop(p, 2, 1, 0.7);
      await TP.sched.wait(fast ? 0.4 : 0.8);
      this.board.focusOverview();
    }
  }

  TP.Game = Game;
})();
