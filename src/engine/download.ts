/**
 * startDownload for every platform.
 * - Desktop (windows/linux): yt-dlp sidecar via `run_ytdlp` (ytdlp.ts, CONTRACT.md).
 * - Android: youtubei.js single-file stream -> 10 MB Range requests through plugin-http -> plugin-fs FileHandle,
 *   streamed to disk (never the whole file in memory). M4A from an audio-only stream is saved as-is; WAV, and M4A
 *   taken from a progressive MP4, go to a temp file in the app cache and through the native keepsake-media plugin
 *   (android-media.ts). MP3/FLAC/Opus are not available on Android yet and are rejected here.
 * - Android TikTok/Instagram: in-process yt-dlp (Chaquopy) through android-ytdlp.ts, one single-file format, no
 *   progress events (indeterminate). M4A from a muxed MP4 goes through the app cache and the transcode plugin.
 * - Android YouTube, self-contained route (info.ytdlpFull, plan 11 WP-F2): one ytdlp_download with the desktop
 *   selectors (selectionArgs, android variant); yt-dlp + the bundled ffmpeg merge the file. WAV = M4A then the
 *   transcode plugin. Any non-final failure falls back once to youtubei.js (runDirect).
 * - Web: same fetch path into a Blob -> <a download>. (CORS blocks YouTube in a plain browser; dev only.) No conversion.
 *
 * VERIFIED (node_modules/@tauri-apps/plugin-fs/dist-js/index.d.ts 2.7.1): `open(path, { write, create, truncate })`
 *   returns FileHandle with `write(data: Uint8Array): Promise<number>` (bytes written, may be short) and `close()`;
 *   `writeFile(path, data)`, `mkdir(path, { recursive })`, `exists(path)`, `remove(path)`.
 * VERIFIED (@tauri-apps/api/path): `downloadDir()`, `appCacheDir()`, `join(...paths)`.
 * INFERRED: googlevideo serves `Range: bytes=a-b` requests with 206 and throttles single huge requests
 *   (the reason yt-dlp uses ~10 MB http_chunk_size for YouTube); not run here.
 */
import { appCacheDir, downloadDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, open, remove, writeFile, type FileHandle } from "@tauri-apps/plugin-fs";
import type { AudioFormat, DownloadHandle, DownloadProgress, DownloadRequest, VideoInfo } from "../lib/types";
import { androidSaveMode, GalleryError, publishToGallery } from "./android-gallery";
import { FolderError, saveToFolder } from "./android-folder";
import { transcodeAudio } from "./android-media";
import {
  cancelAndroid,
  downloadAndroid,
  fetchAndroidInfo,
  hiddenStreams,
  isAndroidYtdlpHost,
  isAndroidYtdlpSupported,
  mapYtdlpError,
  MP3_TEXT,
  muxAndroid,
  PERMISSION_TEXT,
  pickYtdlpFormat,
  runWithRetry,
  TIKTOK_IG_TS_RETRY,
  ytdlpAlternatives,
  ytdlpPickKey,
  type YtdlpPick,
} from "./android-ytdlp";
import { appError, EngineError, fail, toAppError } from "./errors";
import { httpFetch, timeoutSignal } from "./http";
import { isDesktop, platform } from "./platform";
import {
  resolveAdaptive,
  resolveSingleFile,
  fetchYouTubeInfo,
  isYouTubeUrl,
  type ResolvedPair,
  type ResolvedStream,
} from "./youtube";
import { cancelYtdlp, downloadYtdlp, isFormatPart, selectionArgs } from "./ytdlp";
import { androidYtdlpReady } from "./youtube-ytdlp";

const CHUNK = 10 * 1024 * 1024;
const CHUNK_TIMEOUT_MS = 120_000;
const RETRIES = 3;

type Emit = (p: DownloadProgress) => void;

/** Windows-safe file name from a title. */
export function safeName(title: string, max = 150): string {
  const s = title
    // oxlint-disable-next-line no-control-regex -- strip C0 control characters from file names
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  return (s || "download").slice(0, max);
}

/** Tracks speed and ETA over a 3 s window and throttles emits to 4 per second. */
class Meter {
  private samples: [number, number][] = [];
  private lastEmit = 0;
  constructor(
    private id: string,
    private emit: Emit,
  ) {}
  update(downloaded: number, total: number | undefined, force = false) {
    const now = performance.now();
    this.samples.push([now, downloaded]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 3000) this.samples.shift();
    if (!force && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    const [t0, b0] = this.samples[0];
    const speed = now > t0 ? ((downloaded - b0) * 1000) / (now - t0) : undefined;
    this.emit({
      id: this.id,
      status: "downloading",
      downloadedBytes: downloaded,
      totalBytes: total,
      percent: total ? Math.min(100, (downloaded / total) * 100) : undefined,
      speedBps: speed,
      etaSec: total && speed ? Math.max(0, (total - downloaded) / speed) : undefined,
    });
  }
}

/** Feed the body to `onChunk`; stop early (and cancel the stream) when it returns true. */
async function readBody(res: Response, onChunk: (c: Uint8Array) => Promise<boolean | void>): Promise<void> {
  if (!res.body) {
    await onChunk(new Uint8Array(await res.arrayBuffer()));
    return;
  }
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (await onChunk(value)) {
      await reader.cancel().catch(() => undefined);
      return;
    }
  }
}

function statusError(status: number): never {
  if (status === 403) fail("forbidden", `HTTP Error 403: Forbidden`);
  if (status === 404) fail("not_found", `HTTP Error 404`);
  if (status === 429) fail("rate_limited", `HTTP Error 429`);
  fail("unknown", `HTTP Error ${status}`);
}

const bad = (detail: string): never => {
  throw new EngineError({
    code: "unknown",
    message: "The video server sent the wrong part of the file, so the download was stopped. Try again later.",
    detail,
    cookiesHint: false,
  });
};

/**
 * The server must answer a Range request with 206 starting at `start`. A 200 carries the body from byte 0, so
 * writing it at `start` would corrupt the file: fail instead. A 200 is accepted only when the range asked for
 * was the whole file. Not retryable (error code "unknown").
 */
function checkRange(res: Response, start: number, end: number, size: number) {
  if (res.status === 206) {
    const cr = res.headers.get("content-range");
    const m = cr ? /^bytes\s+(\d+)-/i.exec(cr) : null;
    if (m && Number(m[1]) !== start) bad(`Asked for bytes ${start}-${end}, got Content-Range "${cr}"`);
    return;
  }
  if (res.status === 200 && start === 0 && end === size - 1) return;
  bad(`HTTP ${res.status} (expected 206) for Range bytes=${start}-${end}`);
}

/** Download `url` in Range chunks (or one request when the size is unknown), feeding `sink`. */
async function fetchStream(
  url: string,
  size: number | undefined,
  sink: (c: Uint8Array) => Promise<void>,
  meter: Meter,
  signal: AbortSignal,
): Promise<number> {
  let got = 0;
  if (!size) {
    const res = await httpFetch(url, { signal, timeoutMs: 0 });
    if (!res.ok) statusError(res.status);
    const total = Number(res.headers.get("content-length")) || undefined;
    await readBody(res, async (c) => {
      await sink(c);
      got += c.byteLength;
      meter.update(got, total);
    });
    meter.update(got, total, true);
    return got;
  }
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- got is advanced by the readBody callback in the loop body
  while (got < size) {
    const start = got;
    const end = Math.min(size, start + CHUNK) - 1;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await httpFetch(url, {
          headers: { Range: `bytes=${start}-${end}` },
          signal: timeoutSignal(CHUNK_TIMEOUT_MS, signal),
          timeoutMs: 0,
        });
        if (!res.ok) statusError(res.status);
        checkRange(res, start, end, size);
        // `pos` is the file offset of the next body byte. Bytes before `got` were written by an earlier attempt
        // (skip them); bytes after `end` were not asked for (drop them and stop reading).
        let pos = start;
        await readBody(res, async (c) => {
          const from = Math.max(0, got - pos);
          const to = Math.min(c.byteLength, end + 1 - pos);
          pos += c.byteLength;
          if (to > from) {
            const part = from === 0 && to === c.byteLength ? c : c.subarray(from, to);
            await sink(part);
            got += part.byteLength;
            meter.update(got, size);
          }
          return got > end;
        });
        if (got <= end) throw new Error("Connection reset: short read");
        break;
      } catch (e) {
        const err = toAppError(e);
        const retryable = err.code === "network" || err.code === "timeout";
        if (signal.aborted || !retryable || attempt + 1 >= RETRIES) throw e;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  meter.update(got, size, true);
  return got;
}

// ---------------- output targets ----------------

interface Target {
  /** Append a chunk (streaming). */
  write: (c: Uint8Array) => Promise<void>;
  /** Write a small file in one go (thumbnails). */
  writeAll: (bytes: Uint8Array) => Promise<void>;
  finish: () => Promise<string>;
  discard: () => Promise<void>;
}

async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  for (let i = 0; i < 1000; i++) {
    const p = await join(dir, `${base}${i ? ` (${i})` : ""}.${ext}`);
    if (!(await exists(p))) return p;
  }
  return join(dir, `${base}-${Date.now()}.${ext}`);
}

async function androidOutDir(req: DownloadRequest): Promise<string> {
  const dir = req.outputDir || (await downloadDir());
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    fail("bad_folder", `Can't save to ${dir}. ${e instanceof Error ? e.message : String(e)}`);
  }
  return dir.replace(/[\\/]+$/, "");
}

/** FileHandle.write may write fewer bytes than given; loop until the chunk is fully written. */
async function writeFully(fh: FileHandle, c: Uint8Array): Promise<void> {
  let off = 0;
  while (off < c.byteLength) {
    const n = await fh.write(off ? c.subarray(off) : c);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Disk write failed after ${off} of ${c.byteLength} bytes`);
    off += n;
  }
}

/** File target at `path`. `streaming` opens a FileHandle for `write`; otherwise only `writeAll` is usable. */
async function fileTarget(path: string, streaming: boolean): Promise<Target> {
  const fh = streaming ? await open(path, { write: true, create: true, truncate: true }) : undefined;
  return {
    write: async (c) => {
      if (!fh) throw new Error("internal: streaming write on a non-streaming target");
      await writeFully(fh, c);
    },
    writeAll: (bytes) => writeFile(path, bytes),
    finish: async () => {
      await fh?.close();
      return path;
    },
    discard: async () => {
      await fh?.close().catch(() => undefined);
      await remove(path).catch(() => undefined);
    },
  };
}

function webTarget(base: string, ext: string, mime: string): Target {
  // Web is a dev preview; the Blob is built from the chunk list (no extra concat copy).
  let parts: BlobPart[] = [];
  return {
    write: async (c) => {
      parts.push(c.slice() as Uint8Array<ArrayBuffer>);
    },
    writeAll: async (bytes) => {
      parts = [bytes as Uint8Array<ArrayBuffer>];
    },
    finish: async () => {
      const name = `${base}.${ext}`;
      if (parts.length) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob(parts, { type: mime }));
        parts = [];
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      }
      return name;
    },
    discard: async () => {
      parts = [];
    },
  };
}

const MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

async function makeTarget(req: DownloadRequest, base: string, ext: string, streaming: boolean): Promise<Target> {
  if (platform() !== "android") return webTarget(base, ext, MIME[ext] ?? "application/octet-stream");
  return fileTarget(await uniquePath(await androidOutDir(req), base, ext), streaming);
}

// ---------------- thumbnail ----------------

async function convertImage(blob: Blob, to: "png" | "jpg"): Promise<Uint8Array> {
  const bmp = await createImageBitmap(blob);
  const type = to === "png" ? "image/png" : "image/jpeg";
  let out: Blob;
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    out = await c.convertToBlob({ type, quality: 0.95 });
  } else {
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    out = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), type, 0.95));
  }
  bmp.close();
  return new Uint8Array(await out.arrayBuffer());
}

async function downloadThumbnail(req: DownloadRequest, info: VideoInfo, emit: Emit, signal: AbortSignal) {
  const value = req.formatId.split(":")[1] ?? "original";
  // Try up to 8 candidates (jpg/png before webp), 15 s each, 10 MB cap (PLAN_v2 section B).
  const cands = info.thumbnails
    .toSorted((a, b) => Number(/\.webp/i.test(a.url)) - Number(/\.webp/i.test(b.url)))
    .slice(0, 8);
  let blob: Blob | undefined;
  let lastErr: unknown;
  for (const t of cands) {
    try {
      const res = await httpFetch(t.url, { signal });
      if (!res.ok) continue;
      const b = await res.blob();
      if (b.size > 0 && b.size <= 10 * 1024 * 1024) {
        blob = b;
        break;
      }
    } catch (e) {
      if (signal.aborted) throw e;
      lastErr = e;
    }
  }
  if (!blob) throw lastErr ?? appError("no_formats", "No thumbnail found");
  let bytes: Uint8Array;
  let ext: string;
  if (value === "png" || value === "jpg") {
    bytes = await convertImage(blob, value);
    ext = value;
  } else {
    bytes = new Uint8Array(await blob.arrayBuffer());
    ext = blob.type.includes("webp") ? "webp" : blob.type.includes("png") ? "png" : "jpg";
  }
  const target = await makeTarget(req, `${safeName(info.title)}_thumb`, ext, false);
  await target.writeAll(bytes);
  const filePath = await target.finish();
  emit({ id: req.id, status: "done", downloadedBytes: bytes.byteLength, totalBytes: bytes.byteLength, percent: 100, filePath });
  return filePath;
}

// ---------------- direct (Android / web) ----------------

function formatError(message: string, detail?: string): never {
  throw new EngineError({ code: "format_unavailable", message, detail, cookiesHint: false });
}

/** Audio formats the direct path can produce. MP3/FLAC/Opus need encoders the Android build does not ship yet. */
const DIRECT_AUDIO: ReadonlySet<AudioFormat> = new Set<AudioFormat>(["m4a", "wav"]);

/**
 * Android high-quality video: download a video-only stream and its matching audio-only stream into the
 * app cache, then mux them on the phone without re-encoding (keepsake-media: MP4 for AVC/HEVC+AAC,
 * WebM for VP8/VP9+Vorbis/Opus, AV1 to MP4 on Android 10+). This is the path that reaches 1080p, 1440p
 * and 4K; progressive files stop at 360p/720p.
 */
async function downloadAdaptive(
  req: DownloadRequest,
  info: VideoInfo,
  pair: ResolvedPair,
  emit: Emit,
  signal: AbortSignal,
): Promise<DownloadProgress> {
  if (!pair.audio || platform() !== "android") {
    throw new EngineError({
      code: "format_unavailable",
      message: "This quality needs merging, which isn't available on this device.",
      cookiesHint: false,
    });
  }
  const dir = await androidOutDir(req);
  // AV1 always lands in MP4 (Android 10+); every other pair keeps its stream container (MP4 or WebM).
  const ext = /^av0?1/i.test(pair.video.stream.vcodec ?? "") ? "mp4" : pair.video.ext;
  const target = await uniquePath(dir, safeName(info.title), ext);
  const outName = nameFor(target, ext);
  const stage = await join(await appCacheDir(), `mux-${safeName(req.id, 60)}`);
  const vPath = await join(stage, `video.${pair.video.ext}`);
  const aPath = await join(stage, `audio.${pair.audio.ext}`);
  await mkdir(stage, { recursive: true });
  const meter = new Meter(req.id, emit);
  try {
    emit({ id: req.id, status: "downloading", downloadedBytes: 0, stage: "video" });
    const videoTarget = await fileTarget(vPath, true);
    try {
      await fetchStream(pair.video.url, pair.video.sizeBytes, videoTarget.write, meter, signal);
      await videoTarget.finish();
    } catch (e) {
      await videoTarget.discard();
      throw e;
    }
    if (signal.aborted) fail("cancelled");

    emit({ id: req.id, status: "downloading", downloadedBytes: 0, stage: "audio" });
    const audioTarget = await fileTarget(aPath, true);
    try {
      await fetchStream(pair.audio.url, pair.audio.sizeBytes, audioTarget.write, meter, signal);
      await audioTarget.finish();
    } catch (e) {
      await audioTarget.discard();
      throw e;
    }
    if (signal.aborted) fail("cancelled");

    emit({ id: req.id, status: "merging", downloadedBytes: 0, stage: "mux" });
    const res = await muxAndroid({ videoPath: vPath, audioPath: aPath, outDir: dir, fileName: outName });
    if (signal.aborted) {
      await remove(res.path).catch(() => undefined);
      fail("cancelled");
    }
    return { id: req.id, status: "done", downloadedBytes: res.bytes, totalBytes: res.bytes, percent: 100, filePath: res.path };
  } finally {
    await remove(stage, { recursive: true }).catch(() => undefined);
  }
}

async function runDirect(req: DownloadRequest, emit: Emit, signal: AbortSignal): Promise<DownloadProgress> {
  if (!isYouTubeUrl(req.url) && req.info?.source !== "youtubei") {
    fail("unsupported_url", "Only YouTube, TikTok and Instagram links can be downloaded on this device. Other sites need the desktop app.");
  }
  const [kind, value = ""] = req.formatId.split(":");
  // Guard before any network work: the Android format picker hides these, but never let them through.
  const audioFmt = (kind === "audio" ? value || "m4a" : undefined) as AudioFormat | undefined;
  if (audioFmt === "mp3") formatError(MP3_TEXT, "audio:mp3");
  if (audioFmt && !DIRECT_AUDIO.has(audioFmt)) {
    formatError(`${audioFmt.toUpperCase()} isn't available on this device yet. Choose M4A or WAV.`, `audio:${audioFmt}`);
  }

  const info = req.info?.source === "youtubei" ? req.info : await fetchYouTubeInfo(req.url);
  if (info.kind === "playlist") fail("format_unavailable", "Playlists can be downloaded in the desktop app only.");

  if (kind === "thumb") {
    const filePath = await downloadThumbnail(req, info, emit, signal);
    return { id: req.id, status: "done", downloadedBytes: 0, percent: 100, filePath };
  }

  let resolved: ResolvedStream;
  if (kind === "video") {
    const maxHeight = value === "best" ? undefined : Number(value) || undefined;
    // Android: adaptive video+audio pairs reach every height. Desktop/web keep the single-file path.
    if (platform() === "android") {
      const pair = await resolveAdaptive(info.id, maxHeight);
      if (pair.audio && pair.video.stream.kind === "video-only") {
        return downloadAdaptive(req, info, pair, emit, signal);
      }
      resolved = pair.video;
    } else {
      resolved = await resolveSingleFile(info.id, { kind: "progressive", maxHeight });
    }
  } else {
    resolved = await resolveSingleFile(info.id, { kind: "audio", container: "m4a" });
  }

  // M4A from an audio-only stream is the file as served. WAV, or audio inside a progressive MP4, needs the plugin.
  const needsConvert = audioFmt !== undefined && (audioFmt === "wav" || resolved.stream.kind === "progressive");
  if (needsConvert && platform() !== "android") {
    formatError("Converting audio needs the Keepsake Android or desktop app. Choose M4A.", `audio:${audioFmt}`);
  }
  if (needsConvert && audioFmt === "m4a" && !/^mp4a/i.test(resolved.stream.acodec ?? "")) {
    formatError("This video has no AAC audio to save as M4A. Choose WAV.", `acodec=${resolved.stream.acodec ?? "none"}`);
  }

  const base = safeName(info.title);
  const meter = new Meter(req.id, emit);

  if (!needsConvert) {
    const target = await makeTarget(req, base, audioFmt ?? resolved.ext, true);
    try {
      const total = await fetchStream(resolved.url, resolved.sizeBytes, target.write, meter, signal);
      const filePath = await target.finish();
      return { id: req.id, status: "done", downloadedBytes: total, totalBytes: total, percent: 100, filePath };
    } catch (e) {
      await target.discard();
      throw e;
    }
  }

  // Convert: stream to a temp file in the app cache, then the native plugin writes the final file.
  const format = audioFmt as "wav" | "m4a";
  const cache = await appCacheDir();
  await mkdir(cache, { recursive: true }).catch(() => undefined);
  const tmpPath = await join(cache, `dl-${safeName(req.id, 60)}.${resolved.ext}`);
  const tmp = await fileTarget(tmpPath, true);
  let outPath: string | undefined;
  try {
    const total = await fetchStream(resolved.url, resolved.sizeBytes, tmp.write, meter, signal);
    await tmp.finish();
    if (signal.aborted) fail("cancelled");
    emit({ id: req.id, status: "converting", downloadedBytes: total, totalBytes: total });
    outPath = await uniquePath(await androidOutDir(req), base, format);
    // The native transcode cannot be interrupted; a cancel during it is honoured right after.
    const { path } = await transcodeAudio({ input: tmpPath, output: outPath, format, kbps: req.audioBitrate });
    if (signal.aborted) fail("cancelled");
    return { id: req.id, status: "done", downloadedBytes: total, totalBytes: total, percent: 100, filePath: path };
  } catch (e) {
    if (outPath) await remove(outPath).catch(() => undefined);
    throw e;
  } finally {
    await tmp.discard();
  }
}

// ---------------- Android yt-dlp (TikTok / Instagram) ----------------

/** TikTok/Instagram on Android: one concrete single-file format through the in-process yt-dlp (android-ytdlp.ts). */
async function runAndroidYtdlp(
  req: DownloadRequest,
  emit: Emit,
  signal: AbortSignal,
  opts: { ladder?: boolean } = {},
): Promise<DownloadProgress> {
  const [kind, value = ""] = req.formatId.split(":");
  if (kind === "thumb") {
    formatError("Thumbnails from TikTok and Instagram can be saved in the desktop app only.", req.formatId);
  }
  const audioFmt = kind === "audio" ? value || "m4a" : undefined;
  if (audioFmt === "mp3") formatError(MP3_TEXT, req.formatId);
  if (audioFmt && audioFmt !== "m4a" && audioFmt !== "wav") {
    formatError(`${audioFmt.toUpperCase()} isn't available on Android yet. Choose M4A.`, req.formatId);
  }
  if (signal.aborted) fail("cancelled");
  const info = req.info?.source === "ytdlp" ? req.info : await fetchAndroidInfo(req.url, signal);
  const uiFormatId = audioFmt ? "audio:m4a" : req.formatId;
  const pick = pickYtdlpFormat(info, uiFormatId);
  // TikTok / Instagram: the workaround ladder (the first step is exactly the job below). Never YouTube.
  if (opts.ladder === true && isAndroidYtdlpHost(req.url) && !isYouTubeUrl(req.url)) {
    return runAndroidYtdlpLadder(req, emit, signal, info, pick, audioFmt, uiFormatId);
  }
  if (!pick) formatError("This format isn't available for this link on Android.", req.formatId);

  // Cancel: stop whichever native job is running (video, audio or single).
  const jobIds = [req.id, `${req.id}-v`, `${req.id}-a`];
  const onAbort = () => {
    for (const j of jobIds) void cancelAndroid(j);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await runAndroidYtdlpJob(req, emit, signal, info, pick, audioFmt);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Codes that stop the ladder at once: FINAL_CODES, plus a rate limit (the bridge already waited and retried once;
 * more requests make it worse), a bad link, and a missing bridge (every later step would hit it too).
 */
const LADDER_STOP: ReadonlySet<string> = new Set(["rate_limited", "unsupported_url", "ytdlp_missing"]);
const stopsLadder = (e: unknown, signal: AbortSignal) => signal.aborted || FINAL_CODES.has(codeOf(e)) || LADDER_STOP.has(codeOf(e));
/** Non-watermarked / watermarked concrete alternatives tried at most (no TS retry: the bridge retries each call). */
const LADDER_MAX_CLEAN = 3;
const LADDER_MAX_MARKED = 1;
const LADDER_NOTE = "The chosen version failed, so Keepsake saved the next best one.";

/** State shared by the ladder's attempts: native jobs running now (cancel targets) and concrete picks already tried. */
interface LadderState {
  active: Set<string>;
  tried: Set<string>;
  /** Extra TS attempts per native download, network / timeout only (default 1; the bridge already retried). */
  retries?: number;
  /** Clear the attempt's temp folder before use (a leftover would count as "already downloaded"). */
  fresh?: boolean;
}

/**
 * TikTok / Instagram workaround ladder, used only after the primary attempt fails with a non-final error:
 *   1. the normal pick (runAndroidYtdlpJob, unchanged: same payloads, same built-in fallback);
 *   2. the next best concrete non-watermarked alternatives (progressive at or below the height, then pairs the native
 *      muxer accepts), at most LADDER_MAX_CLEAN, no TS retry;
 *   3. when the self-contained runtime reports ready: the full yt-dlp route (selection args + bundled ffmpeg), which
 *      handles HLS/DASH-only posts and codecs the phone cannot mux;
 *   2b. a watermarked version (better than nothing);
 *   4. the primary error, with what was tried in its detail.
 * Cancel, no_space, permission, too_large, not_found, login_required, rate_limited and unsupported_url stop it.
 */
async function runAndroidYtdlpLadder(
  req: DownloadRequest,
  emit: Emit,
  signal: AbortSignal,
  info: VideoInfo,
  pick: YtdlpPick | null,
  audioFmt: string | undefined,
  uiFormatId: string,
): Promise<DownloadProgress> {
  const active = new Set<string>();
  const tried = new Set<string>();
  // Cancel only the native jobs that are running: a cancel flag for an id that never runs would stay behind in the
  // bridge and cancel the next job with that id (a Retry reuses the request id).
  const onAbort = () => {
    for (const j of active) void cancelAndroid(j);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    let first: unknown;
    if (pick) {
      try {
        return await runAndroidYtdlpJob(req, emit, signal, info, pick, audioFmt, { active, tried });
      } catch (e) {
        if (stopsLadder(e, signal)) throw e;
        first = e;
      }
    } else {
      const streamOnly = hiddenStreams(info).some((s) => s.kind !== "audio-only");
      first = new EngineError({
        code: "format_unavailable",
        message: streamOnly
          ? "This post is only offered as a stream that Keepsake's built-in downloader must merge, and it isn't working on this phone. Reinstall Keepsake or use the desktop app."
          : "This format isn't available for this link on Android.",
        detail: req.formatId,
        cookiesHint: false,
      });
    }
    const steps: string[] = [];
    const alts = ytdlpAlternatives(info, uiFormatId, pick);
    // Cap: once an alternative also fails with network / timeout (after the bridge's own 3 attempts), the connection is
    // the problem, not the format: skip the remaining steps instead of up to 5 more 3-attempt bridge calls.
    let offline = false;
    const noteOffline = (e: unknown) => {
      if (TIKTOK_IG_TS_RETRY.has(codeOf(e))) offline = true;
    };
    const tryPicks = async (picks: YtdlpPick[], max: number): Promise<DownloadProgress | undefined> => {
      let n = 0;
      for (const p of picks) {
        if (n >= max || offline) break;
        if (tried.has(ytdlpPickKey(p))) continue;
        n++;
        if (signal.aborted) fail("cancelled");
        steps.push(ytdlpPickKey(p));
        try {
          const res = await runAndroidYtdlpJob(req, emit, signal, info, p, audioFmt, { active, tried, retries: 0, fresh: true });
          return { ...res, note: LADDER_NOTE };
        } catch (e) {
          if (stopsLadder(e, signal)) throw e;
          noteOffline(e);
        }
      }
      return undefined;
    };

    const clean = await tryPicks(alts.clean, LADDER_MAX_CLEAN);
    if (clean) return clean;

    if (signal.aborted) fail("cancelled");
    if (!offline && (await androidYtdlpReady())) {
      if (signal.aborted) fail("cancelled");
      steps.push("full");
      try {
        const res = await runAndroidYtdlpFull(req, emit, signal, info, { retries: 0 });
        return { ...res, note: LADDER_NOTE };
      } catch (e) {
        // Here ytdlp_missing means the bundled ffmpeg broke: the legacy bridge still works, so go on to step 2b.
        if (stopsLadder(e, signal) && codeOf(e) !== "ytdlp_missing") throw e;
        noteOffline(e);
      }
    }

    const marked = await tryPicks(alts.watermarked, LADDER_MAX_MARKED);
    if (marked) return marked;

    if (signal.aborted) fail("cancelled");
    const err = toAppError(first);
    const tail = steps.length > 0 ? `also tried ${steps.join(", ")}` : "no other version to try";
    throw new EngineError({ ...err, detail: err.detail ? `${err.detail}; ${tail}` : tail });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function permissionError(detail: string): EngineError {
  return new EngineError({ code: "permission", message: PERMISSION_TEXT, detail, cookiesHint: false });
}

/** Output folder for yt-dlp downloads: the Settings folder, or a permission error when the platform rejects it. */
async function ytdlpOutDir(req: DownloadRequest): Promise<string> {
  const dir = req.outputDir?.trim() || (await downloadDir());
  if (!dir.startsWith("/")) throw permissionError(`not an absolute path: ${dir}`);
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    throw permissionError(e instanceof Error ? e.message : String(e));
  }
  return dir.replace(/[\\/]+$/, "");
}

const codeOf = (e: unknown) => toAppError(e).code as string;

/**
 * File base name for ytdlp_download. Rust rejects a fileName starting with "." and yt-dlp adds ".<ext>.part": keep
 * the base short (code points, so no half surrogate pair; 50 x 4 UTF-8 bytes stays under the 255-byte name limit)
 * and free of leading dots. TikTok titles are whole captions.
 */
const ytdlpBaseName = (title: string) =>
  Array.from(safeName(title)).slice(0, 50).join("").replace(/^[.\s]+/, "").trim() || "download";
const nameFor = (target: string, ext: string) => target.slice(target.lastIndexOf("/") + 1, target.length - (ext.length + 1));

async function runAndroidYtdlpJob(
  req: DownloadRequest,
  emit: Emit,
  signal: AbortSignal,
  info: VideoInfo,
  pick: NonNullable<ReturnType<typeof pickYtdlpFormat>>,
  audioFmt: string | undefined,
  lad?: LadderState,
): Promise<DownloadProgress> {
  // `lad` (TikTok / Instagram ladder only): track running jobs and tried picks, reject empty files. The invoke payloads
  // are the same with or without it.
  const dl = (formatId: string, outDir: string, fileName: string | undefined, suffix = "") => {
    const jobId = `${req.id}${suffix}`;
    const once = () => downloadAndroid({ url: info.url, formatId, outDir, fileName, jobId });
    const state = lad;
    if (!state) return runWithRetry(once, { signal, retries: 2, delays: [2000, 6000] });
    const tracked = async () => {
      state.active.add(jobId);
      try {
        const r = await once();
        if (!(r.bytes > 0)) {
          await remove(r.path).catch(() => undefined);
          throw new EngineError(mapYtdlpError(`ytdlp:empty: ${formatId} came back empty`));
        }
        return r;
      } finally {
        state.active.delete(jobId);
      }
    };
    // Ladder (TikTok / Instagram): the Python bridge already retried, so at most one more TS attempt, network /
    // timeout only. Without `lad` (legacy YouTube route): unchanged (above).
    return runWithRetry(tracked, { signal, retries: state.retries ?? 1, delays: [2000], codes: TIKTOK_IG_TS_RETRY });
  };
  /** Ladder only: start from an empty temp folder (an earlier attempt's leftover would be taken as done). */
  const freshDir = async (tmpDir: string) => {
    if (lad?.fresh) await remove(tmpDir, { recursive: true }).catch(() => undefined);
  };
  // Fail early on a bad folder, before any download starts.
  const dir = await ytdlpOutDir(req);
  // No byte progress from the native side: indeterminate bar. `stage` is read by the UI when DownloadProgress has it.
  const emitStage = (status: DownloadProgress["status"], stage: "video" | "audio" | "mux" | undefined, downloadedBytes = 0) => {
    const p: DownloadProgress & { stage?: string } = { id: req.id, status, downloadedBytes, stage };
    emit(p);
  };
  emitStage("downloading", audioFmt ? "audio" : "video");
  const base = ytdlpBaseName(info.title);

  const done = (path: string, bytes: number): DownloadProgress => ({
    id: req.id,
    status: "done",
    downloadedBytes: bytes,
    totalBytes: bytes,
    percent: 100,
    filePath: path,
  });

  // Audio that needs the native transcode (WAV, or M4A out of a muxed MP4): download to the app cache first.
  const needsConvert = audioFmt === "wav" || (audioFmt === "m4a" && pick.needsRemux);
  if (needsConvert) {
    const format = audioFmt as "wav" | "m4a";
    const cache = await appCacheDir();
    const tmpDir = await join(cache, `ytdlp-${safeName(req.id, 60)}`);
    let outPath: string | undefined;
    try {
      lad?.tried.add(ytdlpPickKey({ formatId: pick.formatId }));
      await freshDir(tmpDir);
      await mkdir(tmpDir, { recursive: true });
      const { path, bytes } = await dl(pick.formatId, tmpDir, "source");
      if (signal.aborted) fail("cancelled");
      emitStage("converting", "audio", bytes);
      outPath = await uniquePath(dir, base, format);
      const res = await transcodeAudio({ input: path, output: outPath, format });
      if (signal.aborted) fail("cancelled");
      return done(res.path, bytes);
    } catch (e) {
      if (outPath) await remove(outPath).catch(() => undefined);
      throw e;
    } finally {
      await remove(tmpDir, { recursive: true }).catch(() => undefined);
    }
  }

  /** One ytdlp_download of a single-file format straight into the chosen folder. */
  const single = async (formatId: string, ext: string) => {
    lad?.tried.add(ytdlpPickKey({ formatId }));
    const target = await uniquePath(dir, base, ext);
    const { path, bytes } = await dl(formatId, dir, nameFor(target, ext));
    if (signal.aborted) {
      await remove(path).catch(() => undefined);
      fail("cancelled");
    }
    return done(path, bytes);
  };

  /** Single-file attempt; on format_unavailable retry once with the best muxed format of the same info. */
  const singleWithFallback = async (formatId: string, ext: string) => {
    try {
      return await single(formatId, ext);
    } catch (e) {
      if (codeOf(e) === "format_unavailable" && pick.fallback && pick.fallback.formatId !== formatId && !signal.aborted) {
        return single(pick.fallback.formatId, pick.fallback.ext);
      }
      throw e;
    }
  };

  if (!pick.audioFormatId) return singleWithFallback(pick.formatId, pick.ext);

  // Video-only pick: download video, then audio (one after the other), mux, delete the temporary files.
  const cache = await appCacheDir();
  const tmpDir = await join(cache, `ytdlp-${safeName(req.id, 60)}`);
  let outPath: string | undefined;
  try {
    lad?.tried.add(ytdlpPickKey(pick));
    await freshDir(tmpDir);
    await mkdir(tmpDir, { recursive: true });
    emitStage("downloading", "video");
    const video = await dl(pick.formatId, tmpDir, "video", "-v");
    if (signal.aborted) fail("cancelled");
    emitStage("downloading", "audio", video.bytes);
    const audio = await dl(pick.audioFormatId, tmpDir, "audio", "-a");
    if (signal.aborted) fail("cancelled");
    emitStage("converting", "mux", video.bytes + audio.bytes);
    // The native muxer picks the container from the codecs (MP4 or WebM); the pick says which (muxExt), so the
    // collision check below runs on the real output name.
    const ext = pick.muxExt ?? (pick.ext === "webm" ? "webm" : "mp4");
    const target = await uniquePath(dir, base, ext);
    outPath = target;
    const res = await muxAndroid({ videoPath: video.path, audioPath: audio.path, outDir: dir, fileName: nameFor(target, ext) });
    outPath = res.path;
    if (signal.aborted) fail("cancelled");
    return done(res.path, res.bytes || video.bytes + audio.bytes);
  } catch (e) {
    if (outPath) await remove(outPath).catch(() => undefined);
    if (["format_unavailable", "mux_failed"].includes(codeOf(e)) && pick.fallback && !signal.aborted) {
      return single(pick.fallback.formatId, pick.fallback.ext);
    }
    throw e;
  } finally {
    await remove(tmpDir, { recursive: true }).catch(() => undefined);
  }
}

// ---------------- Android yt-dlp, self-contained route (YouTube) ----------------

/** Errors any route would hit again: the full route never falls back on these (plan 11 section 8). */
const FINAL_CODES: ReadonlySet<string> = new Set(["cancelled", "no_space", "permission", "too_large", "not_found", "login_required"]);

/** Every extension the full route can leave under the chosen name (merge mp4/mkv, unmerged webm, M4A). */
const FULL_EXTS = ["mp4", "mkv", "webm", "m4a"] as const;

/**
 * First `base`, `base (1)`, ... for which no `<name>.<ext>` exists in `dir` for any of `exts`. The final extension
 * is only known after yt-dlp merges (mp4 or mkv), and the bridge runs with overwrites off, so an existing file of any
 * of them would be taken as "already downloaded".
 */
async function uniqueBase(dir: string, base: string, exts: readonly string[]): Promise<string> {
  for (let i = 0; i < 1000; i++) {
    const name = `${base}${i ? ` (${i})` : ""}`;
    let free = true;
    for (const ext of exts) {
      if (await exists(await join(dir, `${name}.${ext}`))) {
        free = false;
        break;
      }
    }
    if (free) return name;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Android YouTube through the self-contained yt-dlp (bundled QuickJS + ffmpeg, info.ytdlpFull): one ytdlp_download
 * with the desktop selectors (selectionArgs, android variant). yt-dlp picks, downloads and merges, and returns the
 * final path (.mp4, or .mkv when the streams do not fit MP4). M4A: the same selectors as desktop. WAV: M4A into the
 * app cache, then the native transcode. No byte progress from the native side (indeterminate bar, stage only).
 */
async function runAndroidYtdlpFull(
  req: DownloadRequest,
  emit: Emit,
  signal: AbortSignal,
  info: VideoInfo,
  /** TikTok / Instagram ladder step 3 only (retries 0: the bridge already retries). YouTube omits it: unchanged. */
  opts: { retries?: number } = {},
): Promise<DownloadProgress> {
  const [kind, value = ""] = req.formatId.split(":");
  if (kind !== "video" && kind !== "audio") formatError("This format isn't available for this link on Android.", req.formatId);
  const audioFmt = kind === "audio" ? value || "m4a" : undefined;
  if (audioFmt === "mp3") formatError(MP3_TEXT, req.formatId);
  if (audioFmt && audioFmt !== "m4a" && audioFmt !== "wav") {
    formatError(`${audioFmt.toUpperCase()} isn't available on Android yet. Choose M4A.`, req.formatId);
  }
  if (signal.aborted) fail("cancelled");
  // WAV is an M4A download plus the native transcode, so yt-dlp always gets the M4A selectors for audio.
  const args = selectionArgs({ ...req, info, formatId: audioFmt ? "audio:m4a" : req.formatId }, { platform: "android" });

  const onAbort = () => void cancelAndroid(req.id);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const dl = (outDir: string, fileName: string) =>
      runWithRetry(() => downloadAndroid({ url: info.url, args, full: true, outDir, fileName, jobId: req.id }), {
        signal,
        retries: opts.retries ?? 2,
        delays: [2000, 6000],
      });
    const dir = await ytdlpOutDir(req);
    const emitStage = (status: DownloadProgress["status"], stage: "video" | "audio", downloadedBytes = 0) =>
      emit({ id: req.id, status, downloadedBytes, stage });
    const base = ytdlpBaseName(info.title);
    const done = (path: string, bytes: number): DownloadProgress => ({
      id: req.id,
      status: "done",
      downloadedBytes: bytes,
      totalBytes: bytes,
      percent: 100,
      filePath: path,
    });

    if (audioFmt !== "wav") {
      emitStage("downloading", audioFmt ? "audio" : "video");
      const name = await uniqueBase(dir, base, FULL_EXTS);
      const { path, bytes } = await dl(dir, name);
      if (signal.aborted) {
        await remove(path).catch(() => undefined);
        fail("cancelled");
      }
      if (isFormatPart(path, name)) {
        // Defence in depth (the bridge already rejects this): an unmerged video-only/audio-only part is not a result.
        await remove(path).catch(() => undefined);
        fail("ffmpeg_missing", "yt-dlp did not merge video and audio.");
      }
      return done(path, bytes);
    }

    const tmpDir = await join(await appCacheDir(), `ytdlp-${safeName(req.id, 60)}`);
    let outPath: string | undefined;
    try {
      // A leftover from an earlier attempt would be taken as already downloaded (overwrites off): start clean.
      await remove(tmpDir, { recursive: true }).catch(() => undefined);
      await mkdir(tmpDir, { recursive: true });
      emitStage("downloading", "audio");
      const { path, bytes } = await dl(tmpDir, "source");
      if (signal.aborted) fail("cancelled");
      emitStage("converting", "audio", bytes);
      outPath = await uniquePath(dir, base, "wav");
      const res = await transcodeAudio({ input: path, output: outPath, format: "wav" });
      if (signal.aborted) fail("cancelled");
      return done(res.path, bytes);
    } catch (e) {
      if (outPath) await remove(outPath).catch(() => undefined);
      throw e;
    } finally {
      await remove(tmpDir, { recursive: true }).catch(() => undefined);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

// ---------------- Android gallery / folder staging ----------------

const EXT_KIND: Record<string, "video" | "audio" | "image"> = {
  mp4: "video",
  webm: "video",
  mkv: "video",
  m4a: "audio",
  mp3: "audio",
  opus: "audio",
  wav: "audio",
  flac: "audio",
  jpg: "image",
  png: "image",
  webp: "image",
};

/** True when `p` is `dir` or a path under it (either separator). */
const normPath = (s: string) => s.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
const isInside = (p: string, dir: string) => {
  const a = normPath(p);
  const b = normPath(dir);
  return a === b || a.startsWith(`${b}/`);
};

/** Routes a request on Android (yt-dlp or direct); desktop never reaches here. */
const routeRequest = (r: DownloadRequest, em: Emit, signal: AbortSignal): Promise<DownloadProgress> => {
  if (platform() === "android" && r.info?.source === "ytdlp" && r.info.ytdlpFull === true) {
    // The full route is YouTube only. Full info for any other link is dropped so the legacy route re-fetches its own.
    if (!isYouTubeUrl(r.url)) return runAndroidYtdlp({ ...r, info: undefined }, em, signal, { ladder: true });
    // Any non-final failure goes to youtubei.js once, with fresh info (the full info lists formats it cannot use).
    return runAndroidYtdlpFull(r, em, signal, r.info).catch((e: unknown) => {
      if (signal.aborted || FINAL_CODES.has(codeOf(e))) throw e;
      return runDirect({ ...r, info: undefined }, em, signal);
    });
  }
  // TikTok / Instagram: workaround ladder after a failed first try (runAndroidYtdlp re-checks the host, never YouTube).
  if (platform() === "android" && isAndroidYtdlpSupported(r.url)) return runAndroidYtdlp(r, em, signal, { ladder: true });
  if (platform() === "android" && r.info?.source === "ytdlp") {
    // Info came from the (currently disabled) yt-dlp route: if its download fails, retry through youtubei.js.
    return runAndroidYtdlp(r, em, signal).catch((e: unknown) => {
      if (signal.aborted || !isYouTubeUrl(r.url)) throw e;
      return runDirect({ ...r, info: undefined }, em, signal);
    });
  }
  return runDirect(r, em, signal);
};


/**
 * Android gallery/folder modes: every step writes into $APPCACHE/gallery-<id>, then the final file is published
 * (MediaStore or SAF tree) and the content URI becomes filePath. The staging dir is removed after success.
 */
async function runStaged(
  req: DownloadRequest,
  mode: "gallery" | "folder",
  emit: Emit,
  route: (r: DownloadRequest, em: Emit) => Promise<DownloadProgress>,
): Promise<DownloadProgress> {
  // Unique per attempt: retry reuses the job id, and an earlier failed attempt may have left its file in its own stage.
  const attempt = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const stage = await join(await appCacheDir(), `gallery-${safeName(req.id, 60)}-${attempt}`);
  await mkdir(stage, { recursive: true });
  // The thumbnail path emits its own "done" with the staged path; the real final progress is emitted by startDownload.
  const stagedEmit: Emit = (p) => {
    if (p.status !== "done") emit(p);
  };
  let keepStage = false;
  try {
    const res = await route({ ...req, outputDir: stage }, stagedEmit);
    const src = res.filePath;
    if (!src || res.status !== "done") return res;
    const fileName = src.slice(Math.max(src.lastIndexOf("/"), src.lastIndexOf("\\")) + 1);
    const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    const kind = EXT_KIND[ext] ?? "video";
    try {
      const out =
        mode === "folder"
          ? await saveToFolder({ src, treeUri: req.outputTreeUri ?? "", fileName, mime })
          : await publishToGallery({ src, kind, fileName, mime });
      return { ...res, filePath: out.uri };
    } catch (e) {
      // Folder mode: the plugin deletes src only on success, so on any failure the file is still in staging.
      if (e instanceof FolderError) {
        keepStage = true;
        throw e;
      }
      if (!(e instanceof GalleryError)) {
        keepStage = true;
        throw e;
      }
      // The file is safe only when the plugin moved it to an absolute path outside the staging dir.
      // Anything else ("staging (could not move the file)", a path inside staging, none) leaves it in staging.
      const kept = e.keptPath?.trim();
      const keptSafe = kept !== undefined && kept.startsWith("/") && !isInside(kept, stage);
      if (!keptSafe) keepStage = true;
      if (keptSafe && kept !== undefined && e.galleryCode === "permission") {
        // Storage permission denied: the file is in the kept folder; report it as done with a notice.
        const notice = `Storage permission was denied, so the file was saved to ${kept} instead of the Gallery.`;
        return { ...res, filePath: kept, notice };
      }
      const where = keptSafe ? `file kept at ${kept}` : `file left at ${src}`;
      throw new EngineError({
        code: e.galleryCode === "no_space" ? "no_space" : e.galleryCode === "permission" ? "gallery_permission" : "gallery_failed",
        message: e.message || "The download finished but could not be saved to your Gallery.",
        detail: e.detail ? `${e.detail} (${where})` : `(${where})`,
        cookiesHint: false,
      });
    }
  } finally {
    if (!keepStage) await remove(stage, { recursive: true }).catch(() => undefined);
  }
}

// ---------------- public ----------------

async function resolveOutDir(req: DownloadRequest): Promise<string> {
  const dir = req.outputDir?.trim() || (await downloadDir());
  // Absolute: "C:\..." / "\\server\..." on Windows, "/..." on Linux.
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(dir)) fail("bad_folder", `Can't save to ${dir}. Choose another folder in Settings.`);
  return dir;
}

/**
 * Start a download now (queueing/parallel limits are the caller's job). `onProgress` gets every update,
 * including the final one. `handle.done` resolves with the final progress and never rejects.
 */
export function startDownload(req: DownloadRequest, onProgress: (p: DownloadProgress) => void): DownloadHandle {
  const ctrl = new AbortController();
  let cancelled = false;
  const emit: Emit = (p) => {
    if (!cancelled) onProgress(p);
  };
  onProgress({ id: req.id, status: "queued", downloadedBytes: 0 });

  const run = async (): Promise<DownloadProgress> => {
    if (!req.url.trim()) fail("empty_url");
    if (isDesktop()) {
      const outDir = await resolveOutDir(req);
      // Cancel race: cancel() may run while resolveOutDir awaits, before run_ytdlp registers the job.
      // runYtdlp checks the flag before invoking and re-sends cancel_ytdlp right after start.
      if (cancelled) fail("cancelled");
      return downloadYtdlp(req, outDir, emit, () => cancelled);
    }
    if (platform() === "web" && !isYouTubeUrl(req.url)) fail("web_cors");
    if (platform() === "android") {
      const mode = androidSaveMode({ saveDir: req.outputDir ?? "", saveTreeUri: req.outputTreeUri ?? "" });
      if (mode === "gallery" || mode === "folder") {
        return runStaged(req, mode, emit, (r: DownloadRequest, em: Emit) => routeRequest(r, em, ctrl.signal));
      }
    }
    return routeRequest(req, emit, ctrl.signal);
  };

  const done = run()
    .catch((e: unknown): DownloadProgress => {
      if (cancelled) return { id: req.id, status: "cancelled", downloadedBytes: 0, error: appError("cancelled") };
      const err = toAppError(e);
      return { id: req.id, status: err.code === "cancelled" ? "cancelled" : "failed", downloadedBytes: 0, error: err };
    })
    .then((final) => {
      const f = cancelled ? { ...final, status: "cancelled" as const, error: appError("cancelled") } : final;
      onProgress(f);
      return f;
    });

  return {
    id: req.id,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      ctrl.abort();
      if (isDesktop()) void cancelYtdlp(req.id).catch(() => undefined);
    },
    done,
  };
}
