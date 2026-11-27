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
  const PLACE_NAMES = ["1st", "2nd", "3rd", "4th"];

  // Music speed per phase (beats per minute).
  const BOARD_BPM = 112;
  const MINIGAME_BPM = 138;

  /* End-of-game bonus trophies. Each goes to whoever has the highest
     stat (ties all get one). Skipped if nobody scored anything. */
  const BONUSES = [
    { stat: "minigameWins", title: "Minigame Ace", desc: "Most minigame wins" },
    { stat: "coinsEarned", title: "Coin Collector", desc: "Most coins earned" },
    { stat: "spacesMoved", title: "Road Tripper", desc: "Most spaces driven" },
  ];

  class Game {
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
        if (turn === this.turns) {
          ui.center("FINAL TURN!", "", "#f87171");
          await TP.sched.wait(1.4);
          ui.center("");
        }
        for (const p of this.players) await this.board.takeTurn(p);

        this.board.focusOverview();
        await TP.sched.wait(0.6);
        await this.minigameRound();
      }
      await this.finale();
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
      ui.card(`
        <p class="muted" style="margin:0">MINIGAME</p>
        <h2>${ui.esc(def.name)}</h2>
        <p>${ui.esc(def.blurb)}</p>
        ${this.controlsTable()}
        <p class="muted" style="margin-top:16px">${this.confirmHint() || "Starting…"}</p>`);
      await this.waitForAnyone(12, 2.5);
      ui.hideCard();

      // Swap the screen over to the arena and play it.
      TP.sfx.setTempo(MINIGAME_BPM);
      const arena = new def.cls(this);
      this.view = arena;
      const ranking = await arena.run();
      this.view = this.board;
      arena.dispose();
      TP.sfx.setTempo(BOARD_BPM);

      // Pay out by place. Tied players all get the higher place's reward.
      const rows = [];
      let place = 0;
      for (const group of ranking) {
        for (const i of group) {
          const p = this.players[i];
          const gain = PAYOUT[place];
          p.coins += gain;
          p.stats.coinsEarned += gain;
          if (place === 0) p.stats.minigameWins++;
          rows.push({ p, place, gain });
        }
        place += group.length;
      }

      ui.setPlayers(this.players);
      ui.card(`
        <p class="muted" style="margin:0">RESULTS</p>
        <h2>${ui.esc(def.name)}</h2>
        ${rows.map((r) => `
          <div class="result-row" style="border-color:${r.p.css}">
            <span class="place">${PLACE_NAMES[r.place]}</span>
            <span class="who" style="color:${r.p.css}">${ui.esc(r.p.name)}</span>
            <span class="gain">${r.gain ? "+" + r.gain + " 🪙" : "—"}</span>
          </div>`).join("")}
        <p class="muted" style="margin-top:16px">${this.confirmHint() || "Back to the board…"}</p>`);
      if (rows[0]) TP.sfx.play("coin");
      await this.waitForAnyone(8, 2.5);
      ui.hideCard();
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

      if (this.bonuses) {
        ui.center("BONUS TROPHIES", "", "#ffcc33");
        await TP.sched.wait(1.8);
        for (const b of BONUSES) {
          const best = Math.max(...this.players.map((p) => p.stats[b.stat]));
          if (best <= 0) continue;
          const winners = this.players.filter((p) => p.stats[b.stat] === best);
          winners.forEach((p) => {
            p.trophies++;
            this.board.fx.confetti(this.board.tokens[p.index].pos, { count: 30 });
          });
          TP.sfx.play("trophy");
          ui.center(`🏆 ${b.title}`, `${winners.map((p) => p.name).join(" & ")} — ${b.desc} (${best})`, winners[0].css);
          ui.setPlayers(this.players);
          await TP.sched.wait(2.6);
        }
        ui.center("");
      }

      // Rank: trophies first, coins break ties.
      const ranked = this.players.slice().sort((a, b) => b.trophies - a.trophies || b.coins - a.coins);
      const winner = ranked[0];
      const tie = ranked[1] && ranked[1].trophies === winner.trophies && ranked[1].coins === winner.coins;

      TP.sfx.play("trophy");
      ui.center(tie ? "IT'S A TIE!" : `${winner.name} WINS!`, "", tie ? "#ffcc33" : winner.css);
      this.board.focusOn(winner);
      this.board.fx.confetti(this.board.tokens[winner.index].pos, { count: 90 });
      await TP.sched.wait(2.5);
      ui.center("");

      const card = ui.card(`
        <p class="muted" style="margin:0">FINAL STANDINGS</p>
        <h2>${tie ? "It's a tie!" : `🏆 ${ui.esc(winner.name)} wins!`}</h2>
        ${ranked.map((p, i) => `
          <div class="result-row" style="border-color:${p.css}">
            <span class="place">${PLACE_NAMES[i]}</span>
            <span class="who" style="color:${p.css}">${ui.esc(p.name)}</span>
            <span>🏆 ${p.trophies} &nbsp; 🪙 ${p.coins}</span>
          </div>
          <div class="muted" style="font-size:13px;margin:-2px 0 6px 18px">
            ${p.stats.minigameWins} minigame wins · ${p.stats.coinsEarned} coins earned · ${p.stats.spacesMoved} spaces driven
          </div>`).join("")}
        <div class="row" style="margin-top:18px">
          <button class="btn" id="again">Play again</button>
          <a class="btn" style="background:#26305a;color:var(--text);text-decoration:none" href="${TP.Rumble.HUB_URL}">← All modes</a>
        </div>`);
      card.querySelector("#again").addEventListener("click", () => location.reload());
    }
  }

  TP.Game = Game;
})();
