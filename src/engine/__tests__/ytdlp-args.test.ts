// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Unit tests for the yt-dlp argument builder in src/engine/ytdlp.ts (buildDownloadArgs, parseProgressLine).
 * Pure: buildDownloadArgs only builds an array; nothing is invoked or spawned. No network.
 */
import { describe, expect, test } from "bun:test";
import { buildDownloadArgs, parseProgressLine } from "../ytdlp";

const URL = "https://www.youtube.com/watch?v=abc";
const WIN_OUT = "C:\\Users\\me\\Downloads";
const LINUX_OUT = "/home/me/Downloads";

function streams({ m4a = true } = {}) {
  const s = [
    { id: "137", kind: "video-only", ext: "mp4", height: 1080 },
    { id: "18", kind: "progressive", ext: "mp4", height: 360 },
    { id: "251", kind: "audio-only", ext: "webm", acodec: "opus" },
  ];
  if (m4a) s.push({ id: "140", kind: "audio-only", ext: "m4a", acodec: "mp4a.40.2" });
  return s;
}

function info(opts) {
  return {
    id: "abc",
    url: URL,
    site: "youtube",
    kind: "video",
    title: "Test",
    thumbnails: [],
    hasVideo: true,
    heights: [1080, 360],
    fpsByHeight: { 1080: 30, 360: 30 },
    streams: streams(opts),
    previewOnly: false,
    source: "ytdlp",
  };
}

function req(formatId, over = {}) {
  const mode = formatId.startsWith("video") ? "video" : formatId.startsWith("audio") ? "audio" : "thumbnail";
  return { id: "11111111-2222-3333-4444-555555555555", url: URL, mode, formatId, ...over };
}

const build = (formatId, over = {}, out = LINUX_OUT) => buildDownloadArgs(req(formatId, over), out).args;

/** Value right after `flag` (first occurrence). */
const after = (a, flag) => a[a.indexOf(flag) + 1];

const ALL_FORMATS = [
  "video:best",
  "video:1080",
  "video:360",
  "audio:mp3",
  "audio:m4a",
  "audio:opus",
  "audio:wav",
  "audio:flac",
  "thumb:original",
  "thumb:png",
  "thumb:jpg",
];

// Flags Rust either prepends itself or rejects outright (src-tauri/src/ytdlp.rs). TS must never send them.
const FORBIDDEN = [
  "--ffmpeg-location",
  "--js-runtimes",
  "--no-js-runtimes",
  "--remux-video",
  "--recode-video",
  "--exec",
  "--exec-before-download",
  "--postprocessor-args",
  "--ppa",
  "--downloader",
  "--external-downloader",
  "--downloader-args",
  "--config-location",
  "--config-locations",
  "--batch-file",
  "-a",
  "--load-info-json",
  "--netrc-cmd",
  "--plugin-dirs",
  "--use-postprocessor",
];

describe("buildDownloadArgs: every mode", () => {
  for (const f of ALL_FORMATS) {
    test(`${f}: URL is last after --, and no forbidden, ffprobe, remux or recode args`, () => {
      const a = build(f, { info: info() });
      expect(a.slice(-2)).toEqual(["--", URL]);
      expect(a.filter((x) => x === "--").length).toBe(1);
      for (const bad of FORBIDDEN) expect(a).not.toContain(bad);
      expect(a.some((x) => /ffprobe/i.test(x))).toBe(false);
      expect(a.some((x) => /remux|recode/i.test(x))).toBe(false);
    });
  }

  test("fixed base args and progress template are always present", () => {
    const a = build("audio:mp3");
    expect(after(a, "--encoding")).toBe("utf-8");
    expect(a).toContain("--no-warnings");
    expect(a).toContain("--windows-filenames");
    expect(a).toContain("--newline");
    expect(a.some((x) => x.startsWith("download:KEEPSAKE|"))).toBe(true);
    expect(a.some((x) => x.startsWith("postprocess:KEEPSAKE_PP|"))).toBe(true);
    expect(a).toContain("after_move:KEEPSAKE_DONE|%(filepath)s");
  });

  test("trim length stays in 60..200", () => {
    const short = Number(after(build("audio:mp3", {}, "/d"), "--trim-filenames"));
    const long = Number(after(build("audio:mp3", {}, `/${"x".repeat(300)}`), "--trim-filenames"));
    expect(short).toBe(200);
    expect(long).toBe(60);
  });

  test("Windows temp dir is <outDir>\\.keepsake-tmp\\<id>", () => {
    const r = buildDownloadArgs(req("audio:mp3"), WIN_OUT);
    expect(r.tempDir).toBe(`${WIN_OUT}\\.keepsake-tmp\\11111111-2222-3333-4444-555555555555`);
    expect(r.args).toContain(`home:${WIN_OUT}`);
    expect(r.args).toContain(`temp:${r.tempDir}`);
  });

  test("Linux temp dir drops a trailing slash", () => {
    const r = buildDownloadArgs(req("audio:mp3"), `${LINUX_OUT}/`);
    expect(r.tempDir).toBe(`${LINUX_OUT}/.keepsake-tmp/11111111-2222-3333-4444-555555555555`);
  });

  test("cookies browser is passed only when not off", () => {
    expect(after(build("audio:mp3", { cookiesBrowser: "firefox" }), "--cookies-from-browser")).toBe("firefox");
    expect(build("audio:mp3", { cookiesBrowser: "off" })).not.toContain("--cookies-from-browser");
    expect(build("audio:mp3")).not.toContain("--cookies-from-browser");
  });

  test("non-http URLs are rejected", () => {
    expect(() => buildDownloadArgs(req("audio:mp3", { url: "file:///etc/passwd" }), LINUX_OUT)).toThrow();
    expect(() => buildDownloadArgs(req("audio:mp3", { url: "not a url" }), LINUX_OUT)).toThrow();
  });

  test("unknown format id is rejected with format_unavailable", () => {
    let code;
    try {
      buildDownloadArgs(req("bogus:1"), LINUX_OUT);
    } catch (e) {
      code = e.code;
    }
    expect(code).toBe("format_unavailable");
  });
});

describe("buildDownloadArgs: video", () => {
  test("height cap in -f and mp4/mkv merge output, never -x", () => {
    const a = build("video:1080");
    expect(after(a, "-f")).toContain("[height<=1080]");
    expect(after(a, "--merge-output-format")).toBe("mp4/mkv");
    expect(a).not.toContain("-x");
    expect(a).not.toContain("--audio-format");
  });

  test("best has no height cap", () => {
    expect(after(build("video:best"), "-f")).not.toContain("height<=");
  });

  test("Prefer H.264 adds a sort", () => {
    expect(after(build("video:720", { preferH264: true }), "-S")).toContain("vcodec:h264");
    expect(build("video:720")).not.toContain("-S");
  });

  test("picked video-only stream is merged with best audio", () => {
    const a = build("video:1080", { info: info(), streamId: "137" });
    expect(after(a, "-f").startsWith("137+bestaudio")).toBe(true);
  });

  test("embedding is OFF by default (no thumbnail, no metadata pass)", () => {
    const a = build("video:1080");
    expect(a).not.toContain("--embed-thumbnail");
    expect(a).not.toContain("--embed-metadata");
    expect(a).not.toContain("--convert-thumbnails");
  });

  test("the audio cover-art setting does not turn on video embedding", () => {
    const a = build("video:1080", { embedThumbnail: true });
    expect(a).not.toContain("--embed-thumbnail");
    expect(a).not.toContain("--embed-metadata");
  });

  test("embedVideoMeta: true turns on thumbnail and metadata embedding; false keeps it off", () => {
    const a = build("video:1080", { embedVideoMeta: true });
    expect(a).toContain("--embed-thumbnail");
    expect(a).toContain("--embed-metadata");
    expect(after(a, "--convert-thumbnails")).toBe("jpg");
    const off = build("video:1080", { embedVideoMeta: false });
    expect(off).not.toContain("--embed-thumbnail");
    expect(off).not.toContain("--embed-metadata");
  });
});

describe("buildDownloadArgs: audio", () => {
  test("M4A with a native m4a stream: no -x, selects the m4a stream", () => {
    const a = build("audio:m4a", { info: info({ m4a: true }) });
    expect(a).not.toContain("-x");
    expect(a).not.toContain("--extract-audio");
    expect(a).not.toContain("--audio-format");
    expect(after(a, "-f")).toBe("bestaudio[ext=m4a]");
  });

  test("M4A without a known m4a stream still prefers m4a, with -x as the fallback", () => {
    for (const i of [undefined, info({ m4a: false })]) {
      const a = build("audio:m4a", { info: i });
      expect(after(a, "-f").startsWith("bestaudio[ext=m4a]/")).toBe(true);
      expect(a).toContain("-x");
      expect(after(a, "--audio-format")).toBe("m4a");
    }
  });

  test("M4A for a playlist keeps the fallback (entries are not known yet)", () => {
    const a = build("audio:m4a", { info: { ...info(), kind: "playlist" } });
    expect(a).toContain("-x");
  });

  test("Opus prefers the native Opus stream", () => {
    expect(after(build("audio:opus"), "-f").startsWith("bestaudio[acodec=opus]")).toBe(true);
  });

  test("MP3 extracts and transcodes with the chosen bitrate (192K default)", () => {
    const a = build("audio:mp3");
    expect(a).toContain("-x");
    expect(after(a, "--audio-format")).toBe("mp3");
    expect(after(a, "--audio-quality")).toBe("192K");
    expect(after(build("audio:mp3", { audioBitrate: 320 }), "--audio-quality")).toBe("320K");
  });

  for (const f of ["wav", "flac", "opus"]) {
    test(`${f.toUpperCase()} extracts to ${f}`, () => {
      const a = build(`audio:${f}`, { info: info() });
      expect(a).toContain("-x");
      expect(after(a, "--audio-format")).toBe(f);
    });
  }

  test("lossless formats get no bitrate", () => {
    expect(build("audio:wav")).not.toContain("--audio-quality");
    expect(build("audio:flac")).not.toContain("--audio-quality");
  });

  test("embedding is ON by default for MP3 and M4A", () => {
    for (const f of ["mp3", "m4a"]) {
      const a = build(`audio:${f}`, { info: info() });
      expect(a).toContain("--embed-thumbnail");
      expect(a).toContain("--embed-metadata");
    }
  });

  test("embedding can be turned off for audio", () => {
    const a = build("audio:mp3", { embedThumbnail: false });
    expect(a).not.toContain("--embed-thumbnail");
  });

  test("no cover art is embedded into WAV", () => {
    expect(build("audio:wav")).not.toContain("--embed-thumbnail");
  });
});

describe("buildDownloadArgs: thumbnail", () => {
  test("original: skip download, write thumbnail, no conversion", () => {
    const a = build("thumb:original");
    expect(a).toContain("--skip-download");
    expect(a).toContain("--write-thumbnail");
    expect(a).not.toContain("--convert-thumbnails");
    expect(a).not.toContain("--embed-thumbnail");
  });

  test("png/jpg convert", () => {
    expect(after(build("thumb:png"), "--convert-thumbnails")).toBe("png");
    expect(after(build("thumb:jpg"), "--convert-thumbnails")).toBe("jpg");
  });
});

describe("parseProgressLine", () => {
  test("parses a downloading line", () => {
    const p = parseProgressLine("KEEPSAKE|downloading|500|1000|NA|2048|3|NA|NA|/tmp/f.mp4");
    expect(p).toEqual({
      status: "downloading",
      downloadedBytes: 500,
      totalBytes: 1000,
      percent: 50,
      speedBps: 2048,
      etaSec: 3,
      playlistIndex: undefined,
      playlistCount: undefined,
    });
  });

  test("falls back to the estimate and reads playlist fields", () => {
    const p = parseProgressLine("KEEPSAKE|downloading|250|NA|1000|None|NA|2|5|f");
    expect(p.totalBytes).toBe(1000);
    expect(p.percent).toBe(25);
    expect(p.speedBps).toBeUndefined();
    expect(p.playlistIndex).toBe(2);
    expect(p.playlistCount).toBe(5);
  });

  test("finished maps to merging; percent is capped at 100", () => {
    const p = parseProgressLine("KEEPSAKE|finished|1200|1000|NA|NA|NA|NA|NA|f");
    expect(p.status).toBe("merging");
    expect(p.percent).toBe(100);
  });

  test("unknown total leaves percent undefined", () => {
    expect(parseProgressLine("KEEPSAKE|downloading|10|NA|NA|NA|NA|NA|NA|f").percent).toBeUndefined();
  });

  test("other lines return null", () => {
    expect(parseProgressLine("[download] Destination: x.mp4")).toBeNull();
    expect(parseProgressLine("KEEPSAKE_DONE|/tmp/x.mp4")).toBeNull();
  });
});
