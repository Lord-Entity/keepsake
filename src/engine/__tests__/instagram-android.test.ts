// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Instagram on Android (legacy yt-dlp route): realistic yt-dlp 2026.10.26 Instagram format lists (API video_versions,
 * VP9 / AVC DASH, codec-less and heightless variants) must list video rows that resolve to concrete picks, and the
 * VP9-only case must give the full-route row or a specific message. Every Instagram rule is host-gated: the TikTok and
 * YouTube fixtures at the end pin the exact lists and picks they produced before the Instagram change.
 * Pure: no network, no processes. platform() and the Tauri invoke bridge are mocked.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let current = "android";
mock.module("../platform", () => ({
  platform: () => current,
  inTauri: () => current !== "web",
  isDesktop: () => current === "windows" || current === "linux",
}));
// bun's mock.module is process-wide: export every name any app module imports from it.
mock.module("@tauri-apps/api/core", () => ({
  invoke: mock(async () => ({})),
  isTauri: () => true,
  Channel: class Channel {
    onmessage = () => {};
  },
  convertFileSrc: (p) => `asset://localhost/${p}`,
  addPluginListener: async () => ({ unregister: async () => {} }),
}));

const ytdlp = await import("../android-ytdlp");
const {
  ytdlpInfoToVideoInfo,
  pickYtdlpFormat,
  bestStreamsByHeight,
  hiddenStreams,
  ytdlpAlternatives,
  isInstagramHost,
  offerInstagramFullRoute,
  instagramBestFallback,
  instagramNeedsFullEngine,
} = ytdlp;
const { listFormats, INSTAGRAM_FULL_ENGINE_TEXT } = await import("../formats");

const IG_URL = "https://www.instagram.com/reel/DQabc123/";
const TT_URL = "https://www.tiktok.com/@someone/video/7300";
const YT_URL = "https://www.youtube.com/watch?v=abc";

/** One reduced format as keepsake_ytdlp._reduce_format sends it. */
function f(over) {
  return {
    format_id: "x",
    ext: "mp4",
    vcodec: null,
    acodec: null,
    height: null,
    width: null,
    fps: null,
    tbr: null,
    abr: null,
    filesize: null,
    protocol: "https",
    format_note: null,
    ...over,
  };
}

// _parse_mpd_formats output for Instagram's SegmentBase manifests: single files, protocol https.
const vp9 = (id, w, h, tbr) =>
  f({ format_id: `dash-${id}v`, vcodec: "vp09.00.31.08", acodec: "none", width: w, height: h, tbr, fps: 30, format_note: "DASH video" });
const avc = (id, w, h, tbr) =>
  f({ format_id: `dash-${id}v`, vcodec: "avc1.4d401f", acodec: "none", width: w, height: h, tbr, fps: 30, format_note: "DASH video" });
const aac = (id, abr) =>
  f({ format_id: `dash-${id}a`, ext: "m4a", vcodec: "none", acodec: "mp4a.40.5", abr, tbr: abr, format_note: "DASH audio" });
// _extract_product_media video_versions: url, format_id "101"/"102"/"103", width, height; vcodec from video_codec
// (often missing), acodec "none" only when has_audio is false.
const version = (id, w, h, over = {}) => f({ format_id: id, width: w, height: h, ...over });

function raw(formats, webpage_url = IG_URL, extractor = "Instagram") {
  return { id: "DQabc123", title: "Reel by someone", uploader: "someone", duration: 14.2, thumbnail: null, extractor, webpage_url, formats };
}

const videoRows = (opts) => opts.filter((o) => o.mode === "video");
const ids = (opts) => opts.map((o) => o.id);

beforeEach(() => {
  current = "android";
});

describe("Instagram host gate", () => {
  test("isInstagramHost: Instagram hosts and subdomains only", () => {
    for (const u of [IG_URL, "https://instagram.com/p/x", "https://instagr.am/p/x", "https://m.instagram.com/reel/x"]) {
      expect(isInstagramHost(u)).toBe(true);
    }
    for (const u of [TT_URL, YT_URL, "http://www.instagram.com/reel/x", "https://notinstagram.com/x", "https://instagram.com.evil.com/x", "u"]) {
      expect(isInstagramHost(u)).toBe(false);
    }
  });
});

const vp9OnlyFormats = () => [vp9("1", 720, 1280, 1500), vp9("2", 1080, 1920, 3000), vp9("3", 360, 640, 400), aac("9", 70)];

describe("Instagram: VP9-in-MP4 DASH only (Instagram's 2026 encodes) + AAC audio", () => {
  test("nothing the phone can mux: no height rows, specific message, audio M4A still works", () => {
    const v = ytdlpInfoToVideoInfo(raw(vp9OnlyFormats()), IG_URL);
    expect(v.hasVideo).toBe(true);
    expect(bestStreamsByHeight(v).size).toBe(0);
    expect(instagramBestFallback(v)).toBe(false);
    expect(instagramNeedsFullEngine(v)).toBe(true);
    const video = videoRows(listFormats(v));
    expect(ids(video)).toEqual(["video:none"]);
    expect(video[0].disabledReason).toBe(INSTAGRAM_FULL_ENGINE_TEXT);
    const m4a = listFormats(v).find((o) => o.id === "audio:m4a");
    expect(m4a.disabledReason).toBeUndefined();
    expect(pickYtdlpFormat(v, "audio:m4a")).toMatchObject({ formatId: "dash-9a", ext: "m4a", needsRemux: false });
  });

  test("full route ready (index.ts offerInstagramFullRoute): one default Best available row", () => {
    const v = ytdlpInfoToVideoInfo(raw(vp9OnlyFormats()), IG_URL);
    offerInstagramFullRoute(v);
    expect(hiddenStreams(v).map((s) => s.id).toSorted()).toEqual(["dash-1v", "dash-2v", "dash-3v"]);
    const video = videoRows(listFormats(v));
    expect(ids(video)).toEqual(["video:best"]);
    expect(video[0]).toMatchObject({ label: "Best available", isDefault: true, needsMerge: true, ext: "mp4" });
    expect(video[0].disabledReason).toBeUndefined();
    // No concrete legacy pick: the ladder goes straight to the full route.
    expect(pickYtdlpFormat(v, "video:best")).toBeNull();
    expect(ytdlpAlternatives(v, "video:best", null).clean).toEqual([]);
  });
});

describe("Instagram: AVC DASH next to VP9 DASH", () => {
  test("AVC heights are listed and picked with the AAC audio; VP9-only heights are not", () => {
    const v = ytdlpInfoToVideoInfo(raw([vp9("2", 1080, 1920, 3000), vp9("1", 720, 1280, 1500), avc("5", 720, 1280, 1800), aac("9", 70)]), IG_URL);
    expect(ids(videoRows(listFormats(v)))).toEqual(["video:best", "video:1280"]);
    const pick = pickYtdlpFormat(v, "video:best");
    expect(pick).toMatchObject({ formatId: "dash-5v", audioFormatId: "dash-9a", ext: "mp4", muxExt: "mp4", height: 1280 });
    expect(pickYtdlpFormat(v, "video:1280")).toEqual(pick);
  });
});

describe("Instagram: API video_versions", () => {
  test("progressive versions with heights (no codec, no ext) list every height and pick the file itself", () => {
    const v = ytdlpInfoToVideoInfo(
      raw([version("101", 720, 1280, { ext: "" }), version("102", 480, 854, { ext: "" }), vp9("2", 1080, 1920, 3000), aac("9", 70)]),
      IG_URL,
    );
    const video = videoRows(listFormats(v));
    expect(ids(video)).toEqual(["video:best", "video:1280", "video:854"]);
    expect(video.find((o) => o.id === "video:854").isDefault).toBe(true);
    expect(pickYtdlpFormat(v, "video:best")).toMatchObject({ formatId: "101", ext: "mp4", height: 1280 });
    expect(pickYtdlpFormat(v, "video:best").audioFormatId).toBeUndefined();
  });

  test("silent versions (acodec none, no vcodec) pair with the DASH AAC audio", () => {
    const v = ytdlpInfoToVideoInfo(raw([version("101", 720, 1280, { acodec: "none" }), aac("9", 70)]), IG_URL);
    expect(ids(videoRows(listFormats(v)))).toEqual(["video:best", "video:1280"]);
    expect(pickYtdlpFormat(v, "video:1280")).toMatchObject({ formatId: "101", audioFormatId: "dash-9a", ext: "mp4", muxExt: "mp4" });
  });

  test("a named AVC rep beats a guessed (codec-less) one at the same height", () => {
    const v = ytdlpInfoToVideoInfo(raw([version("101", 720, 1280, { acodec: "none", tbr: 9000 }), avc("5", 720, 1280, 1800), aac("9", 70)]), IG_URL);
    expect(pickYtdlpFormat(v, "video:best")).toMatchObject({ formatId: "dash-5v", audioFormatId: "dash-9a" });
  });

  test("heightless progressive: height from format_note when present", () => {
    const v = ytdlpInfoToVideoInfo(raw([version("101", null, null, { format_note: "720p" }), aac("9", 70)]), IG_URL);
    expect(ids(videoRows(listFormats(v)))).toEqual(["video:best", "video:720"]);
    expect(pickYtdlpFormat(v, "video:720")).toMatchObject({ formatId: "101", height: 720 });
  });

  test("heightless progressive without a hint: one Best available row that the ladder resolves to the file", () => {
    const v = ytdlpInfoToVideoInfo(raw([version("101", null, null), aac("9", 70)]), IG_URL);
    expect(instagramBestFallback(v)).toBe(true);
    const video = videoRows(listFormats(v));
    expect(ids(video)).toEqual(["video:best"]);
    expect(video[0]).toMatchObject({ isDefault: true });
    expect(video[0].disabledReason).toBeUndefined();
    expect(pickYtdlpFormat(v, "video:best")).toBeNull();
    expect(ytdlpAlternatives(v, "video:best", null).clean[0]).toMatchObject({ formatId: "101", ext: "mp4" });
  });
});

describe("Instagram: codec-less and segmented DASH", () => {
  test("codec-less DASH reps are classified by format_note / ext and paired", () => {
    const v = ytdlpInfoToVideoInfo(
      raw([
        f({ format_id: "dash-5v", height: 1280, width: 720, format_note: "DASH video" }),
        f({ format_id: "dash-9a", ext: "m4a", format_note: "DASH audio" }),
      ]),
      IG_URL,
    );
    expect(v.streams.map((s) => [s.id, s.kind])).toEqual([
      ["dash-5v", "video-only"],
      ["dash-9a", "audio-only"],
    ]);
    expect(pickYtdlpFormat(v, "video:best")).toMatchObject({ formatId: "dash-5v", audioFormatId: "dash-9a", muxExt: "mp4" });
    expect(pickYtdlpFormat(v, "audio:m4a")).toMatchObject({ formatId: "dash-9a", ext: "m4a" });
  });

  test("http_dash_segments reps stay listable for Instagram (native DashSegmentsFD, no ffmpeg)", () => {
    const v = ytdlpInfoToVideoInfo(
      raw([{ ...avc("5", 720, 1280, 1800), protocol: "http_dash_segments" }, { ...aac("9", 70), protocol: "http_dash_segments" }]),
      IG_URL,
    );
    expect(hiddenStreams(v)).toEqual([]);
    expect(pickYtdlpFormat(v, "video:best")).toMatchObject({ formatId: "dash-5v", audioFormatId: "dash-9a" });
  });
});

describe("Gate: the same format lists on TikTok behave exactly as before", () => {
  test("http_dash_segments is still dropped to the private copy for TikTok", () => {
    const v = ytdlpInfoToVideoInfo(
      raw([{ ...avc("5", 720, 1280, 1800), protocol: "http_dash_segments" }, { ...aac("9", 70), protocol: "http_dash_segments" }], TT_URL, "TikTok"),
      TT_URL,
    );
    expect(v.streams).toEqual([]);
    expect(hiddenStreams(v).map((s) => s.id)).toEqual(["dash-5v", "dash-9a"]);
  });

  test("VP9-in-MP4 and codec-less video-only stay unlisted for TikTok, with the generic message", () => {
    const v = ytdlpInfoToVideoInfo(raw([vp9("1", 720, 1280, 1500), version("101", 720, 1280, { acodec: "none" }), aac("9", 70)], TT_URL, "TikTok"), TT_URL);
    expect(bestStreamsByHeight(v).size).toBe(0);
    expect(instagramBestFallback(v)).toBe(false);
    expect(instagramNeedsFullEngine(v)).toBe(false);
    offerInstagramFullRoute(v);
    expect(hiddenStreams(v)).toEqual([]);
    const video = videoRows(listFormats(v));
    expect(ids(video)).toEqual(["video:none"]);
    expect(video[0].disabledReason).toBe("No video we can save on Android for this link. Try Audio, or use the desktop app.");
  });
});

/** Same shape as the frozen fixtures in android-ytdlp.test.ts. */
const legacy = (over) => f({ vcodec: "h264", acodec: "aac", height: 720, fps: 30, ...over });

const tiktok = () =>
  raw(
    [
      legacy({ format_id: "download", format_note: "Download video (watermarked)", height: 1080, filesize: 9000000 }),
      legacy({ format_id: "bytevc1_1080p_1-0", vcodec: "h265", height: 1080, filesize: 5000000 }),
      legacy({ format_id: "h264_1080p_1-0", vcodec: "avc1.64001f", height: 1080, filesize: 6000000 }),
      legacy({ format_id: "h264_720p_1-0", vcodec: "avc1.64001f", height: 720, filesize: 3000000 }),
      legacy({ format_id: "hls-1", protocol: "m3u8_native", height: 1080 }),
    ],
    TT_URL,
    "TikTok",
  );

describe("Frozen: TikTok list and picks", () => {
  test("rows", () => {
    const opts = listFormats(ytdlpInfoToVideoInfo(tiktok(), TT_URL));
    expect(opts.map((o) => [o.id, o.label, o.ext, o.isDefault, o.needsMerge, o.needsConversion, o.disabledReason ?? null])).toEqual([
      ["video:best", "Best available", "mp4", false, false, false, null],
      ["video:1080", "1080p Full HD", "mp4", true, false, false, null],
      ["video:720", "720p HD", "mp4", false, false, false, null],
      ["audio:m4a", "M4A", "m4a", true, false, true, null],
      ["audio:mp3", "MP3", "mp3", false, false, true, "MP3 needs the desktop app."],
      ["audio:wav", "WAV", "wav", false, false, true, null],
    ]);
  });

  test("picks", () => {
    const v = ytdlpInfoToVideoInfo(tiktok(), TT_URL);
    expect(pickYtdlpFormat(v, "video:best")).toEqual({ formatId: "h264_1080p_1-0", ext: "mp4", needsRemux: false, height: 1080, sizeBytes: 6000000 });
    expect(pickYtdlpFormat(v, "video:720")).toEqual({ formatId: "h264_720p_1-0", ext: "mp4", needsRemux: false, height: 720, sizeBytes: 3000000 });
    expect(pickYtdlpFormat(v, "audio:m4a")).toEqual({ formatId: "h264_720p_1-0", ext: "mp4", needsRemux: true, height: 720, sizeBytes: 3000000 });
    expect(hiddenStreams(v).map((s) => s.id)).toEqual(["hls-1"]);
  });
});

const youtube = () =>
  raw(
    [
      legacy({ format_id: "137", vcodec: "avc1.640028", acodec: "none", height: 1080 }),
      legacy({ format_id: "248", ext: "webm", vcodec: "vp9", acodec: "none", height: 1080 }),
      legacy({ format_id: "18", vcodec: "avc1.42001E", acodec: "mp4a.40.2", height: 360 }),
      legacy({ format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", height: null, fps: null }),
      legacy({ format_id: "251", ext: "webm", vcodec: "none", acodec: "opus", height: null, fps: null }),
    ],
    YT_URL,
    "youtube",
  );

describe("Frozen: YouTube (legacy yt-dlp) list and picks", () => {
  test("rows", () => {
    const opts = listFormats(ytdlpInfoToVideoInfo(youtube(), YT_URL));
    expect(opts.map((o) => [o.id, o.ext, o.isDefault, o.needsMerge, o.needsConversion, o.disabledReason ?? null])).toEqual([
      ["video:best", "mp4", false, true, false, null],
      ["video:1080", "mp4", true, true, false, null],
      ["video:360", "mp4", false, false, false, null],
      ["audio:m4a", "m4a", true, false, false, null],
      ["audio:mp3", "mp3", false, false, true, "MP3 needs the desktop app."],
      ["audio:wav", "wav", false, false, true, null],
    ]);
  });

  test("picks", () => {
    const v = ytdlpInfoToVideoInfo(youtube(), YT_URL);
    expect(pickYtdlpFormat(v, "video:best")).toEqual({
      formatId: "137",
      ext: "mp4",
      needsRemux: false,
      height: 1080,
      fallback: { formatId: "18", ext: "mp4" },
      audioFormatId: "140",
      muxExt: "mp4",
    });
    expect(pickYtdlpFormat(v, "audio:m4a")).toEqual({ formatId: "140", ext: "m4a", needsRemux: false });
    expect(hiddenStreams(v)).toEqual([]);
    expect(ytdlpAlternatives(v, "video:best", null)).toEqual({ clean: [], watermarked: [] });
  });
});
