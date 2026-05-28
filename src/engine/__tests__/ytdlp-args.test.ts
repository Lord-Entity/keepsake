// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Unit tests for the yt-dlp argument builder in src/engine/ytdlp.ts (buildDownloadArgs, parseProgressLine).
 * Pure: buildDownloadArgs only builds an array; nothing is invoked or spawned. No network.
 */
import { describe, expect, test } from "bun:test";
import {
  buildDownloadArgs,
  isFormatPart,
  ladderSite,
  laddersAfter,
  ladderSteps,
  LADDER_STEPS,
  mergeTracker,
  movedPartPath,
  parseProgressLine,
  selectionArgs,
} from "../ytdlp";

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
    let code: string | undefined;
    try {
      buildDownloadArgs(req("bogus:1"), LINUX_OUT);
    } catch (e) {
      code = (e as { code?: string }).code;
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

// Regression: desktop YouTube gave a .webm + an .mp4 with no sound. yt-dlp could not find the bundled ffmpeg
// (`--ffmpeg-location <folder>` holding keepsake-ffmpeg.exe), skipped the merge under -i/--no-warnings and moved the
// video-only and audio-only `.fNNN` parts into the output folder while the app reported success.
const prog = (f: string) => `KEEPSAKE|finished|10|10|NA|NA|NA|NA|NA|${f}`;
describe("skipped merge is an error, parts are removed", () => {
  const tmp = "C:\\Users\\u\\Downloads\\.keepsake-tmp\\job1";
  const out = "C:\\Users\\u\\Downloads";
  const v = `${tmp}\\Clip [abc].f137.mp4`;
  const a = `${tmp}\\Clip [abc].f251.webm`;

  test("isFormatPart: per-format parts only", () => {
    expect(isFormatPart("C:\\o\\Clip [abc].f137.mp4")).toBe(true);
    expect(isFormatPart("/o/Clip [abc].f251.webm")).toBe(true);
    expect(isFormatPart("/o/Clip [abc].fhls-1080p.mp4")).toBe(true);
    expect(isFormatPart("/o/Clip [abc].mp4")).toBe(false);
    expect(isFormatPart("/o/Clip [abc].mkv")).toBe(false);
    expect(isFormatPart("/o/Clip.final [abc].webm")).toBe(false);
  });

  test("isFormatPart with the Android file name is exact", () => {
    expect(isFormatPart("/data/out/Clip.f137.mp4", "Clip")).toBe(true);
    expect(isFormatPart("/data/out/Clip.f251.webm", "Clip")).toBe(true);
    expect(isFormatPart("/data/out/Clip.mp4", "Clip")).toBe(false);
    expect(isFormatPart("/data/out/Clip.flac", "Clip")).toBe(false);
    expect(isFormatPart("/data/out/my.file.mp4", "my.file")).toBe(false);
    expect(isFormatPart("/data/out/my.file.f140.m4a", "my.file")).toBe(true);
    expect(isFormatPart("/data/out/Other.f137.mp4", "Clip")).toBe(false);
  });

  test("parts without a Merger run are reported, even when the printed path is the merged name", () => {
    const t = mergeTracker();
    t.line(prog(v));
    t.line(prog(a));
    expect(t.done(`${out}\\Clip [abc].mp4`).toSorted()).toEqual([v, a].toSorted());
  });

  test("a merged video reports nothing", () => {
    const t = mergeTracker();
    t.line(prog(v));
    t.line(prog(a));
    t.line("KEEPSAKE_PP|started|Merger");
    t.line("KEEPSAKE_PP|finished|Merger");
    expect(t.done(`${out}\\Clip [abc].mp4`)).toEqual([]);
  });

  test("other postprocessors do not count as a merge; a printed part path is always reported", () => {
    const t = mergeTracker();
    t.line(prog(v));
    t.line("KEEPSAKE_PP|started|MoveFiles");
    expect(t.done(`${out}\\Clip [abc].f137.mp4`)).toEqual([v, `${out}\\Clip [abc].f137.mp4`]);
  });

  test("progressive download (no parts) reports nothing; state resets per video", () => {
    const t = mergeTracker();
    t.line(prog(v));
    t.done(`${out}\\Clip [abc].mp4`);
    t.line(prog(`${tmp}\\Other [x].mp4`));
    expect(t.done(`${out}\\Other [x].mp4`)).toEqual([]);
  });

  test("movedPartPath maps temp to home, keeping playlist sub-folders", () => {
    expect(movedPartPath(v, tmp, out)).toBe(`${out}\\Clip [abc].f137.mp4`);
    expect(movedPartPath(`${tmp}\\PL\\01 - Clip [abc].f251.webm`, tmp, `${out}\\`)).toBe(`${out}\\PL\\01 - Clip [abc].f251.webm`);
    expect(movedPartPath("/o/Clip [abc].f137.mp4", "/o/.keepsake-tmp/job1", "/o")).toBe("/o/Clip [abc].f137.mp4");
  });
});

const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return undefined;
};

describe("selectionArgs", () => {
  const AND = { platform: "android" };
  const DESK = { platform: "desktop" };
  const MERGE = ["--merge-output-format", "mp4/mkv"];
  const THUMB = ["--embed-thumbnail", "--convert-thumbnails", "jpg"];

  describe("android", () => {
    test("video:best has no height cap", () => {
      expect(selectionArgs(req("video:best"), AND)).toEqual(["-f", "bestvideo+bestaudio/best/best", ...MERGE]);
    });

    for (const h of [2160, 1440, 1080, 720, 480, 360]) {
      test(`video:${h} caps the height`, () => {
        expect(selectionArgs(req(`video:${h}`), AND)).toEqual([
          "-f",
          `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`,
          ...MERGE,
        ]);
      });
    }

    test("preferH264 inserts -S before the merge format", () => {
      expect(selectionArgs(req("video:720", { preferH264: true }), AND)).toEqual([
        "-f",
        "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
        "-S",
        "res,fps,vcodec:h264,acodec:aac",
        ...MERGE,
      ]);
    });

    test("streamId, info, embedVideoMeta and embedThumbnail are ignored", () => {
      const plain = selectionArgs(req("video:1080"), AND);
      const extra = selectionArgs(
        req("video:1080", { streamId: "137", info: info(), embedVideoMeta: true, embedThumbnail: true }),
        AND,
      );
      expect(extra).toEqual(plain);
    });

    test("audio:m4a and audio:wav use the m4a fallback chain, with or without info", () => {
      const want = ["-f", "bestaudio[ext=m4a]/bestaudio/best", "-x", "--audio-format", "m4a"];
      for (const f of ["audio:m4a", "audio:wav"]) {
        expect(selectionArgs(req(f), AND)).toEqual(want);
        expect(selectionArgs(req(f, { info: info() }), AND)).toEqual(want);
      }
    });

    for (const f of ["audio:mp3", "audio:opus", "audio:flac", "thumb:png", "thumb:original", "bogus"]) {
      test(`${f} throws format_unavailable`, () => {
        expect(codeOf(() => selectionArgs(req(f), AND))).toBe("format_unavailable");
      });
    }
  });

  describe("desktop", () => {
    const H1080 = ["-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best", ...MERGE];

    test("video:1080 without a streamId uses the height selector", () => {
      expect(selectionArgs(req("video:1080"), DESK)).toEqual(H1080);
    });

    test("picked video-only stream is merged with best audio", () => {
      expect(selectionArgs(req("video:1080", { streamId: "137", info: info() }), DESK)).toEqual([
        "-f",
        "137+bestaudio[ext=m4a]/137+bestaudio",
        ...MERGE,
      ]);
    });

    test("picked progressive stream is used as-is", () => {
      expect(selectionArgs(req("video:1080", { streamId: "18", info: info() }), DESK)).toEqual(["-f", "18", ...MERGE]);
    });

    test("heightFallback ignores the picked stream", () => {
      for (const streamId of ["137", "18"]) {
        expect(selectionArgs(req("video:1080", { streamId, info: info() }), { ...DESK, heightFallback: true })).toEqual(H1080);
      }
    });

    test("embedVideoMeta: true appends the embed flags", () => {
      expect(selectionArgs(req("video:1080", { embedVideoMeta: true }), DESK)).toEqual([
        ...H1080,
        ...THUMB,
        "--embed-metadata",
      ]);
    });

    test("audio:mp3 transcodes at 192K and embeds", () => {
      expect(selectionArgs(req("audio:mp3"), DESK)).toEqual([
        "-f",
        "bestaudio/best",
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "192K",
        ...THUMB,
        "--embed-metadata",
      ]);
    });

    test("audioBitrate 320 gives 320K", () => {
      expect(after(selectionArgs(req("audio:mp3", { audioBitrate: 320 }), DESK), "--audio-quality")).toBe("320K");
    });

    test("audio:m4a with a native m4a stream takes it as-is", () => {
      expect(selectionArgs(req("audio:m4a", { info: info() }), DESK)).toEqual([
        "-f",
        "bestaudio[ext=m4a]",
        ...THUMB,
        "--embed-metadata",
      ]);
    });

    test("audio:m4a without a native m4a stream keeps -x", () => {
      expect(selectionArgs(req("audio:m4a", { info: info({ m4a: false }) }), DESK)).toEqual([
        "-f",
        "bestaudio[ext=m4a]/bestaudio/best",
        "-x",
        "--audio-format",
        "m4a",
        ...THUMB,
        "--embed-metadata",
      ]);
    });

    test("audio:opus has a quality but no cover art", () => {
      expect(selectionArgs(req("audio:opus"), DESK)).toEqual([
        "-f",
        "bestaudio[acodec=opus]/bestaudio/best",
        "-x",
        "--audio-format",
        "opus",
        "--audio-quality",
        "192K",
        "--embed-metadata",
      ]);
    });

    test("embedThumbnail: false drops the thumbnail flags on mp3", () => {
      expect(selectionArgs(req("audio:mp3", { embedThumbnail: false }), DESK)).toEqual([
        "-f",
        "bestaudio/best",
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "192K",
        "--embed-metadata",
      ]);
    });
  });

  describe("consistency with buildDownloadArgs", () => {
    for (const id of ALL_FORMATS.filter((f) => f.startsWith("video:") || f.startsWith("audio:"))) {
      test(`${id}: desktop selection is embedded between -o and --`, () => {
        const a = buildDownloadArgs(req(id), LINUX_OUT).args;
        const start = a.indexOf("-o") + 2;
        expect(a.slice(start, a.length - 2)).toEqual(selectionArgs(req(id), { platform: "desktop" }));
      });
    }
  });
});

describe("TikTok/Instagram workaround ladder", () => {
  const TIKTOK_URL = "https://www.tiktok.com/@a/video/1";
  const INSTAGRAM_URL = "https://www.instagram.com/reel/abc/";
  const LADDER_URLS = { tiktok: TIKTOK_URL, instagram: INSTAGRAM_URL };

  test("ladderSite: TikTok and Instagram hosts", () => {
    for (const u of ["tiktok.com", "www.tiktok.com", "vm.tiktok.com", "m.tiktok.com"]) {
      expect(ladderSite(`https://${u}/x`)).toBe("tiktok");
    }
    for (const u of ["instagram.com", "www.instagram.com", "instagr.am"]) {
      expect(ladderSite(`https://${u}/x`)).toBe("instagram");
    }
  });

  test("ladderSite: every other host (and garbage) is undefined", () => {
    for (const u of [
      "https://youtube.com/watch?v=abc",
      "https://youtu.be/abc",
      "https://music.youtube.com/watch?v=abc",
      "https://nottiktok.com/x",
      "https://tiktok.com.evil.example/x",
      "https://vimeo.com/1",
      "not a url at all",
    ]) {
      expect(ladderSite(u)).toBeUndefined();
    }
  });

  test("YouTube and other sites never get ladder steps", () => {
    expect(ladderSteps("https://www.youtube.com/watch?v=abc").length).toBe(0);
    expect(ladderSteps("https://youtu.be/abc").length).toBe(0);
    expect(ladderSteps("https://vimeo.com/1").length).toBe(0);
  });

  test("ladder steps are pinned exactly", () => {
    expect(LADDER_STEPS.tiktok).toEqual([
      ["--extractor-args", "tiktok:api_hostname=api22-normal-c-alisg.tiktokv.com;app_info=7351144126450059040"],
      ["--force-ipv4", "--impersonate", "safari"],
    ]);
    expect(LADDER_STEPS.instagram).toEqual([
      ["--extractor-args", "instagram:app_id=ios"],
      ["--force-ipv4", "--impersonate", "safari"],
    ]);
    expect(ladderSteps(TIKTOK_URL)).toEqual(LADDER_STEPS.tiktok);
    expect(ladderSteps(INSTAGRAM_URL)).toEqual(LADDER_STEPS.instagram);
  });

  test("no ladder step carries a forbidden flag, cookies flag or `--`", () => {
    for (const site of ["tiktok", "instagram"]) {
      for (const step of LADDER_STEPS[site]) {
        for (const bad of [...FORBIDDEN, "--cookies-from-browser", "--cookies", "--"]) {
          expect(step).not.toContain(bad);
        }
      }
    }
  });

  describe("first attempt is unchanged", () => {
    const URLS = [URL, TIKTOK_URL, INSTAGRAM_URL];
    for (const u of URLS) {
      for (const f of ALL_FORMATS) {
        test(`${f} on ${u}: no opts, {} and heightFallback:false give identical argv without ladder flags`, () => {
          const r = req(f, { url: u });
          const plain = buildDownloadArgs(r, LINUX_OUT).args;
          expect(plain).toEqual(buildDownloadArgs(r, LINUX_OUT, {}).args);
          expect(plain).toEqual(buildDownloadArgs(r, LINUX_OUT, { heightFallback: false }).args);
          for (const flag of ["--force-ipv4", "--impersonate", "--extractor-args"]) expect(plain).not.toContain(flag);
        });
      }
    }

    test("pinned full argv for a TikTok video:1080 first attempt", () => {
      const r = buildDownloadArgs(req("video:1080", { url: TIKTOK_URL }), LINUX_OUT);
      expect(r.tempDir).toBe("/home/me/Downloads/.keepsake-tmp/11111111-2222-3333-4444-555555555555");
      expect(r.args).toEqual([
        "--encoding",
        "utf-8",
        "--no-warnings",
        "--windows-filenames",
        "--trim-filenames",
        "200",
        "-P",
        "home:/home/me/Downloads",
        "-P",
        "temp:/home/me/Downloads/.keepsake-tmp/11111111-2222-3333-4444-555555555555",
        "--newline",
        "--progress",
        "--progress-template",
        "download:KEEPSAKE|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|" +
          "%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.playlist_index)s|" +
          "%(info.n_entries)s|%(progress.filename)s",
        "--progress-template",
        "postprocess:KEEPSAKE_PP|%(progress.status)s|%(progress.postprocessor)s",
        "--print",
        "after_move:KEEPSAKE_DONE|%(filepath)s",
        "-i",
        "--retries",
        "10",
        "--fragment-retries",
        "10",
        "--socket-timeout",
        "30",
        "--concurrent-fragments",
        "4",
        "--no-playlist",
        "-o",
        "%(title).80B [%(id)s].%(ext)s",
        "-f",
        "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        "--merge-output-format",
        "mp4/mkv",
        "--",
        TIKTOK_URL,
      ]);
    });
  });

  describe("pinned first-attempt argv: Instagram video, TikTok/Instagram audio, YouTube has no ladder", () => {
    const TMP = "/home/me/Downloads/.keepsake-tmp/11111111-2222-3333-4444-555555555555";
    const HEAD = [
      "--encoding",
      "utf-8",
      "--no-warnings",
      "--windows-filenames",
      "--trim-filenames",
      "200",
      "-P",
      "home:/home/me/Downloads",
      "-P",
      `temp:${TMP}`,
      "--newline",
      "--progress",
      "--progress-template",
      "download:KEEPSAKE|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|" +
        "%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.playlist_index)s|" +
        "%(info.n_entries)s|%(progress.filename)s",
      "--progress-template",
      "postprocess:KEEPSAKE_PP|%(progress.status)s|%(progress.postprocessor)s",
      "--print",
      "after_move:KEEPSAKE_DONE|%(filepath)s",
      "-i",
      "--retries",
      "10",
      "--fragment-retries",
      "10",
      "--socket-timeout",
      "30",
      "--concurrent-fragments",
      "4",
      "--no-playlist",
      "-o",
      "%(title).80B [%(id)s].%(ext)s",
    ];
    const VIDEO_SEL = ["-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best", "--merge-output-format", "mp4/mkv"];
    const MP3_SEL = [
      "-f",
      "bestaudio/best",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "192K",
      "--embed-thumbnail",
      "--convert-thumbnails",
      "jpg",
      "--embed-metadata",
    ];

    test("Instagram video:1080 first attempt", () => {
      expect(buildDownloadArgs(req("video:1080", { url: INSTAGRAM_URL }), LINUX_OUT).args).toEqual([
        ...HEAD,
        ...VIDEO_SEL,
        "--",
        INSTAGRAM_URL,
      ]);
    });

    test("TikTok audio:mp3 first attempt", () => {
      expect(buildDownloadArgs(req("audio:mp3", { url: TIKTOK_URL }), LINUX_OUT).args).toEqual([
        ...HEAD,
        ...MP3_SEL,
        "--",
        TIKTOK_URL,
      ]);
    });

    test("Instagram audio:mp3 first attempt", () => {
      expect(buildDownloadArgs(req("audio:mp3", { url: INSTAGRAM_URL }), LINUX_OUT).args).toEqual([
        ...HEAD,
        ...MP3_SEL,
        "--",
        INSTAGRAM_URL,
      ]);
    });

    test("every YouTube URL form has no ladder site and no ladder steps (downloadYtdlp gates on ladderSteps)", () => {
      for (const u of [
        URL,
        "https://youtube.com/watch?v=abc",
        "https://m.youtube.com/watch?v=abc",
        "https://music.youtube.com/watch?v=abc",
        "https://www.youtube.com/shorts/abc",
        "https://youtu.be/abc",
      ]) {
        expect(ladderSite(u)).toBeUndefined();
        expect(ladderSteps(u)).toEqual([]);
      }
    });
  });

  describe("ladder args go right before `-- URL`", () => {
    for (const site of ["tiktok", "instagram"]) {
      LADDER_STEPS[site].forEach((step, i) => {
        for (const f of ["video:1080", "audio:mp3", "thumb:png"]) {
          test(`${site} step ${i + 1}, ${f}`, () => {
            const r = req(f, { url: LADDER_URLS[site] });
            const base = buildDownloadArgs(r, LINUX_OUT).args;
            const a = buildDownloadArgs(r, LINUX_OUT, { extra: step }).args;
            expect(a).toEqual([...base.slice(0, -2), ...step, ...base.slice(-2)]);
            expect(a.slice(-2)).toEqual(["--", LADDER_URLS[site]]);
            expect(a.filter((x) => x === "--").length).toBe(1);
          });
        }
      });
    }
  });

  describe("laddersAfter", () => {
    const YES = [
      "unknown",
      "network",
      "timeout",
      "ssl",
      "forbidden",
      "rate_limited",
      "login_required",
      "ip_blocked",
      "anti_bot",
      "parse_failed",
      "no_formats",
    ];
    const NO = [
      "cancelled",
      "js_runtime_missing",
      "ytdlp_missing",
      "no_space",
      "permission",
      "private",
      "unavailable",
      "not_found",
      "drm",
      "password",
      "ffmpeg_missing",
      "format_unavailable",
      "geo_blocked",
      "unsupported_url",
      "bot_check",
      "empty",
      "spawn",
    ];
    for (const c of YES) test(`${c}: ladders`, () => expect(laddersAfter(c)).toBe(true));
    for (const c of NO) test(`${c}: final`, () => expect(laddersAfter(c)).toBe(false));
  });
});
