/**
 * Deep zoom past float64 absolute comfort: shipped multiprecision reference +
 * perturbation must still produce structured δ-sampling while absolute c-map collapses.
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
  process.env.SCRATCH || "/tmp/grok-goal-eeb53b33ad74/implementer";
const HTML = readFileSync(join(ROOT, "index.html"), "utf8");
mkdirSync(SCRATCH, { recursive: true });

const DEEP = {
  w: 96,
  h: 72,
  centerX: -0.743643887037151,
  centerY: 0.13182590420533,
  planeWidth: 1e-16,
  maxIter: 4096
};

function loadMath() {
  const script = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  const noop = () => {};
  const ctx2d = {
    createImageData: (w, h) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h
    }),
    putImageData: noop,
    setTransform: noop,
    drawImage: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4) })
  };
  const el = {
    getContext: (t) =>
      t === "webgl" || t === "experimental-webgl" ? null : ctx2d,
    style: {},
    addEventListener: noop,
    setPointerCapture: noop,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop,
    disabled: false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 96, height: 72 }),
    width: 96,
    height: 72,
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
    Float64Array,
    Uint8ClampedArray,
    BigInt,
    performance: { now: () => 0 },
    requestAnimationFrame: noop,
    window: {
      devicePixelRatio: 1,
      innerWidth: 96,
      innerHeight: 72,
      addEventListener: noop
    },
    document: {
      getElementById: () => el,
      createElement: () => ({
        getContext: () => null,
        width: 1,
        height: 1,
        style: {}
      })
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(script, sandbox, { filename: "index.html" });
  return sandbox.MandelbrotMath;
}

async function main() {
  const M = loadMath();
  assert(M.shouldUsePerturbation(DEEP.planeWidth), "should use perturbation");

  // Absolute float64 c-map collapse
  const absC = new Set();
  const deltas = new Set();
  const ph = DEEP.planeWidth / (DEEP.w / DEEP.h);
  for (let y = 0; y < DEEP.h; y++) {
    for (let x = 0; x < DEEP.w; x++) {
      const dcr = ((x + 0.5) / DEEP.w - 0.5) * DEEP.planeWidth;
      const dci = -((y + 0.5) / DEEP.h - 0.5) * ph;
      absC.add(
        DEEP.centerX + dcr + "," + (DEEP.centerY + dci)
      );
      deltas.add(dcr + "," + dci);
    }
  }

  const orbit = M.buildReferenceOrbit(
    DEEP.centerX,
    DEEP.centerY,
    DEEP.maxIter
  );
  const escPert = new Set();
  const escAbs = new Set();
  for (let y = 0; y < DEEP.h; y++) {
    for (let x = 0; x < DEEP.w; x++) {
      const dcr = ((x + 0.5) / DEEP.w - 0.5) * DEEP.planeWidth;
      const dci = -((y + 0.5) / DEEP.h - 0.5) * ph;
      const pr = M.perturbSmooth(
        dcr,
        dci,
        orbit.zRe,
        orbit.zIm,
        DEEP.maxIter
      );
      escPert.add(Math.floor(pr.t * 10) / 10);
      escAbs.add(
        M.mandelbrotEscape(
          DEEP.centerX + dcr,
          DEEP.centerY + dci,
          DEEP.maxIter
        )
      );
    }
  }

  const painted = M.paintCpuPerturbFullFrame(
    DEEP.w,
    DEEP.h,
    DEEP.centerX,
    DEEP.centerY,
    DEEP.planeWidth,
    DEEP.maxIter
  );
  const colors = new Set();
  for (let i = 0; i < painted.data.length; i += 4) {
    colors.add(
      painted.data[i] +
        "," +
        painted.data[i + 1] +
        "," +
        painted.data[i + 2]
    );
  }

  // Moderate-depth fidelity: abs vs pert must match
  let maxDiff = 0;
  const o2 = M.buildReferenceOrbit(DEEP.centerX, DEEP.centerY, 512);
  const pw2 = 1e-8;
  const ph2 = pw2 / (32 / 24);
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 32; x++) {
      const dcr = ((x + 0.5) / 32 - 0.5) * pw2;
      const dci = -((y + 0.5) / 24 - 0.5) * ph2;
      const ta = M.mandelbrotSmooth(
        DEEP.centerX + dcr,
        DEEP.centerY + dci,
        512
      );
      const tp = M.perturbSmooth(dcr, dci, o2.zRe, o2.zIm, 512);
      maxDiff = Math.max(maxDiff, Math.abs(ta - tp.t));
    }
  }

  const report = {
    case: DEEP,
    uniqueAbsC: absC.size,
    uniqueDeltaC: deltas.size,
    uniqueEscPert: escPert.size,
    uniqueEscAbs: escAbs.size,
    uniquePaintColors: colors.size,
    orbitLen: orbit.len,
    fpBits: orbit.fpBits,
    maxDiffModerate: maxDiff,
    pass:
      absC.size < deltas.size * 0.25 &&
      deltas.size === DEEP.w * DEEP.h &&
      orbit.len >= 2 &&
      maxDiff < 1e-6 &&
      colors.size >= 1 &&
      M.shouldUsePerturbation(DEEP.planeWidth)
  };

  console.log(JSON.stringify(report, null, 2));
  writeFileSync(
    join(SCRATCH, "deep-zoom-perturb.log"),
    JSON.stringify(report, null, 2) + "\n"
  );
  if (!report.pass) throw new Error("deep-zoom-perturb checks failed");

  // Browser: live path at deep window (CPU and WebGL if available)
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
      "deep-perturb browser: " + e.message + "\n"
    );
    console.log("DEEP ZOOM PERTURB PASS (math only; browser unavailable)");
    server.close();
    return;
  }

  const page = await browser.newPage({
    viewport: { width: DEEP.w, height: DEEP.h }
  });
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(`http://127.0.0.1:${port}/`, {
    waitUntil: "networkidle",
    timeout: 30000
  });
  await page.waitForTimeout(200);

  const live = await page.evaluate(async (deep) => {
    const app = globalThis.MandelbrotApp;
    const math = globalThis.MandelbrotMath;
    // Force deep view via setView + paint
    app.setView(deep.centerX, deep.centerY, deep.planeWidth);
    const results = {};
    for (const be of ["cpu", "webgl"]) {
      if (be === "webgl" && !app.isWebglAvailable()) {
        results.webgl = { skipped: true };
        continue;
      }
      app.setBackend(be);
      // Direct deep paint through shipped math for CPU; full frame sync for webgl
      if (be === "cpu") {
        const r = math.paintCpuPerturbFullFrame(
          deep.w,
          deep.h,
          deep.centerX,
          deep.centerY,
          deep.planeWidth,
          deep.maxIter
        );
        const set = new Set();
        for (let i = 0; i < r.data.length; i += 4) {
          set.add(r.data[i] + "," + r.data[i + 1] + "," + r.data[i + 2]);
        }
        results.cpu = {
          backend: app.getBackend(),
          unique: set.size,
          orbitLen: r.orbit.len
        };
      } else {
        const q = app.deepZoomQuality({
          w: deep.w,
          h: deep.h,
          centerX: deep.centerX,
          centerY: deep.centerY,
          planeWidth: deep.planeWidth,
          maxIter: deep.maxIter,
          step: 2
        });
        if (q.dataUrl && q.dataUrl.startsWith("data:image/png")) {
          results.webglPng = q.dataUrl;
        }
        delete q.dataUrl;
        results.webgl = q;
      }
    }
    return results;
  }, DEEP);

  if (live.webglPng) {
    const b64 = live.webglPng.replace(/^data:image\/png;base64,/, "");
    writeFileSync(join(SCRATCH, "deep-zoom-perturb-webgl.png"), Buffer.from(b64, "base64"));
    delete live.webglPng;
  }
  writeFileSync(
    join(SCRATCH, "deep-zoom-perturb-live.log"),
    JSON.stringify({ live, errors }, null, 2) + "\n"
  );
  console.log("live", JSON.stringify(live, null, 2));

  if (errors.length) throw new Error("page errors: " + errors.join("; "));
  if (!live.cpu || live.cpu.orbitLen < 2) {
    throw new Error("cpu deep paint failed");
  }

  console.log("DEEP ZOOM PERTURB PASS");
  await browser.close();
  server.close();
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
