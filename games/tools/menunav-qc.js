/* =====================================================================
   menunav-qc.js: checks that every menu can be fully driven with a
   controller (D-pad / arrows), so nobody gets stuck.

   Usage (from games/):   node tools/menunav-qc.js

   How it works: it opens each menu page in a headless browser, then for
   every control on the menu it puts the highlight there and presses each
   direction (arrow keys run exactly the same code as the D-pad). That
   gives a map of "from here, ← → ↑ ↓ goes there". Then it checks:
     - every control can be reached from the starting highlight, and
     - from every control you can get back to the main action (Play).
   Any control that fails either check is a trap, and it's printed with
   where each direction leads from it.
   ===================================================================== */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const PAGES = [
  { name: "hub", url: "index.html" },
  { name: "turbo-party", url: "turbo-party/index.html" },
  { name: "deflect-duel", url: "deflect-duel/index.html" },
  { name: "car-fighter", url: "car-fighter/index.html" },
  { name: "boost-runner", url: "boost-runner/index.html" },
];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".glb": "model/gltf-binary", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav" };

// A tiny static file server, run inside this script (no separate process).
function serve() {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => srv.listen(0, () => ok(srv)));
}

const DIRS = { "←": "ArrowLeft", "→": "ArrowRight", "↑": "ArrowUp", "↓": "ArrowDown" };

(async () => {
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch({ args: ["--mute-audio"] });
  let failures = 0;

  for (const pg of PAGES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + pg.url);
    await page.waitForTimeout(1500);
    // Dismiss a title card / "press any button" screen if there is one.
    await page.keyboard.press("KeyZ");
    await page.waitForTimeout(800);

    // Label every navigable control so we can talk about them by name.
    const items = await page.evaluate(() => {
      const SEL = 'button:not([disabled]), a[href], select:not([disabled])';
      const vis = (el) => el.offsetParent !== null;
      return [...document.querySelectorAll(SEL)].filter(vis).map((el, i) => {
        el.dataset.qc = i;
        return (el.id ? "#" + el.id : el.tagName.toLowerCase()) + " \"" + (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 18) + "\"";
      });
    });
    if (!items.length) { console.log(`\n${pg.name}: no controller-navigable menu found`); failures++; await page.close(); continue; }
    const startIdx = await page.evaluate(() => { const el = document.querySelector(".rr-nav-focus"); return el ? Number(el.dataset.qc) : -1; });
    const primaryIdx = await page.evaluate(() => { const el = document.querySelector("[data-qc][data-nav-primary]") || document.querySelector(".rr-nav-focus"); return el ? Number(el.dataset.qc) : -1; });

    // Build the map: from each control, where does each direction go?
    const graph = [];
    for (let i = 0; i < items.length; i++) {
      graph[i] = {};
      for (const [d, key] of Object.entries(DIRS)) {
        // Put the highlight on control i (focus syncs MenuNav's highlight),
        // remembering a dropdown's value so we can restore it afterwards.
        const before = await page.evaluate((i) => {
          const el = document.querySelector(`[data-qc="${i}"]`);
          el.focus({ preventScroll: true });
          return el.tagName === "SELECT" ? el.selectedIndex : null;
        }, i);
        await page.keyboard.press(key);
        await page.waitForTimeout(30);
        const r = await page.evaluate(([i, before]) => {
          const el = document.querySelector(`[data-qc="${i}"]`);
          const now = document.querySelector(".rr-nav-focus");
          let changed = false;
          if (before !== null && el.selectedIndex !== before) { changed = true; el.selectedIndex = before; el.dispatchEvent(new Event("change", { bubbles: true })); }
          return { to: now && now.dataset.qc !== undefined ? Number(now.dataset.qc) : -1, changed };
        }, [i, before]);
        graph[i][d] = r.changed ? "value" : r.to === i ? "stuck" : r.to;
      }
    }

    // Reachability: forward from the start, and backward to the primary.
    const reach = (from) => { const seen = new Set([from]); const q = [from];
      while (q.length) { const n = q.shift(); for (const t of Object.values(graph[n])) if (typeof t === "number" && t >= 0 && !seen.has(t)) { seen.add(t); q.push(t); } }
      return seen; };
    const fromStart = reach(startIdx >= 0 ? startIdx : 0);
    const traps = [];
    items.forEach((name, i) => {
      const unreachable = !fromStart.has(i);
      const noWayBack = primaryIdx >= 0 && !reach(i).has(primaryIdx);
      if (unreachable || noWayBack) traps.push({ name, why: [unreachable && "can't be reached", noWayBack && "can't get back to the main action"].filter(Boolean).join(", "), dirs: graph[i] });
    });

    console.log(`\n${pg.name}: ${items.length} controls, start = ${items[startIdx] || "none"}`);
    if (process.env.QC_MAP) items.forEach((n, i) => console.log("   ", n, Object.entries(graph[i]).map(([d, v]) => d + " " + (typeof v === "number" ? (items[v] || "?").slice(0, 14) : v)).join(" · ")));
    for (const t of traps) {
      const dirs = Object.entries(t.dirs).map(([d, v]) => `${d} ${typeof v === "number" ? items[v] || "?" : v}`).join(" · ");
      console.log(`  TRAP ${t.name}: ${t.why}\n       ${dirs}`);
    }
    if (errors.length) console.log("  page errors:", errors.slice(0, 3));
    console.log(traps.length || errors.length ? "  FAIL" : "  PASS");
    if (traps.length || errors.length) failures++;
    await page.close();
  }

  await browser.close();
  srv.close();
  console.log(failures ? `\nRESULT: FAIL (${failures} menu(s))` : "\nRESULT: PASS");
  process.exit(failures ? 1 : 0);
})();
