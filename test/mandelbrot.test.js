/**
 * Unit tests against the pure math shipped in index.html (globalThis.MandelbrotMath).
 * Loads the real script with minimal DOM stubs — does not re-implement escape-time logic.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const HTML_PATH = path.join(ROOT, "index.html");

function loadShippedMath() {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "index.html must contain an inline <script> block");
  const script = match[1];

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
    // Prefer failing WebGL so Node tests exercise math + CPU fallback cleanly
    getContext: (type) => {
      if (type === "webgl" || type === "experimental-webgl") return null;
      return ctx2d;
    },
    style: {},
    addEventListener: noop,
    setPointerCapture: noop,
    classList: { add: noop, remove: noop },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    width: 800,
    height: 600,
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
    performance: { now: () => Date.now() },
    requestAnimationFrame: noop,
    globalThis: null,
    window: {
      devicePixelRatio: 1,
      innerWidth: 800,
      innerHeight: 600,
      addEventListener: noop
    },
    document: {
      getElementById: () => el
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = sandbox.document;

  vm.runInNewContext(script, sandbox, { filename: "index.html#script" });
  assert.ok(sandbox.MandelbrotMath, "script must export globalThis.MandelbrotMath");
  return sandbox.MandelbrotMath;
}

const M = loadShippedMath();
const {
  mandelbrotEscape,
  pixelToComplex,
  zoomAtPoint,
  panByPixels,
  zoomToRect
} = M;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    console.error("  FAIL " + name);
    console.error("       " + (e.stack || e.message));
    process.exitCode = 1;
  }
}

console.log("mandelbrot escape-time (shipped mandelbrotEscape)");

test("c=0 is in the set (does not escape)", () => {
  const n = mandelbrotEscape(0, 0, 200);
  assert.strictEqual(n, 200);
});

test("c=-1 is in the set (period-2 bulb)", () => {
  const n = mandelbrotEscape(-1, 0, 200);
  assert.strictEqual(n, 200);
});

test("c=i escapes (known exterior near imaginary axis)", () => {
  // i is on the boundary of the period-2 bulb; use a point clearly outside
  const n = mandelbrotEscape(0, 1.1, 200);
  assert.ok(n < 200, "expected escape, got " + n);
});

test("c=2 escapes immediately", () => {
  const n = mandelbrotEscape(2, 0, 200);
  assert.ok(n < 10, "c=2 should escape very quickly, got " + n);
});

test("c=0.25 is near cardioid cusp — still bounded for moderate iter", () => {
  // Exactly 0.25 is on the boundary; slightly inside
  const n = mandelbrotEscape(0.24, 0, 500);
  assert.strictEqual(n, 500);
});

test("c=0.26 just outside main cardioid escapes", () => {
  const n = mandelbrotEscape(0.26, 0, 500);
  assert.ok(n < 500, "expected exterior, got " + n);
});

test("exterior iteration counts are finite and positive", () => {
  const n = mandelbrotEscape(1, 0, 100);
  assert.ok(n >= 1 && n < 100);
});

test("far exterior escapes in fewer iterations than near-boundary exterior", () => {
  const far = mandelbrotEscape(10, 0, 1000);
  const near = mandelbrotEscape(0.26, 0, 1000);
  assert.ok(far < near, "far=" + far + " near=" + near);
});

test("classical rule: z←z²+c — known seahorses region exterior sample", () => {
  // Point deep in a typical exterior band should escape
  const n = mandelbrotEscape(-0.75, 0.1, 300);
  // -0.75 is on the cardioid/bulb junction on real axis; with imag 0.1 may be in or out
  // Use a clear exterior: 0.5 + 0.5i
  const n2 = mandelbrotEscape(0.5, 0.5, 300);
  assert.ok(n2 < 20, "0.5+0.5i should escape fast, got " + n2);
});

console.log("\nview transforms (shipped pixelToComplex / zoomAtPoint / panByPixels)");

const W = 800, H = 600;
const CX = -0.5, CY = 0, PW = 3.5;

test("pixel center maps to view center", () => {
  const p = pixelToComplex(W / 2, H / 2, W, H, CX, CY, PW);
  assert.ok(Math.abs(p.re - CX) < 1e-12, "re " + p.re);
  assert.ok(Math.abs(p.im - CY) < 1e-12, "im " + p.im);
});

test("pixel left edge is center - planeWidth/2", () => {
  const p = pixelToComplex(0, H / 2, W, H, CX, CY, PW);
  assert.ok(Math.abs(p.re - (CX - PW / 2)) < 1e-12, "re " + p.re);
});

test("zoom-in shrinks plane width", () => {
  const z = zoomAtPoint(W / 2, H / 2, W, H, CX, CY, PW, 0.5);
  assert.ok(z.planeWidth < PW, "width " + z.planeWidth);
  assert.ok(Math.abs(z.planeWidth - PW * 0.5) < 1e-12);
});

test("zoom-at-point keeps pointed complex coordinate fixed", () => {
  const px = 200, py = 150;
  const before = pixelToComplex(px, py, W, H, CX, CY, PW);
  const z = zoomAtPoint(px, py, W, H, CX, CY, PW, 0.25);
  const after = pixelToComplex(px, py, W, H, z.centerX, z.centerY, z.planeWidth);
  assert.ok(Math.abs(before.re - after.re) < 1e-9, "re " + before.re + " vs " + after.re);
  assert.ok(Math.abs(before.im - after.im) < 1e-9, "im " + before.im + " vs " + after.im);
});

test("zoom-out grows plane width", () => {
  const z = zoomAtPoint(W / 2, H / 2, W, H, CX, CY, PW, 2);
  assert.ok(z.planeWidth > PW);
});

test("pan right moves complex center left (content follows pointer)", () => {
  const next = panByPixels(100, 0, W, H, CX, CY, PW);
  assert.ok(next.centerX < CX, "centerX " + next.centerX);
  assert.strictEqual(next.planeWidth, PW);
});

test("pan down moves complex center up (screen y down)", () => {
  const next = panByPixels(0, 50, W, H, CX, CY, PW);
  assert.ok(next.centerY > CY, "centerY " + next.centerY);
});

test("pan delta magnitude matches plane scale", () => {
  const dx = 80; // pixels
  const next = panByPixels(dx, 0, W, H, CX, CY, PW);
  const expected = CX - (dx / W) * PW;
  assert.ok(Math.abs(next.centerX - expected) < 1e-12);
});

console.log("\nzoom-to-rect (shipped zoomToRect)");

test("zoomToRect is exported", () => {
  assert.strictEqual(typeof zoomToRect, "function");
});

test("zoomToRect centers on selection midpoint", () => {
  // Center half of the canvas
  const x0 = W * 0.25, x1 = W * 0.75;
  const y0 = H * 0.25, y1 = H * 0.75;
  const z = zoomToRect(x0, y0, x1, y1, W, H, CX, CY, PW);
  assert.ok(z, "expected a view");
  const mid = pixelToComplex((x0 + x1) / 2, (y0 + y1) / 2, W, H, CX, CY, PW);
  assert.ok(Math.abs(z.centerX - mid.re) < 1e-9, "cx " + z.centerX + " vs " + mid.re);
  assert.ok(Math.abs(z.centerY - mid.im) < 1e-9, "cy " + z.centerY + " vs " + mid.im);
});

test("zoomToRect shrinks plane width for a smaller selection", () => {
  const z = zoomToRect(W * 0.25, H * 0.25, W * 0.75, H * 0.75, W, H, CX, CY, PW);
  assert.ok(z.planeWidth < PW, "width " + z.planeWidth);
  // Half the pixels in each axis → half plane span when aspect matches
  assert.ok(Math.abs(z.planeWidth - PW * 0.5) < 1e-9, "expected half width, got " + z.planeWidth);
});

test("zoomToRect expands short side to match canvas aspect", () => {
  // Very wide short box: height is limiting; planeWidth should fit height
  const x0 = 100, x1 = 700, y0 = 290, y1 = 310; // 600×20 px
  const z = zoomToRect(x0, y0, x1, y1, W, H, CX, CY, PW);
  assert.ok(z);
  const aspect = W / H;
  const c0 = pixelToComplex(x0, y0, W, H, CX, CY, PW);
  const c1 = pixelToComplex(x1, y1, W, H, CX, CY, PW);
  const selW = Math.abs(c1.re - c0.re);
  const selH = Math.abs(c1.im - c0.im);
  const expected = Math.max(selW, selH * aspect);
  assert.ok(Math.abs(z.planeWidth - expected) < 1e-9, z.planeWidth + " vs " + expected);
  // Selection height should equal (or be less than) new plane height
  const newPlaneH = z.planeWidth / aspect;
  assert.ok(selH <= newPlaneH + 1e-9);
  // Full selection width fits
  assert.ok(selW <= z.planeWidth + 1e-9);
});

test("zoomToRect returns null for tiny rects", () => {
  assert.strictEqual(zoomToRect(10, 10, 12, 12, W, H, CX, CY, PW), null);
});

test("zoomToRect is order-independent", () => {
  const a = zoomToRect(100, 100, 400, 300, W, H, CX, CY, PW);
  const b = zoomToRect(400, 300, 100, 100, W, H, CX, CY, PW);
  assert.ok(a && b);
  assert.ok(Math.abs(a.centerX - b.centerX) < 1e-12);
  assert.ok(Math.abs(a.centerY - b.centerY) < 1e-12);
  assert.ok(Math.abs(a.planeWidth - b.planeWidth) < 1e-12);
});

// Structural checks on the HTML artifact
console.log("\nstatic structure (index.html)");

const html = fs.readFileSync(HTML_PATH, "utf8");

test("single self-contained HTML with canvas", () => {
  assert.ok(/<canvas\b/i.test(html));
  assert.ok(/mandelbrotEscape/.test(html));
  assert.ok(/zoomAtPoint/.test(html));
  assert.ok(/panByPixels/.test(html));
});

test("no remote CDN scripts for core function", () => {
  const remote = html.match(/<script[^>]+src=["']https?:\/\//gi);
  assert.ok(!remote, "found remote script: " + remote);
  const remoteCss = html.match(/<link[^>]+href=["']https?:\/\//gi);
  assert.ok(!remoteCss, "found remote stylesheet: " + remoteCss);
});

test("wheel and pointer handlers present", () => {
  assert.ok(/addEventListener\(\s*["']wheel["']/.test(html));
  assert.ok(/addEventListener\(\s*["']pointerdown["']/.test(html));
  assert.ok(/addEventListener\(\s*["']pointermove["']/.test(html));
});

test("ctrl marquee zoom bindings present", () => {
  assert.ok(/ctrlKey/.test(html));
  assert.ok(/zoomToRect/.test(html));
  assert.ok(/marquee/.test(html));
});

test("WebGL paint path + CPU fallback present", () => {
  assert.ok(/getContext\(\s*["']webgl["']/.test(html));
  assert.ok(/paintCpuFullFrame/.test(html));
  assert.ok(/FRAGMENT_SHADER|fragment/i.test(html));
  assert.ok(/MandelbrotApp/.test(html));
});

test("shipped paintCpuFullFrame produces filled buffer", () => {
  assert.strictEqual(typeof M.paintCpuFullFrame, "function");
  const w = 32,
    h = 24;
  const buf = M.paintCpuFullFrame(w, h, -0.5, 0, 3.5, 64);
  assert.strictEqual(buf.length, w * h * 4);
  let nonBlack = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i] + buf[i + 1] + buf[i + 2] > 40) nonBlack++;
  }
  assert.ok(nonBlack > w * h * 0.1, "expected exterior colors, nonBlack=" + nonBlack);
});

test("minimal chrome: reset control only (sparse UI)", () => {
  assert.ok(/btn-reset|Reset/.test(html));
  // No cluttered toolbar of many buttons
  const buttons = html.match(/<button\b/gi) || [];
  assert.ok(buttons.length <= 3, "too many buttons: " + buttons.length);
});

if (process.exitCode) {
  console.log("\nSOME TESTS FAILED");
} else {
  console.log("\nAll " + passed + " tests passed.");
}
