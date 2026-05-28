// @ts-nocheck -- bun:test types are not in tsconfig; bun runs this file, tsc does not need to.
/**
 * Tests for src/engine/android-gallery.ts: androidSaveMode and the `gallery:<code>: <msg> kept=<path>` error parsing.
 * ASSUMPTIONS (written before the module existed): exports androidSaveMode(settings) and publishToGallery({ src, kind,
 * fileName, mime }); a rejection is an Error/AppError whose `code` is the same-named AppErrorCode and whose text
 * (message or detail) still contains the kept path. Adjust if the final API differs.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../platform", () => ({
  platform: () => "android",
  inTauri: () => true,
  isDesktop: () => false,
}));

// bun's mock.module is process-wide: export every name any engine/editor module imports from this module.
let invokeImpl = async () => ({});
const invokeMock = mock((cmd, args) => invokeImpl(cmd, args));
class FakeChannel {
  onmessage = () => {};
}
mock.module("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: () => true,
  Channel: FakeChannel,
  convertFileSrc: (p) => `asset://localhost/${p}`,
  addPluginListener: async () => ({ unregister: async () => {} }),
}));

const { androidSaveMode, publishToGallery, GALLERY_SAVE } = await import("../android-gallery");

beforeEach(() => {
  invokeImpl = async () => ({});
  invokeMock.mockClear();
});

const all = (e) => [e?.code, e?.message, e?.detail].filter(Boolean).join(" | ");
const fail = (p) => p.then(() => null, (x) => x);

describe("androidSaveMode", () => {
  test("a tree uri wins over a legacy saveDir", () => {
    expect(androidSaveMode({ saveTreeUri: "content://tree/abc", saveDir: "/storage/emulated/0/Download" })).toBe("folder");
    expect(androidSaveMode({ saveTreeUri: "content://tree/abc", saveDir: "" })).toBe("folder");
  });
  test("explicit gallery value means gallery; empty saveDir keeps the old app folder (legacy)", () => {
    expect(androidSaveMode({ saveTreeUri: "", saveDir: GALLERY_SAVE })).toBe("gallery");
    expect(androidSaveMode({ saveTreeUri: "", saveDir: "" })).toBe("legacy");
    expect(androidSaveMode({ saveDir: "" })).toBe("legacy");
  });
  test("a non-empty saveDir without a tree is legacy", () => {
    expect(androidSaveMode({ saveTreeUri: "", saveDir: "/storage/emulated/0/Download" })).toBe("legacy");
  });
});

describe("publishToGallery", () => {
  const args = { src: "/cache/gallery-1/a.mp4", kind: "video", fileName: "a.mp4", mime: "video/mp4" };

  test("invokes galleryPublish through the plugin and returns the result", async () => {
    invokeImpl = async () => ({ uri: "content://media/external/video/media/9", displayPath: "Movies/Keepsake/a.mp4", bytes: 5 });
    const r = await publishToGallery(args);
    expect(invokeMock.mock.calls[0][0]).toBe("plugin:keepsake-media|gallery_publish");
    expect(r.uri).toBe("content://media/external/video/media/9");
  });

  for (const code of ["no_space", "permission", "unknown"]) {
    test(`gallery:${code} keeps the kept path`, async () => {
      invokeImpl = async () => {
        throw `gallery:${code}: could not save kept=/storage/emulated/0/Android/data/app/files/Download/a.mp4`;
      };
      const e = await fail(publishToGallery(args));
      expect(e).not.toBeNull();
      expect(e.code).toBe(code);
      expect(e.galleryCode).toBe(code);
      expect(e.keptPath).toBe("/storage/emulated/0/Android/data/app/files/Download/a.mp4");
      expect(all(e)).not.toContain("kept=");
    });
  }

  test("finds the marker inside wrapped text", async () => {
    invokeImpl = async () => {
      throw new Error("Error: gallery:no_space: disk full kept=/k/a.mp4");
    };
    await expect(publishToGallery(args)).rejects.toMatchObject({ code: "no_space", keptPath: "/k/a.mp4" });
  });

  test("no kept= marker still maps the code", async () => {
    invokeImpl = async () => {
      throw "gallery:permission: denied";
    };
    await expect(publishToGallery(args)).rejects.toMatchObject({ code: "permission" });
  });

  test("an unknown code falls back to unknown", async () => {
    invokeImpl = async () => {
      throw "gallery:bogus: nope";
    };
    await expect(publishToGallery(args)).rejects.toMatchObject({ code: "unknown" });
  });
});
