# Rocket Rumble desktop app

The desktop app (Electron) runs Rocket Rumble in its own window. It's needed because browsers
won't let a double-clicked page load model, texture and sound files. The app serves the
`games/` folder privately, so everything loads. It also gives you full-screen and native
gamepad support. Everything here is free and open source.

## Run it while developing (Windows)

You need **Node.js** (free, https://nodejs.org, the LTS version). Install it once, then open
**Command Prompt** and run these one at a time. Replace the drive and folder with wherever the
repo is on your PC:

```
F:
```
```
cd \path\to\bluerocket-releases\desktop
```
```
npm install
```
```
npm start
```

`npm install` is only needed the first time (and after updates). After that, `npm start`
launches the game.

**In the app:** `F11` toggles full-screen, `Ctrl+R` reloads, and `Ctrl+Shift+I` opens the
developer tools.

## Build a .exe you can share

```
npm run dist
```

This makes `dist\RocketRumble-<version>-portable.exe`, a single file that runs on any
64-bit Windows PC with no install. It isn't code-signed (signing certificates cost money), so
the first time it runs, Windows shows **"Windows protected your PC"**. Click **More info → Run
anyway**.

## How it works

- `main.js` opens a window and serves `../games` at the private address `rumble://game/`.
  Requests that try to reach outside the games folder are refused.
- In a built `.exe`, the games folder is copied inside the app. Test tools and team notes
  are left out; `CREDITS.md` is included.
- Optional launch flag for testing: `--start=turbo-party/index.html?demo` opens a page other
  than the hub.

## Easiest way to play (auto-updating shortcut)

Run this once in PowerShell, from this `desktop` folder:

```
powershell -ExecutionPolicy Bypass -File install-shortcut.ps1
```

That puts a **Rocket Rumble** shortcut with the logo on your Desktop. Every time you
open it, it pulls the latest version of the game, then starts it. If you're offline,
it plays the version you already have. No rebuilding is needed. If something seems off,
`desktop\launch.log` shows what the last launch did.
