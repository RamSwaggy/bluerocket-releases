/* =====================================================================
   Rocket Rumble desktop app (Electron).

   Why this exists: browsers refuse to let a page opened by double-click
   (file://) load model, texture and sound files. This app serves the
   games/ folder through its own private address, rumble://game/..., so
   the game can load any asset, saves work (localStorage), and you get
   a real window with full-screen and native gamepad support.

   Keys:  F11 = toggle full-screen   ·   Ctrl+R = reload
          Ctrl+Shift+I = developer tools (for debugging)

   Optional launch flag (handy for testing):
     --start=turbo-party/index.html?demo    open a page other than the hub
   ===================================================================== */
const { app, BrowserWindow, protocol, net, shell } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

/* ---------- Where the game files live ----------
   While developing: the games/ folder next to this desktop/ folder.
   In a packaged .exe: copied into the app's resources folder. */
const GAMES_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "games")
  : path.join(__dirname, "..", "games");

const SCHEME = "rumble";
const ORIGIN = `${SCHEME}://game`;

// Must run before the app is ready: tell Chromium our scheme behaves like
// a normal secure website (so fetch, localStorage and audio all work).
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

// Only one copy of the game at a time; a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

// Keep the game running smoothly even when the window isn't focused
// (so music and timers don't stutter when you alt-tab).
app.commandLine.appendSwitch("disable-renderer-backgrounding");

/* Serve rumble://game/<path> from GAMES_DIR. Refuses anything that would
   escape the games folder (e.g. "../../secret"). */
function serveGameFiles() {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.normalize(path.join(GAMES_DIR, rel));
    if (!file.startsWith(GAMES_DIR + path.sep) && file !== GAMES_DIR) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: "Rocket Rumble",
    // The Rocket Rumble logo, shown in the window corner and on the taskbar.
    icon: path.join(__dirname, "build", "icon.png"),
    backgroundColor: "#070b1a", // matches the hub, so there's no white flash
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      // It's a game: let title music start without waiting for a click.
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  // Show the window only once the first frame is ready (no flicker).
  win.once("ready-to-show", () => win.show());

  // Stay inside the game: links to other websites open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(ORIGIN)) e.preventDefault();
  });

  // F11 full-screen, Ctrl+R reload, Ctrl+Shift+I dev tools.
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (input.control && !input.shift && input.key.toLowerCase() === "r") { win.webContents.reload(); e.preventDefault(); }
    else if (input.control && input.shift && input.key.toLowerCase() === "i") { win.webContents.toggleDevTools(); e.preventDefault(); }
  });

  // Optional --start=<page> flag, otherwise the hub.
  const startArg = process.argv.find((a) => a.startsWith("--start="));
  const start = startArg ? startArg.slice("--start=".length).replace(/^\/+/, "") : "index.html";
  win.loadURL(`${ORIGIN}/${start}`);
  return win;
}

app.whenReady().then(() => {
  serveGameFiles();
  createWindow();
});

app.on("window-all-closed", () => app.quit());
