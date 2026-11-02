// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Unit tests for src/engine/formats.ts (listFormats, qualityLabel).
 * Pure: no network, no processes. The platform is mocked so every platform's picker can be checked in one run.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let current = "windows";
mock.module("../platform", () => ({
  platform: () => current,
  inTauri: () => current !== "web",
  isDesktop: () => current === "windows" || current === "linux",
}));

const { listFormats, qualityLabel } = await import("../formats");

function info(over = {}) {
  return {
    id: "abc",
    url: "https://www.youtube.com/watch?v=abc",
    site: "youtube",
    kind: "video",
    title: "Test",
    thumbnails: [],
    hasVideo: true,
    heights: [1080, 720, 360],
    fpsByHeight: { 1080: 60, 720: 30, 360: 30 },
    streams: [
      { id: "137", kind: "video-only", ext: "mp4", height: 1080, fps: 60 },
      { id: "136", kind: "video-only", ext: "mp4", height: 720, fps: 30 },
      { id: "18", kind: "progressive", ext: "mp4", height: 360, fps: 30 },
      { id: "140", kind: "audio-only", ext: "m4a", acodec: "mp4a.40.2" },
      { id: "251", kind: "audio-only", ext: "webm", acodec: "opus" },
    ],
    previewOnly: false,
    source: "youtubei",
    ...over,
  };
}

const byMode = (opts, mode) => opts.filter((o) => o.mode === mode);
const enabled = (opts) => opts.filter((o) => !o.disabledReason);
const ids = (opts) => opts.map((o) => o.id);

describe("qualityLabel", () => {
  test("names standard heights and adds fps above 30", () => {
    expect(qualityLabel(1080, 60)).toBe("1080p60 Full HD");
    expect(qualityLabel(720, 30)).toBe("720p HD");
    expect(qualityLabel(2160)).toBe("2160p 4K");
    expect(qualityLabel(1440, 24)).toBe("1440p QHD");
    expect(qualityLabel(4320)).toBe("4320p 8K");
    expect(qualityLabel(360)).toBe("360p");
  });
});

describe("listFormats on desktop", () => {
  beforeEach(() => {
    current = "windows";
  });

  test("offers all five audio formats, MP3 default, M4A needs no conversion", () => {
    const audio = byMode(listFormats(info()), "audio");
    expect(ids(enabled(audio)).sort()).toEqual(["audio:flac", "audio:m4a", "audio:mp3", "audio:opus", "audio:wav"]);
    expect(audio.filter((o) => o.isDefault).map((o) => o.id)).toEqual(["audio:mp3"]);
    const m4a = audio.find((o) => o.id === "audio:m4a");
    expect(m4a.needsConversion).toBe(false);
    expect(m4a.needsMerge).toBe(false);
    for (const f of ["mp3", "opus", "wav", "flac"]) {
      expect(audio.find((o) => o.id === `audio:${f}`).needsConversion).toBe(true);
    }
  });

  test("every height is usable; video-only heights need a merge, progressive ones do not", () => {
    const video = byMode(listFormats(info()), "video");
    expect(video[0].id).toBe("video:best");
    expect(enabled(video).length).toBe(video.length);
    expect(video.find((o) => o.id === "video:1080").needsMerge).toBe(true);
    expect(video.find((o) => o.id === "video:360").needsMerge).toBe(false);
    expect(video.find((o) => o.id === "video:1080").label).toBe("1080p60 Full HD");
  });

  test("default video is the highest height at or below 1080", () => {
    const withTall = info({ heights: [2160, 1080, 720, 360], fpsByHeight: { 2160: 30, 1080: 30, 720: 30, 360: 30 } });
    const video = byMode(listFormats(withTall), "video");
    expect(video.filter((o) => o.isDefault).map((o) => o.id)).toEqual(["video:1080"]);
  });

  test("exactly one default per mode", () => {
    const all = listFormats(info());
    for (const mode of ["video", "audio", "thumbnail"]) {
      expect(byMode(all, mode).filter((o) => o.isDefault).length).toBe(1);
    }
  });

  test("Linux behaves like Windows for video", () => {
    current = "linux";
    const video = byMode(listFormats(info()), "video");
    expect(enabled(video).length).toBe(video.length);
  });
});

describe("listFormats on Android", () => {
  beforeEach(() => {
    current = "android";
  });

  test("only M4A and WAV are usable; MP3, FLAC and Opus are hidden or disabled", () => {
    const audio = byMode(listFormats(info()), "audio");
    expect(ids(enabled(audio)).sort()).toEqual(["audio:m4a", "audio:wav"]);
  });

  test("M4A is the default audio format and needs no conversion; WAV does", () => {
    const audio = enabled(byMode(listFormats(info()), "audio"));
    expect(audio.filter((o) => o.isDefault).map((o) => o.id)).toEqual(["audio:m4a"]);
    expect(audio.find((o) => o.id === "audio:m4a").needsConversion).toBe(false);
    expect(audio.find((o) => o.id === "audio:wav").needsConversion).toBe(true);
  });

  test("video: only progressive heights (360p) are usable, nothing needs a merge", () => {
    const video = byMode(listFormats(info()), "video");
    const usableHeights = enabled(video)
      .filter((o) => o.height)
      .map((o) => o.height);
    expect(usableHeights).toEqual([360]);
    expect(video.every((o) => o.needsMerge === false)).toBe(true);
    expect(video.filter((o) => o.isDefault).map((o) => o.id)).toEqual(["video:360"]);
  });

  test("no usable video height above 360p even if the link offers them", () => {
    const video = enabled(byMode(listFormats(info()), "video"));
    expect(video.every((o) => (o.height ?? 0) <= 360)).toBe(true);
  });

  test("a progressive stream above 360p is still not offered (no PO token, 360p cap)", () => {
    const tall = info({
      streams: [
        { id: "22", kind: "progressive", ext: "mp4", height: 720 },
        { id: "18", kind: "progressive", ext: "mp4", height: 360 },
      ],
    });
    expect(ids(enabled(byMode(listFormats(tall), "video")))).toEqual(["video:360"]);
  });

  test("no progressive stream: one disabled row, nothing usable", () => {
    const none = info({ streams: [{ id: "137", kind: "video-only", ext: "mp4", height: 1080 }] });
    const video = byMode(listFormats(none), "video");
    expect(enabled(video)).toEqual([]);
    expect(video.length).toBeGreaterThan(0);
  });

  test("before a fetch: video placeholders are disabled and never above 360p", () => {
    const video = byMode(listFormats(null), "video");
    expect(video.every((o) => o.disabledReason && (o.height ?? 0) <= 360)).toBe(true);
  });

  test("thumbnails stay available, Original is the default", () => {
    const thumbs = byMode(listFormats(info()), "thumbnail");
    expect(ids(thumbs)).toEqual(["thumb:original", "thumb:png", "thumb:jpg"]);
    expect(thumbs.find((o) => o.isDefault).id).toBe("thumb:original");
  });
});

describe("listFormats in the web preview", () => {
  test("no audio rows (nothing can extract or convert in the browser)", () => {
    current = "web";
    expect(byMode(listFormats(info()), "audio")).toEqual([]);
    expect(enabled(byMode(listFormats(info()), "video")).every((o) => (o.height ?? 0) <= 360)).toBe(true);
  });
});

describe("listFormats before a fetch", () => {
  test("null info gives disabled video placeholders and usable audio/thumbnail rows", () => {
    current = "windows";
    const all = listFormats(null);
    const video = byMode(all, "video");
    expect(video.length).toBeGreaterThan(0);
    expect(video.every((o) => o.disabledReason === "Fetch a video first")).toBe(true);
    expect(enabled(byMode(all, "audio")).length).toBeGreaterThan(0);
    expect(enabled(byMode(all, "thumbnail")).length).toBe(3);
  });

  test("audio-only link has no video rows", () => {
    current = "windows";
    const all = listFormats(info({ hasVideo: false, heights: [], streams: [] }));
    expect(byMode(all, "video")).toEqual([]);
  });
});
