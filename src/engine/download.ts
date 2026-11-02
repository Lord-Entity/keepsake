/**
 * startDownload for every platform.
 * - Desktop (windows/linux): yt-dlp sidecar via `run_ytdlp` (ytdlp.ts, CONTRACT.md).
 * - Android: youtubei.js single-file stream -> 10 MB Range requests through plugin-http -> plugin-fs FileHandle,
 *   streamed to disk (never the whole file in memory). M4A from an audio-only stream is saved as-is; WAV, and M4A
 *   taken from a progressive MP4, go to a temp file in the app cache and through the native keepsake-media plugin
 *   (android-media.ts). MP3/FLAC/Opus are not available on Android yet and are rejected here.
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
import { transcodeAudio } from "./android-media";
import { appError, EngineError, fail, toAppError } from "./errors";
import { httpFetch, timeoutSignal } from "./http";
import { isDesktop, platform } from "./platform";
import { resolveSingleFile, fetchYouTubeInfo, isYouTubeUrl } from "./youtube";
import { cancelYtdlp, downloadYtdlp } from "./ytdlp";

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

/**
 * The server must answer a Range request with 206 starting at `start`. A 200 carries the body from byte 0, so
 * writing it at `start` would corrupt the file: fail instead. A 200 is accepted only when the range asked for
 * was the whole file. Not retryable (error code "unknown").
 */
function checkRange(res: Response, start: number, end: number, size: number) {
  const bad = (detail: string): never => {
    throw new EngineError({
      code: "unknown",
      message: "The video server sent the wrong part of the file, so the download was stopped. Try again later.",
      detail,
      cookiesHint: false,
    });
  };
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
  const cands = [...info.thumbnails]
    .sort((a, b) => Number(/\.webp/i.test(a.url)) - Number(/\.webp/i.test(b.url)))
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

async function runDirect(req: DownloadRequest, emit: Emit, signal: AbortSignal): Promise<DownloadProgress> {
  if (!isYouTubeUrl(req.url) && req.info?.source !== "youtubei") {
    fail("unsupported_url", "Only YouTube links can be downloaded on this device. Other sites need the desktop app.");
  }
  const [kind, value = ""] = req.formatId.split(":");
  // Guard before any network work: the Android format picker hides these, but never let them through.
  const audioFmt = (kind === "audio" ? value || "m4a" : undefined) as AudioFormat | undefined;
  if (audioFmt && !DIRECT_AUDIO.has(audioFmt)) {
    formatError(`${audioFmt.toUpperCase()} isn't available on this device yet. Choose M4A or WAV.`, `audio:${audioFmt}`);
  }

  const info = req.info?.source === "youtubei" ? req.info : await fetchYouTubeInfo(req.url);
  if (info.kind === "playlist") fail("format_unavailable", "Playlists can be downloaded in the desktop app only.");

  if (kind === "thumb") {
    const filePath = await downloadThumbnail(req, info, emit, signal);
    return { id: req.id, status: "done", downloadedBytes: 0, percent: 100, filePath };
  }

  const resolved =
    kind === "video"
      ? await resolveSingleFile(info.id, { kind: "progressive", maxHeight: value === "best" ? undefined : Number(value) || undefined })
      : await resolveSingleFile(info.id, { kind: "audio", container: "m4a" });

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
    return runDirect(req, emit, ctrl.signal);
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
