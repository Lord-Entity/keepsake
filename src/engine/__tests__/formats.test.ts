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
      { id: "137", kind: "video-only", ext: "mp4", height: 1080, fps: 60, vcodec: "avc1.640028" },
      { id: "136", kind: "video-only", ext: "mp4", height: 720, fps: 30, vcodec: "avc1.4d401f" },
      { id: "18", kind: "progressive", ext: "mp4", height: 360, fps: 30, vcodec: "avc1.42001E", acodec: "mp4a.40.2" },
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
    expect(ids(enabled(audio)).toSorted()).toEqual(["audio:flac", "audio:m4a", "audio:mp3", "audio:opus", "audio:wav"]);
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
    expect(ids(enabled(audio)).toSorted()).toEqual(["audio:m4a", "audio:wav"]);
  });

  test("M4A is the default audio format and needs no conversion; WAV does", () => {
    const audio = enabled(byMode(listFormats(info()), "audio"));
    expect(audio.filter((o) => o.isDefault).map((o) => o.id)).toEqual(["audio:m4a"]);
    expect(audio.find((o) => o.id === "audio:m4a").needsConversion).toBe(false);
    expect(audio.find((o) => o.id === "audio:wav").needsConversion).toBe(true);
  });

  test("every height with a muxable stream is usable; video-only heights need a merge, progressive ones do not", () => {
    const video = byMode(listFormats(info()), "video");
    expect(ids(video)).toEqual(["video:1080", "video:720", "video:360"]);
    expect(video.every((o) => !o.disabledReason)).toBe(true);
    expect(video.find((o) => o.id === "video:1080").needsMerge).toBe(true);
    expect(video.find((o) => o.id === "video:360").needsMerge).toBe(false);
    expect(video.every((o) => o.ext === "mp4")).toBe(true);
    expect(video.filter((o) => o.isDefault).map((o) => o.id)).toEqual(["video:1080"]);
  });

  test("a 2160p VP9 + Opus webm pair is offered as video:2160 with ext webm", () => {
    const tall = info({
      heights: [2160, 1080, 720, 360],
      fpsByHeight: { 2160: 30, 1080: 60, 720: 30, 360: 30 },
      streams: [
        { id: "313", kind: "video-only", ext: "webm", height: 2160, fps: 30, vcodec: "vp9" },
        { id: "251", kind: "audio-only", ext: "webm", acodec: "opus" },
        { id: "137", kind: "video-only", ext: "mp4", height: 1080, fps: 60, vcodec: "avc1.640028" },
        { id: "140", kind: "audio-only", ext: "m4a", acodec: "mp4a.40.2" },
        { id: "18", kind: "progressive", ext: "mp4", height: 360, vcodec: "avc1.42001E", acodec: "mp4a.40.2" },
      ],
    });
    const video = byMode(listFormats(tall), "video");
    const top = video.find((o) => o.id === "video:2160");
    expect(top).toMatchObject({ ext: "webm", height: 2160, needsMerge: true, isDefault: false });
    expect(top.disabledReason).toBeUndefined();
    // Default stays the highest <= 1080.
    expect(video.filter((o) => o.isDefault).map((o) => o.id)).toEqual(["video:1080"]);
  });

  test("a 1440p AV1 stream is offered with ext webm", () => {
    const tall = info({
      streams: [
        { id: "400", kind: "video-only", ext: "webm", height: 1440, vcodec: "av01.0.09M.08" },
        { id: "251", kind: "audio-only", ext: "webm", acodec: "opus" },
      ],
    });
    const row = byMode(listFormats(tall), "video").find((o) => o.id === "video:1440");
    expect(row).toMatchObject({ ext: "webm", needsMerge: true });
  });

  test("AVC 1080 mp4 is still offered alongside webm heights", () => {
    expect(byMode(listFormats(info()), "video").find((o) => o.id === "video:1080")).toMatchObject({ ext: "mp4" });
  });

  test("video-only height without a matching audio stream is not offered", () => {
    const none = info({ streams: [{ id: "137", kind: "video-only", ext: "mp4", height: 1080, vcodec: "avc1" }] });
    const video = byMode(listFormats(none), "video");
    expect(enabled(video)).toEqual([]);
    expect(video.length).toBeGreaterThan(0);
  });

  test("video-only webm height with only AAC audio is not offered", () => {
    const mismatched = info({
      streams: [
        { id: "313", kind: "video-only", ext: "webm", height: 2160, vcodec: "vp9" },
        { id: "140", kind: "audio-only", ext: "m4a", acodec: "mp4a.40.2" },
      ],
    });
    expect(enabled(byMode(listFormats(mismatched), "video"))).toEqual([]);
  });

  test("progressive files with yt-dlp codec names (bytevc1, vp09) are still offered", () => {
    const real = info({
      heights: [1080, 720],
      fpsByHeight: { 1080: 30, 720: 30 },
      streams: [
        { id: "bytevc1_1080p", kind: "progressive", ext: "mp4", height: 1080, vcodec: "bytevc1", acodec: "aac" },
        { id: "vp09_720p", kind: "progressive", ext: "webm", height: 720, vcodec: "vp09.00.10.08", acodec: "opus" },
      ],
    });
    const video = byMode(listFormats(real), "video");
    expect(ids(video)).toEqual(["video:1080", "video:720"]);
    expect(video.map((o) => o.ext)).toEqual(["mp4", "webm"]);
    expect(video.every((o) => !o.disabledReason)).toBe(true);
  });

  test("before a fetch: Android placeholders use the playlist heights and are disabled", () => {
    const video = byMode(listFormats(null), "video");
    expect(video.map((o) => o.height)).toEqual([2160, 1440, 1080, 720, 480, 360]);
    expect(video.every((o) => o.disabledReason === "Fetch a video first")).toBe(true);
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

const full = (over = {}) => info({ source: "ytdlp", ytdlpFull: true, ...over });

describe("listFormats on Android, self-contained yt-dlp route (ytdlpFull)", () => {
  beforeEach(() => {
    current = "android";
  });

  test("lists Best + every height, M4A and WAV; no thumbnails, no MP3, nothing disabled", () => {
    const all = listFormats(full());
    expect(ids(all)).toEqual(["video:best", "video:1080", "video:720", "video:360", "audio:m4a", "audio:wav"]);
    expect(byMode(all, "thumbnail")).toEqual([]);
    expect(all.some((o) => o.id === "audio:mp3")).toBe(false);
    expect(enabled(all).length).toBe(all.length);
  });

  test("video rows equal the desktop rows", () => {
    const androidVideo = byMode(listFormats(full()), "video");
    current = "windows";
    const desktopVideo = byMode(listFormats(info({ source: "youtubei", ytdlpFull: undefined })), "video");
    current = "android";
    expect(androidVideo).toEqual(desktopVideo);
  });

  test("defaults: highest <= 1080, else Best; M4A audio default; one default per mode", () => {
    const all = listFormats(full());
    expect(byMode(all, "video").filter((o) => o.isDefault).map((o) => o.id)).toEqual(["video:1080"]);
    expect(byMode(all, "audio").filter((o) => o.isDefault).map((o) => o.id)).toEqual(["audio:m4a"]);
    const audio = byMode(all, "audio");
    expect(audio.find((o) => o.id === "audio:m4a").needsConversion).toBe(false);
    expect(audio.find((o) => o.id === "audio:wav").needsConversion).toBe(true);

    const tall = full({ heights: [2160, 1440], fpsByHeight: { 2160: 30, 1440: 30 } });
    expect(byMode(listFormats(tall), "video").filter((o) => o.isDefault).map((o) => o.id)).toEqual(["video:best"]);
  });

  test("needsMerge, ext and labels follow the desktop rules", () => {
    const video = byMode(listFormats(full()), "video");
    expect(video.find((o) => o.id === "video:1080").needsMerge).toBe(true);
    expect(video.find((o) => o.id === "video:360").needsMerge).toBe(false);
    expect(video.find((o) => o.id === "video:best").needsMerge).toBe(true);
    expect(video.every((o) => o.ext === "mp4")).toBe(true);
    expect(video.find((o) => o.id === "video:1080").label).toBe("1080p60 Full HD");
  });

  test("heights without a phone-muxable stream are still listed (yt-dlp merges them)", () => {
    const tall = full({
      heights: [2160, 1080],
      fpsByHeight: { 2160: 30, 1080: 30 },
      streams: [
        { id: "313", kind: "video-only", ext: "webm", height: 2160, vcodec: "vp9" },
        { id: "140", kind: "audio-only", ext: "m4a", acodec: "mp4a.40.2" },
      ],
    });
    const video = byMode(listFormats(tall), "video");
    expect(ids(enabled(video))).toEqual(expect.arrayContaining(["video:2160", "video:1080"]));
  });

  test("a link without video gives only M4A (default) and WAV", () => {
    const all = listFormats(full({ hasVideo: false, heights: [], streams: [] }));
    expect(ids(all)).toEqual(["audio:m4a", "audio:wav"]);
    expect(all.find((o) => o.id === "audio:m4a").isDefault).toBe(true);
  });

  test("without ytdlpFull the legacy route is used (disabled MP3 row)", () => {
    for (const flag of [false, undefined]) {
      const mp3 = listFormats(info({ source: "ytdlp", ytdlpFull: flag })).find((o) => o.id === "audio:mp3");
      expect(mp3).toBeDefined();
      expect(mp3.disabledReason).toBeTruthy();
    }
  });

  test("on desktop, ytdlpFull does not change the normal list", () => {
    current = "windows";
    const all = listFormats(full());
    expect(byMode(all, "audio").length).toBe(5);
    expect(byMode(all, "thumbnail").length).toBe(3);
  });
});

const { ytdlpInfoToVideoInfo, hiddenStreams, forgetHiddenStreams } = await import("../android-ytdlp");

const yfmt = (over) => ({
  format_id: "x",
  ext: "mp4",
  vcodec: "h264",
  acodec: "aac",
  height: 720,
  fps: 30,
  filesize: null,
  protocol: "https",
  format_note: null,
  ...over,
});
const rawInfo = (formats, over = {}) => ({
  id: "7300",
  title: "A clip",
  uploader: "someone",
  duration: 12,
  thumbnail: null,
  extractor: "TikTok",
  webpage_url: "https://www.tiktok.com/@someone/video/7300",
  formats,
  ...over,
});

describe("listFormats on Android, hidden HLS-only branch", () => {
  beforeEach(() => {
    current = "android";
  });

  test("HLS-only TikTok lists one default Best row; audio rows as for no streams", () => {
    const v = ytdlpInfoToVideoInfo(rawInfo([yfmt({ format_id: "hls-1080", protocol: "m3u8_native", height: 1080 })]), "u");
    const all = listFormats(v);
    const video = byMode(all, "video");
    expect(ids(video)).toEqual(["video:best"]);
    expect(video[0].isDefault).toBe(true);
    expect(video[0].disabledReason).toBeUndefined();
    expect(video[0]).toMatchObject({ ext: "mp4", needsMerge: true });
    const audio = byMode(all, "audio");
    expect(ids(audio)).toEqual(["audio:m4a", "audio:mp3", "audio:wav"]);
    expect(audio.find((o) => o.id === "audio:m4a").disabledReason).toBeTruthy();
    expect(audio.find((o) => o.id === "audio:mp3").disabledReason).toBeTruthy();
    expect(ids(enabled(audio))).toEqual(["audio:wav"]);
  });

  test("after forgetHiddenStreams (full route not ready) the HLS-only post shows the disabled No video row", () => {
    const v = ytdlpInfoToVideoInfo(rawInfo([yfmt({ format_id: "hls-1080", protocol: "m3u8_native", height: 1080 })]), "u");
    expect(hiddenStreams(v).length).toBe(1);
    forgetHiddenStreams(v);
    expect(hiddenStreams(v)).toEqual([]);
    const video = byMode(listFormats(v), "video");
    expect(ids(video)).toEqual(["video:none"]);
    expect(video[0].disabledReason).toMatch(/^No video/);
  });

  test("http formats plus an HLS format list the same rows as without the HLS one", () => {
    const http = [
      yfmt({ format_id: "h264_1080p", vcodec: "avc1", height: 1080 }),
      yfmt({ format_id: "h264_720p", vcodec: "avc1", height: 720 }),
    ];
    const withHls = ytdlpInfoToVideoInfo(rawInfo([...http, yfmt({ format_id: "hls-1", protocol: "m3u8_native", height: 1080 })]), "u");
    const without = ytdlpInfoToVideoInfo(rawInfo(http), "u");
    expect(ids(byMode(listFormats(withHls), "video"))).toEqual(["video:best", "video:1080", "video:720"]);
    expect(listFormats(withHls)).toEqual(listFormats(without));
  });

  test("YouTube with only m3u8 formats keeps the disabled No video row", () => {
    const v = ytdlpInfoToVideoInfo(
      rawInfo([yfmt({ format_id: "hls-yt", protocol: "m3u8_native", height: 1080 })], {
        extractor: "youtube",
        webpage_url: "https://www.youtube.com/watch?v=abc",
      }),
      "u",
    );
    const video = byMode(listFormats(v), "video");
    expect(ids(video)).toEqual(["video:none"]);
    expect(video[0].disabledReason).toMatch(/^No video/);
    expect(video.some((o) => o.id === "video:best")).toBe(false);
  });
});
