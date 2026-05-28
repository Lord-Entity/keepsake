// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Unit tests for src/editor/ui/crop-math.ts: preset ratios, clamping, even rounding, resize/move,
 * screen <-> source mapping, zoom/pan and trim clamping. Pure geometry; no DOM.
 */
import { describe, expect, test } from "bun:test";
import {
  CROP_PRESETS,
  MAX_ZOOM,
  MIN_TRIM,
  MIN_ZOOM,
  applyPreset,
  clampRect,
  clampTrim,
  clampView,
  fitRatio,
  fitView,
  formatTime,
  fullRect,
  isFullFrame,
  minSide,
  moveRect,
  panBy,
  presetRatio,
  rectToScreen,
  resizeRect,
  roundCrop,
  toScreen,
  toSource,
  zoomAt,
} from "../ui/crop-math";

const HD = { width: 1920, height: 1080 };
const SQ = { width: 1000, height: 1000 };

function expectRect(actual, expected, digits = 6) {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.w).toBeCloseTo(expected.w, digits);
  expect(actual.h).toBeCloseTo(expected.h, digits);
}

function expectInside(r, size) {
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.y).toBeGreaterThanOrEqual(0);
  expect(r.x + r.w).toBeLessThanOrEqual(size.width + 1e-9);
  expect(r.y + r.h).toBeLessThanOrEqual(size.height + 1e-9);
}

describe("presets", () => {
  test("CROP_PRESETS lists every CropPreset in UI order", () => {
    expect([...CROP_PRESETS]).toEqual(["free", "original", "1:1", "4:5", "9:16", "16:9", "4:3", "3:4"]);
  });

  test("presetRatio returns w/h for fixed ratios", () => {
    expect(presetRatio("1:1", HD)).toBe(1);
    expect(presetRatio("4:5", HD)).toBeCloseTo(0.8, 10);
    expect(presetRatio("9:16", HD)).toBeCloseTo(0.5625, 10);
    expect(presetRatio("16:9", HD)).toBeCloseTo(16 / 9, 10);
    expect(presetRatio("4:3", HD)).toBeCloseTo(4 / 3, 10);
    expect(presetRatio("3:4", HD)).toBeCloseTo(0.75, 10);
  });

  test("free has no ratio; original uses the source ratio, or none for an empty source", () => {
    expect(presetRatio("free", HD)).toBeNull();
    expect(presetRatio("original", HD)).toBeCloseTo(16 / 9, 10);
    expect(presetRatio("original", { width: 0, height: 100 })).toBeNull();
  });

  test("applyPreset free keeps (clamped) current rect, original resets to the full frame", () => {
    expect(applyPreset({ x: 10, y: 20, w: 300, h: 200 }, "free", HD)).toEqual({ x: 10, y: 20, w: 300, h: 200 });
    expect(applyPreset({ x: 10, y: 20, w: 300, h: 200 }, "original", HD)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  test("applyPreset fits the largest rect of the ratio, centred on the current crop", () => {
    expectRect(applyPreset(fullRect(HD), "1:1", HD), { x: 420, y: 0, w: 1080, h: 1080 });
    expectRect(applyPreset(fullRect(HD), "9:16", HD), { x: 656.25, y: 0, w: 607.5, h: 1080 });
    expectRect(applyPreset(fullRect(SQ), "4:5", SQ), { x: 100, y: 0, w: 800, h: 1000 });
    expectRect(applyPreset(fullRect(SQ), "3:4", SQ), { x: 125, y: 0, w: 750, h: 1000 });
    expectRect(applyPreset(fullRect(SQ), "4:3", SQ), { x: 0, y: 125, w: 1000, h: 750 });
    expectRect(applyPreset(fullRect(SQ), "16:9", SQ), { x: 0, y: 218.75, w: 1000, h: 562.5 });
  });

  test("every fixed preset keeps its ratio and stays inside the source", () => {
    for (const size of [HD, SQ, { width: 1080, height: 1920 }]) {
      for (const p of ["1:1", "4:5", "9:16", "16:9", "4:3", "3:4"]) {
        const r = applyPreset({ x: 0, y: 0, w: 50, h: 50 }, p, size);
        expect(r.w / r.h).toBeCloseTo(presetRatio(p, size), 6);
        expectInside(r, size);
      }
    }
  });

  test("fitRatio shifts a rect centred near an edge back inside", () => {
    expectRect(fitRatio(1, HD, { x: 100, y: 540 }), { x: 0, y: 0, w: 1080, h: 1080 });
    expectRect(fitRatio(1, HD, { x: 1900, y: 540 }), { x: 840, y: 0, w: 1080, h: 1080 });
  });
});

describe("clamping", () => {
  test("minSide is 16 for normal sources, shrinks for tiny ones, never below 2", () => {
    expect(minSide(HD)).toBe(16);
    expect(minSide({ width: 10, height: 4 })).toBe(4);
    expect(minSide({ width: 1, height: 1 })).toBe(2);
  });

  test("fullRect and isFullFrame", () => {
    expect(fullRect(HD)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(isFullFrame(fullRect(HD), HD)).toBe(true);
    expect(isFullFrame({ x: 0.5, y: 0.5, w: 1919, h: 1079 }, HD)).toBe(true);
    expect(isFullFrame({ x: 2, y: 0, w: 1918, h: 1080 }, HD)).toBe(false);
  });

  test("oversized rect shrinks to the source", () => {
    expect(clampRect({ x: -10, y: -10, w: 5000, h: 5000 }, HD)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  test("rect past the right/bottom edge is pushed back, size kept", () => {
    expect(clampRect({ x: 1900, y: 1000, w: 100, h: 100 }, HD)).toEqual({ x: 1820, y: 980, w: 100, h: 100 });
  });

  test("tiny rect grows to the minimum side", () => {
    expect(clampRect({ x: 0, y: 0, w: 4, h: 4 }, HD)).toEqual({ x: 0, y: 0, w: 16, h: 16 });
  });

  test("non-finite values fall back to safe defaults", () => {
    expect(clampRect({ x: NaN, y: 5, w: NaN, h: 100 }, HD)).toEqual({ x: 0, y: 5, w: 1920, h: 100 });
  });
});

describe("roundCrop", () => {
  test("even rounding floors x/y/w/h to even integers", () => {
    expect(roundCrop({ x: 3.4, y: 5.6, w: 101.3, h: 99.7 }, HD, true)).toEqual({ x: 2, y: 6, w: 100, h: 100 });
  });

  test("odd rounding only rounds to integers", () => {
    expect(roundCrop({ x: 3.4, y: 5.6, w: 101.3, h: 99.7 }, HD, false)).toEqual({ x: 3, y: 6, w: 101, h: 100 });
  });

  test("full frame of an odd-sized source becomes the largest even rect", () => {
    const size = { width: 1081, height: 721 };
    expect(roundCrop(fullRect(size), size, true)).toEqual({ x: 0, y: 0, w: 1080, h: 720 });
  });

  test("rect touching the far edge stays inside after rounding", () => {
    const size = { width: 1001, height: 601 };
    expect(roundCrop({ x: 900.7, y: 500.9, w: 100.3, h: 100.1 }, size, true)).toEqual({ x: 900, y: 500, w: 100, h: 100 });
  });

  test("even results are always even, integer and inside the source", () => {
    const sizes = [HD, { width: 1081, height: 721 }, { width: 37, height: 23 }];
    const rects = [
      { x: 0, y: 0, w: 1e9, h: 1e9 },
      { x: 13.7, y: 9.2, w: 17.9, h: 17.1 },
      { x: 1e9, y: 1e9, w: 31, h: 33 },
      { x: -5, y: -5, w: 3, h: 3 },
    ];
    for (const size of sizes) {
      for (const r of rects) {
        const c = roundCrop(r, size, true);
        for (const v of [c.x, c.y, c.w, c.h]) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v % 2).toBe(0);
        }
        expect(c.w).toBeGreaterThanOrEqual(2);
        expect(c.h).toBeGreaterThanOrEqual(2);
        expectInside(c, size);
      }
    }
  });
});

describe("move and resize", () => {
  const start = { x: 100, y: 100, w: 200, h: 200 };

  test("moveRect stops at the edges", () => {
    expect(moveRect(start, 50, -20, HD)).toEqual({ x: 150, y: 80, w: 200, h: 200 });
    expect(moveRect(start, -500, -500, HD)).toEqual({ x: 0, y: 0, w: 200, h: 200 });
    expect(moveRect(start, 5000, 5000, HD)).toEqual({ x: 1720, y: 880, w: 200, h: 200 });
  });

  test("free resize moves only the dragged edges", () => {
    expect(resizeRect(start, "se", 50, 30, HD, null)).toEqual({ x: 100, y: 100, w: 250, h: 230 });
    expect(resizeRect(start, "e", 5000, 0, HD, null)).toEqual({ x: 100, y: 100, w: 1820, h: 200 });
    expect(resizeRect(start, "w", 500, 0, HD, null)).toEqual({ x: 284, y: 100, w: 16, h: 200 });
  });

  test("ratio corner resize follows the dominant axis and keeps the ratio", () => {
    expect(resizeRect(start, "se", 50, 10, HD, 1)).toEqual({ x: 100, y: 100, w: 250, h: 250 });
  });

  test("ratio corner resize stops at the source edge", () => {
    expect(resizeRect(start, "nw", -500, -500, HD, 1)).toEqual({ x: 0, y: 0, w: 300, h: 300 });
  });

  test("ratio edge resize grows the other axis symmetrically", () => {
    expect(resizeRect(start, "e", 100, 0, HD, 1)).toEqual({ x: 100, y: 50, w: 300, h: 300 });
    expect(resizeRect(start, "n", 0, -50, HD, 1)).toEqual({ x: 75, y: 50, w: 250, h: 250 });
  });
});

describe("screen <-> source mapping, zoom and pan", () => {
  test("fitView centres the source inside the padded stage", () => {
    expect(fitView({ width: 848, height: 648 }, { width: 1600, height: 1200 }, 24)).toEqual({ scale: 0.5, tx: 24, ty: 24 });
  });

  test("toScreen and toSource are inverses", () => {
    const v = { scale: 0.5, tx: 24, ty: 24 };
    expect(toScreen({ x: 100, y: 200 }, v)).toEqual({ x: 74, y: 124 });
    expect(toSource({ x: 74, y: 124 }, v)).toEqual({ x: 100, y: 200 });

    const odd = { scale: 1.37, tx: -311.5, ty: 42.25 };
    for (const p of [{ x: 0, y: 0 }, { x: 1919, y: 1079 }, { x: 333.3, y: 777.7 }]) {
      const back = toSource(toScreen(p, odd), odd);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  test("rectToScreen scales size and offsets position", () => {
    expect(rectToScreen({ x: 100, y: 200, w: 50, h: 60 }, { scale: 0.5, tx: 24, ty: 24 })).toEqual({ x: 74, y: 124, w: 25, h: 30 });
  });

  test("zoomAt keeps the source point under the cursor fixed", () => {
    const v = { scale: 1, tx: 0, ty: 0 };
    const at = { x: 100, y: 50 };
    const z = zoomAt(v, 2, at, 1);
    expect(z).toEqual({ scale: 2, tx: -100, ty: -50 });
    expect(toSource(at, z)).toEqual(toSource(at, v));

    const v2 = { scale: 0.7, tx: 13, ty: -9 };
    const at2 = { x: 321, y: 123 };
    const z2 = zoomAt(v2, 1.5, at2, 0.7);
    const a = toSource(at2, v2);
    const b = toSource(at2, z2);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
  });

  test("zoomAt is limited to [MIN_ZOOM, MAX_ZOOM] x fit scale", () => {
    const v = { scale: 1, tx: 0, ty: 0 };
    expect(zoomAt(v, 100, { x: 0, y: 0 }, 1).scale).toBe(MAX_ZOOM);
    expect(zoomAt(v, 0.01, { x: 0, y: 0 }, 1).scale).toBe(MIN_ZOOM);
  });

  test("panBy offsets the view; clampView keeps part of the source on stage", () => {
    expect(panBy({ scale: 2, tx: 1, ty: 2 }, 10, -5)).toEqual({ scale: 2, tx: 11, ty: -3 });
    const stage = { width: 800, height: 600 };
    const src = { width: 1600, height: 1200 };
    expect(clampView({ scale: 0.5, tx: 10000, ty: -10000 }, stage, src)).toEqual({ scale: 0.5, tx: 752, ty: -552 });
    expect(clampView({ scale: 0.5, tx: 5, ty: 6 }, stage, src)).toEqual({ scale: 0.5, tx: 5, ty: 6 });
  });
});

describe("trim", () => {
  test("moving start pushes end to keep MIN_TRIM", () => {
    const [s, e] = clampTrim(5, 3, 10, "start");
    expect(s).toBe(5);
    expect(e).toBeCloseTo(5 + MIN_TRIM, 9);
  });

  test("start is clamped to [0, duration - MIN_TRIM]", () => {
    expect(clampTrim(-1, 8, 10, "start")).toEqual([0, 8]);
    const [s, e] = clampTrim(12, 20, 10, "start");
    expect(s).toBeCloseTo(10 - MIN_TRIM, 9);
    expect(e).toBe(10);
  });

  test("moving end pushes start back to keep MIN_TRIM", () => {
    const [s, e] = clampTrim(5, 4.95, 10, "end");
    expect(e).toBe(4.95);
    expect(s).toBeCloseTo(4.85, 9);
    const [s2, e2] = clampTrim(0, 0, 10, "end");
    expect(s2).toBe(0);
    expect(e2).toBeCloseTo(MIN_TRIM, 9);
  });

  test("zero duration collapses to [0, 0]", () => {
    expect(clampTrim(0, 0, 0, "start")).toEqual([0, 0]);
    expect(clampTrim(3, 5, 0, "end")).toEqual([0, 0]);
  });

  test("results always satisfy validateJob's invariant 0 <= s < e <= duration", () => {
    for (const [a, b, which] of [[0, 10, "start"], [9.99, 1, "start"], [3, 3, "end"], [-4, 50, "end"]]) {
      const [s, e] = clampTrim(a, b, 10, which);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(e).toBeGreaterThan(s);
      expect(e).toBeLessThanOrEqual(10);
    }
  });
});

describe("formatTime", () => {
  test("m:ss.t and h:mm:ss.t", () => {
    expect(formatTime(0)).toBe("0:00.0");
    expect(formatTime(65.25)).toBe("1:05.2");
    expect(formatTime(3725.5)).toBe("1:02:05.5");
  });

  test("negative and non-finite become 0", () => {
    expect(formatTime(-5)).toBe("0:00.0");
    expect(formatTime(NaN)).toBe("0:00.0");
  });
});
