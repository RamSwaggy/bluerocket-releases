/* =====================================================================
   credits-check.js — enforces Reece's "free assets only, every
   third-party asset gets a line in games/CREDITS.md" rule.

   Usage (from the games folder):
     node tools/credits-check.js                 (checks boost-runner)
     node tools/credits-check.js turbo-party
     node tools/credits-check.js boost-runner turbo-party

   Plain Node, no browser, runs in well under a second.

   What it does, in plain English:
     1. Lists every ASSET file (anything that isn't .js/.html/.css/.md)
        in the mode folder(s) you name, plus everything in shared/vendor/
        (third-party code we ship to every mode).
     2. Reads the tables in games/CREDITS.md and looks for a row whose
        "Path" column covers each asset. A row path ending in "/" covers
        a whole folder.
     3. Checks every CREDITS row: Source, Author and Licence must be
        filled in, the licence must be one Reece allows, and CC-BY rows
        must have their credit text.
     4. Looks for third-party content that a file listing can't see:
        assets loaded from web URLs, big base64 "data:" blobs inside
        code, and big or licence-headed .js files outside shared/vendor/.

   Report categories:
     MISSING      asset file with no CREDITS row            -> FAIL
     BAD-LICENCE  row with a banned/blank licence, or a row
                  missing Source/Author/credit text          -> FAIL
     STALE        CREDITS row whose file no longer exists    -> warning
     FLAGGED      something a person should look at (an
                  unknown licence, a web URL, an embedded
                  blob, a suspicious .js file)               -> warning

   Exit code 0 = PASS (nothing MISSING or BAD-LICENCE), 1 = FAIL.

   Our own committed asset files (anything the team made but didn't
   generate in code at runtime) still need a row: use the licence
   "Rocket Rumble team (original)". That's the rule the boss agreed.

   Note: games/mode-5/ is never scanned unless named explicitly
   (TEAMS.md: other teams don't open it).
   ===================================================================== */
const fs = require("fs");
const path = require("path");

// Everything is relative to the games/ folder, same as CREDITS.md paths.
const GAMES = path.resolve(__dirname, "..");
const CREDITS_FILE = path.join(GAMES, "CREDITS.md");

// Folders to check: the command-line arguments, or boost-runner by default.
const folders = process.argv.slice(2).length ? process.argv.slice(2) : ["boost-runner"];

/* ---------- Which files count as assets ---------- */

// Source code and docs we write ourselves. These are scanned for hidden
// third-party content (step 4) but don't need a CREDITS row.
const CODE_EXT = new Set([".js", ".html", ".css", ".md"]);

// Licence/notice files that sit next to a credited library (for example
// shared/vendor/THREE-LICENSE). They're paperwork, not assets.
const LICENCE_FILE = /^(.*[-_.])?(LICEN[CS]E|COPYING|NOTICE)([-_.].*)?$/i;

// Third-party code folders: every file inside needs a row, even .js.
const VENDOR_DIR = /(^|\/)(vendor|third[-_]?party|lib)\//i;

/* ---------- Licence rules (TEAMS.md "Free assets and tools only") ---------- */

// Any of these in the licence text means the asset can't ship.
const BANNED = [
  [/\bNC\b|non-?commercial/i, "NonCommercial licence"],
  [/\bND\b|no-?deriv/i, "NoDerivatives licence"],
  [/megascans|quixel/i, "engine-tied licence (Megascans/Quixel)"],
  [/\bunknown\b|\bunclear\b|\bnone\b|\btbd\b|\?\?/i, "no clear licence"],
  [/\bpaid\b|proprietary|all rights reserved|commercial licen[cs]e/i, "paid or proprietary"],
];

// Licences that are fine. Anything not banned and not on this list is
// FLAGGED so the boss can rule on it.
const ALLOWED = [
  [/\bCC0\b|public domain/i, "public domain"],
  [/\bCC[- ]?BY\b(?!-N)/i, "credit required"], // CC-BY and CC-BY-SA (NC/ND already caught above)
  [/\bMIT\b|\bBSD\b|\bApache\b|\bISC\b|\bzlib\b|\bOFL\b|SIL Open Font/i, "open source"],
  [/sonniss|royalty[- ]free/i, "royalty-free bundle"],
  [/rocket rumble team/i, "our own work"],
];

/* ---------- Small helpers ---------- */

// Walk a folder and return every file path, relative to games/, with
// forward slashes so they match how CREDITS.md writes them.
function walk(relDir) {
  const out = [];
  const abs = path.join(GAMES, relDir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(relDir.split(path.sep).join("/"), entry.name);
    if (entry.name.startsWith(".")) continue; // skip .git-style hidden files
    if (entry.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

// Strip markdown decoration from a table cell: backticks, bold, italics.
const clean = (s) => s.replace(/`/g, "").replace(/\*+/g, "").trim();

/* ---------- Step 2: read CREDITS.md ---------- */

// Returns one object per table row: { line, table, what, paths[], source,
// author, licence, credit, hasCreditColumn }. Column positions are found
// from each table's header row, so the two tables can differ.
function readCredits() {
  const rows = [];
  if (!fs.existsSync(CREDITS_FILE)) return { rows, error: "games/CREDITS.md not found" };
  const lines = fs.readFileSync(CREDITS_FILE, "utf8").split("\n");
  let header = null; // column name -> index, for the table we're inside
  let tableName = "";
  lines.forEach((text, i) => {
    if (text.startsWith("#")) tableName = text.replace(/^#+\s*/, "");
    if (!text.trim().startsWith("|")) { header = null; return; }
    const cells = text.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (!header) {
      // First row of a table is its header.
      header = {};
      cells.forEach((c, idx) => {
        const name = clean(c).toLowerCase();
        if (name.startsWith("what")) header.what = idx;
        else if (name.startsWith("path")) header.path = idx;
        else if (name.startsWith("source")) header.source = idx;
        else if (name.startsWith("author")) header.author = idx;
        else if (name.startsWith("licen")) header.licence = idx;
        else if (name.startsWith("credit")) header.credit = idx;
      });
      return;
    }
    if (/^[-:|\s]+$/.test(text.trim())) return; // the |---|---| divider row
    const get = (k) => (header[k] === undefined ? "" : clean(cells[header[k]] || ""));
    // A cell may list several paths separated by commas or <br>.
    const paths = get("path").split(/,|<br\s*\/?>/i).map((p) => p.trim()).filter(Boolean);
    if (!paths.length) return; // placeholder rows like "(none yet ...)"
    rows.push({
      line: i + 1,
      table: tableName,
      what: get("what"),
      paths,
      source: get("source"),
      author: get("author"),
      licence: get("licence"),
      credit: get("credit"),
      hasCreditColumn: header.credit !== undefined,
    });
  });
  return { rows };
}

// Does this CREDITS row path cover this file? Exact match, or the row is
// a folder ("music/") that contains the file.
function covers(rowPath, file) {
  if (rowPath.endsWith("/")) return file.startsWith(rowPath);
  return rowPath === file;
}

/* ---------- Step 3: check one row's licence ---------- */

// Returns { bad: [reasons], flag: [reasons] } for one CREDITS row.
function judgeRow(row) {
  const bad = [];
  const flag = [];
  if (!row.licence) bad.push("licence is blank");
  if (!row.source) bad.push("source is blank");
  if (!row.author) bad.push("author is blank");
  for (const [re, why] of BANNED) if (re.test(row.licence)) bad.push(why);
  if (row.licence && !bad.length) {
    const ok = ALLOWED.find(([re]) => re.test(row.licence));
    if (!ok) flag.push(`licence "${row.licence}" isn't on the allowed list: boss to rule`);
    // CC-BY only works if we actually show the credit.
    else if (ok[1] === "credit required" && !row.credit) {
      bad.push(row.hasCreditColumn ? "CC-BY but the credit text is blank" : "CC-BY row is in a table with no credit-text column");
    }
  }
  return { bad, flag };
}

/* ---------- Step 4: hidden third-party content in our code ---------- */

// URL patterns that mean "the game loads something from the web".
// Plain URLs in comments or <a> links to web pages are fine and ignored.
const LOAD_PATTERNS = [
  /\bfetch\s*\(\s*["'`](https?:\/\/[^"'`]+)/g,
  /\.load(?:Async)?\s*\(\s*["'`](https?:\/\/[^"'`]+)/g, // GLTFLoader, TextureLoader, ...
  /new\s+Audio\s*\(\s*["'`](https?:\/\/[^"'`]+)/g,
  /\bimport\s*\(\s*["'`](https?:\/\/[^"'`]+)/g,
  /\bfrom\s+["'`](https?:\/\/[^"'`]+)/g,
  /\burl\(\s*["']?(https?:\/\/[^"')\s]+)/g, // CSS url(...) and @font-face
  /@import\s+["'](https?:\/\/[^"']+)/g,
  /<(?:script|img|audio|video|source|link|iframe)\b[^>]*\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)/gi,
  /\.src\s*=\s*["'`](https?:\/\/[^"'`]+)/g,
];

// Hosts that appear in CREDITS rows count as credited sources.
function creditedHosts(rows) {
  const hosts = new Set();
  for (const r of rows) {
    const m = r.source.match(/https?:\/\/([^/\s)]+)/);
    if (m) hosts.add(m[1].toLowerCase());
  }
  return hosts;
}

// Turn a character offset into a 1-based line number.
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

function scanCode(file, hosts, rows) {
  const flags = [];
  const abs = path.join(GAMES, file);
  const text = fs.readFileSync(abs, "utf8");
  const isCredited = rows.some((r) => r.paths.some((p) => covers(p, file)));

  // a) Assets loaded from the web.
  for (const re of LOAD_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const host = (m[1].match(/^https?:\/\/([^/]+)/) || [])[1] || "";
      if (!hosts.has(host.toLowerCase())) {
        flags.push(`${file}:${lineOf(text, m.index)} loads from the web (${m[1].slice(0, 80)}) with no CREDITS row for ${host}`);
      }
    }
  }

  // b) Big embedded base64 blobs: almost always an image, sound or font.
  const blob = /data:[\w/+.-]+;base64,([A-Za-z0-9+/=]{1000,})/g;
  let b;
  while ((b = blob.exec(text))) {
    flags.push(`${file}:${lineOf(text, b.index)} embeds a ${Math.round(b[1].length * 0.75 / 1024)} KB base64 data: blob (an embedded asset?)`);
  }

  // c) Third-party code dropped into a mode folder: big, or carries a licence header.
  if (file.endsWith(".js") && !isCredited) {
    const kb = fs.statSync(abs).size / 1024;
    if (kb > 50) flags.push(`${file} is ${kb.toFixed(0)} KB: third-party library? If so, move it to a vendor folder and credit it`);
    if (/@license|SPDX-License-Identifier|Copyright \(c\)|Licensed under/i.test(text.slice(0, 2048))) {
      flags.push(`${file} starts with a third-party licence header but has no CREDITS row`);
    }
  }
  return flags;
}

/* ---------- Main ---------- */

const { rows, error } = readCredits();
if (error) { console.log(error + "\nRESULT: FAIL"); process.exit(1); }

const missing = [];
const badLicence = [];
const stale = [];
const flagged = [];

// Files to check: the named mode folders, plus shared/vendor (shipped to every mode).
const scanDirs = [...folders.filter((f) => f !== "mode-5" || process.argv.includes("mode-5")), "shared/vendor"];
const files = [...new Set(scanDirs.flatMap(walk))];
for (const f of folders) if (!fs.existsSync(path.join(GAMES, f))) flagged.push(`folder games/${f} doesn't exist`);

// Step 1 + 2: every asset needs a row.
let assetCount = 0;
for (const file of files) {
  const base = path.posix.basename(file);
  const ext = path.posix.extname(file).toLowerCase();
  if (LICENCE_FILE.test(base)) continue;
  const needsRow = !CODE_EXT.has(ext) || VENDOR_DIR.test(file);
  if (!needsRow) continue;
  assetCount++;
  if (!rows.some((r) => r.paths.some((p) => covers(p, file)))) missing.push(file);
}

// Step 3: every row (the whole file, so a bad row anywhere is caught).
for (const r of rows) {
  const { bad, flag } = judgeRow(r);
  const label = `CREDITS.md:${r.line} "${r.what || r.paths[0]}"`;
  bad.forEach((why) => badLicence.push(`${label}: ${why}`));
  flag.forEach((why) => flagged.push(`${label}: ${why}`));
  for (const p of r.paths) {
    const exists = fs.existsSync(path.join(GAMES, p.replace(/\/$/, "")));
    if (!exists) stale.push(`CREDITS.md:${r.line} lists ${p}, which doesn't exist`);
  }
}

// Step 4: our own code, outside vendor folders (those are credited as a whole).
const hosts = creditedHosts(rows);
let codeCount = 0;
for (const file of files) {
  const ext = path.posix.extname(file).toLowerCase();
  if (![".js", ".html", ".css"].includes(ext) || VENDOR_DIR.test(file)) continue;
  codeCount++;
  flagged.push(...scanCode(file, hosts, rows));
}

/* ---------- Report ---------- */

console.log(`Credits check: ${scanDirs.map((d) => "games/" + d).join(", ")}`);
console.log(`${assetCount} asset file(s), ${codeCount} code file(s) scanned, ${rows.length} CREDITS row(s).\n`);
const section = (name, list) => {
  console.log(`${name} (${list.length})`);
  list.forEach((x) => console.log("  - " + x));
};
section("MISSING", missing);
section("BAD-LICENCE", badLicence);
section("STALE", stale);
section("FLAGGED", flagged);

const pass = !missing.length && !badLicence.length;
console.log(pass ? "\nRESULT: PASS" : "\nRESULT: FAIL (fix MISSING / BAD-LICENCE before merging)");
process.exit(pass ? 0 : 1);
