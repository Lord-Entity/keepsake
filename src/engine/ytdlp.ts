/**
 * Desktop path (Windows/Linux): yt-dlp sidecar driven through Tauri commands that the PLATFORM agent provides.
 * Argument contract: src/engine/CONTRACT.md. TypeScript builds every yt-dlp argument except
 * `--ffmpeg-location`, which Rust prepends because only Rust knows the sidecar folder.
 *
 * VERIFIED (node_modules/@tauri-apps/api/core.d.ts 2.12.4): `invoke<T>(cmd, args?)`, `class Channel<T>` with `onmessage`.
 * yt-dlp flags used below are from the yt-dlp README (options --progress-template, --print WHEN:TEMPLATE,
 * -P TYPES:PATH, --trim-filenames, --js-runtimes, --cookies-from-browser, --convert-thumbnails). INFERRED: not run here.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { AppError, DownloadProgress, DownloadRequest, StreamInfo, Thumbnail, VideoInfo } from "../lib/types";
import { appError, EngineError, fail, friendlyError, toAppError } from "./errors";

export type YtdlpEvent = { event: "stdout"; line: string } | { event: "stderr"; line: string };

export interface RunResult {
  code: number;
  stdout: string[];
  stderr: string[];
}

/**
 * Run yt-dlp once. `onLine` sees every line from both streams.
 * Cancel race: a `cancel_ytdlp` sent before Rust registers the job is a no-op. So we check `isCancelled`
 * before invoking, and re-send the cancel when the first line arrives (Rust registers the PID before any
 * output can be read) and once more shortly after start for a process that prints nothing.
 */
export async function runYtdlp(
  jobId: string,
  args: string[],
  onLine?: (line: string, stream: "stdout" | "stderr") => void,
  tempDir?: string,
  isCancelled?: () => boolean,
): Promise<RunResult> {
  if (isCancelled?.()) fail("cancelled");
  const stdout: string[] = [];
  const stderr: string[] = [];
  let resentOnLine = false;
  const resendCancel = () => {
    if (isCancelled?.()) void cancelYtdlp(jobId).catch(() => undefined);
  };
  const ch = new Channel<YtdlpEvent>();
  ch.onmessage = (m) => {
    if (!resentOnLine && isCancelled?.()) {
      resentOnLine = true;
      resendCancel();
    }
    (m.event === "stdout" ? stdout : stderr).push(m.line);
    onLine?.(m.line, m.event);
  };
  const timer = isCancelled ? setTimeout(resendCancel, 500) : undefined;
  let code: number;
  try {
    code = await invoke<number>("run_ytdlp", { jobId, args, tempDir: tempDir ?? null, onEvent: ch });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("js_runtime_missing")) fail("js_runtime_missing");
    if (/not found|no such file|missing/i.test(msg) && /yt-dlp|sidecar/i.test(msg)) fail("ytdlp_missing", msg);
    throw new EngineError(friendlyError(msg));
  } finally {
    clearTimeout(timer);
  }
  return { code, stdout, stderr };
}

export function cancelYtdlp(jobId: string): Promise<void> {
  return invoke<void>("cancel_ytdlp", { jobId });
}

export function binaryVersions(): Promise<{ ytdlp: string | null; ffmpeg: string | null; node?: string | null }> {
  return invoke("binary_status");
}

// ---------------- cookie fallback ----------------

/** Retry order when YouTube shows its bot check and Settings > Cookies is "off" (yt-dlp browser names). */
export const COOKIE_FALLBACK_ORDER = ["edge", "chrome", "firefox", "brave", "chromium", "opera", "vivaldi"] as const;

const BROWSER_LABEL: Record<string, string> = {
  edge: "Edge",
  chrome: "Chrome",
  firefox: "Firefox",
  brave: "Brave",
  chromium: "Chromium",
  opera: "Opera",
  vivaldi: "Vivaldi",
};

let installedPromise: Promise<string[]> | undefined;

/** Fallback browsers whose profile folder exists, in COOKIE_FALLBACK_ORDER. Cached after the first success. */
async function fallbackBrowsers(): Promise<string[]> {
  installedPromise ??= invoke<string[]>("list_installed_browsers").catch((): string[] => {
    installedPromise = undefined;
    return [];
  });
  const have = new Set(await installedPromise);
  return COOKIE_FALLBACK_ORDER.filter((b) => have.has(b));
}

/** Only fall back when the user has not picked a browser themselves. */
function wantsFallback(cookiesBrowser?: string): boolean {
  return !cookiesBrowser || cookiesBrowser === "off";
}

function triedDetail(err: AppError, tried: string[]): AppError {
  if (tried.length === 0) return err;
  const note = `Also tried cookies from ${tried.map((b) => BROWSER_LABEL[b] ?? b).join(", ")}.`;
  return { ...err, detail: err.detail ? `${err.detail} ${note}` : note, cookiesHint: true };
}

/** Errors that end the fallback loop at once (no point trying another browser). */
function isFinal(code: AppError["code"]): boolean {
  return code === "cancelled" || code === "js_runtime_missing" || code === "ytdlp_missing";
}

function assertHttpUrl(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    fail("unsupported_url", url);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") fail("unsupported_url", url);
}

/** Fixed args on every call (PLAN_v2 section B). The URL always goes last, after `--`. */
function baseArgs(cookiesBrowser?: string): string[] {
  // Rust already prepends `--ignore-config --no-plugin-dirs --no-js-runtimes --js-runtimes <runtime>:<path>` and
  // `--ffmpeg-location` (ytdlp.rs): the bundled QuickJS (qjs) when present, else a user-installed node.
  const a = ["--encoding", "utf-8", "--no-warnings"];
  if (cookiesBrowser && cookiesBrowser !== "off") a.push("--cookies-from-browser", cookiesBrowser);
  return a;
}

function lastError(lines: string[]): string {
  const errs = lines.filter((l) => l.includes("ERROR:"));
  return errs[errs.length - 1] ?? lines[lines.length - 1] ?? "yt-dlp failed";
}

// ---------------- fetch info (-J) ----------------

interface YdlFormat {
  format_id: string;
  ext?: string;
  vcodec?: string;
  acodec?: string;
  height?: number | null;
  fps?: number | null;
  tbr?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  format_note?: string;
}
interface YdlInfo {
  _type?: string;
  id: string;
  title?: string;
  webpage_url?: string;
  extractor_key?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  view_count?: number;
  upload_date?: string;
  description?: string;
  thumbnail?: string;
  thumbnails?: { url: string; width?: number; height?: number; preference?: number }[];
  formats?: YdlFormat[];
  playlist_count?: number;
  entries?: unknown[];
}

function mapYdlInfo(j: YdlInfo, url: string): VideoInfo {
  const streams: StreamInfo[] = (j.formats ?? [])
    .filter((f) => !(f.vcodec === "none" && f.acodec === "none"))
    .map((f) => ({
      id: f.format_id,
      kind:
        f.vcodec === "none" ? "audio-only" : f.acodec === "none" ? "video-only" : ("progressive" as const),
      ext: f.ext ?? "bin",
      height: f.height ?? undefined,
      fps: f.fps ?? undefined,
      vcodec: f.vcodec && f.vcodec !== "none" ? f.vcodec : undefined,
      acodec: f.acodec && f.acodec !== "none" ? f.acodec : undefined,
      bitrate: f.tbr ? Math.round(f.tbr * 1000) : undefined,
      sizeBytes: f.filesize ?? f.filesize_approx ?? undefined,
    }));
  const fpsByHeight: Record<number, number> = {};
  for (const s of streams) {
    if (s.height && s.kind !== "audio-only") fpsByHeight[s.height] = Math.max(fpsByHeight[s.height] ?? 0, s.fps ?? 0);
  }
  const heights = Object.keys(fpsByHeight)
    .map(Number)
    .sort((a, b) => b - a);
  const isPlaylist = j._type === "playlist";
  const hasVideo = isPlaylist || streams.length === 0 || streams.some((s) => s.kind !== "audio-only");
  const thumbs: Thumbnail[] = [...(j.thumbnails ?? [])]
    .sort((a, b) => (b.preference ?? 0) - (a.preference ?? 0) || (b.width ?? 0) - (a.width ?? 0))
    .map((t) => ({ url: t.url, width: t.width, height: t.height }));
  if (thumbs.length === 0 && j.thumbnail) thumbs.push({ url: j.thumbnail });
  const d = j.upload_date;
  return {
    id: j.id,
    url: j.webpage_url ?? url,
    site: (j.extractor_key ?? "generic").toLowerCase(),
    kind: isPlaylist ? "playlist" : hasVideo ? "video" : "audio",
    title: j.title ?? "Untitled",
    channel: j.channel ?? j.uploader,
    durationSec: j.duration,
    viewCount: j.view_count,
    uploadDate: d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : undefined,
    description: j.description?.split("\n").find((l) => l.trim()),
    thumbnails: thumbs,
    hasVideo,
    heights,
    fpsByHeight,
    streams,
    previewOnly: streams.length > 0 && streams.every((s) => /preview/i.test(s.id)),
    playlistCount: isPlaylist ? (j.playlist_count ?? j.entries?.length) : undefined,
    source: "ytdlp",
  };
}

type InfoOpts = { cookiesBrowser?: string; signal?: AbortSignal };

/**
 * `yt-dlp -J -i --flat-playlist -- URL`. On a bot check with Settings > Cookies "off", retries once per
 * installed browser (COOKIE_FALLBACK_ORDER) with `--cookies-from-browser` and stops at the first success.
 */
export async function fetchInfoYtdlp(url: string, opts: InfoOpts = {}): Promise<VideoInfo> {
  try {
    return await fetchInfoOnce(url, opts);
  } catch (e) {
    const first = toAppError(e);
    if (first.code !== "bot_check" || !wantsFallback(opts.cookiesBrowser)) throw e;
    const tried: string[] = [];
    for (const b of await fallbackBrowsers()) {
      if (opts.signal?.aborted) fail("cancelled");
      tried.push(b);
      try {
        return await fetchInfoOnce(url, { ...opts, cookiesBrowser: b });
      } catch (e2) {
        if (opts.signal?.aborted) fail("cancelled");
        if (isFinal(toAppError(e2).code)) throw e2;
      }
    }
    throw new EngineError(triedDetail(first, tried));
  }
}

async function fetchInfoOnce(url: string, opts: InfoOpts): Promise<VideoInfo> {
  assertHttpUrl(url);
  const jobId = `info-${crypto.randomUUID()}`;
  const onAbort = () => void cancelYtdlp(jobId).catch(() => undefined);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const args = [...baseArgs(opts.cookiesBrowser), "-J", "-i", "--flat-playlist", "--", url];
    const r = await runYtdlp(jobId, args, undefined, undefined, () => !!opts.signal?.aborted);
    if (opts.signal?.aborted) fail("cancelled");
    const json = r.stdout.find((l) => l.trimStart().startsWith("{"));
    if (r.code !== 0 && !json) throw new EngineError(friendlyError(lastError(r.stderr)));
    if (!json) fail("no_formats", lastError(r.stderr));
    return mapYdlInfo(JSON.parse(json) as YdlInfo, url);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

// ---------------- download ----------------

const PROGRESS_TEMPLATE =
  "download:KEEPSAKE|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|" +
  "%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.playlist_index)s|" +
  "%(info.n_entries)s|%(progress.filename)s";
const PP_TEMPLATE = "postprocess:KEEPSAKE_PP|%(progress.status)s|%(progress.postprocessor)s";

function sep(dir: string): string {
  return dir.includes("\\") ? "\\" : "/";
}

/** True when the fetched info lists a native M4A (AAC) audio-only stream. */
function hasNativeM4a(info: VideoInfo | undefined): boolean {
  return !!info && info.kind !== "playlist" && info.streams.some((st) => st.kind === "audio-only" && st.ext === "m4a");
}

/**
 * `-f` and extraction args for an audio download.
 * - m4a with a known native m4a stream: take that stream as-is, no `-x` (no ExtractAudio pass).
 * - m4a otherwise (playlists, no info, no m4a stream): prefer m4a and keep `-x`; yt-dlp skips the conversion when the
 *   file is already AAC in M4A.
 * - opus: prefer the native Opus stream so `-x` is a stream copy into .opus.
 * - mp3/wav/flac: best audio, converted by ffmpeg.
 */
function audioSelection(fmt: string, info: VideoInfo | undefined): string[] {
  if (fmt === "m4a" && hasNativeM4a(info)) return ["-f", "bestaudio[ext=m4a]"];
  const f =
    fmt === "m4a"
      ? "bestaudio[ext=m4a]/bestaudio/best"
      : fmt === "opus"
        ? "bestaudio[acodec=opus]/bestaudio/best"
        : "bestaudio/best";
  return ["-f", f, "-x", "--audio-format", fmt];
}

/** Build the yt-dlp argument list for a download (exported for tests). */
export function buildDownloadArgs(req: DownloadRequest, outDir: string): { args: string[]; tempDir: string } {
  assertHttpUrl(req.url);
  const s = sep(outDir);
  const tempDir = `${outDir.replace(/[\\/]+$/, "")}${s}.keepsake-tmp${s}${req.id}`;
  // Keep full paths under ~240 chars on Windows.
  const trim = Math.max(60, Math.min(200, 240 - outDir.length));
  const a = [
    ...baseArgs(req.cookiesBrowser),
    "--windows-filenames",
    "--trim-filenames",
    String(trim),
    "-P",
    `home:${outDir}`,
    "-P",
    `temp:${tempDir}`,
    "--newline",
    "--progress",
    "--progress-template",
    PROGRESS_TEMPLATE,
    "--progress-template",
    PP_TEMPLATE,
    "--print",
    "after_move:KEEPSAKE_DONE|%(filepath)s",
    "-i",
  ];
  const [kind, value = ""] = req.formatId.split(":");

  if (kind === "video") {
    a.push("-o", "%(title)s.%(ext)s");
    const h = value === "best" ? 0 : Number.parseInt(value, 10) || 0;
    const cap = h ? `[height<=${h}]` : "";
    const picked = req.streamId && req.info?.streams.find((st) => st.id === req.streamId);
    if (picked) {
      a.push("-f", picked.kind === "video-only" ? `${picked.id}+bestaudio[ext=m4a]/${picked.id}+bestaudio` : picked.id);
    } else {
      a.push("-f", `bestvideo${cap}+bestaudio/best${cap}/best`);
      if (req.preferH264) a.push("-S", "res,fps,vcodec:h264,acodec:aac");
    }
    a.push("--merge-output-format", "mp4/mkv");
    // Each embed pass rewrites the whole video file, so video embeds are opt-in (Settings, default off).
    if (req.embedVideoMeta === true) a.push("--embed-thumbnail", "--convert-thumbnails", "jpg", "--embed-metadata");
  } else if (kind === "audio") {
    const fmt = value || "mp3";
    a.push("-o", "%(title)s.%(ext)s", ...audioSelection(fmt, req.info));
    if (fmt === "mp3" || fmt === "opus") a.push("--audio-quality", `${req.audioBitrate ?? 192}K`);
    // Python bug not ported: never embed into WebM. Embed cover art for mp3/m4a only (Settings, default on).
    if (req.embedThumbnail !== false && (fmt === "mp3" || fmt === "m4a")) {
      a.push("--embed-thumbnail", "--convert-thumbnails", "jpg");
    }
    a.push("--embed-metadata");
  } else if (kind === "thumb") {
    a.push("--skip-download", "--write-thumbnail", "-o", "thumbnail:%(title)s_thumb.%(ext)s");
    if (value === "png" || value === "jpg") a.push("--convert-thumbnails", value);
    // --skip-download never reaches after_move; print the written thumbnail path instead (INFERRED).
    a.push("--print", "after_video:KEEPSAKE_DONE|%(thumbnails.-1.filepath)s");
  } else {
    fail("format_unavailable", req.formatId);
  }
  a.push("--", req.url);
  return { args: a, tempDir };
}

function num(v: string | undefined): number | undefined {
  if (!v || v === "NA" || v === "None") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse one KEEPSAKE progress line (exported for tests). */
export function parseProgressLine(line: string): Partial<DownloadProgress> | null {
  const i = line.indexOf("KEEPSAKE|");
  if (i < 0) return null;
  const [, status, dl, total, est, speed, eta, pIdx, nEntries] = line.slice(i).split("|");
  const downloaded = num(dl) ?? 0;
  const tot = num(total) ?? num(est);
  return {
    status: status === "finished" ? "merging" : "downloading",
    downloadedBytes: downloaded,
    totalBytes: tot,
    percent: tot ? Math.min(100, (downloaded / tot) * 100) : undefined,
    speedBps: num(speed),
    etaSec: num(eta),
    playlistIndex: num(pIdx),
    playlistCount: num(nEntries),
  };
}

/**
 * Download with yt-dlp. On a bot check with Settings > Cookies "off", retries once per installed browser
 * (COOKIE_FALLBACK_ORDER) with `--cookies-from-browser`, stops at the first success and sets
 * `note: "Retried with cookies from <Browser>"`. An explicit browser choice is never overridden.
 * Every attempt reuses the job id: Rust drops the job from its table and deletes `.keepsake-tmp/<id>` after
 * each exit, so cancel_ytdlp and the temp cleanup behave the same on every attempt.
 */
export async function downloadYtdlp(
  req: DownloadRequest,
  outDir: string,
  emit: (p: DownloadProgress) => void,
  isCancelled: () => boolean,
): Promise<DownloadProgress> {
  const first = await downloadOnce(req, outDir, emit, isCancelled);
  if (first.status !== "failed" || first.error?.code !== "bot_check" || !wantsFallback(req.cookiesBrowser)) {
    return first;
  }
  const cancelled = (): DownloadProgress => ({ id: req.id, status: "cancelled", downloadedBytes: 0, error: appError("cancelled") });
  const tried: string[] = [];
  for (const b of await fallbackBrowsers()) {
    if (isCancelled()) return cancelled();
    tried.push(b);
    emit({ id: req.id, status: "downloading", downloadedBytes: 0 });
    let r: DownloadProgress;
    try {
      r = await downloadOnce({ ...req, cookiesBrowser: b }, outDir, emit, isCancelled);
    } catch (e) {
      const err = toAppError(e);
      if (isCancelled() || isFinal(err.code)) throw e;
      continue;
    }
    if (r.status === "done") return { ...r, note: `Retried with cookies from ${BROWSER_LABEL[b] ?? b}` };
    if (r.status === "cancelled" || (r.error && isFinal(r.error.code))) return r;
  }
  return { ...first, error: triedDetail(first.error, tried) };
}

async function downloadOnce(
  req: DownloadRequest,
  outDir: string,
  emit: (p: DownloadProgress) => void,
  isCancelled: () => boolean,
): Promise<DownloadProgress> {
  const { args, tempDir } = buildDownloadArgs(req, outDir);
  let last: DownloadProgress = { id: req.id, status: "downloading", downloadedBytes: 0 };
  const files: string[] = [];
  const errors: string[] = [];
  const r = await runYtdlp(
    req.id,
    args,
    (line) => {
      const p = parseProgressLine(line);
      if (p) {
        last = { ...last, ...p, id: req.id };
        emit(last);
      } else if (line.includes("KEEPSAKE_PP|")) {
        const st = line.split("|")[1];
        if (st === "started" || st === "processing") {
          last = { ...last, status: "merging", percent: undefined };
          emit(last);
        }
      } else if (line.startsWith("KEEPSAKE_DONE|")) {
        files.push(line.slice("KEEPSAKE_DONE|".length));
      } else if (line.includes("ERROR:")) {
        errors.push(line);
      }
    },
    tempDir,
    isCancelled,
  );
  if (isCancelled()) return { ...last, status: "cancelled", error: appError("cancelled") };
  const finalPath = files[files.length - 1];
  const count = last.playlistCount;
  if (count && count > 1) {
    // Playlist: "N videos, M failed"; all failed = error.
    if (files.length === 0) {
      return { ...last, status: "failed", error: friendlyError(lastError(errors.length ? errors : r.stderr)) };
    }
    const failed = errors.length;
    const err = failed ? { ...appError("unknown"), message: `${files.length} videos, ${failed} failed` } : undefined;
    return { ...last, status: "done", percent: 100, filePath: finalPath, error: err };
  }
  if (r.code !== 0 || !finalPath) {
    return { ...last, status: "failed", error: friendlyError(lastError(errors.length ? errors : r.stderr)) };
  }
  return { ...last, status: "done", percent: 100, filePath: finalPath };
}
