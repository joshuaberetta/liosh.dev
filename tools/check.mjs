// Smoke test: serve the site, load it in headless Chrome at desktop and phone
// sizes, exercise both modes, save screenshots, and fail on any page error.
//
//   npm install          (once, for puppeteer-core)
//   npm run check
//
// Uses your installed Chrome. Set CHROME_PATH if it isn't in the usual place.
// Screenshots land in tools/shots/ (git-ignored); look at them, since a sim can
// run without errors and still look wrong.

import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const shots = join(root, "tools", "shots");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, path.endsWith("/") ? path + "index.html" : path);
  try {
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const url = `http://localhost:${server.address().port}/`;

const chrome = process.env.CHROME_PATH || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find(existsSync);
if (!chrome) throw new Error("Chrome not found; set CHROME_PATH");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fps = (page) => page.evaluate(() => new Promise((done) => {
  let n = 0;
  const start = performance.now();
  const tick = () => (++n, performance.now() - start < 1000 ? requestAnimationFrame(tick) : done(n));
  requestAnimationFrame(tick);
}));

await mkdir(shots, { recursive: true });
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--use-angle=metal"] });
const problems = [];

try {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
  ]) {
    const page = await browser.newPage();
    page.on("pageerror", (e) => problems.push(`${name}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && problems.push(`${name}: ${m.text()}`));
    page.on("response", (r) => r.status() >= 400 && problems.push(`${name}: ${r.status()} ${r.url()}`));
    await page.setViewport(viewport);
    await page.goto(url);

    // Magnetic mode: let filings settle, then drag the title through the subtitle.
    await wait(4000);
    await page.screenshot({ path: join(shots, `${name}-magnetic.png`) });
    const title = await page.$eval("h1", (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(title.x, title.y);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(title.x + i * 3, title.y + i * 6), await wait(20);
    await page.mouse.up();
    await wait(1000);
    await page.screenshot({ path: join(shots, `${name}-dragged.png`) });
    const magneticFps = await fps(page);

    // Water mode: switch, let the current develop, recenter the words.
    await page.$eval('[data-action="recenter"]', (b) => b.click());
    await page.$eval('[data-action="mode"]', (b) => b.click());
    await wait(4000);
    await page.screenshot({ path: join(shots, `${name}-water.png`) });
    const waterFps = await fps(page);

    console.log(`${name.padEnd(8)} magnetic ${magneticFps} fps · water ${waterFps} fps`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`screenshots: ${shots}`);
if (problems.length) {
  console.error("\nproblems:\n" + problems.map((p) => "  " + p).join("\n"));
  process.exit(1);
}
console.log("no page errors");
