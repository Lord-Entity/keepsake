// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Unit tests for src/editor/engine-photo.ts: name helpers, error mapping (mapNativeError / editorError),
 * parseProbe, progressGate, videoCrop, videoTrim, and the photo pipeline (probePhoto / renderPhoto) with
 * createImageBitmap and OffscreenCanvas replaced by fakes. No DOM, no Tauri.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  MIME,
  PHOTO_EXTS,
  VIDEO_EXTS,
  baseOf,
  cancelled,
  editBase,
  editorError,
  extOf,
  kindFromName,
  mapNativeError,
  markSaveStep,
  parseProbe,
  probePhoto,
  progressGate,
  rawText,
  renderPhoto,
  stepOf,
  throwIfAborted,
  videoCrop,
  videoTrim,
} from "../engine-photo";
import { EditorError } from "../types";

const HD = { width: 1920, height: 1080, duration: 10, hasAudio: true, rotation: 0 };

describe("export step tag", () => {
  test("markSaveStep tags the same EditorError; stepOf reads it back, anything else is undefined", () => {
    const e = new EditorError("export_failed", "x");
    expect(stepOf(e)).toBeUndefined();
    expect(markSaveStep(e, "save")).toBe(e);
    expect(stepOf(e)).toBe("save");
    expect(e.code).toBe("export_failed");
    expect(stepOf(markSaveStep(new EditorError("export_failed", "y"), "export"))).toBe("export");
    expect(stepOf(Object.assign(new Error("z"), { step: "save" }))).toBeUndefined();
    expect(stepOf("save")).toBeUndefined();
  });
});

describe("names and kinds", () => {
  test("baseOf handles both separators", () => {
    expect(baseOf("C:\\Users\\me\\clip.mp4")).toBe("clip.mp4");
    expect(baseOf("/home/me/pic.png")).toBe("pic.png");
    expect(baseOf("C:/mixed\\dir/x.jpg")).toBe("x.jpg");
    expect(baseOf("plain")).toBe("plain");
  });

  test("extOf is lower-case, ignores dot-files and folder dots", () => {
    expect(extOf("A.JPG")).toBe("jpg");
    expect(extOf("archive.tar.MKV")).toBe("mkv");
    expect(extOf(".hidden")).toBe("");
    expect(extOf("noext")).toBe("");
    expect(extOf("C:\\dir.v\\file")).toBe("");
  });

  test("kindFromName maps known extensions", () => {
    expect(kindFromName("a.MOV")).toBe("video");
    expect(kindFromName("a.mp4")).toBe("video");
    expect(kindFromName("a.webp")).toBe("photo");
    expect(kindFromName("a.jpeg")).toBe("photo");
    expect(kindFromName("a.txt")).toBeUndefined();
    expect(kindFromName("noext")).toBeUndefined();
  });

  test("extension lists do not overlap and common types have a MIME", () => {
    for (const e of VIDEO_EXTS) expect(PHOTO_EXTS.includes(e)).toBe(false);
    for (const e of ["mp4", "mov", "webm", "jpg", "jpeg", "png", "webp"]) expect(typeof MIME[e]).toBe("string");
  });

  test("editBase strips the extension and unsafe characters, adds _edit", () => {
    expect(editBase("My clip.mp4")).toBe("My clip_edit");
    expect(editBase("C:\\x\\video")).toBe("video_edit");
    expect(editBase('a<b>:c"d|e?f*.png')).toBe("a_b__c_d_e_f__edit");
    expect(editBase("  spaced   name .mp4")).toBe("spaced name_edit");
    expect(editBase("...")).toBe("keepsake_edit");
    expect(editBase("")).toBe("keepsake_edit");
  });

  test("editBase keeps at most 80 characters of the stem", () => {
    expect(editBase(`${"a".repeat(100)}.mp4`)).toBe(`${"a".repeat(80)}_edit`);
  });
});

describe("errors", () => {
  test("rawText reads Error, string, JSON and falls back to String()", () => {
    expect(rawText(new Error("boom"))).toBe("boom");
    expect(rawText("text")).toBe("text");
    expect(rawText({ a: 1 })).toBe('{"a":1}');
    const circular = {};
    circular.self = circular;
    expect(rawText(circular)).toBe("[object Object]");
  });

  test("editorError adds a collapsed, trimmed detail", () => {
    const plain = editorError("permission");
    expect(plain).toBeInstanceOf(EditorError);
    expect(plain.code).toBe("permission");
    expect(plain.message).not.toContain("Details");
    const detailed = editorError("export_failed", "  line one\n  line two ");
    expect(detailed.message.endsWith("(Details: line one line two)")).toBe(true);
    expect(editorError("export_failed", "x".repeat(500)).message).toContain(`(Details: ${"x".repeat(300)})`);
    expect(editorError("export_failed", "x".repeat(500)).message).not.toContain("x".repeat(301));
  });

  test("every code has a distinct friendly text", () => {
    const codes = ["unsupported", "cancelled", "probe_failed", "export_failed", "no_space", "permission", "invalid_job"];
    const texts = codes.map((c) => editorError(c).message);
    for (const t of texts) expect(t.length).toBeGreaterThan(5);
    expect(new Set(texts).size).toBe(codes.length);
  });

  test("cancelled() and throwIfAborted", () => {
    expect(cancelled().code).toBe("cancelled");
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
    const ac = new AbortController();
    ac.abort();
    let caught;
    try {
      throwIfAborted(ac.signal);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EditorError);
    expect(caught.code).toBe("cancelled");
  });

  test("mapNativeError passes EditorError through unchanged", () => {
    const e = new EditorError("no_space", "x");
    expect(mapNativeError(e, "export_failed")).toBe(e);
  });

  test("mapNativeError understands editor:<code>: prefixes", () => {
    const e = mapNativeError(new Error("editor:no_space: disk full"), "export_failed");
    expect(e.code).toBe("no_space");
    expect(e.message).toContain("(Details: disk full)");
    expect(mapNativeError("editor:permission: denied by SAF", "export_failed").code).toBe("permission");
    expect(mapNativeError("editor:cancelled: user", "export_failed").code).toBe("cancelled");
    expect(mapNativeError("editor:unsupported: HDR", "probe_failed").code).toBe("unsupported");
    expect(mapNativeError("editor:probe_failed: bad", "export_failed").code).toBe("probe_failed");
    expect(mapNativeError("editor:invalid_job: bad crop", "export_failed").code).toBe("invalid_job");
    expect(mapNativeError("editor:export_failed: codec", "probe_failed").code).toBe("export_failed");
  });

  test("unknown editor:<code> falls back", () => {
    expect(mapNativeError("editor:bogus: x", "probe_failed").code).toBe("probe_failed");
    expect(mapNativeError("editor:constructor: x", "probe_failed").code).toBe("probe_failed");
  });

  test("desktop editor.rs codes map onto EditorErrorCode", () => {
    expect(mapNativeError("editor:invalid: crop is too small", "export_failed").code).toBe("invalid_job");
    const enc = mapNativeError("editor:no_encoder: cropping needs a video encoder", "export_failed");
    expect(enc.code).toBe("unsupported");
    expect(enc.message).toContain("(Details: cropping needs a video encoder)");
    expect(mapNativeError("editor:no_ffmpeg: ffmpeg was not found", "probe_failed").code).toBe("unsupported");
    expect(mapNativeError("editor:no_video: no video stream found", "export_failed").code).toBe("probe_failed");
    expect(mapNativeError("editor:failed: ffmpeg exited with 1", "export_failed").code).toBe("export_failed");
    expect(mapNativeError("editor:failed: could not start ffmpeg", "probe_failed").code).toBe("probe_failed");
    const bare = mapNativeError("editor:cancelled", "export_failed");
    expect(bare.code).toBe("cancelled");
    expect(bare.message).not.toContain("Details");
  });

  test("missing plugin or command means unsupported", () => {
    for (const t of ["plugin keepsake-editor not found", "Command edit_video not found", "unknown command", "editor.edit_video not allowed"]) {
      expect(mapNativeError(new Error(t), "export_failed").code).toBe("unsupported");
    }
  });

  test("OS texts map to cancelled, no_space and permission", () => {
    expect(mapNativeError("Export was cancelled", "export_failed").code).toBe("cancelled");
    expect(mapNativeError("job canceled", "export_failed").code).toBe("cancelled");
    expect(mapNativeError("No space left on device (os error 28)", "export_failed").code).toBe("no_space");
    expect(mapNativeError("There is not enough space on the disk. (os error 112)", "export_failed").code).toBe("no_space");
    expect(mapNativeError("Access is denied. (os error 5)", "export_failed").code).toBe("permission");
    expect(mapNativeError("EACCES: permission denied", "export_failed").code).toBe("permission");
  });

  test("anything else becomes the fallback with the raw text as detail", () => {
    const e = mapNativeError(new Error("ffmpeg exited with code 1"), "export_failed");
    expect(e.code).toBe("export_failed");
    expect(e.message).toContain("ffmpeg exited with code 1");
    expect(mapNativeError({ weird: true }, "probe_failed").code).toBe("probe_failed");
  });
});

describe("parseProbe", () => {
  test("accepts a good probe, rounds sizes, keeps duration", () => {
    expect(parseProbe({ width: 1919.6, height: 1080, duration: 3.5, hasAudio: true, rotation: 90 })).toEqual({
      width: 1920,
      height: 1080,
      duration: 3.5,
      hasAudio: true,
      rotation: 90,
    });
  });

  test("odd rotation becomes 0, missing/non-boolean hasAudio becomes false, duration 0 is allowed", () => {
    expect(parseProbe({ width: 10, height: 10, duration: 0, hasAudio: "true", rotation: 45 })).toEqual({
      width: 10,
      height: 10,
      duration: 0,
      hasAudio: false,
      rotation: 0,
    });
    expect(parseProbe({ width: 10, height: 10, duration: 1 }).rotation).toBe(0);
  });

  test("bad responses throw probe_failed", () => {
    for (const r of [null, undefined, {}, { width: 0, height: 10, duration: 1 }, { width: 10, height: -1, duration: 1 }, { width: 10, height: 10, duration: -1 }, { width: 10, height: 10, duration: NaN }, { width: "10", height: 10, duration: 1 }]) {
      let caught;
      try {
        parseProbe(r);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EditorError);
      expect(caught.code).toBe("probe_failed");
    }
  });
});

describe("progressGate", () => {
  test("clamps to 0..1, drops NaN and anything not above the last value", () => {
    const seen = [];
    const gate = progressGate((f) => seen.push(f));
    for (const f of [-1, 0.1, 0.05, NaN, Infinity, 0.5, 2, 1, 0.9]) gate(f);
    expect(seen).toEqual([0, 0.1, 0.5, 1]);
  });
});

describe("videoCrop", () => {
  test("no crop or a full-frame crop means no crop filter", () => {
    expect(videoCrop(undefined, HD)).toBeUndefined();
    expect(videoCrop({ x: 0, y: 0, w: 1920, h: 1080 }, HD)).toBeUndefined();
    expect(videoCrop({ x: 0, y: 0, w: 1081, h: 721 }, { ...HD, width: 1081, height: 721 })).toBeUndefined();
  });

  test("rounds down to even pixels", () => {
    expect(videoCrop({ x: 3, y: 5, w: 101, h: 99 }, HD)).toEqual({ x: 2, y: 4, w: 100, h: 98 });
    expect(videoCrop({ x: 0, y: 0, w: 1080, h: 1080 }, HD)).toEqual({ x: 0, y: 0, w: 1080, h: 1080 });
  });

  test("clamps a crop that runs off the frame", () => {
    expect(videoCrop({ x: 1919, y: 1079, w: 100, h: 100 }, HD)).toEqual({ x: 1918, y: 1078, w: 2, h: 2 });
    expect(videoCrop({ x: 1000, y: 0, w: 5000, h: 500 }, HD)).toEqual({ x: 1000, y: 0, w: 920, h: 500 });
  });
});

const job = (over) => ({ input: { kind: "video", name: "a.mp4" }, audio: true, output: "mp4", ...over });

describe("videoTrim", () => {
  test("omits points that match the file's own start/end", () => {
    expect(videoTrim(job({}), HD)).toEqual({});
    expect(videoTrim(job({ trimStart: 0, trimEnd: 10 }), HD)).toEqual({});
    expect(videoTrim(job({ trimStart: 0.0005, trimEnd: 9.995 }), HD)).toEqual({});
  });
  test("keeps real trim points", () => {
    expect(videoTrim(job({ trimStart: 1, trimEnd: 9.5 }), HD)).toEqual({ trimStart: 1, trimEnd: 9.5 });
    expect(videoTrim(job({ trimStart: 2 }), HD)).toEqual({ trimStart: 2 });
    expect(videoTrim(job({ trimEnd: 4 }), HD)).toEqual({ trimEnd: 4 });
  });
});

// ---------------- photo pipeline with fake canvas ----------------

const realCreateImageBitmap = globalThis.createImageBitmap;
const realOffscreenCanvas = globalThis.OffscreenCanvas;

let bitmapSize = { width: 400, height: 300 };
let decodeFails = false;
let encodeFails = false;
const closeMock = mock(() => {});
const decodeMock = mock(async (_blob, _opts) => {
  if (decodeFails) throw new Error("bad image data");
  return { width: bitmapSize.width, height: bitmapSize.height, close: closeMock };
});
let canvases = [];

class FakeCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.calls = [];
    this.blobOpts = undefined;
    canvases.push(this);
  }
  getContext() {
    const calls = this.calls;
    const ctx = {
      fillStyle: "",
      imageSmoothingQuality: "",
      fillRect: (...a) => calls.push(["fillRect", ctx.fillStyle, ...a]),
      drawImage: (...a) => calls.push(["drawImage", ...a.slice(1)]),
    };
    return ctx;
  }
  async convertToBlob(opts) {
    this.blobOpts = opts;
    if (encodeFails) throw new Error("encoder out of memory");
    return new Blob([new Uint8Array([1, 2, 3])], { type: opts.type });
  }
}

beforeEach(() => {
  bitmapSize = { width: 400, height: 300 };
  decodeFails = false;
  encodeFails = false;
  canvases = [];
  closeMock.mockClear();
  decodeMock.mockClear();
  globalThis.createImageBitmap = decodeMock;
  globalThis.OffscreenCanvas = FakeCanvas;
});

afterAll(() => {
  globalThis.createImageBitmap = realCreateImageBitmap;
  globalThis.OffscreenCanvas = realOffscreenCanvas;
});

const src = new Blob([new Uint8Array([9])], { type: "image/jpeg" });
const photoJob = (over) => ({ input: { kind: "photo", name: "p.jpg" }, audio: false, output: "jpg", ...over });

async function rejection(p) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("probePhoto", () => {
  test("reads the decoded (EXIF-applied) size and closes the bitmap", async () => {
    expect(await probePhoto(src)).toEqual({ width: 400, height: 300, duration: 0, hasAudio: false, rotation: 0 });
    expect(decodeMock.mock.calls[0][1]).toEqual({ imageOrientation: "from-image" });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  test("undecodable picture is unsupported", async () => {
    decodeFails = true;
    const e = await rejection(probePhoto(src));
    expect(e).toBeInstanceOf(EditorError);
    expect(e.code).toBe("unsupported");
  });
});

describe("renderPhoto", () => {
  test("crops with rounded source pixels and encodes JPEG on white at the given quality", async () => {
    const r = await renderPhoto(src, photoJob({ crop: { x: 10.4, y: 20.6, w: 100.2, h: 50.5 }, quality: 80 }));
    expect(r.ext).toBe("jpg");
    expect(r.mime).toBe("image/jpeg");
    expect(r.bytes).toBeInstanceOf(Uint8Array);
    expect([...r.bytes]).toEqual([1, 2, 3]);
    const c = canvases[0];
    expect([c.width, c.height]).toEqual([100, 51]);
    expect(c.calls).toEqual([
      ["fillRect", "#ffffff", 0, 0, 100, 51],
      ["drawImage", 10, 21, 100, 51, 0, 0, 100, 51],
    ]);
    expect(c.blobOpts).toEqual({ type: "image/jpeg", quality: 0.8 });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  test("PNG without crop keeps the full picture and has no background fill or quality", async () => {
    const r = await renderPhoto(src, photoJob({ output: "png", quality: 50 }));
    expect(r.ext).toBe("png");
    expect(r.mime).toBe("image/png");
    const c = canvases[0];
    expect([c.width, c.height]).toEqual([400, 300]);
    expect(c.calls).toEqual([["drawImage", 0, 0, 400, 300, 0, 0, 400, 300]]);
    expect(c.blobOpts).toEqual({ type: "image/png", quality: undefined });
  });

  test("JPEG quality defaults to 92 and is clamped to 1..100", async () => {
    await renderPhoto(src, photoJob({}));
    await renderPhoto(src, photoJob({ quality: 0 }));
    await renderPhoto(src, photoJob({ quality: 500 }));
    expect(canvases.map((c) => c.blobOpts.quality)).toEqual([0.92, 0.01, 1]);
  });

  test("a crop running off the picture is clipped to it", async () => {
    await renderPhoto(src, photoJob({ crop: { x: 390, y: 290, w: 100, h: 100 } }));
    expect(canvases[0].calls[1]).toEqual(["drawImage", 390, 290, 10, 10, 0, 0, 10, 10]);
  });

  test("a NaN crop is invalid_job and the bitmap is closed", async () => {
    const e = await rejection(renderPhoto(src, photoJob({ crop: { x: NaN, y: 0, w: 10, h: 10 } })));
    expect(e.code).toBe("invalid_job");
    expect(canvases.length).toBe(0);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  test("a huge output that fails to encode says the picture is too large", async () => {
    bitmapSize = { width: 8000, height: 6000 };
    encodeFails = true;
    const e = await rejection(renderPhoto(src, photoJob({})));
    expect(e.code).toBe("export_failed");
    expect(e.message).toContain("too large");
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  test("a small output failure has no size hint", async () => {
    encodeFails = true;
    const e = await rejection(renderPhoto(src, photoJob({})));
    expect(e.message).not.toContain("too large");
  });

  test("MP4 output is invalid_job and nothing is decoded", async () => {
    const e = await rejection(renderPhoto(src, photoJob({ output: "mp4" })));
    expect(e.code).toBe("invalid_job");
    expect(decodeMock).not.toHaveBeenCalled();
  });

  test("an aborted signal cancels before decoding", async () => {
    const ac = new AbortController();
    ac.abort();
    const e = await rejection(renderPhoto(src, photoJob({}), ac.signal));
    expect(e.code).toBe("cancelled");
    expect(decodeMock).not.toHaveBeenCalled();
  });

  test("encoder failure is export_failed and the bitmap is still closed", async () => {
    encodeFails = true;
    const e = await rejection(renderPhoto(src, photoJob({})));
    expect(e).toBeInstanceOf(EditorError);
    expect(e.code).toBe("export_failed");
    expect(e.message).toContain("encoder out of memory");
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
