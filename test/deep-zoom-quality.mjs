/**
 * Deep-zoom quality: at a planeWidth where float32 mapping collapses, the live
 * WebGL (emulated double) path must still show spatial color variation comparable
 * to shipped float64 paintCpuFullFrame — not a flat field.
 */
import { chromium } from "playwright-core";
import { createServer } from "http";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCRATCH =
  process.env.SCRATCH || "/tmp/grok-goal-0629836d73da/implementer";
const HTML = readFileSync(join(ROOT, "index.html"), "utf8");

mkdirSync(SCRATCH, { recursive: true });

// Seahorse valley: float32 pixel→c map collapses (≲25 unique on 48² grid) while
// float64 CPU still paints rich exterior structure at maxIter≥2048.
const DEEP = {
  w: 320,
  h: 240,
  centerX: -0.743643887037151,
  centerY: 0.13182590420533,
  planeWidth: 1e-7,
  maxIter: 2048,
  step: 4
};

function loadCpuPaint() {
  const script = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  const noop = () => {};
  const ctx2d = {
    createImageData: (w, h) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h
    }),
    putImageData: noop
  };
  const el = {
    getContext: (type) =>
      type === "webgl" || type === "experimental-webgl" ? null : ctx2d,
    style: {},
    addEventListener: noop,
    setPointerCapture: noop,
    classList: { add: noop, remove: noop },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
    width: 320,
    height: 240,
    textContent: ""
  };
  const sandbox = {
    console,
    Math,
    Number,
    isFinite,
    Map,
    Array,
    Object,
    Float32Array,
    Uint8ClampedArray,
    performance: { now: () => 0 },
    requestAnimationFrame: noop,
    window: {
      devicePixelRatio: 1,
      innerWidth: 320,
      innerHeight: 240,
      addEventListener: noop
    },
    document: { getElementById: () => el }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(script, sandbox, { filename: "index.html" });
  return sandbox.MandelbrotMath;
}

function uniqueFromBuffer(buf, w, h, step) {
  const set = new Set();
  let samples = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      set.add(buf[i] + "," + buf[i + 1] + "," + buf[i + 2]);
      samples++;
    }
  }
  return { unique: set.size, samples };
}

async function main() {
  const M = loadCpuPaint();
  const cpuBuf = M.paintCpuFullFrame(
    DEEP.w,
    DEEP.h,
    DEEP.centerX,
    DEEP.centerY,
    DEEP.planeWidth,
    DEEP.maxIter
  );
  const cpuQ = uniqueFromBuffer(cpuBuf, DEEP.w, DEEP.h, DEEP.step);

  // Simulate float32-only paint mapping collapse: re-run with fround center/scale
  // (approximation of old shader quality — few unique colors)
  const f = Math.fround;
  let flatUnique = 0;
  {
    const set = new Set();
    const aspect = f(DEEP.w / DEEP.h);
    const pw = f(DEEP.planeWidth);
    const ph = f(pw / aspect);
    const cx = f(DEEP.centerX);
    const cy = f(DEEP.centerY);
    for (let y = 0; y < DEEP.h; y += DEEP.step) {
      for (let x = 0; x < DEEP.w; x += DEEP.step) {
        const re = f(cx + f((x / DEEP.w - 0.5) * pw));
        const im = f(cy - f((y / DEEP.h - 0.5) * ph));
        // one smooth evaluation is enough for uniqueness of c
        set.add(re + "," + im);
      }
    }
    flatUnique = set.size;
  }

  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

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
      "deep-zoom quality browser failed: " + e.message + "\n"
    );
    throw e;
  }

  const page = await browser.newPage({
    viewport: { width: DEEP.w, height: DEEP.h }
  });
  await page.goto(`http://127.0.0.1:${port}/`, {
    waitUntil: "networkidle",
    timeout: 30000
  });
  await page.waitForTimeout(200);

  const live = await page.evaluate((deep) => {
    const app = globalThis.MandelbrotApp;
    const q = app.deepZoomQuality(deep);
    return q;
  }, DEEP);

  if (live.dataUrl && live.dataUrl.startsWith("data:image/png")) {
    const b64 = live.dataUrl.replace(/^data:image\/png;base64,/, "");
    writeFileSync(join(SCRATCH, "deep-zoom.png"), Buffer.from(b64, "base64"));
  } else {
    await page.screenshot({
      path: join(SCRATCH, "deep-zoom.png"),
      fullPage: true
    });
  }
  const dataUrl = live.dataUrl;
  delete live.dataUrl;
  live.backend = live.backend || "unknown";
  void dataUrl;

  const report = {
    case: DEEP,
    float32CollapsedUniqueC: flatUnique,
    cpuFloat64: cpuQ,
    liveBackend: live,
    // Live path must not be degenerate: at least 20% of CPU unique colors
    // and far more unique than float32-collapsed mapping
    pass:
      live.unique >= Math.max(8, Math.floor(cpuQ.unique * 0.2)) &&
      live.unique > flatUnique * 4 &&
      cpuQ.unique > flatUnique * 4
  };

  console.log(JSON.stringify(report, null, 2));
  writeFileSync(
    join(SCRATCH, "deep-zoom-quality.log"),
    JSON.stringify(report, null, 2) + "\n"
  );

  if (!report.pass) {
    throw new Error(
      "deep zoom quality failed: live unique=" +
        live.unique +
        " cpu=" +
        cpuQ.unique +
        " f32map=" +
        flatUnique
    );
  }
  console.log("DEEP ZOOM QUALITY PASS");

  await browser.close();
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
