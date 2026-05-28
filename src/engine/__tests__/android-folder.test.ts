// @ts-nocheck -- bun:test types are not in tsconfig; bun runs this file, tsc does not need to.
/**
 * Tests for src/engine/android-folder.ts: folder wrappers and `folder:<code>: <msg>` error parsing.
 * ASSUMPTIONS (module did not exist when written): exports pickAndroidFolder(), folderStatus(treeUri),
 * saveToFolder({ src, treeUri, fileName, mime }); a rejection has `code` = the same-named AppErrorCode for
 * permission and no_space, and its text contains the native message. Adjust if the final API differs.
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

const { pickAndroidFolder, folderStatus, saveToFolder } = await import("../android-folder");

beforeEach(() => {
  invokeImpl = async () => ({});
  invokeMock.mockClear();
});

const args = {
  src: "/cache/gallery-1/a.mp4",
  treeUri: "content://com.android.externalstorage.documents/tree/primary%3AKeep",
  fileName: "a.mp4",
  mime: "video/mp4",
};
const fail = (p) => p.then(() => null, (x) => x);
const text = (e) => [e?.code, e?.message, e?.detail].filter(Boolean).join(" | ");

describe("wrappers", () => {
  test("pickAndroidFolder returns uri and name, or null on cancel", async () => {
    invokeImpl = async () => ({ uri: args.treeUri, name: "Keep" });
    expect(await pickAndroidFolder()).toMatchObject({ uri: args.treeUri, name: "Keep" });
    expect(invokeMock.mock.calls[0][0]).toBe("plugin:keepsake-media|folder_pick");
    invokeImpl = async () => ({ uri: null, name: null });
    const r = await pickAndroidFolder();
    expect(r == null || r.uri == null).toBe(true);
  });

  test("folderStatus sends treeUri", async () => {
    invokeImpl = async () => ({ ok: true, name: "Keep" });
    const r = await folderStatus(args.treeUri);
    expect(invokeMock.mock.calls[0][0]).toBe("plugin:keepsake-media|folder_status");
    expect(invokeMock.mock.calls[0][1]).toMatchObject({ treeUri: args.treeUri });
    expect(r.ok).toBe(true);
  });

  test("saveToFolder sends src, treeUri, fileName, mime", async () => {
    invokeImpl = async () => ({ uri: "content://x/document/1", name: "a.mp4", bytes: 3 });
    const r = await saveToFolder(args);
    expect(invokeMock.mock.calls[0][0]).toBe("plugin:keepsake-media|folder_save");
    expect(invokeMock.mock.calls[0][1]).toMatchObject(args);
    expect(r.uri).toBe("content://x/document/1");
  });
});

describe("folder:<code> error parsing", () => {
  for (const code of ["permission", "not_found", "no_space", "source_missing", "bad_uri", "io"]) {
    test(`folder:${code} is surfaced with its message`, async () => {
      invokeImpl = async () => {
        throw `folder:${code}: something went wrong`;
      };
      const e = await fail(saveToFolder(args));
      expect(e).not.toBeNull();
      expect(text(e)).toContain("something went wrong");
      expect(e.folderCode).toBe(code);
      if (code === "permission" || code === "no_space") expect(e.code).toBe(code);
    });
  }

  test("finds the marker inside wrapped text", async () => {
    invokeImpl = async () => {
      throw new Error("Error: folder:no_space: disk full");
    };
    await expect(saveToFolder(args)).rejects.toMatchObject({ code: "no_space" });
  });

  test("an unknown folder code still rejects", async () => {
    invokeImpl = async () => {
      throw "folder:bogus: nope";
    };
    expect(await fail(saveToFolder(args))).not.toBeNull();
  });
});
