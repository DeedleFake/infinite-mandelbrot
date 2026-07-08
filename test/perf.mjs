/**
 * Performance harness: times shipped CPU baseline vs active paint backend
 * (WebGL full-frame with gl.finish, or CPU) for a fixed deep window.
 */
import { chromium } from "playwright-core";
import { createServer } from "http";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCRATCH =
  process.env.SCRATCH || "/tmp/grok-goal-70878daad40d/implementer";
const HTML = readFileSync(join(ROOT, "index.html"));

mkdirSync(SCRATCH, { recursive: true });

const CASE = {
  w: 960,
  h: 640,
  centerX: -0.743643887037151,
  centerY: 0.13182590420533,
  planeWidth: 0.002,
  maxIter: 512
};

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
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
      args: [
        "--no-sandbox",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--use-gl=angle",
        "--use-angle=swiftshader-webgl"
      ]
    });
  } catch (e) {
    writeFileSync(
      join(SCRATCH, "browser-unavailable.log"),
      "perf browser launch failed: " + e.message + "\n"
    );
    throw e;
  }

  const page = await browser.newPage({
    viewport: { width: CASE.w, height: CASE.h }
  });
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(300);

  const backend = await page.evaluate(() => globalThis.MandelbrotApp.getBackend());
  console.log("backend:", backend);

  // Warmup
  await page.evaluate((c) => {
    globalThis.MandelbrotApp.paintCpuFullFrameSync(c);
    globalThis.MandelbrotApp.paintFullFrameSync(c);
  }, CASE);

  const cpuRuns = [];
  for (let i = 0; i < 3; i++) {
    const r = await page.evaluate((c) => {
      return globalThis.MandelbrotApp.paintCpuFullFrameSync(c);
    }, CASE);
    cpuRuns.push(r.ms);
    console.log("cpu run", i, r.ms.toFixed(2), "ms");
  }

  const optRuns = [];
  for (let i = 0; i < 5; i++) {
    const r = await page.evaluate((c) => {
      return globalThis.MandelbrotApp.paintFullFrameSync(c);
    }, CASE);
    optRuns.push(r.ms);
    console.log("opt run", i, r.ms.toFixed(2), "ms", r.backend);
  }

  const cpuMed = median(cpuRuns);
  const optMed = median(optRuns);
  const speedup = cpuMed / optMed;

  const report = {
    case: CASE,
    backend,
    cpuRunsMs: cpuRuns,
    cpuMedianMs: cpuMed,
    optimizedRunsMs: optRuns,
    optimizedMedianMs: optMed,
    speedup,
    pass5x: speedup >= 5,
    errors
  };

  console.log(JSON.stringify(report, null, 2));

  writeFileSync(
    join(SCRATCH, "perf-baseline.log"),
    JSON.stringify(
      {
        label: "shipped-paintCpuFullFrameSync",
        ...CASE,
        runsMs: cpuRuns,
        medianMs: cpuMed,
        backend: "cpu"
      },
      null,
      2
    ) + "\n"
  );
  writeFileSync(
    join(SCRATCH, "perf-optimized.log"),
    JSON.stringify(
      {
        label: "shipped-paintFullFrameSync",
        ...CASE,
        runsMs: optRuns,
        medianMs: optMed,
        backend,
        speedupVsCpu: speedup
      },
      null,
      2
    ) + "\n"
  );
  writeFileSync(join(SCRATCH, "perf.log"), JSON.stringify(report, null, 2) + "\n");

  if (errors.length) {
    throw new Error("page errors: " + errors.join("; "));
  }
  if (speedup < 5) {
    throw new Error(
      `speedup ${speedup.toFixed(2)}x < 5× (cpu ${cpuMed.toFixed(1)}ms vs opt ${optMed.toFixed(1)}ms)`
    );
  }

  console.log(
    `PERF PASS: ${speedup.toFixed(1)}× (${cpuMed.toFixed(1)}ms → ${optMed.toFixed(1)}ms, backend=${backend})`
  );

  await browser.close();
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
