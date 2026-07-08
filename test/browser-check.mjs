/**
 * Headless verification of index.html via Playwright + system Chromium.
 * Captures screenshots and asserts canvas fill + zoom state change.
 */
import { chromium } from "playwright-core";
import { createServer } from "http";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCRATCH =
  process.env.SCRATCH || "/tmp/grok-goal-adf2aef02c52/implementer";
const HTML = readFileSync(join(ROOT, "index.html"));

mkdirSync(SCRATCH, { recursive: true });

function log(msg) {
  console.log(msg);
}

async function main() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"]
    });
  } catch (e) {
    const msg = "browser launch failed: " + e.message;
    writeFileSync(join(SCRATCH, "browser-unavailable.log"), msg + "\n");
    console.error(msg);
    server.close();
    process.exit(1);
  }

  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push("console: " + msg.text());
  });

  // Launch twice for consistency
  for (let launch = 1; launch <= 2; launch++) {
    log(`launch ${launch}: goto ${url}`);
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    // Allow first paint chunks
    await page.waitForTimeout(800);

    const metrics = await page.evaluate(() => {
      const c = document.getElementById("c");
      if (!c) return { error: "no canvas" };
      const ctx = c.getContext("2d");
      const w = c.width;
      const h = c.height;
      const sample = ctx.getImageData(0, 0, w, h).data;
      let nonBlack = 0;
      let nonEmpty = 0;
      const step = 16; // sample every Nth pixel for speed
      let total = 0;
      for (let i = 0; i < sample.length; i += 4 * step) {
        total++;
        const r = sample[i], g = sample[i + 1], b = sample[i + 2], a = sample[i + 3];
        if (a > 0) nonEmpty++;
        // interior is ~8,8,12 — count clearly colored exterior pixels
        if (r + g + b > 40) nonBlack++;
      }
      const info = document.getElementById("info");
      return {
        width: w,
        height: h,
        cssW: c.clientWidth,
        cssH: c.clientHeight,
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
        nonBlackFrac: nonBlack / total,
        nonEmptyFrac: nonEmpty / total,
        infoText: info ? info.textContent : "",
        hudButtons: document.querySelectorAll("#actions button").length
      };
    });

    log(JSON.stringify(metrics, null, 2));

    if (metrics.error) throw new Error(metrics.error);
    if (metrics.width < metrics.viewportW * 0.5) {
      throw new Error("canvas width too small: " + metrics.width);
    }
    if (metrics.height < metrics.viewportH * 0.5) {
      throw new Error("canvas height too small: " + metrics.height);
    }
    // CSS size should fill viewport
    if (Math.abs(metrics.cssW - metrics.viewportW) > 2) {
      throw new Error("canvas CSS width != viewport");
    }
    if (Math.abs(metrics.cssH - metrics.viewportH) > 2) {
      throw new Error("canvas CSS height != viewport");
    }
    // Substantially filled with fractal colors (not blank)
    if (metrics.nonBlackFrac < 0.15) {
      throw new Error(
        "surface mostly blank; nonBlackFrac=" + metrics.nonBlackFrac
      );
    }
    if (metrics.hudButtons > 3) {
      throw new Error("UI not sparse: " + metrics.hudButtons + " buttons");
    }

    await page.screenshot({
      path: join(SCRATCH, launch === 1 ? "ui.png" : "ui-launch2.png"),
      fullPage: true
    });
  }

  // Drive zoom and assert view / pixels change
  const before = await page.evaluate(() => {
    const c = document.getElementById("c");
    const ctx = c.getContext("2d");
    const d = ctx.getImageData(0, 0, Math.min(64, c.width), Math.min(64, c.height)).data;
    return {
      info: document.getElementById("info").textContent,
      hash: Array.from(d).reduce((a, b) => (a * 31 + b) | 0, 0),
      view: globalThis.MandelbrotMath
        ? null
        : null
    };
  });

  // Wheel zoom at center
  await page.mouse.move(480, 320);
  await page.mouse.wheel(0, -400); // zoom in
  await page.waitForTimeout(1000);

  const after = await page.evaluate(() => {
    const c = document.getElementById("c");
    const ctx = c.getContext("2d");
    const d = ctx.getImageData(0, 0, Math.min(64, c.width), Math.min(64, c.height)).data;
    return {
      info: document.getElementById("info").textContent,
      hash: Array.from(d).reduce((a, b) => (a * 31 + b) | 0, 0)
    };
  });

  log("before info: " + before.info.replace(/\n/g, " | "));
  log("after  info: " + after.info.replace(/\n/g, " | "));
  log("pixel hash before=" + before.hash + " after=" + after.hash);

  if (before.info === after.info && before.hash === after.hash) {
    throw new Error("zoom did not change view state or pixels");
  }
  // Zoom string should increase
  const zoomBefore = parseFloat((before.info.match(/zoom ×([0-9.eE+-]+)/) || [])[1]);
  const zoomAfter = parseFloat((after.info.match(/zoom ×([0-9.eE+-]+)/) || [])[1]);
  log("zoom before=" + zoomBefore + " after=" + zoomAfter);
  if (!(zoomAfter > zoomBefore)) {
    throw new Error("expected zoom-in to increase zoom factor");
  }

  await page.screenshot({ path: join(SCRATCH, "ui-zoomed.png"), fullPage: true });

  // Pan
  await page.mouse.move(480, 320);
  await page.mouse.down();
  await page.mouse.move(580, 400, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(800);

  const afterPan = await page.evaluate(
    () => document.getElementById("info").textContent
  );
  log("after pan: " + afterPan.replace(/\n/g, " | "));
  if (afterPan === after.info) {
    throw new Error("pan did not change HUD center");
  }
  await page.screenshot({ path: join(SCRATCH, "ui-panned.png"), fullPage: true });

  if (errors.length) {
    throw new Error("page errors: " + errors.join("; "));
  }

  const summary = {
    ok: true,
    launches: 2,
    nonBlackFrac: "see logs",
    zoomBefore,
    zoomAfter,
    errors: 0
  };
  writeFileSync(
    join(SCRATCH, "browser-check.log"),
    JSON.stringify(summary, null, 2) + "\n" +
      "zoom " + zoomBefore + " -> " + zoomAfter + "\n" +
      "no page errors\n"
  );
  log("BROWSER CHECK PASSED");

  await browser.close();
  server.close();
}

main().catch(async (e) => {
  console.error(e);
  writeFileSync(
    join(SCRATCH, "browser-unavailable.log"),
    String(e.stack || e) + "\n"
  );
  process.exit(1);
});
