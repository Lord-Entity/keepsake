// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Unit tests for src/editor/engine-android.ts: picker URI -> kind/name, probe (native + photo), previewUrl,
 * editor_export_video argument mapping, progress events, save modes (legacy / gallery / folder), cancel and
 * error-code mapping. The Tauri bridge, path, dialog and fs APIs and the settings store are mocked; the real
 * android-gallery.ts / android-folder.ts run on top of the mocked invoke (so they are not replaced for other files).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const P = "plugin:keepsake-media|";
let handlers = {};
const invokeMock = mock(async (cmd, args) => {
  const h = handlers[cmd];
  return h ? h(args) : undefined;
});
let progressCb;
let listenerFails = false;
const unregisterMock = mock(async () => {});
const listenMock = mock(async (plugin, event, cb) => {
  if (listenerFails) throw new Error("listener unavailable");
  progressCb = cb;
  return { unregister: unregisterMock };
});
// bun's mock.module is process-wide: export every name any editor/engine module imports from these
// (ytdlp.ts and engine-desktop.ts import Channel; engine-desktop.ts imports convertFileSrc and dirname),
// so a module linked later under this mock never misses an export.
mock.module("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  addPluginListener: listenMock,
  Channel: class Channel {
    onmessage = () => {};
  },
  convertFileSrc: (p) => `asset://localhost/${p}`,
  isTauri: () => true,
}));

const DL = "/storage/emulated/0/Download";
mock.module("@tauri-apps/api/path", () => ({
  join: async (...parts) => parts.join("/"),
  dirname: async (p) => p.slice(0, p.lastIndexOf("/")),
  appCacheDir: async () => "/data/cache",
  downloadDir: async () => DL,
}));

let dialogImpl = async () => null;
const dialogMock = mock((opts) => dialogImpl(opts));
mock.module("@tauri-apps/plugin-dialog", () => ({ open: dialogMock }));

let taken = new Set();
let mkdirImpl = async () => {};
let writeImpl = async () => {};
let chunks = [];
const closeHandle = mock(async () => {});
const mkdirMock = mock((p, o) => mkdirImpl(p, o));
const writeMock = mock((p, b) => writeImpl(p, b));
const removeMock = mock(async () => {});
/** Bytes written through file handles (the legacy-mode video copy). */
let handleWrites = [];
const handleWrite = mock(async (data) => {
  handleWrites.push(...data);
  return data.length;
});
const openMock = mock(async () => ({
  read: async (buf) => {
    const next = chunks.shift();
    if (next === undefined) return null;
    if (typeof next === "number") return next;
    buf.set(next);
    return next.length;
  },
  write: handleWrite,
  close: closeHandle,
}));
/** Staged files in the app cache exist unless a test says they went missing. */
let stagedMissing = false;
let dirEntries = [];
const readDirMock = mock(async () => dirEntries);
mock.module("@tauri-apps/plugin-fs", () => ({
  exists: async (p) => taken.has(p) || (p.startsWith("/data/cache/") && !stagedMissing),
  mkdir: mkdirMock,
  open: openMock,
  readDir: readDirMock,
  readFile: async () => new Uint8Array([1, 2, 3]),
  remove: removeMock,
  writeFile: writeMock,
}));

let settings = { saveDir: "", saveTreeUri: "" };
mock.module("../../state/settings", () => ({
  settingsStore: { get: () => settings },
}));

// Photo decode/encode and object-URL fakes.
const realCreateImageBitmap = globalThis.createImageBitmap;
const realOffscreenCanvas = globalThis.OffscreenCanvas;
const realCreateObjectURL = URL.createObjectURL;
let lastBlob;
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
URL.createObjectURL = (b) => {
  lastBlob = b;
  return "blob:fake";
};
afterAll(() => {
  globalThis.createImageBitmap = realCreateImageBitmap;
  globalThis.OffscreenCanvas = realOffscreenCanvas;
  URL.createObjectURL = realCreateObjectURL;
});

const { androidEngine, discardPendingStage, stageTime, sweepStaleStages, STAGE_PREFIX } = await import("../engine-android");
const { stepOf } = await import("../engine-photo");
const { EditorError } = await import("../types");

const VURI = "content://media/external/video/media/42";
const VIDEO = { kind: "video", name: "clip.mp4", uri: VURI };
const PHOTO = { kind: "photo", name: "pic.jpg", uri: "content://media/external/images/media/9" };
const PROBE = { width: 1920, height: 1080, duration: 10, hasAudio: true, rotation: 0 };
const LEGACY_OUT = `${DL}/clip_edit.mp4`;
/**
 * The plugin only writes inside the app cache: every video export goes to a staging dir there first. Its name must
 * start with "gallery-" (KeepsakeMediaPlugin.kt stagedSource refuses any other publish source).
 */
const STAGED = /^\/data\/cache\/gallery-editor-[a-z0-9]+-[a-z0-9]+\/clip_edit\.mp4$/;
const stageOf = (p) => p.slice(0, p.lastIndexOf("/"));
const removedStage = (stage) => removeMock.mock.calls.some((c) => c[0] === stage);

const videoJob = (over = {}) => ({ input: VIDEO, audio: true, output: "mp4", ...over });
const photoJob = (over = {}) => ({ input: PHOTO, audio: false, output: "jpg", ...over });

async function rejection(p) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

const calls = (cmd) => invokeMock.mock.calls.filter((c) => c[0] === cmd);
/** Default export handler: succeed and return the outPath it was given. */
const exportOk = async (args) => ({ path: args.outPath });

beforeEach(async () => {
  // A failed save in one test must not hand its kept stage to the next one.
  await discardPendingStage();
  stagedMissing = false;
  dirEntries = [];
  readDirMock.mockClear();
  handlers = { [`${P}editor_export_video`]: exportOk };
  invokeMock.mockClear();
  listenMock.mockClear();
  unregisterMock.mockClear();
  listenerFails = false;
  progressCb = undefined;
  dialogImpl = async () => null;
  dialogMock.mockClear();
  taken = new Set();
  mkdirImpl = async () => {};
  writeImpl = async () => {};
  chunks = [];
  closeHandle.mockClear();
  handleWrites = [];
  handleWrite.mockClear();
  mkdirMock.mockClear();
  writeMock.mockClear();
  removeMock.mockClear();
  openMock.mockClear();
  settings = { saveDir: "", saveTreeUri: "" };
  lastBlob = undefined;
});

describe("pickMedia", () => {
  test("uses the media picker; a video/ URI is a video with a generated name", async () => {
    dialogImpl = async () => VURI;
    const r = await androidEngine.pickMedia();
    expect(r.kind).toBe("video");
    expect(r.uri).toBe(VURI);
    expect(r.name).toMatch(/^VID_\d{8}_\d{6}\.mp4$/);
    expect(dialogMock.mock.calls[0][0].pickerMode).toBe("media");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("a document URI with a file name keeps the name and its kind", async () => {
    const uri = "content://com.android.externalstorage.documents/document/primary%3ADCIM%2Fbeach.JPG";
    dialogImpl = async () => uri;
    expect(await androidEngine.pickMedia()).toEqual({ kind: "photo", name: "beach.JPG", uri });
  });

  test("an opaque picker URI is probed: a duration means video, and probe() reuses that result once", async () => {
    const uri = "content://media/picker/0/com.android.providers.media.photopicker/media/1000";
    dialogImpl = async () => uri;
    handlers[`${P}editor_probe`] = async () => ({ width: 720, height: 1280, duration: 5, hasAudio: true, rotation: 90 });
    const r = await androidEngine.pickMedia();
    expect(r.kind).toBe("video");
    expect(r.name).toMatch(/^VID_.*\.mp4$/);
    expect(calls(`${P}editor_probe`)).toEqual([[`${P}editor_probe`, { uri }]]);

    expect(await androidEngine.probe(r)).toEqual({ width: 720, height: 1280, duration: 5, hasAudio: true, rotation: 90 });
    expect(calls(`${P}editor_probe`).length).toBe(1);
    await androidEngine.probe(r);
    expect(calls(`${P}editor_probe`).length).toBe(2);
  });

  test("an opaque URI that fails to probe, or has no duration, is a photo", async () => {
    const uri = "content://media/picker/0/com.android.providers.media.photopicker/media/2000";
    dialogImpl = async () => uri;
    handlers[`${P}editor_probe`] = async () => {
      throw "editor:unsupported: not a video";
    };
    const r = await androidEngine.pickMedia();
    expect(r.kind).toBe("photo");
    expect(r.name).toMatch(/^IMG_\d{8}_\d{6}\.jpg$/);

    handlers[`${P}editor_probe`] = async () => ({ width: 10, height: 10, duration: 0 });
    expect((await androidEngine.pickMedia()).kind).toBe("photo");
  });

  test("no kind keeps the media picker for both families", async () => {
    await androidEngine.pickMedia();
    expect(dialogMock.mock.calls[0][0]).toEqual({
      multiple: false,
      directory: false,
      pickerMode: "media",
      filters: [{ name: "Photos and videos", extensions: ["image/*", "video/*"] }],
    });
  });

  test("a requested kind limits the picker to image/* or video/*", async () => {
    await androidEngine.pickMedia("photo");
    await androidEngine.pickMedia("video");
    const [photo, video] = dialogMock.mock.calls.map((c) => c[0]);
    expect(photo.pickerMode).toBe("image");
    expect(photo.filters).toEqual([{ name: "Photos", extensions: ["image/*"] }]);
    expect(video.pickerMode).toBe("video");
    expect(video.filters).toEqual([{ name: "Videos", extensions: ["video/*"] }]);
  });

  test("an opaque URI from a kind-limited picker takes that kind without a native probe", async () => {
    const uri = "content://media/picker/0/com.android.providers.media.photopicker/media/3000";
    dialogImpl = async () => uri;
    const v = await androidEngine.pickMedia("video");
    expect(v.kind).toBe("video");
    expect(v.name).toMatch(/^VID_\d{8}_\d{6}\.mp4$/);
    const p = await androidEngine.pickMedia("photo");
    expect(p.kind).toBe("photo");
    expect(p.name).toMatch(/^IMG_\d{8}_\d{6}\.jpg$/);
    expect(calls(`${P}editor_probe`).length).toBe(0);
  });

  test("the file's real kind wins over the requested one", async () => {
    dialogImpl = async () => VURI;
    expect((await androidEngine.pickMedia("photo")).kind).toBe("video");
  });

  test("the plugin's 'File picker cancelled' rejection is a cancel (null), not an error", async () => {
    dialogImpl = async () => {
      throw "File picker cancelled";
    };
    expect(await androidEngine.pickMedia()).toBeNull();
    expect(await androidEngine.pickMedia("photo")).toBeNull();
  });

  test("cancel returns null; picker failure is permission", async () => {
    expect(await androidEngine.pickMedia()).toBeNull();
    dialogImpl = async () => {
      throw new Error("picker crashed");
    };
    expect((await rejection(androidEngine.pickMedia())).code).toBe("permission");
  });
});

describe("probe", () => {
  test("video probe invokes the plugin with the URI", async () => {
    handlers[`${P}editor_probe`] = async () => ({ width: 1920, height: 1080, duration: 12.5, hasAudio: false, rotation: 270 });
    expect(await androidEngine.probe(VIDEO)).toEqual({ width: 1920, height: 1080, duration: 12.5, hasAudio: false, rotation: 270 });
    expect(calls(`${P}editor_probe`)[0][1]).toEqual({ uri: VURI });
  });

  test("plugin errors map to codes", async () => {
    const cases = [
      ["editor:unsupported: HDR source", "unsupported"],
      ["editor:permission: SecurityException", "permission"],
      ["editor:no_space: cache full", "no_space"],
      ["plugin keepsake-media not found", "unsupported"],
      ["MediaExtractor failed", "probe_failed"],
    ];
    for (const [text, code] of cases) {
      handlers[`${P}editor_probe`] = async () => {
        throw text;
      };
      const e = await rejection(androidEngine.probe(VIDEO));
      expect(e).toBeInstanceOf(EditorError);
      expect(e.code).toBe(code);
    }
  });

  test("photo probe decodes in the webview; missing URI is invalid_job; aborted is cancelled", async () => {
    expect(await androidEngine.probe(PHOTO)).toEqual({ width: 640, height: 480, duration: 0, hasAudio: false, rotation: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
    expect((await rejection(androidEngine.probe({ kind: "video", name: "x.mp4" }))).code).toBe("invalid_job");
    const ac = new AbortController();
    ac.abort();
    expect((await rejection(androidEngine.probe(VIDEO, ac.signal))).code).toBe("cancelled");
  });
});

describe("previewUrl", () => {
  test("photo is read whole into a typed blob", async () => {
    expect(await androidEngine.previewUrl({ kind: "photo", name: "beach.png", uri: "content://x/beach.png" })).toBe("blob:fake");
    expect(lastBlob.type).toBe("image/png");
    expect(lastBlob.size).toBe(3);
  });

  test("video is read in chunks and the handle is closed", async () => {
    chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    expect(await androidEngine.previewUrl(VIDEO)).toBe("blob:fake");
    expect(openMock.mock.calls[0]).toEqual([VURI, { read: true }]);
    expect(lastBlob.type).toBe("video/mp4");
    expect([...new Uint8Array(await lastBlob.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
    expect(closeHandle).toHaveBeenCalledTimes(1);
  });

  test("a video over 1 GB is unsupported for preview", async () => {
    chunks = [600 * 1024 * 1024, 600 * 1024 * 1024];
    const e = await rejection(androidEngine.previewUrl(VIDEO));
    expect(e.code).toBe("unsupported");
    expect(closeHandle).toHaveBeenCalledTimes(1);
  });
});

describe("exportEdit: video, legacy folder", () => {
  test("maps crop/trim/audio into editor_export_video, exports into the cache and saves to Downloads", async () => {
    const res = await androidEngine.exportEdit(
      videoJob({ crop: { x: 3, y: 5, w: 101, h: 99 }, trimStart: 1.5, trimEnd: 10 }),
      PROBE,
      () => {},
    );
    expect(res).toEqual({ path: LEGACY_OUT, name: "clip_edit.mp4" });
    const args = calls(`${P}editor_export_video`)[0][1];
    expect(args).toEqual({
      uri: VURI,
      outPath: expect.stringMatching(STAGED),
      crop: { x: 2, y: 4, w: 100, h: 98 },
      trimStart: 1.5,
      audio: true,
    });
    expect(mkdirMock.mock.calls[0]).toEqual([DL, { recursive: true }]);
    expect(openMock.mock.calls).toEqual([
      [args.outPath, { read: true }],
      [LEGACY_OUT, { write: true, create: true, truncate: true }],
    ]);
    expect(removeMock).toHaveBeenCalledWith(args.outPath.slice(0, -"/clip_edit.mp4".length), { recursive: true });
    expect(removeMock).not.toHaveBeenCalledWith(LEGACY_OUT);
  });

  test("the staged video is copied into the save folder chunk by chunk and both handles are closed", async () => {
    chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    await androidEngine.exportEdit(videoJob(), PROBE, () => {});
    expect(handleWrites).toEqual([1, 2, 3, 4, 5]);
    expect(handleWrite).toHaveBeenCalledTimes(2);
    expect(closeHandle).toHaveBeenCalledTimes(2);
  });

  test("a failed copy maps to its code and removes the partial file", async () => {
    handleWrite.mockImplementationOnce(async () => {
      throw new Error("No space left on device (os error 28)");
    });
    chunks = [new Uint8Array([1])];
    expect((await rejection(androidEngine.exportEdit(videoJob(), PROBE, () => {}))).code).toBe("no_space");
    expect(removeMock).toHaveBeenCalledWith(LEGACY_OUT);
    expect(closeHandle).toHaveBeenCalledTimes(2);
  });

  test("no crop, no trim and mute send only uri/outPath/audio", async () => {
    await androidEngine.exportEdit(videoJob({ audio: false }), PROBE, () => {});
    const args = calls(`${P}editor_export_video`)[0][1];
    expect(Object.keys(args).toSorted()).toEqual(["audio", "outPath", "uri"]);
    expect(args.audio).toBe(false);
  });

  test("a silent source always sends audio false; trimEnd is sent when before the end", async () => {
    await androidEngine.exportEdit(videoJob({ trimEnd: 4 }), { ...PROBE, hasAudio: false }, () => {});
    const args = calls(`${P}editor_export_video`)[0][1];
    expect(args.audio).toBe(false);
    expect(args.trimEnd).toBe(4);
    expect("trimStart" in args).toBe(false);
  });

  test("Settings saveDir is used (trailing slash dropped); taken names get (n)", async () => {
    settings = { saveDir: "/storage/emulated/0/Movies/Keepsake/", saveTreeUri: "" };
    taken = new Set(["/storage/emulated/0/Movies/Keepsake/clip_edit.mp4"]);
    const res = await androidEngine.exportEdit(videoJob(), PROBE, () => {});
    expect(res.path).toBe("/storage/emulated/0/Movies/Keepsake/clip_edit (1).mp4");
  });

  test("progress events are gated, end at 1, and the listener is removed", async () => {
    handlers[`${P}editor_export_video`] = async (args) => {
      progressCb({ fraction: 0.3 });
      progressCb({ fraction: "x" });
      progressCb({ fraction: 0.2 });
      progressCb({ fraction: 0.9 });
      return { path: args.outPath };
    };
    const seen = [];
    await androidEngine.exportEdit(videoJob(), PROBE, (f) => seen.push(f));
    expect(listenMock.mock.calls[0].slice(0, 2)).toEqual(["keepsake-media", "keepsake-editor-progress"]);
    expect(seen).toEqual([0.3, 0.9, 1]);
    expect(unregisterMock).toHaveBeenCalledTimes(1);
  });

  test("export still works when the progress listener cannot be added", async () => {
    listenerFails = true;
    const seen = [];
    expect((await androidEngine.exportEdit(videoJob(), PROBE, (f) => seen.push(f))).path).toBe(LEGACY_OUT);
    expect(seen).toEqual([1]);
  });

  test("plugin errors map to codes and the partial file is removed", async () => {
    const cases = [
      ["editor:no_space: ENOSPC", "no_space"],
      ["editor:permission: cannot write", "permission"],
      ["editor:unsupported: no H.264 encoder", "unsupported"],
      ["editor:export_failed: ExportException 7001", "export_failed"],
      ["Transformer died", "export_failed"],
    ];
    for (const [text, code] of cases) {
      removeMock.mockClear();
      handlers[`${P}editor_export_video`] = async () => {
        throw text;
      };
      const e = await rejection(androidEngine.exportEdit(videoJob(), PROBE, () => {}));
      expect(e).toBeInstanceOf(EditorError);
      expect(e.code).toBe(code);
      expect(removeMock).toHaveBeenCalledWith(LEGACY_OUT);
    }
  });

  test("a response without a path is export_failed", async () => {
    handlers[`${P}editor_export_video`] = async () => ({});
    expect((await rejection(androidEngine.exportEdit(videoJob(), PROBE, () => {}))).code).toBe("export_failed");
    expect(removeMock).toHaveBeenCalledWith(LEGACY_OUT);
  });

  test("an unwritable save folder is permission", async () => {
    mkdirImpl = async () => {
      throw new Error("Permission denied (os error 13)");
    };
    expect((await rejection(androidEngine.exportEdit(videoJob(), PROBE, () => {}))).code).toBe("permission");
    expect(calls(`${P}editor_export_video`).length).toBe(0);
  });

  test("abort sends editor_cancel, removes the partial file and rejects cancelled", async () => {
    const ac = new AbortController();
    handlers[`${P}editor_export_video`] = async () => {
      ac.abort();
      throw "editor:cancelled: Export cancelled";
    };
    const e = await rejection(androidEngine.exportEdit(videoJob(), PROBE, () => {}, ac.signal));
    expect(e.code).toBe("cancelled");
    expect(calls(`${P}editor_cancel`)).toEqual([[`${P}editor_cancel`, {}]]);
    expect(removeMock).toHaveBeenCalledWith(LEGACY_OUT);
  });

  test("an abort while the stage is being prepared never starts the export", async () => {
    const ac = new AbortController();
    mkdirImpl = async () => {
      ac.abort();
    };
    expect((await rejection(androidEngine.exportEdit(videoJob(), PROBE, () => {}, ac.signal))).code).toBe("cancelled");
    expect(calls(`${P}editor_export_video`).length).toBe(0);
  });

  test("an already-aborted signal never starts the export", async () => {
    const ac = new AbortController();
    ac.abort();
    expect((await rejection(androidEngine.exportEdit(videoJob(), PROBE, () => {}, ac.signal))).code).toBe("cancelled");
    expect(calls(`${P}editor_export_video`).length).toBe(0);
  });
});

describe("exportEdit: video, gallery and folder modes", () => {
  test("gallery mode exports into a cache stage, publishes, then removes the stage", async () => {
    settings = { saveDir: "gallery", saveTreeUri: "" };
    handlers[`${P}gallery_publish`] = async () => ({ uri: "content://media/external/video/media/77" });
    const res = await androidEngine.exportEdit(videoJob(), PROBE, () => {});
    expect(res).toEqual({ path: "content://media/external/video/media/77", name: "clip_edit.mp4" });
    const outPath = calls(`${P}editor_export_video`)[0][1].outPath;
    expect(outPath).toMatch(STAGED);
    expect(calls(`${P}gallery_publish`)[0][1]).toEqual({ src: outPath, kind: "video", fileName: "clip_edit.mp4", mime: "video/mp4" });
    const stage = outPath.slice(0, -"/clip_edit.mp4".length);
    expect(removeMock).toHaveBeenCalledWith(stage, { recursive: true });
  });

  test("gallery errors map to no_space / permission / export_failed", async () => {
    settings = { saveDir: "gallery", saveTreeUri: "" };
    for (const [text, code] of [
      ["gallery:no_space: full", "no_space"],
      ["gallery:permission: denied", "permission"],
      ["gallery:unknown: MediaStore insert failed", "export_failed"],
    ]) {
      handlers[`${P}gallery_publish`] = async () => {
        throw text;
      };
      expect((await rejection(androidEngine.exportEdit(videoJob(), PROBE, () => {}))).code).toBe(code);
    }
  });

  test("gallery permission error with a kept file outside the stage reports that file", async () => {
    settings = { saveDir: "gallery", saveTreeUri: "" };
    handlers[`${P}gallery_publish`] = async () => {
      throw "gallery:permission: no WRITE_EXTERNAL_STORAGE kept=/storage/emulated/0/Movies/Keepsake/clip_edit.mp4";
    };
    expect(await androidEngine.exportEdit(videoJob(), PROBE, () => {})).toEqual({
      path: "/storage/emulated/0/Movies/Keepsake/clip_edit.mp4",
      name: "clip_edit.mp4",
    });
  });

  test("folder mode copies into the SAF tree", async () => {
    settings = { saveDir: "", saveTreeUri: "content://tree/abc" };
    handlers[`${P}folder_save`] = async () => ({ uri: "content://tree/abc/document/1", name: "clip_edit.mp4" });
    expect(await androidEngine.exportEdit(videoJob(), PROBE, () => {})).toEqual({
      path: "content://tree/abc/document/1",
      name: "clip_edit.mp4",
    });
    const args = calls(`${P}folder_save`)[0][1];
    expect(args.treeUri).toBe("content://tree/abc");
    expect(args.fileName).toBe("clip_edit.mp4");
    expect(args.mime).toBe("video/mp4");
    expect(args.src).toMatch(STAGED);
  });

  test("folder errors map to codes", async () => {
    settings = { saveDir: "", saveTreeUri: "content://tree/abc" };
    for (const [text, code] of [
      ["folder:no_space: full", "no_space"],
      ["folder:permission: revoked", "permission"],
      ["folder:not_found: gone", "permission"],
      ["folder:io: broken pipe", "export_failed"],
    ]) {
      handlers[`${P}folder_save`] = async () => {
        throw text;
      };
      expect((await rejection(androidEngine.exportEdit(videoJob(), PROBE, () => {}))).code).toBe(code);
    }
  });
});

describe("exportEdit: photo", () => {
  test("legacy mode writes <name>_edit.jpg into Downloads and reports 1", async () => {
    const seen = [];
    expect(await androidEngine.exportEdit(photoJob(), { ...PROBE, duration: 0 }, (f) => seen.push(f))).toEqual({
      path: `${DL}/pic_edit.jpg`,
      name: "pic_edit.jpg",
    });
    expect([...writeMock.mock.calls[0][1]]).toEqual([7]);
    expect(seen).toEqual([1]);
  });

  test("legacy write failures map to permission or no_space", async () => {
    writeImpl = async () => {
      throw new Error("EACCES: permission denied");
    };
    expect((await rejection(androidEngine.exportEdit(photoJob(), PROBE, () => {}))).code).toBe("permission");
    writeImpl = async () => {
      throw new Error("No space left on device (os error 28)");
    };
    expect((await rejection(androidEngine.exportEdit(photoJob(), PROBE, () => {}))).code).toBe("no_space");
  });

  test("gallery mode stages the PNG, publishes it as an image and removes the stage", async () => {
    settings = { saveDir: "gallery", saveTreeUri: "" };
    handlers[`${P}gallery_publish`] = async () => ({ uri: "content://media/external/images/media/5" });
    const res = await androidEngine.exportEdit(photoJob({ output: "png" }), PROBE, () => {});
    expect(res).toEqual({ path: "content://media/external/images/media/5", name: "pic_edit.png" });
    const args = calls(`${P}gallery_publish`)[0][1];
    expect(args.kind).toBe("image");
    expect(args.mime).toBe("image/png");
    expect(args.fileName).toBe("pic_edit.png");
    expect(args.src).toMatch(/^\/data\/cache\/gallery-editor-[a-z0-9]+-[a-z0-9]+\/pic_edit\.png$/);
    // The PNG was written to exactly the path that was published.
    expect(writeMock.mock.calls[0][0]).toBe(args.src);
    expect(removeMock).toHaveBeenCalledWith(args.src.slice(0, -"/pic_edit.png".length), { recursive: true });
  });
});

describe("exportEdit: staged save (Gallery / folder) like download.ts runStaged", () => {
  const GALLERY = { saveDir: "gallery", saveTreeUri: "" };
  const FOLDER = { saveDir: "", saveTreeUri: "content://tree/abc" };

  test("the stage prefix is one the plugin's stagedSource accepts", () => {
    expect(STAGE_PREFIX.startsWith("gallery-")).toBe(true);
  });

  test("publishes exactly the file Media3 wrote, and removes the stage only after the publish succeeded", async () => {
    settings = GALLERY;
    let removedBeforePublish;
    handlers[`${P}gallery_publish`] = async (args) => {
      removedBeforePublish = removedStage(stageOf(args.src));
      return { uri: "content://media/external/video/media/1" };
    };
    await androidEngine.exportEdit(videoJob(), PROBE, () => {});
    const outPath = calls(`${P}editor_export_video`)[0][1].outPath;
    expect(calls(`${P}gallery_publish`)[0][1].src).toBe(outPath);
    expect(removedBeforePublish).toBe(false);
    expect(removedStage(stageOf(outPath))).toBe(true);
  });

  test("a failed save keeps the stage; Retry of the same edit re-publishes it without re-encoding", async () => {
    settings = GALLERY;
    handlers[`${P}gallery_publish`] = async () => {
      throw "gallery:unknown: MediaStore insert failed";
    };
    const e = await rejection(androidEngine.exportEdit(videoJob(), PROBE, () => {}));
    expect(e.code).toBe("export_failed");
    expect(stepOf(e)).toBe("save");
    expect(e.message).toContain("Your edit was made, but Keepsake couldn't save it to the Gallery.");
    expect(e.message).toContain("Tap Retry to save it again");
    expect(e.message).toContain("(Details: gallery:unknown: MediaStore insert failed");
    const src = calls(`${P}gallery_publish`)[0][1].src;
    expect(removedStage(stageOf(src))).toBe(false);

    handlers[`${P}gallery_publish`] = async () => ({ uri: "content://media/external/video/media/2" });
    const seen = [];
    const res = await androidEngine.exportEdit(videoJob(), PROBE, (f) => seen.push(f));
    expect(res.path).toBe("content://media/external/video/media/2");
    expect(calls(`${P}editor_export_video`).length).toBe(1);
    expect(calls(`${P}gallery_publish`)[1][1].src).toBe(src);
    expect(seen).toEqual([1]);
    expect(removedStage(stageOf(src))).toBe(true);
  });

  test("a different edit drops the kept stage and exports again", async () => {
    settings = GALLERY;
    handlers[`${P}gallery_publish`] = async () => {
      throw "gallery:unknown: boom";
    };
    await rejection(androidEngine.exportEdit(videoJob(), PROBE, () => {}));
    const first = calls(`${P}editor_export_video`)[0][1].outPath;
    handlers[`${P}gallery_publish`] = async () => ({ uri: "content://x/3" });
    await androidEngine.exportEdit(videoJob({ audio: false }), PROBE, () => {});
    expect(calls(`${P}editor_export_video`).length).toBe(2);
    expect(removedStage(stageOf(first))).toBe(true);
  });

  test("folder source_missing: honest save-step error, stage removed, Retry exports again", async () => {
    settings = FOLDER;
    handlers[`${P}folder_save`] = async () => {
      throw "folder:source_missing: The source must be a staged download in the app cache: /x";
    };
    const e = await rejection(androidEngine.exportEdit(videoJob(), PROBE, () => {}));
    expect(e).toBeInstanceOf(EditorError);
    expect(e.code).toBe("export_failed");
    expect(stepOf(e)).toBe("save");
    expect(e.message).toContain("Your edit was made, but Keepsake couldn't save it to your folder.");
    expect(e.message).toContain("Tap Retry to export it again.");
    expect(e.message).toContain("(Details: folder:source_missing: The source must be a staged download");
    expect(e.message).not.toContain("downloaded file");
    const src = calls(`${P}folder_save`)[0][1].src;
    expect(removedStage(stageOf(src))).toBe(true);

    handlers[`${P}folder_save`] = async () => ({ uri: "content://tree/abc/document/9", name: "clip_edit.mp4" });
    await androidEngine.exportEdit(videoJob(), PROBE, () => {});
    expect(calls(`${P}editor_export_video`).length).toBe(2);
  });

  test("a staged file that is not there is an export-step error and nothing is published", async () => {
    settings = GALLERY;
    stagedMissing = true;
    const e = await rejection(androidEngine.exportEdit(videoJob(), PROBE, () => {}));
    expect(e.code).toBe("export_failed");
    expect(stepOf(e)).toBe("export");
    expect(e.message).toContain("Details: export: missing /data/cache/gallery-editor-");
    expect(calls(`${P}gallery_publish`).length).toBe(0);
  });

  test("photo: a failed folder save keeps the PNG for Retry; leaving the editor frees it", async () => {
    settings = FOLDER;
    handlers[`${P}folder_save`] = async () => {
      throw "folder:io: broken pipe";
    };
    const e = await rejection(androidEngine.exportEdit(photoJob({ output: "png" }), PROBE, () => {}));
    expect(stepOf(e)).toBe("save");
    const src = calls(`${P}folder_save`)[0][1].src;
    expect(writeMock.mock.calls[0][0]).toBe(src);
    expect(removedStage(stageOf(src))).toBe(false);
    await discardPendingStage();
    expect(removedStage(stageOf(src))).toBe(true);
  });

  test("an abort during the save does not keep the stage", async () => {
    settings = GALLERY;
    const ac = new AbortController();
    handlers[`${P}gallery_publish`] = async () => {
      ac.abort();
      throw "gallery:unknown: interrupted";
    };
    await rejection(androidEngine.exportEdit(videoJob(), PROBE, () => {}, ac.signal));
    const src = calls(`${P}gallery_publish`)[0][1].src;
    expect(removedStage(stageOf(src))).toBe(true);
  });

  test("the sweep removes only gallery-editor stages older than an hour", async () => {
    const old = `${STAGE_PREFIX}${(Date.now() - 2 * 3600_000).toString(36)}-abcd`;
    const fresh = `${STAGE_PREFIX}${(Date.now() - 60_000).toString(36)}-abcd`;
    dirEntries = [
      { name: old, isDirectory: true },
      { name: fresh, isDirectory: true },
      { name: "gallery-job1-xyz", isDirectory: true },
      // "_" is not a base-36 digit, so no creation time can be read from this name ("garbage" would parse as one).
      { name: `${STAGE_PREFIX}_partial`, isDirectory: true },
    ];
    // Pass the listing directly: the plugin-fs mock is process-wide in bun, so the default readDir may belong to another file.
    await sweepStaleStages("/data/cache", async () => dirEntries);
    expect(removeMock.mock.calls.map((c) => c[0])).toEqual([`/data/cache/${old}`]);
    expect(stageTime(fresh)).toBeGreaterThan(0);
    expect(Number.isNaN(stageTime("gallery-job1-xyz"))).toBe(true);
    expect(Number.isNaN(stageTime(`${STAGE_PREFIX}_partial`))).toBe(true);
  });
});
