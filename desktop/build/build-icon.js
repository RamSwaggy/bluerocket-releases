// Renders build/icon.svg into the PNG and ICO files the desktop app uses.
// You only need to run this if you change icon.svg:
//   node build/build-icon.js
// It uses a headless browser (Playwright) to draw the SVG at each size, then
// packs the sizes into one Windows .ico file (Windows picks the right size for
// the taskbar, desktop, Explorer, and so on).
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const SIZES = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  const svg = fs.readFileSync(path.join(__dirname, "icon.svg"), "utf8");
  const browser = await chromium.launch({ args: ["--mute-audio"] });
  const page = await browser.newPage();
  const pngs = {};
  for (const size of [...SIZES, 512]) {
    await page.setViewportSize({ width: size, height: size });
    // Draw the SVG to fill the page exactly, on a transparent background.
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}</style>` +
      svg.replace("<svg ", `<svg style="display:block;width:${size}px;height:${size}px" `)
    );
    pngs[size] = await page.screenshot({ omitBackground: true });
  }
  await browser.close();

  // icon.png (512) is used for the app window and the Linux build.
  fs.writeFileSync(path.join(__dirname, "icon.png"), pngs[512]);

  // An .ico is a small header, one 16-byte directory entry per image,
  // then the images themselves (modern Windows accepts PNG data inside).
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type 1 = icon
  header.writeUInt16LE(SIZES.length, 4); // number of images
  const entries = [];
  let offset = 6 + 16 * SIZES.length;
  for (const size of SIZES) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 means 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt16LE(1, 4);                   // colour planes
    e.writeUInt16LE(32, 6);                  // bits per pixel
    e.writeUInt32LE(pngs[size].length, 8);   // image size in bytes
    e.writeUInt32LE(offset, 12);             // where the image starts
    offset += pngs[size].length;
    entries.push(e);
  }
  fs.writeFileSync(
    path.join(__dirname, "icon.ico"),
    Buffer.concat([header, ...entries, ...SIZES.map((s) => pngs[s])])
  );
  console.log("Wrote build/icon.png and build/icon.ico");
})();
