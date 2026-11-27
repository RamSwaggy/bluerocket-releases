/* =====================================================================
   game.js — the overall flow of one match.

     for each turn:
        every player takes a board turn (roll, move, land)
        everyone plays one minigame → coins paid out by finishing place
     after the last turn: most trophies wins (coins break ties)

   `view` is whatever is on screen right now — the board or a minigame
   arena. main.js renders `game.view.scene` with `game.view.camera`.
   ===================================================================== */
(function () {
  "use strict";
  const { pick } = TP.util;

  // Coins paid for 1st, 2nd, 3rd, 4th in a minigame.
  const PAYOUT = [10, 6, 3, 0];
  const PLACE_NAMES = ["1st", "2nd", "3rd", "4th"];

  class Game {
    /* config = { turns, slots: [{ name, controller }, ×4] } */
    constructor(config) {
      this.turns = config.turns;
      this.players = config.slots.map((s, i) => ({
        index: i,
        name: s.name || TP.DEFAULT_NAMES[i],
        controller: s.controller,
        color: TP.PLAYER_COLORS[i],
        css: TP.PLAYER_CSS[i],
        coins: 10,
        trophies: 0,
        space: 0,
      }));
      this.humans = this.players.filter((p) => p.controller !== "bot");
      this.board = new TP.Board(this);
      this.view = this.board;
      this.lastMinigame = null;
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
      this.board.focusOverview();

      ui.center("TURBO PARTY", `Most trophies after ${this.turns} turns wins · trophies cost ${TP.TROPHY_COST} coins`, "#ffcc33");
      await TP.sched.wait(2.6);
      ui.center("");

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
      // Pick a minigame, avoiding an immediate repeat.
      const choices = TP.MINIGAMES.filter((m) => m.id !== this.lastMinigame) ;
      const def = pick(choices.length ? choices : TP.MINIGAMES);
      this.lastMinigame = def.id;

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
      const arena = new def.cls(this);
      this.view = arena;
      const ranking = await arena.run();
      this.view = this.board;
      arena.dispose();

      // Pay out by place. Tied players all get the higher place's reward.
      const rows = [];
      let place = 0;
      for (const group of ranking) {
        for (const i of group) {
          const p = this.players[i];
          const gain = PAYOUT[place];
          p.coins += gain;
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
       End of match
       ------------------------------------------------------------------ */
    async finale() {
      const ui = TP.UI;
      ui.turnLabel("");
      this.board.focusOverview();
      // Rank: trophies first, coins break ties.
      const ranked = this.players.slice().sort((a, b) => b.trophies - a.trophies || b.coins - a.coins);
      const winner = ranked[0];
      const tie = ranked[1] && ranked[1].trophies === winner.trophies && ranked[1].coins === winner.coins;

      TP.sfx.play("trophy");
      ui.center(tie ? "IT'S A TIE!" : `${winner.name} WINS!`, "", tie ? "#ffcc33" : winner.css);
      this.board.focusOn(winner);
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
          </div>`).join("")}
        <div class="row" style="margin-top:18px"><button class="btn" id="again">Play again</button></div>`);
      card.querySelector("#again").addEventListener("click", () => location.reload());
    }
  }

  TP.Game = Game;
})();
