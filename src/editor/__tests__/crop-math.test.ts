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
  drawRect,
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

  test("out-of-range input is clamped inside the source and clamping is idempotent", () => {
    // w, h -> 16 (minimum); x -> 0; y = 2000 -> 1080 - 16 = 1064.
    const c = clampRect({ x: -50, y: 2000, w: -10, h: 0 }, HD);
    expect(c).toEqual({ x: 0, y: 1064, w: 16, h: 16 });
    expect(clampRect(c, HD)).toEqual(c);
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

  test("rounding twice gives the same rect (stable)", () => {
    // 37x23: {13.7,9.2,17.9,17.1} -> {14,6,18,16}; HD: {3.4,5.6,101.3,99.7} -> {2,6,100,100}.
    const small = { width: 37, height: 23 };
    const a = roundCrop({ x: 13.7, y: 9.2, w: 17.9, h: 17.1 }, small, true);
    expect(a).toEqual({ x: 14, y: 6, w: 18, h: 16 });
    expect(roundCrop(a, small, true)).toEqual(a);
    const b = roundCrop({ x: 3.4, y: 5.6, w: 101.3, h: 99.7 }, HD, true);
    expect(b).toEqual({ x: 2, y: 6, w: 100, h: 100 });
    expect(roundCrop(b, HD, true)).toEqual(b);
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

  test("free resize never shrinks below the minimum side", () => {
    // right = clamp(300 - 5000, 100 + 16, 1920) = 116; bottom likewise.
    expect(resizeRect(start, "se", -5000, -5000, HD, null)).toEqual({ x: 100, y: 100, w: 16, h: 16 });
  });

  test("ratio corner resize is limited by the bottom edge and keeps the ratio", () => {
    // wx = wy = 5200; maxW = min(1920 - 100, (1080 - 100) * 1) = 980; w = h = 980 -> bottom = 1080.
    const r = resizeRect(start, "se", 5000, 5000, HD, 1);
    expect(r).toEqual({ x: 100, y: 100, w: 980, h: 980 });
    expectInside(r, HD);
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

  test("the full source maps to the padded stage and back", () => {
    const v = fitView({ width: 848, height: 648 }, { width: 1600, height: 1200 }, 24);
    expect(rectToScreen(fullRect({ width: 1600, height: 1200 }), v)).toEqual({ x: 24, y: 24, w: 800, h: 600 });
    expect(toSource({ x: 24, y: 24 }, v)).toEqual({ x: 0, y: 0 });
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

describe("drawRect", () => {
  test("free drag down-right keeps the anchor at the start", () => {
    // dx = 400-100 = 300, dy = 250-50 = 200; both above MIN_CROP; x=ax, y=ay.
    expect(drawRect({ x: 100, y: 50 }, { x: 400, y: 250 }, HD, null)).toEqual({ x: 100, y: 50, w: 300, h: 200 });
  });

  test("free drag up-left keeps the anchor as the bottom-right corner", () => {
    // w = |200-500| = 300, h = |100-400| = 300; sx = sy = -1 so x = 500-300 = 200, y = 400-300 = 100.
    expect(drawRect({ x: 500, y: 400 }, { x: 200, y: 100 }, HD, null)).toEqual({ x: 200, y: 100, w: 300, h: 300 });
  });

  test("pointer beyond the source is clamped to its edges", () => {
    // to -> (1920, 1080); w = 1920-1800 = 120, h = 1080-1000 = 80; x+w = 1920, y+h = 1080.
    const r = drawRect({ x: 1800, y: 1000 }, { x: 5000, y: 5000 }, HD, null);
    expect(r).toEqual({ x: 1800, y: 1000, w: 120, h: 80 });
    expect(r.x + r.w).toBe(1920);
    expect(r.y + r.h).toBe(1080);
  });

  test("tiny drag gets the minimum side and is shifted inside at the edge", () => {
    // to clamps to (1920, 1080) = anchor, so w = h = 0 -> minSide 16; x = 1920 clamps to 1920-16 = 1904, y to 1080-16 = 1064.
    expect(minSide(HD)).toBe(16);
    const r = drawRect({ x: 1920, y: 1080 }, { x: 5000, y: 5000 }, HD, null);
    expect(r).toEqual({ x: 1904, y: 1064, w: 16, h: 16 });
    // Same for a tiny drag in the middle: 2px -> 16px, anchor stays.
    expect(drawRect({ x: 500, y: 500 }, { x: 502, y: 501 }, HD, null)).toEqual({ x: 500, y: 500, w: 16, h: 16 });
  });

  test("ratio 1 uses the dominant axis", () => {
    // dx = 300, dy = 100; roomX = 1920, roomY = 1080; w = max(min(max(300, 100*1), 1920, 1080*1), 16) = 300; h = 300.
    const r = drawRect({ x: 0, y: 0 }, { x: 300, y: 100 }, HD, 1);
    expectRect(r, { x: 0, y: 0, w: 300, h: 300 });
    expect(r.w).toBe(r.h);
  });

  test("ratio 16/9 is limited by the room below the anchor", () => {
    // w0 = 1920, h0 = 180; roomX = 1920, roomY = 1080-900 = 180 -> roomY*16/9 = 320;
    // w = max(min(max(1920, 320), 1920, 320), 16) = 320; h = 320 / (16/9) = 180.
    const r = drawRect({ x: 0, y: 900 }, { x: 1920, y: 1080 }, HD, 16 / 9);
    expectRect(r, { x: 0, y: 900, w: 320, h: 180 });
  });

  test("NaN inputs do not produce NaN", () => {
    // anchor NaN -> (0, 0); to (100, 100) -> 100x100 at the origin.
    expect(drawRect({ x: NaN, y: NaN }, { x: 100, y: 100 }, HD, null)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    // to NaN -> falls back to the anchor -> tiny drag -> 16x16.
    expect(drawRect({ x: 200, y: 300 }, { x: NaN, y: NaN }, HD, null)).toEqual({ x: 200, y: 300, w: 16, h: 16 });
    for (const v of Object.values(drawRect({ x: NaN, y: NaN }, { x: NaN, y: NaN }, HD, 4 / 5))) expect(Number.isNaN(v)).toBe(false);
  });

  test("always inside the source and keeps the ratio", () => {
    const anchors = [
      { x: 0, y: 0 },
      { x: 960, y: 540 },
      { x: 1900, y: 1070 },
      { x: 100, y: 1000 },
      { x: 1500, y: 30 },
    ];
    const targets = [
      { x: 0, y: 0 },
      { x: 300, y: 700 },
      { x: 1919, y: 1079 },
      { x: 1200, y: 20 },
      { x: -50, y: 2000 },
      { x: 3000, y: -10 },
    ];
    for (const ratio of [4 / 5, 9 / 16]) {
      for (const a of anchors) {
        for (const t of targets) {
          const r = drawRect(a, t, HD, ratio);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(HD.width + 1e-9);
          expect(r.y + r.h).toBeLessThanOrEqual(HD.height + 1e-9);
          expect(Math.abs(r.w / r.h - ratio)).toBeLessThan(1e-9);
        }
      }
    }
  });
});
