// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Unit tests for src/editor/engine-desktop.ts: pickMedia, probe, previewUrl and exportEdit argument mapping
 * (job -> edit_video args, output naming, save-folder fallback, cancel, error codes). Every Tauri API is mocked;
 * photo decoding uses a fake createImageBitmap / OffscreenCanvas.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

let invokeImpl = async () => ({});
const invokeMock = mock((cmd, args) => invokeImpl(cmd, args));
class FakeChannel {
  onmessage = () => {};
}
// bun's mock.module is process-wide: export every name any editor/engine module imports from these,
// so a module linked later under this mock never misses an export.
mock.module("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: FakeChannel,
  convertFileSrc: (p) => `asset://localhost/${encodeURIComponent(p)}`,
  addPluginListener: async () => ({ unregister: async () => {} }),
  isTauri: () => true,
}));

let downloads = "C:\\Users\\me\\Downloads";
mock.module("@tauri-apps/api/path", () => ({
  join: async (...parts) => parts.join("\\"),
  dirname: async (p) => p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"))),
  downloadDir: async () => downloads,
  appCacheDir: async () => "C:\\cache",
}));

let dialogImpl = async () => null;
const dialogMock = mock((opts) => dialogImpl(opts));
mock.module("@tauri-apps/plugin-dialog", () => ({ open: dialogMock }));

let taken = new Set();
let writeImpl = async () => {};
const writeMock = mock((p, b) => writeImpl(p, b));
const removeMock = mock(async () => {});
mock.module("@tauri-apps/plugin-fs", () => ({
  exists: async (p) => taken.has(p),
  mkdir: async () => {},
  open: async () => ({ read: async () => null, write: async (d) => d.length, close: async () => {} }),
  readFile: async () => new Uint8Array([1, 2, 3]),
  writeFile: writeMock,
  remove: removeMock,
  rename: async () => {},
}));

let saveDir = "";
mock.module("../../state/settings", () => ({
  settingsStore: { get: () => ({ saveDir }) },
}));

// Photo decode/encode fakes (engine-photo.ts uses createImageBitmap + OffscreenCanvas).
const realCreateImageBitmap = globalThis.createImageBitmap;
const realOffscreenCanvas = globalThis.OffscreenCanvas;
globalThis.createImageBitmap = async () => ({ width: 640, height: 480, close() {} });
globalThis.OffscreenCanvas = class {
  constructor(w, h) {
    this.width = w;
    this.height = h;
  }
  getContext() {
    return { fillRect() {}, drawImage() {} };
  }
  async convertToBlob(o) {
    return new Blob([new Uint8Array([7])], { type: o.type });
  }
};
afterAll(() => {
  globalThis.createImageBitmap = realCreateImageBitmap;
  globalThis.OffscreenCanvas = realOffscreenCanvas;
});

const { desktopEngine, dialogFilters, needsWebCrop, WEBCROP_NOTE, WEBCODECS_NOTE, COPY_ONLY_NOTE, NO_CROP_HELP } = await import("../engine-desktop");
const { EditorError } = await import("../types");
const { RECORD_SHARE, bitrateFor, drawMatrix, extForMime, pickRecorderMime, recordProgress, recorderMimes, remuxProgress } =
  await import("../engine-webcrop");

const SRC = "C:\\v\\clip.mp4";
const VIDEO = { kind: "video", name: "clip.mp4", path: SRC };
const PHOTO = { kind: "photo", name: "pic.png", path: "C:\\v\\pic.png" };
const PROBE = { width: 1920, height: 1080, duration: 10, hasAudio: true, rotation: 0 };

function videoJob(over = {}) {
  return { input: VIDEO, audio: true, output: "mp4", ...over };
}

async function rejection(p) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

/** Records edit_video args; `script` runs with the args (emit events, throw, abort...). */
let editArgs;
function onEdit(script = async () => {}) {
  invokeImpl = async (cmd, args) => {
    if (cmd === "edit_video") {
      editArgs = args;
      return script(args);
    }
    return undefined;
  };
}

beforeEach(() => {
  invokeImpl = async () => ({});
  invokeMock.mockClear();
  dialogImpl = async () => null;
  dialogMock.mockClear();
  writeImpl = async () => {};
  writeMock.mockClear();
  removeMock.mockClear();
  taken = new Set();
  saveDir = "";
  downloads = "C:\\Users\\me\\Downloads";
  editArgs = undefined;
});

describe("capabilities", () => {
  const FULL = { crop: true, trim: true, mute: true, exactTrim: true };

  test("photos can always do everything, with no native call", async () => {
    expect(await desktopEngine.capabilities("photo")).toEqual(FULL);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("video: an encoder means the full set", async () => {
    invokeImpl = async () => ({ copyOnly: false, canReencode: true, encoder: "libx264" });
    expect(await desktopEngine.capabilities("video")).toEqual(FULL);
    expect(invokeMock.mock.calls[0][0]).toBe("editor_capabilities");
  });

  test("video: copy-only ffmpeg trims (keyframe) and mutes but cannot crop", async () => {
    invokeImpl = async () => ({ copyOnly: true, canReencode: false, encoder: null });
    const c = await desktopEngine.capabilities("video");
    expect([c.crop, c.trim, c.mute, c.exactTrim]).toEqual([false, true, true, false]);
    expect(typeof c.note).toBe("string");
  });

  test("video: no ffmpeg at all disables everything with an install note", async () => {
    invokeImpl = async () => ({ copyOnly: false, canReencode: false });
    const c = await desktopEngine.capabilities("video");
    expect([c.crop, c.trim, c.mute, c.exactTrim]).toEqual([false, false, false, false]);
    expect(c.note).toContain("ffmpeg");
  });

  test("video: editor:unsupported disables everything; a bad reply rejects", async () => {
    invokeImpl = async () => {
      throw "editor:unsupported: video editing is only available on desktop";
    };
    const c = await desktopEngine.capabilities("video");
    expect([c.crop, c.trim, c.mute]).toEqual([false, false, false]);
    expect(typeof c.note).toBe("string");

    invokeImpl = async () => ({ copyOnly: "yes" });
    await rejection(desktopEngine.capabilities("video"));
    invokeImpl = async () => null;
    await rejection(desktopEngine.capabilities("video"));
  });
});

async function withRecorder(fn) {
  const g = globalThis;
  const saved = {
    MediaRecorder: g.MediaRecorder,
    HTMLCanvasElement: g.HTMLCanvasElement,
    document: g.document,
    hadDocument: "document" in g,
  };
  try {
    // oxlint-disable-next-line typescript/no-extraneous-class -- minimal MediaRecorder stand-in
    g.MediaRecorder = class {
      static isTypeSupported() {
        return true;
      }
    };
    // oxlint-disable-next-line typescript/no-extraneous-class -- minimal canvas stand-in
    g.HTMLCanvasElement = class {};
    g.HTMLCanvasElement.prototype.captureStream = function () {};
    g.document = g.document ?? {};
    return await fn();
  } finally {
    g.MediaRecorder = saved.MediaRecorder;
    g.HTMLCanvasElement = saved.HTMLCanvasElement;
    if (saved.hadDocument) g.document = saved.document;
    else delete g.document;
  }
}

describe("capabilities with webview recording available", () => {
  const FULL = { crop: true, trim: true, mute: true, exactTrim: true };

  test("copy-only ffmpeg can crop through the webview recorder, in real time", async () => {
    invokeImpl = async () => ({ copyOnly: true, canReencode: false, encoder: null });
    const c = await withRecorder(() => desktopEngine.capabilities("video"));
    expect([c.crop, c.trim, c.mute, c.exactTrim]).toEqual([true, true, true, false]);
    expect(c.note).toBe(WEBCROP_NOTE);
    expect(c.note).toContain("real time");
  });

  test("an encoder still means the full set", async () => {
    invokeImpl = async () => ({ copyOnly: false, canReencode: true, encoder: "libx264" });
    expect(await withRecorder(() => desktopEngine.capabilities("video"))).toEqual(FULL);
  });
});

describe("needsWebCrop", () => {
  test("true for no_encoder / no_ffmpeg rejections", () => {
    expect(needsWebCrop("editor:no_encoder: cropping needs a video encoder")).toBe(true);
    expect(needsWebCrop("editor:no_ffmpeg: x")).toBe(true);
    expect(needsWebCrop(new Error("editor:no_encoder: cropping needs a video encoder"))).toBe(true);
  });

  test("false for other rejections", () => {
    expect(needsWebCrop("editor:failed: x")).toBe(false);
    expect(needsWebCrop("editor:cancelled")).toBe(false);
  });
});

describe("exportEdit: no webview recorder", () => {
  test("no_encoder maps to unsupported and edit_video runs only once (no fallback)", async () => {
    onEdit(async () => {
      throw "editor:no_encoder: cropping needs a video encoder and none was found.";
    });
    const e = await rejection(desktopEngine.exportEdit(videoJob({ crop: { x: 2, y: 2, w: 100, h: 100 } }), PROBE, () => {}));
    expect(e.code).toBe("unsupported");
    expect(invokeMock.mock.calls.filter((c) => c[0] === "edit_video")).toHaveLength(1);
  });

  test("the final message is not a dead end: it lists every attempt and says trim / sound off still work", async () => {
    onEdit(async () => {
      throw "editor:no_encoder: cropping needs a video encoder and none was found.";
    });
    const e = await rejection(desktopEngine.exportEdit(videoJob({ crop: { x: 2, y: 2, w: 100, h: 100 } }), PROBE, () => {}));
    expect(e.message).toContain(NO_CROP_HELP);
    expect(e.message).toContain("Tried: ffmpeg: cropping needs a video encoder");
    expect(e.message).toContain("in-app encoder:");
    expect(e.message).toContain("real-time recording:");
    expect(e.message).toContain("trim");
  });
});

// Tauri 2 rejects invoke() for a Rust `Err(String)` with that string itself (ipc/mod.rs From<T: Serialize> for
// InvokeError -> serde_json Value::String; ipc-protocol.js parses the JSON body; core.js rejects with it as is).
describe("Tauri rejection shapes reach the in-app fallback", () => {
  const shapes = [
    ["plain string (what Tauri 2 delivers)", "editor:no_encoder: cropping needs a video encoder and none was found."],
    ["Error wrapper", new Error("editor:no_encoder: cropping needs a video encoder and none was found.")],
    ["serialized object", { message: "editor:no_encoder: cropping needs a video encoder" }],
    ["no ffmpeg string", "editor:no_ffmpeg: ffmpeg was not found"],
  ];
  for (const [name, err] of shapes) {
    test(`${name} triggers the fallback`, async () => {
      expect(needsWebCrop(err)).toBe(true);
      onEdit(async () => {
        throw err;
      });
      // With a (fake) recorder present the recorder path is attempted: the message names it with its own failure,
      // not "not available", proving the fallback ran instead of mapping the native error straight to "unsupported".
      const e = await withRecorder(() => rejection(desktopEngine.exportEdit(videoJob({ crop: { x: 2, y: 2, w: 100, h: 100 } }), PROBE, () => {})));
      expect(e.message).toContain("real-time recording:");
      expect(e.message).not.toContain("real-time recording: not available");
    });
  }
  test("other rejections do not", () => {
    for (const err of ["editor:failed: ffmpeg exited with 1", "editor:invalid: x", "editor:cancelled", new Error("boom")]) expect(needsWebCrop(err)).toBe(false);
  });
});

function FakeCodec() {}
FakeCodec.isConfigSupported = async (c) => ({ supported: c.codec.startsWith("avc1."), config: c });

describe("capabilities with an in-app WebCodecs encoder", () => {
  test("copy-only ffmpeg can crop fast through WebCodecs", async () => {
    const g = globalThis;
    const saved = { VideoEncoder: g.VideoEncoder, VideoDecoder: g.VideoDecoder, VideoFrame: g.VideoFrame, OffscreenCanvas: g.OffscreenCanvas };
    try {
      // Constructor stand-ins: only `typeof === "function"` and the static isConfigSupported are used.
      g.VideoEncoder = FakeCodec;
      g.VideoDecoder = FakeCodec;
      g.VideoFrame = FakeCodec;
      invokeImpl = async () => ({ copyOnly: true, canReencode: false, encoder: null });
      const c = await desktopEngine.capabilities("video");
      expect([c.crop, c.trim, c.mute, c.exactTrim]).toEqual([true, true, true, false]);
      expect(c.note).toBe(WEBCODECS_NOTE);
    } finally {
      Object.assign(g, saved);
    }
  });

  test("copy-only ffmpeg with neither path: crop off and the note says what is missing", async () => {
    invokeImpl = async () => ({ copyOnly: true, canReencode: false, encoder: null });
    const c = await desktopEngine.capabilities("video");
    expect(c.crop).toBe(false);
    expect(c.note).toBe(COPY_ONLY_NOTE);
    expect(c.note).toContain("WebView2");
  });
});

describe("dialogFilters and pickMedia(kind)", () => {
  test("no argument returns three filters, the first with videos and photos", () => {
    const d = dialogFilters();
    expect(d.filters).toHaveLength(3);
    expect(d.filters[0].extensions).toContain("mp4");
    expect(d.filters[0].extensions).toContain("jpg");
  });

  test("pickMedia('video') offers only video extensions", async () => {
    await desktopEngine.pickMedia("video");
    const opts = dialogMock.mock.calls[0][0];
    expect(opts.filters).toHaveLength(1);
    for (const x of ["mp4", "mov", "mkv", "webm", "m4v"]) expect(opts.filters[0].extensions).toContain(x);
    expect(opts.filters[0].extensions).not.toContain("jpg");
    expect(opts.title.toLowerCase()).toContain("video");
  });

  test("pickMedia('photo') offers only photo extensions", async () => {
    await desktopEngine.pickMedia("photo");
    const opts = dialogMock.mock.calls[0][0];
    expect(opts.filters).toHaveLength(1);
    for (const x of ["jpg", "jpeg", "png", "webp"]) expect(opts.filters[0].extensions).toContain(x);
    expect(opts.filters[0].extensions).not.toContain("mp4");
  });
});

const vp9 = (m) => m.startsWith("video/webm;codecs=vp9");
const applyMatrix = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const rotProbe = (w, h, rotation) => ({ width: w, height: h, duration: 10, hasAudio: true, rotation });

describe("engine-webcrop helpers", () => {
  test("recorderMimes prefers mp4 with AAC when audio is recorded", () => {
    const withAudio = recorderMimes(true);
    expect(withAudio[0].startsWith("video/mp4;codecs=avc1")).toBe(true);
    expect(withAudio[0]).toContain("mp4a.40.2");
    const joined = recorderMimes(false).join("|");
    expect(joined).not.toContain("mp4a");
    expect(joined).not.toContain("opus");
  });

  test("pickRecorderMime picks the first supported mime, null when none, never throws", () => {
    expect(pickRecorderMime(vp9, true)).toBe("video/webm;codecs=vp9,opus");
    expect(pickRecorderMime(vp9, false)).toBe("video/webm;codecs=vp9");
    expect(pickRecorderMime(() => false, true)).toBeNull();
    expect(
      pickRecorderMime(() => {
        throw new Error("boom");
      }, true),
    ).toBeNull();
    expect(pickRecorderMime(() => true, true)).toBe(recorderMimes(true)[0]);
    expect(pickRecorderMime(() => true, false)).toBe(recorderMimes(false)[0]);
  });

  test("extForMime", () => {
    expect(extForMime("video/mp4;codecs=avc1")).toBe("mp4");
    expect(extForMime("video/webm;codecs=vp9,opus")).toBe("webm");
    expect(extForMime("VIDEO/MP4")).toBe("mp4");
  });

  test("recordProgress and remuxProgress", () => {
    expect(recordProgress(5, 0, 10)).toBeCloseTo(RECORD_SHARE * 0.5, 10);
    expect(recordProgress(-1, 0, 10)).toBe(0);
    expect(recordProgress(11, 0, 10)).toBeCloseTo(RECORD_SHARE, 10);
    expect(recordProgress(5, 10, 10)).toBe(0);
    expect(recordProgress(5, 10, 0)).toBe(0);
    expect(recordProgress(Number.NaN, 0, 10)).toBe(0);
    expect(remuxProgress(0)).toBeCloseTo(RECORD_SHARE, 10);
    expect(remuxProgress(1)).toBeCloseTo(1, 10);
    expect(remuxProgress(Number.NaN)).toBeCloseTo(RECORD_SHARE, 10);
    expect(remuxProgress(2)).toBeCloseTo(1, 10);
  });

  test("bitrateFor is about 4 bits per pixel, clamped to 1..40 Mb/s", () => {
    expect(bitrateFor(1920, 1080)).toBe(8294400);
    expect(bitrateFor(10, 10)).toBe(1_000_000);
    expect(bitrateFor(8000, 8000)).toBe(40_000_000);
  });

  describe("drawMatrix", () => {
    const crop = { x: 100, y: 50, w: 400, h: 300 };

    test("no rotation: translate, or scale when the intrinsic size differs", () => {
      expect(drawMatrix(crop, rotProbe(1920, 1080, 0), 1920, 1080)).toEqual([1, 0, 0, 1, -100, -50]);
      expect(drawMatrix(crop, rotProbe(1920, 1080, 0), 960, 540)).toEqual([2, 0, 0, 2, -100, -50]);
    });

    test("rotation 90 the webview did not apply", () => {
      const m = drawMatrix(crop, rotProbe(1080, 1920, 90), 1920, 1080);
      expect(m).toEqual([0, 1, -1, 0, 980, -50]);
      const [x0, y0] = applyMatrix(m, 0, 0);
      expect([x0, y0]).toEqual([1080 - 100, -50]);
      const [x1, y1] = applyMatrix(m, 1920, 1080);
      expect([x1, y1]).toEqual([0 - 100, 1920 - 50]);
    });

    test("rotation 270 the webview did not apply", () => {
      const m = drawMatrix(crop, rotProbe(1080, 1920, 270), 1920, 1080);
      expect(m).toEqual([0, -1, 1, 0, -100, 1870]);
      const [x0, y0] = applyMatrix(m, 0, 0);
      expect([x0, y0]).toEqual([0 - 100, 1920 - 50]);
      const [x1, y1] = applyMatrix(m, 1920, 1080);
      expect([x1, y1]).toEqual([1080 - 100, 0 - 50]);
    });

    test("rotation 90 already applied by the webview is a plain scale", () => {
      expect(drawMatrix(crop, rotProbe(1080, 1920, 90), 1080, 1920)).toEqual([1, 0, 0, 1, -100, -50]);
    });
  });
});

describe("pickMedia", () => {
  test("returns a video input from the dialog path", async () => {
    dialogImpl = async () => "C:\\v\\Clip.MOV";
    expect(await desktopEngine.pickMedia()).toEqual({ kind: "video", name: "Clip.MOV", path: "C:\\v\\Clip.MOV" });
    const opts = dialogMock.mock.calls[0][0];
    expect(opts.multiple).toBe(false);
    expect(opts.directory).toBe(false);
    expect(opts.filters[0].extensions).toContain("mp4");
    expect(opts.filters[0].extensions).toContain("jpg");
  });

  test("returns a photo input", async () => {
    dialogImpl = async () => "/home/me/a.webp";
    expect(await desktopEngine.pickMedia()).toEqual({ kind: "photo", name: "a.webp", path: "/home/me/a.webp" });
  });

  test("cancelled dialog returns null", async () => {
    expect(await desktopEngine.pickMedia()).toBeNull();
    dialogImpl = async () => "";
    expect(await desktopEngine.pickMedia()).toBeNull();
  });

  test("unknown file type is unsupported", async () => {
    dialogImpl = async () => "C:\\x\\notes.txt";
    const e = await rejection(desktopEngine.pickMedia());
    expect(e).toBeInstanceOf(EditorError);
    expect(e.code).toBe("unsupported");
  });

  test("dialog failure maps to permission", async () => {
    dialogImpl = async () => {
      throw new Error("dialog exploded");
    };
    expect((await rejection(desktopEngine.pickMedia())).code).toBe("permission");
  });
});

describe("probe and previewUrl", () => {
  test("video probe calls editor_probe with the path and shape-checks the result", async () => {
    invokeImpl = async () => ({ width: 1280, height: 720, duration: 4.5, hasAudio: false, rotation: 90 });
    expect(await desktopEngine.probe(VIDEO)).toEqual({ width: 1280, height: 720, duration: 4.5, hasAudio: false, rotation: 90 });
    expect(invokeMock.mock.calls[0]).toEqual(["editor_probe", { path: SRC }]);
  });

  test("probe rejections map to EditorError codes", async () => {
    invokeImpl = async () => {
      throw "editor:unsupported: 10-bit HEVC";
    };
    expect((await rejection(desktopEngine.probe(VIDEO))).code).toBe("unsupported");
    invokeImpl = async () => {
      throw "ffprobe: Invalid data found when processing input";
    };
    expect((await rejection(desktopEngine.probe(VIDEO))).code).toBe("probe_failed");
    invokeImpl = async () => ({ width: 0 });
    expect((await rejection(desktopEngine.probe(VIDEO))).code).toBe("probe_failed");
  });

  test("probe without a path is invalid_job; aborted signal is cancelled", async () => {
    expect((await rejection(desktopEngine.probe({ kind: "video", name: "x.mp4" }))).code).toBe("invalid_job");
    const ac = new AbortController();
    ac.abort();
    expect((await rejection(desktopEngine.probe(VIDEO, ac.signal))).code).toBe("cancelled");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("photo probe decodes in the webview, no native call", async () => {
    expect(await desktopEngine.probe(PHOTO)).toEqual({ width: 640, height: 480, duration: 0, hasAudio: false, rotation: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("previewUrl uses the asset protocol", async () => {
    expect(await desktopEngine.previewUrl(VIDEO)).toBe(`asset://localhost/${encodeURIComponent(SRC)}`);
  });
});

describe("exportEdit: video argument mapping", () => {
  test("maps crop (even), trim and audio into edit_video and writes next to the source", async () => {
    onEdit();
    const res = await desktopEngine.exportEdit(
      videoJob({ crop: { x: 3, y: 5, w: 101, h: 99 }, trimStart: 1, trimEnd: 10 }),
      PROBE,
      () => {},
    );
    expect(res).toEqual({ path: "C:\\v\\clip_edit.mp4", name: "clip_edit.mp4" });
    expect(editArgs.jobId).toMatch(/^edit-/);
    expect(editArgs.input).toBe(SRC);
    expect(editArgs.output).toBe("C:\\v\\clip_edit.mp4");
    expect(editArgs.crop).toEqual({ x: 2, y: 4, w: 100, h: 98 });
    expect(editArgs.trimStart).toBe(1);
    expect(editArgs.trimEnd).toBeNull();
    expect(editArgs.audio).toBe(true);
    expect(editArgs.onEvent).toBeInstanceOf(FakeChannel);
  });

  test("full-frame crop and no trim send nulls; mute or a silent source sends audio false", async () => {
    onEdit();
    await desktopEngine.exportEdit(videoJob({ crop: { x: 0, y: 0, w: 1920, h: 1080 }, audio: false }), PROBE, () => {});
    expect(editArgs.crop).toBeNull();
    expect(editArgs.trimStart).toBeNull();
    expect(editArgs.trimEnd).toBeNull();
    expect(editArgs.audio).toBe(false);

    await desktopEngine.exportEdit(videoJob({ trimEnd: 6 }), { ...PROBE, hasAudio: false }, () => {});
    expect(editArgs.audio).toBe(false);
    expect(editArgs.trimEnd).toBe(6);
  });

  test("taken names get a (n) suffix; save folder from Settings wins", async () => {
    onEdit();
    taken = new Set(["C:\\v\\clip_edit.mp4", "C:\\v\\clip_edit (1).mp4"]);
    expect((await desktopEngine.exportEdit(videoJob(), PROBE, () => {})).path).toBe("C:\\v\\clip_edit (2).mp4");

    taken = new Set();
    saveDir = "D:\\Out\\";
    expect((await desktopEngine.exportEdit(videoJob(), PROBE, () => {})).path).toBe("D:\\Out\\clip_edit.mp4");

    saveDir = "relative\\folder";
    expect((await desktopEngine.exportEdit(videoJob(), PROBE, () => {})).path).toBe("C:\\v\\clip_edit.mp4");
  });

  test("progress events are monotonic and end at 1", async () => {
    onEdit(async (args) => {
      args.onEvent.onmessage({ progress: 0.5 });
      args.onEvent.onmessage({ progress: 0.4 });
      args.onEvent.onmessage({ progress: 0.75 });
      args.onEvent.onmessage({ done: true });
    });
    const seen = [];
    await desktopEngine.exportEdit(videoJob(), PROBE, (f) => seen.push(f));
    expect(seen).toEqual([0.5, 0.75, 1]);
  });

  test("native failures map to error codes", async () => {
    onEdit(async () => {
      throw "editor:no_space: wrote 0 bytes";
    });
    expect((await rejection(desktopEngine.exportEdit(videoJob(), PROBE, () => {}))).code).toBe("no_space");
    onEdit(async () => {
      throw new Error("ffmpeg exited with code 1");
    });
    const e = await rejection(desktopEngine.exportEdit(videoJob(), PROBE, () => {}));
    expect(e).toBeInstanceOf(EditorError);
    expect(e.code).toBe("export_failed");
    expect(removeMock).not.toHaveBeenCalled();
  });

  test("editor.rs rejection strings map to EditorError codes", async () => {
    // editor.rs codes outside EditorErrorCode: failed -> fallback, invalid -> invalid_job,
    // no_encoder / no_ffmpeg -> unsupported, no_video -> probe_failed.
    const cases = [
      ["editor:failed: ffmpeg exited with 1: Invalid argument", "export_failed"],
      ["editor:cancelled", "cancelled"],
      ["editor:unsupported: video editing is only available on desktop", "unsupported"],
      ["editor:invalid: crop is too small", "invalid_job"],
      ["editor:no_ffmpeg: ffmpeg was not found", "unsupported"],
      ["editor:no_video: no video stream found (x)", "probe_failed"],
    ];
    for (const [text, code] of cases) {
      onEdit(async () => {
        throw text;
      });
      expect((await rejection(desktopEngine.exportEdit(videoJob(), PROBE, () => {}))).code).toBe(code);
    }
    onEdit(async () => {
      throw "editor:no_encoder: cropping needs a video encoder and none was found.";
    });
    const e = await rejection(desktopEngine.exportEdit(videoJob(), PROBE, () => {}));
    expect(e.code).toBe("unsupported");
    expect(e.message).toContain("cropping needs a video encoder");
  });

  test("editor_probe rejections from editor.rs map to probe codes", async () => {
    for (const [text, code] of [
      ["editor:failed: could not start ffmpeg: not found", "probe_failed"],
      ["editor:no_video: no video stream found", "probe_failed"],
      ["editor:invalid: input file does not exist", "invalid_job"],
      ["editor:no_ffmpeg: ffmpeg was not found", "unsupported"],
    ]) {
      invokeImpl = async () => {
        throw text;
      };
      expect((await rejection(desktopEngine.probe(VIDEO))).code).toBe(code);
    }
  });

  test("abort during export sends cancel_edit, removes the partial file and rejects cancelled", async () => {
    const ac = new AbortController();
    onEdit(async () => {
      ac.abort();
      throw new Error("ffmpeg killed");
    });
    const e = await rejection(desktopEngine.exportEdit(videoJob(), PROBE, () => {}, ac.signal));
    expect(e.code).toBe("cancelled");
    const cancelCall = invokeMock.mock.calls.find((c) => c[0] === "cancel_edit");
    expect(cancelCall[1]).toEqual({ jobId: editArgs.jobId });
    expect(removeMock).toHaveBeenCalledWith("C:\\v\\clip_edit.mp4");
  });

  test("already-aborted signal never starts ffmpeg", async () => {
    onEdit();
    const ac = new AbortController();
    ac.abort();
    expect((await rejection(desktopEngine.exportEdit(videoJob(), PROBE, () => {}, ac.signal))).code).toBe("cancelled");
    expect(editArgs).toBeUndefined();
  });
});

const photoJob = (over = {}) => ({ input: PHOTO, audio: false, output: "jpg", ...over });

describe("exportEdit: photo", () => {
  test("writes <name>_edit.<ext> next to the source and reports 1", async () => {
    const seen = [];
    const res = await desktopEngine.exportEdit(photoJob({ output: "png" }), { ...PROBE, duration: 0 }, (f) => seen.push(f));
    expect(res).toEqual({ path: "C:\\v\\pic_edit.png", name: "pic_edit.png" });
    expect(writeMock.mock.calls[0][0]).toBe("C:\\v\\pic_edit.png");
    expect([...writeMock.mock.calls[0][1]]).toEqual([7]);
    expect(seen).toEqual([1]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("falls back to Downloads when the source folder is outside the fs scope", async () => {
    writeImpl = async (p) => {
      if (p.startsWith("C:\\v\\")) throw new Error(`forbidden path: ${p}`);
    };
    const res = await desktopEngine.exportEdit(photoJob(), PROBE, () => {});
    expect(res.path).toBe("C:\\Users\\me\\Downloads\\pic_edit.jpg");
  });

  test("no_space stops at once; every folder refused is permission", async () => {
    writeImpl = async () => {
      throw new Error("There is not enough space on the disk. (os error 112)");
    };
    expect((await rejection(desktopEngine.exportEdit(photoJob(), PROBE, () => {}))).code).toBe("no_space");
    expect(writeMock).toHaveBeenCalledTimes(1);

    writeMock.mockClear();
    writeImpl = async () => {
      throw new Error("forbidden path");
    };
    expect((await rejection(desktopEngine.exportEdit(photoJob(), PROBE, () => {}))).code).toBe("permission");
    expect(writeMock).toHaveBeenCalledTimes(2);
  });
});
