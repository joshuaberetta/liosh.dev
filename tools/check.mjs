// Smoke test: serve the site, load it in headless Chrome at desktop and phone
// sizes, exercise all four modes, save screenshots, and fail on any page error.
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
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      Promise.all(m.args().map((arg) => arg.evaluate((value) => value instanceof Error ? value.stack : String(value)).catch(() => ""))).then((values) => console.error(values.join("\n")));
      problems.push(`${name}: ${text}`);
    });
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

    // Ferrofluid: settle, pull the pointer, and send a shockwave.
    await page.$eval('[data-action="recenter"]', (b) => b.click());
    await page.$eval('[data-action="mode"]', (b) => b.click());
    await wait(2500);
    await page.mouse.move(viewport.width * 0.7, viewport.height * 0.4);
    await wait(600);
    await page.screenshot({ path: join(shots, `${name}-ferrofluid.png`) });
    await page.$eval('[data-action="shock"]', (b) => b.click());
    await wait(250);
    await page.screenshot({ path: join(shots, `${name}-shockwave.png`) });
    const ferrofluidFps = await fps(page);
    await page.$eval('[data-action="calm"]', (b) => b.click());

    // Sand: let a pattern form, step to the next resonance, then pour some sand.
    await page.$eval('[data-action="mode"]', (b) => b.click());
    await wait(5000);
    await page.screenshot({ path: join(shots, `${name}-sand.png`) });
    const sandFps = await fps(page);
    await page.$eval('[data-action="resonance"]', (b) => b.click());
    await wait(5000);
    await page.screenshot({ path: join(shots, `${name}-sand-next.png`) });
    await page.$eval('[data-action="pour"]', (b) => b.click());
    await page.mouse.move(viewport.width * 0.3, viewport.height * 0.3);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(viewport.width * (0.3 + i * 0.01), viewport.height * 0.3), await wait(20);
    await page.mouse.up();
    await page.$eval('[data-action="pour"]', (b) => b.click());

    for (const expected of ["magnetic", "water", "ferrofluid", "sand", "magnetic"]) {
      await page.$eval('[data-action="mode"]', (b) => b.click());
      const state = await page.evaluate(() => ({
        mode: document.getElementById("mode").textContent,
        visible: [...document.querySelectorAll("canvas")].filter((c) => getComputedStyle(c).display !== "none").map((c) => c.id),
        controls: [...document.querySelectorAll("[data-mode]")].filter((e) => getComputedStyle(e).display !== "none").map((e) => e.dataset.mode),
      }));
      if (state.mode !== expected || state.visible.length !== 1 || state.controls.length === 0 || !state.controls.every((control) => control.split(" ").includes(expected))) {
        problems.push(`${name}: bad mode/controls after switching to ${expected}: ${JSON.stringify(state)}`);
      }
    }

    // Verify reduced motion from page load, not just after changing a setting.
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.reload();
    await page.$eval('[data-action="mode"]', (b) => b.click());
    await page.$eval('[data-action="mode"]', (b) => b.click());
    await wait(1000);
    await page.screenshot({ path: join(shots, `${name}-reduced-motion.png`) });
    await page.mouse.click(viewport.width * 0.7, viewport.height * 0.4);
    await page.$eval('[data-action="shock"]', (b) => b.click());
    await wait(400);
    await page.screenshot({ path: join(shots, `${name}-reduced-shock.png`) });
    await page.$eval('[data-action="mode"]', (b) => b.click());
    await wait(500);
    await page.screenshot({ path: join(shots, `${name}-reduced-sand.png`) });

    console.log(`${name.padEnd(8)} magnetic ${magneticFps} fps · water ${waterFps} fps · ferrofluid ${ferrofluidFps} fps · sand ${sandFps} fps`);
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
