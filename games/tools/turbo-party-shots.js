/* =====================================================================
   turbo-party-shots.js — takes screenshots of Turbo Party's key moments
   so the look can be checked without a person watching a whole match.

   Usage (from the games folder):
     node tools/turbo-party-shots.js <outDir> [scene ...]
     node tools/turbo-party-shots.js /tmp/shots            # every scene
     node tools/turbo-party-shots.js /tmp/shots board podium

   Scenes:
     menu      the title / setup menu
     board     a bot match a few seconds in (turn banner, HUD)
     hop       mid-move on the board (car hopping between spaces)
     intro     a minigame intro card with the ready check
     minigame  each minigame a few seconds in (one picture per minigame)
     finish    the finish-line reactions at the end of a minigame
     dusk      the whole board at sunset (sky, stands, floodlights)
     cannon    the Spark Cannon's fireball in flight
     bonus     a bonus-trophy reveal card
     podium    the end-ceremony podium

   Each picture is saved as <outDir>/<scene>[-<name>].png at 1280×720.
   Uses software WebGL (SwiftShader), muted audio, and closes the browser.
   ===================================================================== */
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const outDir = process.argv[2] || "shots";
const wanted = process.argv.slice(3);
const ALL = ["menu", "board", "hop", "dusk", "cannon", "intro", "minigame", "finish", "bonus", "podium"];
const scenes = wanted.length ? wanted : ALL;
const FILE = "file:///" + path.resolve(__dirname, "../turbo-party/index.html").replace(/\\/g, "/");
const ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"];

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ARGS });
  const errors = [];
  const newPage = async (query) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE ERROR: " + m.text()); });
    await page.goto(FILE + query);
    return page;
  };
  const shot = async (page, name) => {
    const file = path.join(outDir, name + ".png");
    await page.screenshot({ path: file });
    console.log("saved " + file);
  };
  // Wait (real time) until a condition holds in the page.
  const until = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });

  try {
    if (scenes.includes("menu")) {
      const page = await newPage("");
      await until(page, () => document.getElementById("start"));
      await page.waitForTimeout(800);
      await shot(page, "menu");
      await page.close();
    }

    if (scenes.includes("board") || scenes.includes("hop")) {
      const page = await newPage("?demo&turns=2&speed=1");
      await until(page, () => TP.game && document.querySelector("#banner.show"));
      await page.waitForTimeout(350);
      if (scenes.includes("board")) await shot(page, "board");
      if (scenes.includes("hop")) {
        // Wait for a car to be mid-hop (well above its parked height).
        await until(page, () => TP.game.board.tokens.some((t) => t.pos.y > 0.9));
        await shot(page, "hop");
      }
      await page.close();
    }

    if (scenes.includes("dusk") || scenes.includes("cannon")) {
      const page = await newPage("?demo&turns=2&speed=1");
      await until(page, () => TP.game && TP.game.board);
      await page.evaluate(() => {
        const g = TP.game, b = g.board;
        b.takeTurn = async () => {}; g.minigameRound = async () => {};
        b.roundEnd = async () => {}; g.finale = async () => {}; g.shiftSky = () => {};
      });
      await page.waitForTimeout(4500); // past the title banner
      if (scenes.includes("dusk")) {
        await page.evaluate(() => { const b = TP.game.board; b.orbit = false; b.setTimeOfDay(0.7); b.focusOverview(); });
        await page.waitForTimeout(2500);
        await shot(page, "dusk");
      }
      if (scenes.includes("cannon")) {
        await page.evaluate(() => {
          const b = TP.game.board;
          b.orbit = false;
          b.setTimeOfDay(0.3);
          b.cannon.zone = [5, 6, 7, 8, 9];
          TP.game.players[1].space = 7; b.parkToken(1);
          window.__fired = b.fireCannon();
        });
        await page.waitForTimeout(1500);
        await shot(page, "cannon");
      }
      await page.close();
    }

    if (scenes.includes("intro") || scenes.includes("finish")) {
      // One human seat so the intro card waits for a ready press.
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      page.on("pageerror", (e) => errors.push("PAGE ERROR: " + e.message));
      await page.addInitScript(() => localStorage.setItem("rocketRumble.setup.v1", JSON.stringify({ slots: [
        { name: "Reece", controller: "kb1" }, { name: "Orange", controller: "bot" },
        { name: "Green", controller: "bot" }, { name: "Pink", controller: "bot" }] })));
      await page.goto(FILE + "?speed=1");
      await until(page, () => document.getElementById("start"));
      await page.click("#start");
      await until(page, () => TP.game);
      // Skip straight to a minigame round.
      await page.evaluate(() => { TP.game.board.takeTurn = async () => {}; });
      await until(page, () => document.querySelector(".ready-chip"));
      await page.waitForTimeout(2600); // bots have readied by now
      if (scenes.includes("intro")) await shot(page, "intro");
      await page.keyboard.press("Space");
      if (scenes.includes("finish")) {
        await until(page, () => TP.game.view !== TP.game.board && TP.game.view.state === "play");
        // Let them drive a moment, end the round early, then catch the reactions.
        await page.waitForTimeout(2500);
        await page.evaluate(() => { TP.game.view.timeLeft = 0; TP.game.view.state = "done"; });
        await page.waitForTimeout(900);
        await shot(page, "finish");
      }
      await page.close();
    }

    if (scenes.includes("minigame")) {
      const page = await newPage("?demo&turns=1&speed=1");
      await until(page, () => TP.game);
      await page.evaluate(() => { TP.game.update = () => {}; });
      const ids = await page.evaluate(() => TP.MINIGAMES.map((m) => m.id));
      for (const id of ids) {
        await page.evaluate((id) => {
          if (window.__arena) { window.__arena.dispose(); }
          const def = TP.MINIGAMES.find((m) => m.id === id);
          const a = new def.cls(TP.game);
          a.state = "play";
          window.__arena = a;
          TP.game.view = a;
          // Run 4 s of game time so cars spread out.
          for (let i = 0; i < 240; i++) a.update(1 / 60);
          TP.game.update = (dt) => a.update(dt);
        }, id);
        await page.waitForTimeout(500);
        await shot(page, "minigame-" + id);
      }
      await page.close();
    }

    if (scenes.includes("bonus") || scenes.includes("podium")) {
      const page = await newPage("?demo&turns=1&speed=1");
      await until(page, () => TP.game);
      // Jump to the end: give everyone some stats and run the finale.
      await page.evaluate(() => {
        const g = TP.game;
        g.board.takeTurn = async () => {};
        g.minigameRound = async () => {};
        g.players.forEach((p, i) => { p.trophies = [2, 1, 3, 0][i]; p.coins = [14, 30, 5, 22][i];
          p.stats.minigameWins = [1, 2, 0, 1][i]; p.stats.coinsEarned = [40, 31, 22, 50][i]; p.stats.spacesMoved = [30, 41, 28, 33][i]; });
      });
      if (scenes.includes("bonus")) {
        await until(page, () => document.querySelector("#bonus-who.final"));
        await page.waitForTimeout(150);
        await shot(page, "bonus");
      }
      if (scenes.includes("podium")) {
        await until(page, () => TP.game.board.podium);
        await page.waitForTimeout(2400);
        await shot(page, "podium");
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "No page errors.");
  process.exit(errors.length ? 1 : 0);
})();
