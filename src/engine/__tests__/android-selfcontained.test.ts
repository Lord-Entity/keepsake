// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Android self-contained yt-dlp route (plan-docs/11): youtubeRoute, androidYtdlpReady, fetchInfo routing, the
 * startDownload full route and its fallbacks, legacy invoke payloads, selectionArgs (android) and error mapping.
 * Pure: platform(), the Tauri bridge, fs/path/http/dialog and the youtubei.js module (../youtube) are mocked.
 * Never uses network / timeout / rate_limited in download tests (runWithRetry would sleep 2 s + 6 s).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

let current = "android";
mock.module("../platform", () => ({
  platform: () => current,
  inTauri: () => current !== "web",
  isDesktop: () => current === "windows" || current === "linux",
}));

let invokeImpl = async () => ({});
const invokeMock = mock((cmd, args) => invokeImpl(cmd, args));
// bun's mock.module is process-wide: export every name any app module imports from these modules.
mock.module("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: () => true,
  Channel: class Channel {
    onmessage = () => {};
  },
  convertFileSrc: (p) => `asset://localhost/${p}`,
  addPluginListener: async () => ({ unregister: async () => {} }),
}));
mock.module("@tauri-apps/api/path", () => ({
  join: async (...p) => p.join("/"),
  dirname: async (p) => p.slice(0, p.lastIndexOf("/")),
  downloadDir: async () => "/storage/emulated/0/Download",
  appCacheDir: async () => "/data/cache",
}));
mock.module("@tauri-apps/plugin-fs", () => ({
  exists: async () => false,
  mkdir: async () => {},
  open: async () => ({ read: async () => null, write: async (d) => d.length, close: async () => {} }),
  readFile: async () => new Uint8Array([1]),
  remove: async () => {},
  writeFile: async () => {},
}));
mock.module("@tauri-apps/plugin-http", () => ({
  fetch: async () => {
    throw new Error("no network in tests");
  },
}));
mock.module("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));

let youtubeiInfoImpl = async () => {
  throw new Error("youtubeiInfoImpl not set");
};
const fetchYouTubeInfoMock = mock(async (url) => youtubeiInfoImpl(url));
mock.module("../youtube", () => ({
  getClient: async () => {
    throw new Error("no client");
  },
  // Same expression as isYouTubeUrl in src/engine/youtube.ts.
  isYouTubeUrl: (u) => {
    try {
      return /(^|\.)((youtube|youtube-nocookie)\.com|youtu\.be)$/i.test(new URL(u).hostname);
    } catch {
      return false;
    }
  },
  parseYouTubeUrl: () => ({}),
  fetchYouTubeInfo: fetchYouTubeInfoMock,
  resolveSingleFile: async () => {
    throw new Error("resolveSingleFile not available in tests");
  },
  resolveAdaptive: async () => {
    throw new Error("resolveAdaptive not available in tests");
  },
}));

const {
  YTDLP_ERROR_CODES,
  YTDLP_FULL_ERROR_CODES,
  androidYtdlpStatus,
  downloadAndroid,
  fetchAndroidInfo,
  fetchAndroidYouTubeInfo,
  mapYtdlpError,
  ytdlpInfoToVideoInfo,
} = await import("../android-ytdlp");
const { ANDROID_SELFCONTAINED, androidYtdlpReady, youtubeRoute } = await import("../youtube-ytdlp");
const { fetchInfo, startDownload } = await import("../index");
const { selectionArgs } = await import("../ytdlp");
const { EngineError, appError } = await import("../errors");

const P = "plugin:keepsake-media|";
const DL = "/storage/emulated/0/Download";
const YT_URL = "https://youtu.be/dQw4w9WgXcQ";
const YT_CANON = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const TT_URL = "https://www.tiktok.com/@a/video/1";
const IG_URL = "https://www.instagram.com/reel/Cabc/";

const READY = { ytdlp: "2026.10.26", ejs: "0.8.0", jsRuntime: "quickjs-ng 0.18.0", ffmpeg: "ffmpeg version 7.1.1", ready: true, problems: [] };

const YT_INFO = {
  id: "dQw4w9WgXcQ",
  url: YT_CANON,
  site: "youtube",
  kind: "video",
  title: "Via youtubei",
  thumbnails: [],
  hasVideo: true,
  heights: [],
  fpsByHeight: {},
  streams: [],
  previewOnly: false,
  source: "youtubei",
};

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

function rawYoutube(over = {}) {
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
      fmt({ format_id: "hls-720", protocol: "m3u8_native", height: 720 }),
      fmt({ format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", height: null, fps: null, filesize: 1000000 }),
    ],
    ...over,
  };
}

function rawTikTok() {
  return {
    id: "7300",
    title: "A clip",
    uploader: "someone",
    duration: 12.5,
    thumbnail: null,
    extractor: "TikTok",
    webpage_url: "https://www.tiktok.com/@someone/video/7300",
    formats: [
      fmt({ format_id: "h264_1080p_1-0", vcodec: "avc1.64001f", height: 1080, filesize: 6000000 }),
      fmt({ format_id: "h264_720p_1-0", vcodec: "avc1.64001f", height: 720, filesize: 3000000 }),
    ],
  };
}

function rawInstagram() {
  return {
    id: "Cabc",
    title: "Reel",
    uploader: null,
    duration: null,
    thumbnail: null,
    extractor: "Instagram",
    webpage_url: IG_URL,
    formats: [fmt({ format_id: "prog", vcodec: "avc1", acodec: "mp4a.40.2", height: 720 })],
  };
}

/** Routes invoke by command name (the part after "plugin:keepsake-media|"); unknown commands reject. */
function setHandlers(map) {
  invokeImpl = async (cmd, args) => {
    const h = map[String(cmd).split("|")[1]];
    if (!h) throw new Error(`unexpected command ${cmd}`);
    return h(args);
  };
}

/** Sets the handlers, then refreshes the cached status (the cache is process-wide and shared with other files). */
async function setHandlersAndStatus(map) {
  setHandlers(map);
  await androidYtdlpStatus({ refresh: true });
}

const calls = (name) => invokeMock.mock.calls.filter((c) => c[0] === `${P}${name}`);

async function waitFor(cond) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("waitFor timed out");
}

function fullYtInfo() {
  return ytdlpInfoToVideoInfo(rawYoutube(), "https://www.youtube.com/watch?v=abc", { full: true });
}

function ytReq(formatId, over = {}) {
  return {
    id: "job-yt",
    url: "https://www.youtube.com/watch?v=abc",
    info: fullYtInfo(),
    mode: formatId.startsWith("audio") ? "audio" : "video",
    formatId,
    outputDir: DL,
    ...over,
  };
}

const thrownCode = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return undefined;
};

const origWarn = console.warn;

beforeEach(() => {
  current = "android";
  invokeImpl = async () => ({});
  invokeMock.mockClear();
  youtubeiInfoImpl = async () => YT_INFO;
  fetchYouTubeInfoMock.mockClear();
  console.warn = () => {};
});

afterAll(async () => {
  console.warn = origWarn;
  // Leave the shared status cache as "not ready" for any file that runs after this one.
  current = "android";
  invokeImpl = async () => {
    throw "command ytdlp_status not found";
  };
  await androidYtdlpStatus({ refresh: true });
});

describe("youtubeRoute", () => {
  test("false or omitted ready always means innertube", () => {
    for (const u of [YT_CANON, YT_URL, "https://www.youtube.com/shorts/dQw4w9WgXcQ"]) {
      expect(youtubeRoute(u)).toBe("innertube");
      expect(youtubeRoute(u, false)).toBe("innertube");
    }
  });

  test("ready: https watch / youtu.be / shorts links on every YouTube host go to ytdlp", () => {
    for (const u of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://youtube.com/shorts/dQw4w9WgXcQ",
    ]) {
      expect(youtubeRoute(u, true)).toBe("ytdlp");
    }
  });

  test("ready: http, other sites, playlist-only and junk stay on innertube", () => {
    for (const u of [
      "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "http://youtu.be/dQw4w9WgXcQ",
      TT_URL,
      IG_URL,
      "https://www.youtube.com/playlist?list=PL123",
      "https://evil.com/watch?v=dQw4w9WgXcQ",
      "junk",
      "",
    ]) {
      expect(youtubeRoute(u, true)).toBe("innertube");
    }
  });
});

describe("androidYtdlpReady", () => {
  test("the build flag is on", () => {
    expect(ANDROID_SELFCONTAINED).toBe(true);
  });

  test("ready status -> true, and ytdlp_status is invoked with {}", async () => {
    await setHandlersAndStatus({ ytdlp_status: async () => READY });
    expect(await androidYtdlpReady()).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(`${P}ytdlp_status`, {});
  });

  test("ready:false -> false", async () => {
    await setHandlersAndStatus({ ytdlp_status: async () => ({ ...READY, ready: false, problems: ["qjs_missing"] }) });
    expect(await androidYtdlpReady()).toBe(false);
  });

  test("ready:true but a missing part (ejs null / ffmpeg empty / runtime null) -> false", async () => {
    for (const over of [{ ejs: null }, { ffmpeg: "" }, { jsRuntime: null }]) {
      await setHandlersAndStatus({ ytdlp_status: async () => ({ ...READY, ...over }) });
      expect(await androidYtdlpReady()).toBe(false);
    }
  });

  test("old plugin without the command -> false", async () => {
    await setHandlersAndStatus({
      ytdlp_status: async () => {
        throw "command ytdlp_status not found";
      },
    });
    expect(await androidYtdlpReady()).toBe(false);
  });

  test("null or malformed response -> false", async () => {
    await setHandlersAndStatus({ ytdlp_status: async () => null });
    expect(await androidYtdlpReady()).toBe(false);
    await setHandlersAndStatus({ ytdlp_status: async () => ({ ready: true }) });
    expect(await androidYtdlpReady()).toBe(false);
  });

  test("off Android: ready is false and the status resolves null without invoking", async () => {
    await setHandlersAndStatus({ ytdlp_status: async () => READY });
    invokeMock.mockClear();
    current = "windows";
    expect(await androidYtdlpReady()).toBe(false);
    expect(await androidYtdlpStatus()).toBeNull();
    expect(await androidYtdlpStatus({ refresh: true })).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("fetchInfo on Android: YouTube", () => {
  test("flag is on (a flip must be noticed here)", () => {
    expect(ANDROID_SELFCONTAINED).toBe(true);
  });

  test("not ready: youtubei.js gets the original url, ytdlp_info is not invoked", async () => {
    await setHandlersAndStatus({ ytdlp_status: async () => ({ ...READY, ready: false }) });
    const v = await fetchInfo(YT_URL);
    expect(v).toBe(YT_INFO);
    expect(fetchYouTubeInfoMock).toHaveBeenCalledTimes(1);
    expect(fetchYouTubeInfoMock).toHaveBeenCalledWith(YT_URL);
    expect(calls("ytdlp_info")).toHaveLength(0);
  });

  test("ready: ytdlp_info gets { url: canonical, full: true }; full info keeps HLS; youtubei is not used", async () => {
    await setHandlersAndStatus({
      ytdlp_status: async () => READY,
      ytdlp_info: async () => ({ ok: true, info: rawYoutube({ id: "dQw4w9WgXcQ", webpage_url: YT_CANON }) }),
    });
    const v = await fetchInfo(YT_URL);
    expect(calls("ytdlp_info")).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith(`${P}ytdlp_info`, { url: YT_CANON, full: true });
    expect(Object.keys(calls("ytdlp_info")[0][1]).toSorted()).toEqual(["full", "url"]);
    expect(v.source).toBe("ytdlp");
    expect(v.ytdlpFull).toBe(true);
    expect(v.url).toBe(YT_CANON);
    expect(v.streams.map((s) => s.id)).toEqual(["18", "137", "hls-720", "140"]);
    expect(fetchYouTubeInfoMock).not.toHaveBeenCalled();
  });

  test("ready but ytdlp_info fails (bot_check / js_runtime_missing / ytdlp_missing): falls back to youtubei", async () => {
    for (const text of [
      "ytdlp:bot_check: Sign in to confirm you're not a bot",
      "ytdlp:js_runtime_missing: qjs not executable",
      "ytdlp:ytdlp_missing: python module gone",
    ]) {
      fetchYouTubeInfoMock.mockClear();
      await setHandlersAndStatus({
        ytdlp_status: async () => READY,
        ytdlp_info: async () => {
          throw text;
        },
      });
      const v = await fetchInfo(YT_URL);
      expect(v).toBe(YT_INFO);
      expect(fetchYouTubeInfoMock).toHaveBeenCalledTimes(1);
    }
  });

  test("ready, ytdlp_info rejects cancelled: fetchInfo rejects cancelled, youtubei is not used", async () => {
    await setHandlersAndStatus({
      ytdlp_status: async () => READY,
      ytdlp_info: async () => {
        throw "ytdlp:cancelled: stopped";
      },
    });
    await expect(fetchInfo(YT_URL)).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchYouTubeInfoMock).not.toHaveBeenCalled();
  });

  test("ready, abort while ytdlp_info is pending: rejects cancelled, youtubei is not used", async () => {
    await setHandlersAndStatus({
      ytdlp_status: async () => READY,
      ytdlp_info: () => new Promise(() => {}),
    });
    const ctrl = new AbortController();
    const p = fetchInfo(YT_URL, { signal: ctrl.signal });
    const settled = p.then(
      () => "resolved",
      (e) => e,
    );
    await waitFor(() => calls("ytdlp_info").length === 1);
    ctrl.abort();
    const err = await settled;
    expect(err).toBeInstanceOf(EngineError);
    expect(err.code).toBe("cancelled");
    expect(fetchYouTubeInfoMock).not.toHaveBeenCalled();
  });

  test("status rejects (old plugin): youtubei is used", async () => {
    await setHandlersAndStatus({
      ytdlp_status: async () => {
        throw "command ytdlp_status not found";
      },
    });
    const v = await fetchInfo(YT_URL);
    expect(v).toBe(YT_INFO);
    expect(fetchYouTubeInfoMock).toHaveBeenCalledTimes(1);
    expect(calls("ytdlp_info")).toHaveLength(0);
  });
});

describe("TikTok / Instagram never use the full route", () => {
  test("fetchInfo(TikTok) with a ready status sends exactly { url } and is not full", async () => {
    await setHandlersAndStatus({ ytdlp_status: async () => READY, ytdlp_info: async () => ({ ok: true, info: rawTikTok() }) });
    const v = await fetchInfo(TT_URL);
    expect(calls("ytdlp_info")).toHaveLength(1);
    expect(calls("ytdlp_info")[0][1]).toEqual({ url: TT_URL });
    expect(Object.keys(calls("ytdlp_info")[0][1])).toEqual(["url"]);
    expect(v.source).toBe("ytdlp");
    expect(v.ytdlpFull).toBeUndefined();
    expect(fetchYouTubeInfoMock).not.toHaveBeenCalled();
  });

  test("fetchInfo(Instagram reel) with a ready status sends exactly { url } and is not full", async () => {
    await setHandlersAndStatus({ ytdlp_status: async () => READY, ytdlp_info: async () => ({ ok: true, info: rawInstagram() }) });
    const v = await fetchInfo(IG_URL);
    expect(calls("ytdlp_info")[0][1]).toEqual({ url: IG_URL });
    expect(Object.keys(calls("ytdlp_info")[0][1])).toEqual(["url"]);
    expect(v.ytdlpFull).toBeUndefined();
  });

  test("startDownload: full info on a TikTok link is dropped, re-fetched legacy, downloaded with formatId only", async () => {
    setHandlers({
      ytdlp_info: async () => ({ ok: true, info: rawTikTok() }),
      ytdlp_download: async () => ({ path: `${DL}/A clip.mp4`, bytes: 10 }),
    });
    const forced = { ...ytdlpInfoToVideoInfo(rawTikTok(), TT_URL), ytdlpFull: true };
    const handle = startDownload(
      { id: "job-tt", url: TT_URL, info: forced, mode: "video", formatId: "video:1080", outputDir: DL },
      () => {},
    );
    const final = await handle.done;
    expect(final.status).toBe("done");
    expect(final.filePath).toBe(`${DL}/A clip.mp4`);
    expect(calls("ytdlp_info")).toHaveLength(1);
    expect(calls("ytdlp_info")[0][1]).toEqual({ url: TT_URL });
    expect(calls("ytdlp_download")).toHaveLength(1);
    const sent = calls("ytdlp_download")[0][1];
    expect(sent).toEqual({
      url: "https://www.tiktok.com/@someone/video/7300",
      formatId: "h264_1080p_1-0",
      outDir: DL,
      fileName: "A clip",
      jobId: "job-tt",
    });
    expect(Object.keys(sent).toSorted()).toEqual(["fileName", "formatId", "jobId", "outDir", "url"]);
    expect("args" in sent).toBe(false);
    expect("full" in sent).toBe(false);
    expect(fetchYouTubeInfoMock).not.toHaveBeenCalled();
  });
});

describe("startDownload: YouTube full route", () => {
  test("video:1080 -> one ytdlp_download with the desktop selectors, full: true", async () => {
    setHandlers({ ytdlp_download: async () => ({ path: `${DL}/A video.mp4`, bytes: 1234 }) });
    const final = await startDownload(ytReq("video:1080"), () => {}).done;
    expect(final.status).toBe("done");
    expect(final.filePath).toBe(`${DL}/A video.mp4`);
    expect(calls("ytdlp_download")).toHaveLength(1);
    expect(calls("ytdlp_download")[0][1]).toEqual({
      url: "https://www.youtube.com/watch?v=abc",
      args: ["-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best", "--merge-output-format", "mp4/mkv"],
      outDir: DL,
      fileName: "A video",
      jobId: "job-yt",
      full: true,
    });
    expect(Object.keys(calls("ytdlp_download")[0][1]).toSorted()).toEqual(["args", "fileName", "full", "jobId", "outDir", "url"]);
    expect(fetchYouTubeInfoMock).not.toHaveBeenCalled();
  });

  test("audio:m4a -> one ytdlp_download with the m4a selectors, full: true", async () => {
    setHandlers({ ytdlp_download: async () => ({ path: `${DL}/A video.m4a`, bytes: 99 }) });
    const final = await startDownload(ytReq("audio:m4a"), () => {}).done;
    expect(final.status).toBe("done");
    expect(final.filePath).toBe(`${DL}/A video.m4a`);
    expect(calls("ytdlp_download")).toHaveLength(1);
    expect(calls("ytdlp_download")[0][1]).toEqual({
      url: "https://www.youtube.com/watch?v=abc",
      args: ["-f", "bestaudio[ext=m4a]/bestaudio/best", "-x", "--audio-format", "m4a"],
      outDir: DL,
      fileName: "A video",
      jobId: "job-yt",
      full: true,
    });
    expect(fetchYouTubeInfoMock).not.toHaveBeenCalled();
  });

  test("non-final failures fall back once to youtubei.js (runDirect) and report its error", async () => {
    for (const code of ["bot_check", "js_runtime_missing", "ytdlp_missing", "unknown"]) {
      invokeMock.mockClear();
      fetchYouTubeInfoMock.mockClear();
      youtubeiInfoImpl = async () => {
        throw new EngineError(appError("no_formats", "youtubei fallback"));
      };
      setHandlers({
        ytdlp_download: async () => {
          throw `ytdlp:${code}: boom`;
        },
      });
      const final = await startDownload(ytReq("video:1080"), () => {}).done;
      expect(calls("ytdlp_download")).toHaveLength(1);
      expect(fetchYouTubeInfoMock).toHaveBeenCalledTimes(1);
      expect(fetchYouTubeInfoMock).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abc");
      expect(final.status).toBe("failed");
      expect(final.error.code).toBe("no_formats");
    }
  });

  test("final failures never fall back and keep their own code", async () => {
    for (const code of ["login_required", "not_found", "no_space", "permission", "too_large"]) {
      invokeMock.mockClear();
      fetchYouTubeInfoMock.mockClear();
      setHandlers({
        ytdlp_download: async () => {
          throw `ytdlp:${code}: boom`;
        },
      });
      const final = await startDownload(ytReq("video:1080"), () => {}).done;
      expect(calls("ytdlp_download")).toHaveLength(1);
      expect(fetchYouTubeInfoMock).not.toHaveBeenCalled();
      expect(final.status).toBe("failed");
      expect(final.error.code).toBe(code);
    }
  });

  test("cancel while ytdlp_download is pending: cancelled, ytdlp_cancel sent, no fallback", async () => {
    let rejectDownload;
    setHandlers({
      ytdlp_download: () =>
        new Promise((_, reject) => {
          rejectDownload = reject;
        }),
      ytdlp_cancel: async () => ({}),
    });
    const handle = startDownload(ytReq("video:1080"), () => {});
    await waitFor(() => calls("ytdlp_download").length === 1);
    handle.cancel();
    await waitFor(() => calls("ytdlp_cancel").length === 1);
    rejectDownload("ytdlp:unknown: interrupted");
    const final = await handle.done;
    expect(final.status).toBe("cancelled");
    expect(final.error.code).toBe("cancelled");
    expect(fetchYouTubeInfoMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith(`${P}ytdlp_cancel`, { jobId: "job-yt" });
  });

  test("audio:mp3 on the full route: format_unavailable falls back to runDirect, which rejects mp3 before any fetch", async () => {
    setHandlers({ ytdlp_download: async () => ({ path: "/never", bytes: 1 }) });
    const final = await startDownload(ytReq("audio:mp3"), () => {}).done;
    expect(final.status).toBe("failed");
    expect(final.error.code).toBe("format_unavailable");
    expect(final.error.message).toBe("MP3 isn't available on Android yet. Choose M4A.");
    expect(calls("ytdlp_download")).toHaveLength(0);
    expect(fetchYouTubeInfoMock).not.toHaveBeenCalled();
  });
});

describe("legacy payloads are unchanged", () => {
  test("downloadAndroid with formatId sends exactly url, formatId, outDir, fileName, jobId", async () => {
    setHandlers({ ytdlp_download: async () => ({ path: "/p", bytes: 1 }) });
    const a = { url: TT_URL, formatId: "f", outDir: "/d", fileName: "n", jobId: "j1" };
    expect(await downloadAndroid(a)).toEqual({ path: "/p", bytes: 1 });
    expect(invokeMock).toHaveBeenCalledWith(`${P}ytdlp_download`, a);
    expect(Object.keys(calls("ytdlp_download")[0][1]).toSorted()).toEqual(["fileName", "formatId", "jobId", "outDir", "url"]);
  });

  test("without fileName and jobId it sends { url, formatId, outDir, jobId: 'job' }", async () => {
    setHandlers({ ytdlp_download: async () => ({ path: "/p", bytes: 1 }) });
    await downloadAndroid({ url: TT_URL, formatId: "f", outDir: "/d" });
    expect(calls("ytdlp_download")[0][1]).toEqual({ url: TT_URL, formatId: "f", outDir: "/d", jobId: "job" });
    expect(Object.keys(calls("ytdlp_download")[0][1]).toSorted()).toEqual(["formatId", "jobId", "outDir", "url"]);
  });

  test("full: false sends no full key; formatId with args: [] still sends formatId", async () => {
    setHandlers({ ytdlp_download: async () => ({ path: "/p", bytes: 1 }) });
    await downloadAndroid({ url: TT_URL, formatId: "f", outDir: "/d", full: false });
    expect(Object.keys(calls("ytdlp_download")[0][1]).toSorted()).toEqual(["formatId", "jobId", "outDir", "url"]);
    invokeMock.mockClear();
    await downloadAndroid({ url: TT_URL, formatId: "f", args: [], outDir: "/d" });
    expect(Object.keys(calls("ytdlp_download")[0][1]).toSorted()).toEqual(["formatId", "jobId", "outDir", "url"]);
  });

  test("args + full: true sends { url, args, outDir, fileName, jobId, full: true } and no formatId", async () => {
    setHandlers({ ytdlp_download: async () => ({ path: "/p", bytes: 1 }) });
    await downloadAndroid({ url: YT_CANON, args: ["-f", "best"], full: true, outDir: "/d", fileName: "n", jobId: "j" });
    const sent = calls("ytdlp_download")[0][1];
    expect(sent).toEqual({ url: YT_CANON, args: ["-f", "best"], outDir: "/d", fileName: "n", jobId: "j", full: true });
    expect(Object.keys(sent).toSorted()).toEqual(["args", "fileName", "full", "jobId", "outDir", "url"]);
  });

  test("both formatId and args, neither, or empty args alone reject unknown without invoking", async () => {
    for (const a of [
      { url: YT_CANON, formatId: "f", args: ["-f", "x"], outDir: "/d" },
      { url: YT_CANON, outDir: "/d" },
      { url: YT_CANON, args: [], outDir: "/d" },
    ]) {
      await expect(downloadAndroid(a)).rejects.toMatchObject({ code: "unknown" });
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("fetchAndroidYouTubeInfo sends { url }, or { url, full: true } with full", async () => {
    setHandlers({ ytdlp_info: async () => ({ ok: true, info: rawYoutube() }) });
    await fetchAndroidYouTubeInfo(YT_CANON);
    expect(calls("ytdlp_info")[0][1]).toEqual({ url: YT_CANON });
    expect(Object.keys(calls("ytdlp_info")[0][1])).toEqual(["url"]);
    invokeMock.mockClear();
    await fetchAndroidYouTubeInfo(YT_CANON, undefined, { full: true });
    expect(calls("ytdlp_info")[0][1]).toEqual({ url: YT_CANON, full: true });
    expect(Object.keys(calls("ytdlp_info")[0][1]).toSorted()).toEqual(["full", "url"]);
  });

  test("fetchAndroidInfo(TikTok) sends { url }", async () => {
    setHandlers({ ytdlp_info: async () => ({ ok: true, info: rawTikTok() }) });
    await fetchAndroidInfo(TT_URL);
    expect(calls("ytdlp_info")[0][1]).toEqual({ url: TT_URL });
    expect(Object.keys(calls("ytdlp_info")[0][1])).toEqual(["url"]);
  });
});

describe("selectionArgs (android)", () => {
  const android = { platform: "android" };
  const MERGE = ["--merge-output-format", "mp4/mkv"];

  test("video:best", () => {
    expect(selectionArgs({ formatId: "video:best" }, android)).toEqual(["-f", "bestvideo+bestaudio/best/best", ...MERGE]);
  });

  test("video heights", () => {
    for (const h of [2160, 1440, 1080, 720, 480, 360]) {
      expect(selectionArgs({ formatId: `video:${h}` }, android)).toEqual([
        "-f",
        `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`,
        ...MERGE,
      ]);
    }
  });

  test("preferH264 adds -S before --merge-output-format", () => {
    expect(selectionArgs({ formatId: "video:1080", preferH264: true }, android)).toEqual([
      "-f",
      "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
      "-S",
      "res,fps,vcodec:h264,acodec:aac",
      ...MERGE,
    ]);
    expect(selectionArgs({ formatId: "video:best", preferH264: true }, android)).toEqual([
      "-f",
      "bestvideo+bestaudio/best/best",
      "-S",
      "res,fps,vcodec:h264,acodec:aac",
      ...MERGE,
    ]);
  });

  test("audio:m4a and audio:wav both select m4a", () => {
    const want = ["-f", "bestaudio[ext=m4a]/bestaudio/best", "-x", "--audio-format", "m4a"];
    expect(selectionArgs({ formatId: "audio:m4a" }, android)).toEqual(want);
    expect(selectionArgs({ formatId: "audio:wav" }, android)).toEqual(want);
  });

  test("audio:mp3 / opus / flac and thumb:png throw format_unavailable", () => {
    for (const id of ["audio:mp3", "audio:opus", "audio:flac", "thumb:png"]) {
      expect(thrownCode(() => selectionArgs({ formatId: id }, android))).toBe("format_unavailable");
    }
  });

  test("every token satisfies the allow-list", () => {
    const FLAG_VALUE = {
      "-f": /^[A-Za-z0-9_.+/[\]<>=!*?^$:~-]{1,200}$/,
      "-S": /^[a-z0-9:,+_.-]{1,100}$/,
      "--merge-output-format": /^mp4\/mkv$/,
      "--audio-format": /^m4a$/,
    };
    const standalone = new Set(["-x"]);
    const ids = ["video:best", "video:2160", "video:1440", "video:1080", "video:720", "video:480", "video:360", "audio:m4a", "audio:wav"];
    for (const id of ids) {
      for (const preferH264 of [false, true]) {
        const argv = selectionArgs({ formatId: id, preferH264 }, android);
        for (let i = 0; i < argv.length; i++) {
          const t = argv[i];
          if (standalone.has(t)) continue;
          expect(Object.hasOwn(FLAG_VALUE, t)).toBe(true);
          expect(argv[i + 1]).toMatch(FLAG_VALUE[t]);
          i++;
        }
      }
    }
  });
});

describe("error codes", () => {
  test("js_runtime_missing and ytdlp_missing map with a Reinstall message and no cookie hint", () => {
    const j = mapYtdlpError("ytdlp:js_runtime_missing: qjs not executable");
    expect(j.code).toBe("js_runtime_missing");
    expect(j.cookiesHint).toBe(false);
    expect(j.detail).toBe("qjs not executable");
    expect(j.message).toContain("Reinstall");
    const m = mapYtdlpError("ytdlp:ytdlp_missing: module gone");
    expect(m.code).toBe("ytdlp_missing");
    expect(m.cookiesHint).toBe(false);
    expect(m.detail).toBe("module gone");
    expect(m.message).toContain("Reinstall");
  });

  test("bot_check mentions the bot check, also inside wrapped text", () => {
    const e = mapYtdlpError("ytdlp:bot_check: Sign in to confirm");
    expect(e.code).toBe("bot_check");
    expect(e.message).toMatch(/not a bot/);
    expect(e.cookiesHint).toBe(false);
    const w = mapYtdlpError("Error: ytdlp:bot_check: x");
    expect(w.code).toBe("bot_check");
    expect(w.detail).toBe("x");
  });

  test("the full-route codes are separate from the legacy list", () => {
    expect([...YTDLP_FULL_ERROR_CODES]).toEqual(["js_runtime_missing", "ytdlp_missing", "bot_check"]);
    for (const c of YTDLP_FULL_ERROR_CODES) expect(YTDLP_ERROR_CODES).not.toContain(c);
    expect(YTDLP_ERROR_CODES.length).toBe(16);
  });

  test("downloadAndroid maps a js_runtime_missing rejection", async () => {
    setHandlers({
      ytdlp_download: async () => {
        throw "ytdlp:js_runtime_missing: x";
      },
    });
    await expect(downloadAndroid({ url: YT_CANON, args: ["-f", "best"], full: true, outDir: "/d" })).rejects.toMatchObject({
      code: "js_runtime_missing",
      cookiesHint: false,
    });
  });
});
