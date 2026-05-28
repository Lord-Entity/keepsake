// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Unit tests for src/editor/engine.ts (the EditorEngine the UI calls): platform dispatch, the per-file probe
 * cache, and validateJob gating before any native export starts. platform() and every Tauri API are mocked;
 * the real engine-desktop.ts / engine-android.ts run underneath.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let current = "windows";
mock.module("../../engine/platform", () => ({
  platform: () => current,
  inTauri: () => current !== "web",
  isDesktop: () => current === "windows" || current === "linux",
}));

let handlers = {};
const invokeMock = mock(async (cmd, args) => {
  const h = handlers[cmd];
  return h ? h(args) : undefined;
});
class FakeChannel {
  onmessage = () => {};
}
mock.module("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: FakeChannel,
  convertFileSrc: (p) => `asset://localhost/${p}`,
  addPluginListener: async () => ({ unregister: async () => {} }),
  isTauri: () => true,
}));
mock.module("@tauri-apps/api/path", () => ({
  join: async (...parts) => parts.join("/"),
  dirname: async (p) => p.slice(0, p.lastIndexOf("/")),
  downloadDir: async () => "/dl",
  appCacheDir: async () => "/cache",
}));
mock.module("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
mock.module("@tauri-apps/plugin-fs", () => ({
  exists: async () => false,
  mkdir: async () => {},
  open: async () => ({ read: async () => null, write: async (d) => d.length, close: async () => {} }),
  readFile: async () => new Uint8Array([1]),
  remove: async () => {},
  writeFile: async () => {},
}));
mock.module("../../state/settings", () => ({
  settingsStore: { get: () => ({ saveDir: "", saveTreeUri: "" }) },
}));

const { editorEngine, webAccept, releaseEditorStage } = await import("../engine");
const { desktopEngine } = await import("../engine-desktop");
const { EditorError } = await import("../types");

const PROBE = { width: 1920, height: 1080, duration: 10, hasAudio: true, rotation: 0 };
let n = 0;
/** A fresh path per test: engine.ts caches probes per file for the whole module lifetime. */
const freshVideo = () => ({ kind: "video", name: "clip.mp4", path: `/v/clip${++n}.mp4`, uri: `content://media/external/video/media/${n}` });

async function rejection(p) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}
const calls = (cmd) => invokeMock.mock.calls.filter((c) => c[0] === cmd);

beforeEach(() => {
  current = "windows";
  handlers = {
    editor_probe: async () => PROBE,
    edit_video: async () => undefined,
    "plugin:keepsake-media|editor_probe": async () => PROBE,
    "plugin:keepsake-media|editor_export_video": async (a) => ({ path: a.outPath }),
  };
  invokeMock.mockClear();
});

describe("dispatch", () => {
  test("windows and linux use the desktop commands", async () => {
    for (const p of ["windows", "linux"]) {
      current = p;
      invokeMock.mockClear();
      const v = freshVideo();
      expect(await editorEngine.probe(v)).toEqual(PROBE);
      expect(calls("editor_probe")[0][1]).toEqual({ path: v.path });
    }
  });

  test("android uses the keepsake-media plugin", async () => {
    current = "android";
    const v = freshVideo();
    expect(await editorEngine.probe(v)).toEqual(PROBE);
    expect(calls("plugin:keepsake-media|editor_probe")[0][1]).toEqual({ uri: v.uri });
    expect(calls("editor_probe").length).toBe(0);
  });

  test("releaseEditorStage resolves on every platform and makes no native call", async () => {
    for (const p of ["android", "windows", "linux", "web"]) {
      current = p;
      await expect(releaseEditorStage()).resolves.toBeUndefined();
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("pickMedia kind", () => {
  test("the kind is passed through; omitted means the platform module gets no argument", async () => {
    const real = desktopEngine.pickMedia;
    const seen = [];
    desktopEngine.pickMedia = async (...args) => {
      seen.push(args);
      return null;
    };
    try {
      expect(await editorEngine.pickMedia()).toBeNull();
      expect(await editorEngine.pickMedia("photo")).toBeNull();
      expect(await editorEngine.pickMedia("video")).toBeNull();
    } finally {
      desktopEngine.pickMedia = real;
    }
    expect(seen).toEqual([[], ["photo"], ["video"]]);
  });

  test("a picker failure still maps to an EditorError", async () => {
    const real = desktopEngine.pickMedia;
    desktopEngine.pickMedia = async () => {
      throw "boom";
    };
    try {
      const e = await rejection(editorEngine.pickMedia("photo"));
      expect(e).toBeInstanceOf(EditorError);
      expect(e.code).toBe("unsupported");
    } finally {
      desktopEngine.pickMedia = real;
    }
  });

  test("webAccept limits the dev-preview file input to the requested kind", () => {
    expect(webAccept("photo")).toBe(".jpg,.jpeg,.png,.webp,.bmp,.gif,.avif");
    expect(webAccept("video")).toBe(".mp4,.mov,.m4v,.mkv,.webm,.avi,.3gp,.ts,.mts");
    expect(webAccept()).toBe(`${webAccept("photo")},${webAccept("video")}`);
  });
});

describe("capabilities", () => {
  const FULL = { crop: true, trim: true, mute: true, exactTrim: true };

  test("desktop video reflects editor_capabilities", async () => {
    handlers.editor_capabilities = async () => ({ copyOnly: true, canReencode: false });
    const c = await editorEngine.capabilities("video");
    expect([c.crop, c.trim, c.exactTrim]).toEqual([false, true, false]);
  });

  test("never rejects: a failed check falls back to the full set", async () => {
    handlers.editor_capabilities = async () => {
      throw "boom";
    };
    expect(await editorEngine.capabilities("video")).toEqual(FULL);
  });

  test("android reports the full set without a native call", async () => {
    current = "android";
    expect(await editorEngine.capabilities("video")).toEqual(FULL);
    expect(await editorEngine.capabilities("photo")).toEqual(FULL);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("probe cache", () => {
  test("a second probe of the same file is not re-run; export reuses it", async () => {
    const v = freshVideo();
    await editorEngine.probe(v);
    await editorEngine.probe(v);
    await editorEngine.exportEdit({ input: v, audio: true, output: "mp4" }, () => {});
    expect(calls("editor_probe").length).toBe(1);
    expect(calls("edit_video").length).toBe(1);
  });

  test("a failed probe is not cached and maps to probe_failed", async () => {
    const v = freshVideo();
    handlers.editor_probe = async () => {
      throw "garbage";
    };
    const e = await rejection(editorEngine.probe(v));
    expect(e).toBeInstanceOf(EditorError);
    expect(e.code).toBe("probe_failed");
    handlers.editor_probe = async () => PROBE;
    expect(await editorEngine.probe(v)).toEqual(PROBE);
    expect(calls("editor_probe").length).toBe(2);
  });
});

describe("exportEdit gating", () => {
  test("an invalid job is rejected with invalid_job and the validateJob message, before any export", async () => {
    const v = freshVideo();
    const cases = [
      [{ trimStart: 2, trimEnd: 20 }, "Trim range is invalid"],
      [{ crop: { x: 0, y: 0, w: 1, h: 1 } }, "Crop is too small"],
      [{ crop: { x: 1000, y: 0, w: 1000, h: 100 } }, "Crop is outside the picture"],
      [{ output: "jpg" }, "A video exports as MP4"],
    ];
    for (const [over, message] of cases) {
      const e = await rejection(editorEngine.exportEdit({ input: v, audio: true, output: "mp4", ...over }, () => {}));
      expect(e).toBeInstanceOf(EditorError);
      expect(e.code).toBe("invalid_job");
      expect(e.message).toBe(message);
    }
    expect(calls("edit_video").length).toBe(0);
  });

  test("a valid job runs and returns the result", async () => {
    const v = freshVideo();
    const r = await editorEngine.exportEdit({ input: v, audio: true, output: "mp4", trimStart: 1, trimEnd: 5 }, () => {});
    expect(r).toEqual({ path: "/v/clip_edit.mp4", name: "clip_edit.mp4" });
    const args = calls("edit_video")[0][1];
    expect(args.trimStart).toBe(1);
    expect(args.trimEnd).toBe(5);
  });

  test("an aborted signal is cancelled before probing", async () => {
    const ac = new AbortController();
    ac.abort();
    const e = await rejection(editorEngine.exportEdit({ input: freshVideo(), audio: true, output: "mp4" }, () => {}, ac.signal));
    expect(e.code).toBe("cancelled");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("native export errors keep their EditorError code", async () => {
    handlers.edit_video = async () => {
      throw "editor:no_space: disk full";
    };
    const e = await rejection(editorEngine.exportEdit({ input: freshVideo(), audio: true, output: "mp4" }, () => {}));
    expect(e.code).toBe("no_space");
  });
});
