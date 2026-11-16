// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Unit tests for src/engine/android-ytdlp.ts (host allow-list, error mapping, info mapping, format picking,
 * invoke wrappers). Pure: no network, no processes. platform() and the Tauri invoke bridge are mocked.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let current = "android";
mock.module("../platform", () => ({
  platform: () => current,
  inTauri: () => current !== "web",
  isDesktop: () => current === "windows" || current === "linux",
}));

let invokeImpl = async () => ({});
const invokeMock = mock((cmd, args) => invokeImpl(cmd, args));
mock.module("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: () => true,
}));

const {
  ANDROID_YTDLP_HOSTS,
  YTDLP_ERROR_CODES,
  isAndroidYtdlpHost,
  isAndroidYtdlpSupported,
  mapYtdlpError,
  ytdlpInfoToVideoInfo,
  pickYtdlpFormat,
  fetchAndroidInfo,
  downloadAndroid,
} = await import("../android-ytdlp");
const { listFormats } = await import("../formats");

function fmt(over) {
  return {
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
  };
}

function tiktokInfo() {
  return {
    id: "7300",
    title: "A clip",
    uploader: "someone",
    duration: 12.5,
    thumbnail: "https://p16.example/thumb.jpg",
    extractor: "TikTok",
    webpage_url: "https://www.tiktok.com/@someone/video/7300",
    formats: [
      fmt({ format_id: "download", format_note: "Download video (watermarked)", height: 1080, filesize: 9000000 }),
      fmt({ format_id: "bytevc1_1080p_1-0", vcodec: "h265", height: 1080, filesize: 5000000 }),
      fmt({ format_id: "h264_1080p_1-0", vcodec: "avc1.64001f", height: 1080, filesize: 6000000 }),
      fmt({ format_id: "h264_720p_1-0", vcodec: "avc1.64001f", height: 720, filesize: 3000000 }),
      fmt({ format_id: "hls-1", protocol: "m3u8_native", height: 1080 }),
    ],
  };
}

function instagramInfo() {
  return {
    id: "Cabc",
    title: "Reel",
    uploader: null,
    duration: null,
    thumbnail: null,
    extractor: "Instagram",
    webpage_url: "https://www.instagram.com/reel/Cabc/",
    formats: [
      fmt({ format_id: "dash-v", vcodec: "avc1", acodec: "none", height: 1080 }),
      fmt({ format_id: "dash-a-small", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", height: null, fps: null, filesize: 100 }),
      fmt({ format_id: "dash-a", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", height: null, fps: null, filesize: 900 }),
      fmt({ format_id: "prog", vcodec: "avc1", acodec: "mp4a.40.2", height: 720 }),
    ],
  };
}

beforeEach(() => {
  current = "android";
  invokeImpl = async () => ({});
  invokeMock.mockClear();
});

describe("host allow-list", () => {
  test("exports the five hosts", () => {
    expect([...ANDROID_YTDLP_HOSTS]).toEqual(["tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "instagram.com", "instagr.am"]);
  });

  test("accepts TikTok and Instagram https links", () => {
    for (const u of [
      "https://tiktok.com/@a/video/1",
      "https://www.tiktok.com/@a/video/1",
      "https://vm.tiktok.com/ZM123/",
      "https://vt.tiktok.com/ZS123/",
      "https://instagram.com/p/x",
      "https://www.instagram.com/reel/abc/",
      "https://instagr.am/p/x",
      "https://WWW.TikTok.com./@a/video/1",
    ]) {
      expect(isAndroidYtdlpHost(u)).toBe(true);
    }
  });

  test("rejects other sites, http and lookalike hosts", () => {
    for (const u of [
      "https://youtube.com/watch?v=x",
      "http://www.tiktok.com/@a/video/1",
      "http://instagram.com/p/x",
      "https://tiktok.com.evil.com/x",
      "https://eviltiktok.com/x",
      "https://nottiktok.com/x",
      "https://instagram.com@evil.com/x",
      "not a url",
      "",
    ]) {
      expect(isAndroidYtdlpHost(u)).toBe(false);
    }
  });

  test("isAndroidYtdlpSupported needs the android platform", () => {
    const u = "https://www.tiktok.com/@a/video/1";
    current = "android";
    expect(isAndroidYtdlpSupported(u)).toBe(true);
    expect(isAndroidYtdlpSupported("https://youtube.com/watch?v=x")).toBe(false);
    for (const p of ["windows", "linux", "web"]) {
      current = p;
      expect(isAndroidYtdlpSupported(u)).toBe(false);
    }
  });
});

describe("mapYtdlpError", () => {
  test("maps every code to the same AppErrorCode with Android text and no cookie hint", () => {
    expect(YTDLP_ERROR_CODES.length).toBe(16);
    for (const code of YTDLP_ERROR_CODES) {
      const e = mapYtdlpError(`ytdlp:${code}: something happened`);
      expect(e.code).toBe(code);
      expect(e.cookiesHint).toBe(false);
      expect(e.detail).toBe("something happened");
      expect(e.message).not.toContain("Details");
      expect(e.message).not.toContain("Settings > Cookies");
    }
  });

  test("finds the marker inside wrapped text", () => {
    const e = mapYtdlpError("Error: ytdlp:forbidden: HTTP Error 403");
    expect(e.code).toBe("forbidden");
    expect(e.detail).toBe("HTTP Error 403");
    expect(e.cookiesHint).toBe(false);
  });

  test("login_required says the Android app cannot log in", () => {
    const e = mapYtdlpError("ytdlp:login_required: login required");
    expect(e.message).toMatch(/needs you to be signed in/);
    expect(e.message).toMatch(/can't do on Android yet/);
  });

  test("an empty detail adds no Details suffix; long details are cut to 300", () => {
    expect(mapYtdlpError("ytdlp:network: ").message).not.toContain("Details");
    expect(mapYtdlpError(`ytdlp:unknown: ${"a".repeat(500)}`).detail.length).toBe(300);
  });

  test("an unknown code falls through to unknown", () => {
    expect(mapYtdlpError("ytdlp:bogus: nope").code).toBe("unknown");
  });

  test("missing plugin text -> ytdlp_missing", () => {
    for (const t of ["Plugin keepsake-media not found", "command ytdlp_info not found", "ytdlp_info not allowed. Permissions are denied"]) {
      const e = mapYtdlpError(t);
      expect(e.code).toBe("ytdlp_missing");
      expect(e.cookiesHint).toBe(false);
    }
  });

  test("random text -> unknown", () => {
    const e = mapYtdlpError("something odd");
    expect(e.code).toBe("unknown");
    expect(e.cookiesHint).toBe(false);
  });
});

describe("ytdlpInfoToVideoInfo", () => {
  test("drops non-http formats and maps fields", () => {
    const v = ytdlpInfoToVideoInfo(tiktokInfo(), "https://vm.tiktok.com/ZM1/");
    expect(v.source).toBe("ytdlp");
    expect(v.site).toBe("tiktok");
    expect(v.url).toBe("https://www.tiktok.com/@someone/video/7300");
    expect(v.channel).toBe("someone");
    expect(v.durationSec).toBe(12.5);
    expect(v.thumbnails).toEqual([{ url: "https://p16.example/thumb.jpg" }]);
    expect(v.streams.map((s) => s.id)).toEqual(["download", "bytevc1_1080p_1-0", "h264_1080p_1-0", "h264_720p_1-0"]);
    expect(v.heights).toEqual([1080, 720]);
    expect(v.hasVideo).toBe(true);
    expect(v.kind).toBe("video");
    expect(v.previewOnly).toBe(false);
  });

  test("classifies stream kinds and falls back to the requested url", () => {
    const v = ytdlpInfoToVideoInfo(instagramInfo(), "x");
    expect(v.streams.find((s) => s.id === "dash-v").kind).toBe("video-only");
    expect(v.streams.find((s) => s.id === "dash-a").kind).toBe("audio-only");
    expect(v.streams.find((s) => s.id === "prog").kind).toBe("progressive");
    expect(v.channel).toBeUndefined();
  });
});

describe("pickYtdlpFormat", () => {
  test("video picks the non-watermarked H.264 stream at the requested height", () => {
    const v = ytdlpInfoToVideoInfo(tiktokInfo(), "u");
    expect(pickYtdlpFormat(v, "video:1080").formatId).toBe("h264_1080p_1-0");
    expect(pickYtdlpFormat(v, "video:best").formatId).toBe("h264_1080p_1-0");
    expect(pickYtdlpFormat(v, "video:900").formatId).toBe("h264_720p_1-0");
    expect(pickYtdlpFormat(v, "video:360")).toBeNull();
    expect(pickYtdlpFormat(v, "video:abc")).toBeNull();
  });

  test("real yt-dlp codec names (bytevc1, hvc1, vp09) still pick and still list", () => {
    const v = ytdlpInfoToVideoInfo(
      {
        ...tiktokInfo(),
        formats: [
          fmt({ format_id: "bytevc1_1080p", vcodec: "bytevc1", acodec: "aac", height: 1080, filesize: 5000000 }),
          fmt({ format_id: "hvc1_720p", vcodec: "hvc1", acodec: "aac", height: 720, filesize: 3000000 }),
          fmt({ format_id: "vp09_480p", ext: "webm", vcodec: "vp09.00.10.08", acodec: "opus", height: 480, filesize: 1000000 }),
        ],
      },
      "u",
    );
    expect(pickYtdlpFormat(v, "video:best").formatId).toBe("bytevc1_1080p");
    expect(pickYtdlpFormat(v, "video:720").formatId).toBe("hvc1_720p");
    const video = listFormats(v).filter((o) => o.mode === "video" && !o.disabledReason && o.id !== "video:best");
    expect(video.map((o) => o.height)).toEqual([1080, 720, 480]);
    expect(video.find((o) => o.height === 480).ext).toBe("webm");
  });

  test("audio:m4a prefers the largest audio-only m4a, no remux", () => {
    const v = ytdlpInfoToVideoInfo(instagramInfo(), "u");
    expect(pickYtdlpFormat(v, "audio:m4a")).toMatchObject({ formatId: "dash-a", ext: "m4a", needsRemux: false });
  });

  test("audio:m4a falls back to a progressive mp4 that needs remux", () => {
    const v = ytdlpInfoToVideoInfo(tiktokInfo(), "u");
    const p = pickYtdlpFormat(v, "audio:m4a");
    expect(p.needsRemux).toBe(true);
    expect(p.ext).toBe("mp4");
    expect(p.formatId).toBe("h264_720p_1-0");
  });

  test("other ids and non-ytdlp infos give null", () => {
    const v = ytdlpInfoToVideoInfo(tiktokInfo(), "u");
    expect(pickYtdlpFormat(v, "audio:mp3")).toBeNull();
    expect(pickYtdlpFormat(v, "thumb:png")).toBeNull();
    expect(pickYtdlpFormat({ ...v, source: "youtubei" }, "video:best")).toBeNull();
  });
});

describe("fetchAndroidInfo", () => {
  test("invokes ytdlp_info with { url } and maps the result", async () => {
    invokeImpl = async () => ({ ok: true, info: tiktokInfo() });
    const url = "https://www.tiktok.com/@someone/video/7300";
    const v = await fetchAndroidInfo(url);
    expect(invokeMock).toHaveBeenCalledWith("plugin:keepsake-media|ytdlp_info", { url });
    expect(v.site).toBe("tiktok");
    expect(v.source).toBe("ytdlp");
  });

  test("rejects unsupported_url for YouTube without invoking", async () => {
    await expect(fetchAndroidInfo("https://www.youtube.com/watch?v=abc")).rejects.toMatchObject({ code: "unsupported_url" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("abort rejects with cancelled at once", async () => {
    invokeImpl = () => new Promise(() => {});
    const ctrl = new AbortController();
    const p = fetchAndroidInfo("https://www.tiktok.com/@a/video/1", ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
    ctrl.abort();
    await expect(fetchAndroidInfo("https://www.tiktok.com/@a/video/1", ctrl.signal)).rejects.toMatchObject({ code: "cancelled" });
  });

  test("native rejections are mapped, bad responses are parse_failed", async () => {
    invokeImpl = async () => {
      throw "ytdlp:rate_limited: HTTP Error 429";
    };
    await expect(fetchAndroidInfo("https://www.tiktok.com/@a/video/1")).rejects.toMatchObject({ code: "rate_limited", cookiesHint: false });
    invokeImpl = async () => ({ ok: true });
    await expect(fetchAndroidInfo("https://www.tiktok.com/@a/video/1")).rejects.toMatchObject({ code: "parse_failed" });
  });
});

describe("downloadAndroid", () => {
  test("passes exactly url, formatId, outDir, fileName", async () => {
    invokeImpl = async () => ({ path: "/data/x/a.mp4", bytes: 42 });
    const args = { url: "https://www.tiktok.com/@a/video/1", formatId: "h264_720p_1-0", outDir: "/data/x", fileName: "a" };
    expect(await downloadAndroid(args)).toEqual({ path: "/data/x/a.mp4", bytes: 42 });
    expect(invokeMock).toHaveBeenCalledWith("plugin:keepsake-media|ytdlp_download", { ...args, jobId: "job" });
  });

  test("omits fileName when undefined", async () => {
    invokeImpl = async () => ({ path: "/p", bytes: 1 });
    await downloadAndroid({ url: "u", formatId: "f", outDir: "/d" });
    const sent = invokeMock.mock.calls[0][1];
    expect(Object.keys(sent).toSorted()).toEqual(["formatId", "jobId", "outDir", "url"]);
  });

  test("bad response -> unknown; native rejection is mapped", async () => {
    invokeImpl = async () => ({ path: "", bytes: 1 });
    await expect(downloadAndroid({ url: "u", formatId: "f", outDir: "/d" })).rejects.toMatchObject({ code: "unknown" });
    invokeImpl = async () => {
      throw new Error("ytdlp:not_found: HTTP Error 404");
    };
    await expect(downloadAndroid({ url: "u", formatId: "f", outDir: "/d" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("listFormats for android + ytdlp info", () => {
  test("video rows have no 360 cap, audio is M4A or WAV, no thumbnail rows", () => {
    const v = ytdlpInfoToVideoInfo(tiktokInfo(), "u");
    const opts = listFormats(v);
    const video = opts.filter((o) => o.mode === "video" && !o.disabledReason);
    expect(video.map((o) => o.id)).toEqual(["video:best", "video:1080", "video:720"]);
    expect(video.map((o) => o.height)).toEqual([undefined, 1080, 720]);
    expect(opts.filter((o) => o.mode === "audio" && !o.disabledReason).map((o) => o.id)).toEqual(["audio:m4a", "audio:wav"]);
    expect(opts.filter((o) => o.mode === "thumbnail")).toEqual([]);
  });

  test("video:best is listed like desktop and resolves to the highest listed height", () => {
    const v = ytdlpInfoToVideoInfo(instagramInfo(), "u");
    const video = listFormats(v).filter((o) => o.mode === "video");
    const best = video.find((o) => o.id === "video:best");
    expect(best).toMatchObject({ label: "Best available", ext: "mp4", needsMerge: true, isDefault: false });
    expect(best.disabledReason).toBeUndefined();
    expect(video.filter((o) => o.isDefault).map((o) => o.id)).toEqual(["video:1080"]);
    expect(pickYtdlpFormat(v, "video:best")).toEqual(pickYtdlpFormat(v, "video:1080"));
  });

  test("video:best is the default when every height is above 1080", () => {
    const v = ytdlpInfoToVideoInfo({ ...tiktokInfo(), formats: [fmt({ format_id: "h264_2160", vcodec: "avc1", height: 2160 })] }, "u");
    const video = listFormats(v).filter((o) => o.mode === "video");
    expect(video.filter((o) => o.isDefault).map((o) => o.id)).toEqual(["video:best"]);
  });

  test("list and pick agree for every listed height", () => {
    const infos = [
      tiktokInfo(),
      instagramInfo(),
      {
        ...tiktokInfo(),
        formats: [
          fmt({ format_id: "download", format_note: "watermarked", height: 1080, tbr: 9000 }),
          fmt({ format_id: "bytevc1_1080p_low", vcodec: "bytevc1", height: 1080, tbr: 1200, filesize: 9000000 }),
          fmt({ format_id: "bytevc1_1080p_high", vcodec: "bytevc1", height: 1080, tbr: 2400, filesize: 4000000 }),
          fmt({ format_id: "dash-720", vcodec: "avc1", acodec: "none", height: 720, fps: 60 }),
          fmt({ format_id: "prog-720", vcodec: "avc1", acodec: "aac", height: 720, fps: 30 }),
          fmt({ format_id: "vp9-540", ext: "webm", vcodec: "vp9", acodec: "none", height: 540 }),
          fmt({ format_id: "a-m4a", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", height: null, fps: null, abr: 128 }),
          fmt({ format_id: "a-opus", ext: "webm", vcodec: "none", acodec: "opus", height: null, fps: null, abr: 96 }),
          fmt({ format_id: "hls-1080", protocol: "m3u8_native", height: 1440 }),
        ],
      },
    ];
    for (const raw of infos) {
      const v = ytdlpInfoToVideoInfo(raw, "u");
      const map = ytdlpModule.bestStreamsByHeight(v);
      const rows = listFormats(v).filter((o) => o.mode === "video" && o.height);
      expect(rows.map((o) => o.height)).toEqual([...map.keys()].toSorted((a, b) => b - a));
      for (const row of rows) {
        const hs = map.get(row.height);
        const p = pickYtdlpFormat(v, row.id);
        expect(p.formatId).toBe(hs.video.id);
        expect(p.height).toBe(row.height);
        expect(p.audioFormatId).toBe(hs.audio?.id);
        expect(row.needsMerge).toBe(!!hs.audio);
        expect(row.ext).toBe(hs.container);
      }
    }
  });

  test("tbr breaks ties between same-height TikTok variants; abr picks the audio", () => {
    const v = ytdlpInfoToVideoInfo(
      {
        ...tiktokInfo(),
        formats: [
          fmt({ format_id: "bytevc1_1080p_low", vcodec: "bytevc1", height: 1080, tbr: 1200, filesize: 9000000 }),
          fmt({ format_id: "bytevc1_1080p_high", vcodec: "bytevc1", height: 1080, tbr: 2400, filesize: 4000000 }),
          fmt({ format_id: "dash-v", vcodec: "avc1", acodec: "none", height: 720 }),
          fmt({ format_id: "a-big", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", height: null, fps: null, abr: 64, filesize: 900 }),
          fmt({ format_id: "a-hq", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", height: null, fps: null, abr: 128, filesize: 500 }),
        ],
      },
      "u",
    );
    expect(pickYtdlpFormat(v, "video:1080").formatId).toBe("bytevc1_1080p_high");
    expect(pickYtdlpFormat(v, "video:best").formatId).toBe("bytevc1_1080p_high");
    expect(pickYtdlpFormat(v, "video:720")).toMatchObject({ formatId: "dash-v", audioFormatId: "a-hq", ext: "mp4", muxExt: "mp4" });
    expect(pickYtdlpFormat(v, "audio:m4a").formatId).toBe("a-hq");
  });

  test("a muxed AV1 pick reports mp4 as the mux output ext", () => {
    const v = ytdlpInfoToVideoInfo(
      {
        ...tiktokInfo(),
        formats: [
          fmt({ format_id: "av1-1080", ext: "webm", vcodec: "av01.0.08M.08", acodec: "none", height: 1080 }),
          fmt({ format_id: "a-opus", ext: "webm", vcodec: "none", acodec: "opus", height: null, fps: null }),
        ],
      },
      "u",
    );
    expect(pickYtdlpFormat(v, "video:1080")).toMatchObject({ formatId: "av1-1080", audioFormatId: "a-opus", ext: "webm", muxExt: "mp4" });
  });
});

const {
  ANDROID_YTDLP_YOUTUBE_HOSTS,
  isAndroidYouTubeYtdlpHost,
  filterYouTubeMuxableFormats,
  filterYouTubeMp4Formats,
  muxContainerFor,
  fetchAndroidYouTubeInfo,
} = await import("../android-ytdlp");
const ytdlpModule = await import("../android-ytdlp");
const { YOUTUBE_VIA_YTDLP, youtubeRoute, tryYouTubeViaYtdlp } = await import("../youtube-ytdlp");

function youtubeInfo(over = {}) {
  return {
    id: "abc",
    title: "A video",
    uploader: "chan",
    duration: 60,
    thumbnail: null,
    extractor: "youtube",
    webpage_url: "https://www.youtube.com/watch?v=abc",
    formats: [
      fmt({ format_id: "18", vcodec: "avc1.42001E", acodec: "mp4a.40.2", height: 360 }),
      fmt({ format_id: "137", vcodec: "avc1.640028", acodec: "none", height: 1080, filesize: 50000000 }),
      fmt({ format_id: "136", vcodec: "avc1.4d401f", acodec: "none", height: 720, filesize: 20000000 }),
      fmt({ format_id: "248", ext: "webm", vcodec: "vp9", acodec: "none", height: 1080 }),
      fmt({ format_id: "313", ext: "webm", vcodec: "vp9", acodec: "none", height: 2160 }),
      fmt({ format_id: "399", vcodec: "av01.0.08M.08", acodec: "none", height: 1080 }),
      fmt({ format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", height: null, fps: null, filesize: 1000000 }),
      fmt({ format_id: "251", ext: "webm", vcodec: "none", acodec: "opus", height: null, fps: null, filesize: 2000000 }),
    ],
    ...over,
  };
}

describe("YouTube yt-dlp host list (separate from TikTok/Instagram)", () => {
  test("exports the five YouTube hosts; the TikTok/Instagram list is unchanged", () => {
    expect([...ANDROID_YTDLP_YOUTUBE_HOSTS]).toEqual(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
    expect(ANDROID_YTDLP_HOSTS.some((h) => h.includes("youtu"))).toBe(false);
    expect(isAndroidYtdlpHost("https://www.youtube.com/watch?v=x")).toBe(false);
  });

  test("accepts https YouTube hosts, rejects others", () => {
    for (const u of [
      "https://youtube.com/watch?v=x",
      "https://www.youtube.com/watch?v=x",
      "https://m.youtube.com/watch?v=x",
      "https://youtu.be/x",
      "https://WWW.YouTube.com./watch?v=x",
    ]) {
      expect(isAndroidYouTubeYtdlpHost(u)).toBe(true);
    }
    for (const u of [
      "http://www.youtube.com/watch?v=x",
      "https://youtube.com.evil.com/x",
      "https://evilyoutube.com/x",
      "https://youtube.com@evil.com/x",
      "https://www.tiktok.com/@a/video/1",
      "not a url",
      "",
    ]) {
      expect(isAndroidYouTubeYtdlpHost(u)).toBe(false);
    }
  });
});

describe("youtubeRoute", () => {
  test("flag is off by default: YouTube uses youtubei.js for PO tokens", () => {
    expect(YOUTUBE_VIA_YTDLP).toBe(false);
    expect(youtubeRoute("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("innertube");
    expect(youtubeRoute("https://www.youtube.com/watch?v=dQw4w9WgXcQ", true)).toBe("ytdlp");
  });

  test("ytdlp only for https YouTube hosts with the flag on", () => {
    for (const u of ["https://youtube.com/watch?v=dQw4w9WgXcQ", "https://m.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ"]) {
      expect(youtubeRoute(u, true)).toBe("ytdlp");
      expect(youtubeRoute(u, false)).toBe("innertube");
    }
    for (const u of ["http://youtube.com/watch?v=dQw4w9WgXcQ", "https://www.tiktok.com/@a/video/1", "https://evil.com/x", "junk"]) {
      expect(youtubeRoute(u, true)).toBe("innertube");
    }
  });
});

describe("muxContainerFor", () => {
  test("maps AVC/HEVC mp4 to mp4 and VP8/VP9/AV1 webm to webm", () => {
    expect(muxContainerFor({ id: "a", kind: "video-only", ext: "mp4", vcodec: "avc1.640028" })).toBe("mp4");
    expect(muxContainerFor({ id: "a", kind: "video-only", ext: "mp4", vcodec: "hev1.1.6" })).toBe("mp4");
    expect(muxContainerFor({ id: "a", kind: "video-only", ext: "webm", vcodec: "vp9" })).toBe("webm");
    expect(muxContainerFor({ id: "a", kind: "video-only", ext: "webm", vcodec: "vp08" })).toBe("webm");
    expect(muxContainerFor({ id: "a", kind: "video-only", ext: "webm", vcodec: "av01.0.08M.08" })).toBe("webm");
  });

  test("mismatched container or unknown codec gives null", () => {
    expect(muxContainerFor({ id: "a", kind: "video-only", ext: "webm", vcodec: "avc1" })).toBeNull();
    expect(muxContainerFor({ id: "a", kind: "video-only", ext: "mp4", vcodec: "vp9" })).toBeNull();
    expect(muxContainerFor({ id: "a", kind: "video-only", ext: "mp4", vcodec: "av01" })).toBeNull();
    expect(muxContainerFor({ id: "a", kind: "video-only", ext: "mkv", vcodec: "h264" })).toBeNull();
  });
});

describe("YouTube via yt-dlp info", () => {
  test("keeps every muxable format (mp4 and webm) and picks VP9 2160 + Opus", async () => {
    const f = filterYouTubeMuxableFormats(youtubeInfo()).formats.map((x) => x.format_id);
    // 399 is av01 in an mp4 container: the phone cannot mux that pair.
    expect(f).toEqual(["18", "137", "136", "248", "313", "140", "251"]);
    expect(filterYouTubeMp4Formats).toBe(filterYouTubeMuxableFormats);
    invokeImpl = async () => ({ ok: true, info: youtubeInfo() });
    const url = "https://www.youtube.com/watch?v=abc";
    const v = await fetchAndroidYouTubeInfo(url);
    expect(invokeMock).toHaveBeenCalledWith("plugin:keepsake-media|ytdlp_info", { url });
    expect(v.source).toBe("ytdlp");
    expect(v.heights).toEqual([2160, 1080, 720, 360]);
    expect(pickYtdlpFormat(v, "video:best")).toMatchObject({ formatId: "313", audioFormatId: "251", ext: "webm", height: 2160 });
  });

  test("AVC 1080 mp4 is still offered and pairs with AAC", () => {
    const v = ytdlpInfoToVideoInfo(youtubeInfo(), "https://www.youtube.com/watch?v=abc");
    expect(pickYtdlpFormat(v, "video:1080")).toMatchObject({ ext: "mp4", audioFormatId: "140", height: 1080 });
  });

  test("a 1440p AV1 stream is offered as webm and pairs with Opus", () => {
    const v = ytdlpInfoToVideoInfo(
      youtubeInfo({
        formats: [
          fmt({ format_id: "18", vcodec: "avc1.42001E", acodec: "mp4a.40.2", height: 360 }),
          fmt({ format_id: "400", ext: "webm", vcodec: "av01.0.09M.08", acodec: "none", height: 1440, filesize: 90000000 }),
          fmt({ format_id: "251", ext: "webm", vcodec: "none", acodec: "opus", height: null, fps: null, filesize: 9000000 }),
          fmt({ format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", height: null, fps: null, filesize: 1000000 }),
        ],
      }),
      "https://www.youtube.com/watch?v=abc",
    );
    expect(pickYtdlpFormat(v, "video:best")).toMatchObject({ formatId: "400", audioFormatId: "251", ext: "webm", height: 1440 });
  });

  test("the highest height wins even when it is VP9, with the 360p progressive as fallback", () => {
    const v = ytdlpInfoToVideoInfo(
      youtubeInfo({
        formats: [
          fmt({ format_id: "18", vcodec: "avc1.42001E", acodec: "mp4a.40.2", height: 360 }),
          fmt({ format_id: "271", ext: "webm", vcodec: "vp9", acodec: "none", height: 1440 }),
          fmt({ format_id: "251", ext: "webm", vcodec: "none", acodec: "opus", height: null, fps: null }),
        ],
      }),
      "https://www.youtube.com/watch?v=abc",
    );
    expect(pickYtdlpFormat(v, "video:best")).toMatchObject({
      formatId: "271",
      audioFormatId: "251",
      ext: "webm",
      height: 1440,
      fallback: { formatId: "18", ext: "mp4" },
    });
  });

  test("video-only VP9 without Opus is skipped in favour of the progressive stream", () => {
    const v = ytdlpInfoToVideoInfo(
      youtubeInfo({
        formats: [
          fmt({ format_id: "18", vcodec: "avc1.42001E", acodec: "mp4a.40.2", height: 360 }),
          fmt({ format_id: "271", ext: "webm", vcodec: "vp9", acodec: "none", height: 1440 }),
          fmt({ format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", height: null, fps: null }),
        ],
      }),
      "https://www.youtube.com/watch?v=abc",
    );
    expect(pickYtdlpFormat(v, "video:best")).toMatchObject({ formatId: "18", ext: "mp4", height: 360 });
  });

  test("the old high-resolution desktop note is gone", () => {
    expect(ytdlpModule.YOUTUBE_HIGH_RES_NOTE).toBeUndefined();
  });

  test("TikTok and Instagram picks are unchanged", () => {
    const t = ytdlpInfoToVideoInfo(tiktokInfo(), "u");
    expect(pickYtdlpFormat(t, "video:best").formatId).toBe("h264_1080p_1-0");
    const i = ytdlpInfoToVideoInfo(instagramInfo(), "u");
    expect(pickYtdlpFormat(i, "video:best")).toMatchObject({ formatId: "dash-v", audioFormatId: "dash-a", height: 1080 });
  });

  test("fetchAndroidYouTubeInfo rejects off Android and for TikTok without invoking", async () => {
    current = "windows";
    await expect(fetchAndroidYouTubeInfo("https://www.youtube.com/watch?v=abc")).rejects.toMatchObject({ code: "unsupported_url" });
    current = "android";
    await expect(fetchAndroidYouTubeInfo("https://www.tiktok.com/@a/video/1")).rejects.toMatchObject({ code: "unsupported_url" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("tryYouTubeViaYtdlp returns info whenever a pick exists, null on error or no muxable pair", async () => {
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    invokeImpl = async () => ({ ok: true, info: youtubeInfo() });
    expect((await tryYouTubeViaYtdlp(url))?.source).toBe("ytdlp");
    // A 360p progressive is enough now: no >360 gate.
    invokeImpl = async () => ({ ok: true, info: youtubeInfo({ formats: [youtubeInfo().formats[0]] }) });
    expect((await tryYouTubeViaYtdlp(url))?.source).toBe("ytdlp");
    // VP9 video-only with no Opus audio -> nothing to mux.
    invokeImpl = async () => ({ ok: true, info: youtubeInfo({ formats: [youtubeInfo().formats[4]] }) });
    expect(await tryYouTubeViaYtdlp(url)).toBeNull();
    invokeImpl = async () => {
      throw "ytdlp:unsupported_url: Only https TikTok and Instagram links are supported on Android";
    };
    expect(await tryYouTubeViaYtdlp(url)).toBeNull();
    invokeImpl = async () => ({ ok: true });
    expect(await tryYouTubeViaYtdlp(url)).toBeNull();
  });
});
