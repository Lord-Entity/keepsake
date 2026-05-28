// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Unit tests for src/editor/types.ts: validateJob (every branch) and EditorError. Pure; no Tauri, no DOM.
 */
import { describe, expect, test } from "bun:test";
import { EditorError, validateJob } from "../types";

const videoProbe = { width: 1920, height: 1080, duration: 10, hasAudio: true, rotation: 0 };
const photoProbe = { width: 4000, height: 3000, duration: 0, hasAudio: false, rotation: 0 };

function videoJob(over = {}) {
  return { input: { kind: "video", name: "clip.mp4", path: "C:/v/clip.mp4" }, audio: true, output: "mp4", ...over };
}
function photoJob(over = {}) {
  return { input: { kind: "photo", name: "pic.jpg", path: "C:/p/pic.jpg" }, audio: false, output: "jpg", ...over };
}

describe("validateJob: valid jobs", () => {
  test("plain video job with no crop or trim is valid", () => {
    expect(validateJob(videoJob(), videoProbe)).toBeNull();
  });

  test("plain photo job to jpg and png is valid", () => {
    expect(validateJob(photoJob(), photoProbe)).toBeNull();
    expect(validateJob(photoJob({ output: "png" }), photoProbe)).toBeNull();
  });

  test("full-frame crop is valid", () => {
    expect(validateJob(videoJob({ crop: { x: 0, y: 0, w: 1920, h: 1080 } }), videoProbe)).toBeNull();
  });

  test("crop overshooting by up to 0.5px is tolerated", () => {
    expect(validateJob(videoJob({ crop: { x: 0.5, y: 0.5, w: 1920, h: 1080 } }), videoProbe)).toBeNull();
  });

  test("smallest allowed crop is 2x2", () => {
    expect(validateJob(photoJob({ crop: { x: 10, y: 10, w: 2, h: 2 } }), photoProbe)).toBeNull();
  });

  test("trim inside the duration is valid, end may exceed duration by up to 0.05s", () => {
    expect(validateJob(videoJob({ trimStart: 1, trimEnd: 9 }), videoProbe)).toBeNull();
    expect(validateJob(videoJob({ trimStart: 0, trimEnd: 10.05 }), videoProbe)).toBeNull();
    expect(validateJob(videoJob({ trimStart: 9.9 }), videoProbe)).toBeNull();
    expect(validateJob(videoJob({ trimEnd: 0.1 }), videoProbe)).toBeNull();
  });

  test("audio flag does not affect validity", () => {
    expect(validateJob(videoJob({ audio: false }), videoProbe)).toBeNull();
  });

  test("trim fields on a photo are ignored", () => {
    expect(validateJob(photoJob({ trimStart: 5, trimEnd: 1 }), photoProbe)).toBeNull();
  });
});

describe("validateJob: crop errors", () => {
  test("non-finite crop values", () => {
    for (const crop of [
      { x: NaN, y: 0, w: 10, h: 10 },
      { x: 0, y: Infinity, w: 10, h: 10 },
      { x: 0, y: 0, w: -Infinity, h: 10 },
      { x: 0, y: 0, w: 10, h: NaN },
      { x: "1", y: 0, w: 10, h: 10 },
    ]) {
      expect(validateJob(videoJob({ crop }), videoProbe)).toBe("Crop is not a number");
    }
  });

  test("crop narrower or shorter than 2px", () => {
    expect(validateJob(videoJob({ crop: { x: 0, y: 0, w: 1, h: 100 } }), videoProbe)).toBe("Crop is too small");
    expect(validateJob(videoJob({ crop: { x: 0, y: 0, w: 100, h: 1.9 } }), videoProbe)).toBe("Crop is too small");
    expect(validateJob(videoJob({ crop: { x: 0, y: 0, w: 0, h: 0 } }), videoProbe)).toBe("Crop is too small");
  });

  test("crop outside the picture on each side", () => {
    const msg = "Crop is outside the picture";
    expect(validateJob(videoJob({ crop: { x: -1, y: 0, w: 100, h: 100 } }), videoProbe)).toBe(msg);
    expect(validateJob(videoJob({ crop: { x: 0, y: -0.1, w: 100, h: 100 } }), videoProbe)).toBe(msg);
    expect(validateJob(videoJob({ crop: { x: 1, y: 0, w: 1920, h: 100 } }), videoProbe)).toBe(msg);
    expect(validateJob(videoJob({ crop: { x: 0, y: 0, w: 100, h: 1081 } }), videoProbe)).toBe(msg);
  });

  test("overshoot beyond the 0.5px tolerance is rejected (1920.6 > 1920.5, 1080.6 > 1080.5)", () => {
    const msg = "Crop is outside the picture";
    expect(validateJob(videoJob({ crop: { x: 0.6, y: 0, w: 1920, h: 1080 } }), videoProbe)).toBe(msg);
    expect(validateJob(videoJob({ crop: { x: 0, y: 0.6, w: 1920, h: 1080 } }), videoProbe)).toBe(msg);
  });

  test("photo crops are checked against the photo probe", () => {
    expect(validateJob(photoJob({ crop: { x: 0, y: 0, w: 4000, h: 3000 } }), photoProbe)).toBeNull();
    expect(validateJob(photoJob({ crop: { x: 3999, y: 0, w: 2, h: 2 } }), photoProbe)).toBe("Crop is outside the picture");
    expect(validateJob(photoJob({ crop: { x: 0, y: 0, w: 1, h: 2000 } }), photoProbe)).toBe("Crop is too small");
  });

  test("crop check runs before the trim check", () => {
    expect(validateJob(videoJob({ crop: { x: 0, y: 0, w: 1, h: 1 }, trimStart: 5, trimEnd: 1 }), videoProbe)).toBe(
      "Crop is too small",
    );
  });
});

describe("validateJob: trim errors (video only)", () => {
  const msg = "Trim range is invalid";
  test("negative start", () => {
    expect(validateJob(videoJob({ trimStart: -0.1 }), videoProbe)).toBe(msg);
  });
  test("NaN start or end", () => {
    expect(validateJob(videoJob({ trimStart: NaN }), videoProbe)).toBe(msg);
    expect(validateJob(videoJob({ trimEnd: NaN }), videoProbe)).toBe(msg);
  });
  test("end equal to or before start", () => {
    expect(validateJob(videoJob({ trimStart: 3, trimEnd: 3 }), videoProbe)).toBe(msg);
    expect(validateJob(videoJob({ trimStart: 5, trimEnd: 2 }), videoProbe)).toBe(msg);
    expect(validateJob(videoJob({ trimStart: 10 }), videoProbe)).toBe(msg);
  });
  test("end past duration beyond the 0.05s tolerance", () => {
    expect(validateJob(videoJob({ trimEnd: 10.1 }), videoProbe)).toBe(msg);
  });
  test("negative or infinite end", () => {
    expect(validateJob(videoJob({ trimEnd: -1 }), videoProbe)).toBe(msg);
    expect(validateJob(videoJob({ trimStart: Infinity }), videoProbe)).toBe(msg);
    expect(validateJob(videoJob({ trimEnd: Infinity }), videoProbe)).toBe(msg);
  });
  test("zero-duration probe with no trim is invalid", () => {
    expect(validateJob(videoJob(), { ...videoProbe, duration: 0 })).toBe(msg);
  });
});

describe("validateJob: output kind", () => {
  test("photo cannot export mp4", () => {
    expect(validateJob(photoJob({ output: "mp4" }), photoProbe)).toBe("A photo cannot export as MP4");
  });
  test("video must export mp4", () => {
    expect(validateJob(videoJob({ output: "jpg" }), videoProbe)).toBe("A video exports as MP4");
    expect(validateJob(videoJob({ output: "png" }), videoProbe)).toBe("A video exports as MP4");
  });
});

describe("EditorError", () => {
  test("carries code and message and is an Error", () => {
    const codes = ["unsupported", "cancelled", "probe_failed", "export_failed", "no_space", "permission", "invalid_job"];
    for (const code of codes) {
      const e = new EditorError(code, `msg ${code}`);
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(EditorError);
      expect(e.code).toBe(code);
      expect(e.message).toBe(`msg ${code}`);
    }
  });
});
