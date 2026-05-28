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
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Tauri Channel only exposes onmessage
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

// ---------------- TikTok / Instagram workaround ladder ----------------

export type LadderSite = "tiktok" | "instagram";

/** TikTok or Instagram host (any subdomain), else undefined. YouTube and every other site never ladder. */
export function ladderSite(url: string): LadderSite | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return undefined;
  }
  const is = (d: string) => host === d || host.endsWith(`.${d}`);
  if (is("tiktok.com")) return "tiktok";
  if (is("instagram.com") || is("instagr.am")) return "instagram";
  return undefined;
}

/**
 * Extra args for attempts 2, 3, ... after a failed first attempt (attempt 1 adds nothing). Each step goes in front of
 * `-- URL`; the user's cookie setting is kept as-is on every step and never widened.
 * - tiktok step 2: the mobile API (yt-dlp README `tiktok:api_hostname`, `app_info`; the iid is a placeholder).
 *   yt-dlp falls back to the webpage on its own when the API fails, so this is never worse than attempt 1.
 * - instagram step 2: the iOS `X-IG-App-ID` (yt-dlp README `instagram:app_id`).
 * - step 3: IPv4 only and a Safari TLS fingerprint (curl_cffi; the bundled yt-dlp lists safari targets).
 */
export const LADDER_STEPS: Readonly<Record<LadderSite, readonly (readonly string[])[]>> = {
  tiktok: [
    ["--extractor-args", "tiktok:api_hostname=api22-normal-c-alisg.tiktokv.com;app_info=7351144126450059040"],
    ["--force-ipv4", "--impersonate", "safari"],
  ],
  instagram: [
    ["--extractor-args", "instagram:app_id=ios"],
    ["--force-ipv4", "--impersonate", "safari"],
  ],
};

/** Steps to try after attempt 1 fails for this URL (empty for every non-TikTok/Instagram URL). */
export function ladderSteps(url: string): readonly (readonly string[])[] {
  const site = ladderSite(url);
  return site ? LADDER_STEPS[site] : [];
}

/** Errors another request shape can fix. Everything else (cancel, missing binaries, disk, private, removed...) is final. */
const LADDER_CODES: ReadonlySet<AppError["code"]> = new Set<AppError["code"]>([
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
]);

/** True when a failure with this code may be retried with the next ladder step (exported for tests). */
export function laddersAfter(code: AppError["code"]): boolean {
  return LADDER_CODES.has(code) && !isFinal(code);
}

function ladderNote(err: AppError, steps: number): AppError {
  const note = `Also tried ${steps} workaround${steps === 1 ? "" : "s"}.`;
  return { ...err, detail: err.detail ? `${err.detail} ${note}` : note };
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
    .toSorted((a, b) => b - a);
  const isPlaylist = j["_type"] === "playlist";
  const hasVideo = isPlaylist || streams.length === 0 || streams.some((s) => s.kind !== "audio-only");
  const thumbs: Thumbnail[] = (j.thumbnails ?? [])
    .toSorted((a, b) => (b.preference ?? 0) - (a.preference ?? 0) || (b.width ?? 0) - (a.width ?? 0))
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
    if (first.code !== "bot_check" && ladderSteps(url).length > 0) return fetchInfoLadder(url, opts, e, first);
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

/** TikTok/Instagram only: after a ladderable first failure, try each LADDER_STEPS entry; rethrow the first error. */
async function fetchInfoLadder(url: string, opts: InfoOpts, firstThrown: unknown, first: AppError): Promise<VideoInfo> {
  if (!laddersAfter(first.code)) throw firstThrown;
  const steps = ladderSteps(url);
  for (const extra of steps) {
    if (opts.signal?.aborted) fail("cancelled");
    try {
      return await fetchInfoOnce(url, opts, extra);
    } catch (e2) {
      if (opts.signal?.aborted) fail("cancelled");
      if (!laddersAfter(toAppError(e2).code)) throw e2;
    }
  }
  throw new EngineError(ladderNote(first, steps.length));
}

async function fetchInfoOnce(url: string, opts: InfoOpts, extra: readonly string[] = []): Promise<VideoInfo> {
  assertHttpUrl(url);
  const jobId = `info-${crypto.randomUUID()}`;
  const onAbort = () => void cancelYtdlp(jobId).catch(() => undefined);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const args = [...baseArgs(opts.cookiesBrowser), "-J", "-i", "--flat-playlist", ...extra, "--", url];
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

/** Per-job temp folder. Rust must keep it when a job fails (not cancelled) so Retry can resume from it. */
export function keepTempOnFailure(jobId: string, outDir: string): string {
  const s = sep(outDir);
  return `${outDir.replace(/[\\/]+$/, "")}${s}.keepsake-tmp${s}${jobId}`;
}

const FILE_TEMPLATE = "%(title).80B [%(id)s].%(ext)s";
const PLAYLIST_TEMPLATE = "%(playlist_title)s/%(playlist_index)s - %(title).80B [%(id)s].%(ext)s";

/** Format-selection argv shared by desktop (buildDownloadArgs) and Android (self-contained yt-dlp). Video and audio only. */
export function selectionArgs(
  req: Pick<DownloadRequest, "formatId" | "info" | "streamId" | "preferH264" | "embedVideoMeta" | "audioBitrate" | "embedThumbnail">,
  opts: { platform: "desktop" | "android"; heightFallback?: boolean },
): string[] {
  const [kind, value = ""] = req.formatId.split(":");
  const a: string[] = [];
  if (kind === "video") {
    const h = value === "best" ? 0 : Number.parseInt(value, 10) || 0;
    const cap = h ? `[height<=${h}]` : "";
    if (opts.platform === "android") {
      a.push("-f", `bestvideo${cap}+bestaudio/best${cap}/best`);
      if (req.preferH264) a.push("-S", "res,fps,vcodec:h264,acodec:aac");
      a.push("--merge-output-format", "mp4/mkv");
      return a;
    }
    const picked = !opts.heightFallback && req.streamId && req.info?.streams.find((st) => st.id === req.streamId);
    if (picked) {
      a.push("-f", picked.kind === "video-only" ? `${picked.id}+bestaudio[ext=m4a]/${picked.id}+bestaudio` : picked.id);
    } else {
      a.push("-f", `bestvideo${cap}+bestaudio/best${cap}/best`);
      if (req.preferH264) a.push("-S", "res,fps,vcodec:h264,acodec:aac");
    }
    a.push("--merge-output-format", "mp4/mkv");
    // Each embed pass rewrites the whole video file, so video embeds are opt-in (Settings, default off).
    if (req.embedVideoMeta === true) a.push("--embed-thumbnail", "--convert-thumbnails", "jpg", "--embed-metadata");
    return a;
  }
  if (kind === "audio") {
    const fmt = value || "mp3";
    if (opts.platform === "android") {
      // WAV is transcoded from the M4A afterwards by the caller.
      if (fmt === "m4a" || fmt === "wav") return ["-f", "bestaudio[ext=m4a]/bestaudio/best", "-x", "--audio-format", "m4a"];
      return fail("format_unavailable", req.formatId);
    }
    a.push(...audioSelection(fmt, req.info));
    if (fmt === "mp3" || fmt === "opus") a.push("--audio-quality", `${req.audioBitrate ?? 192}K`);
    // Python bug not ported: never embed into WebM. Embed cover art for mp3/m4a only (Settings, default on).
    if (req.embedThumbnail !== false && (fmt === "mp3" || fmt === "m4a")) {
      a.push("--embed-thumbnail", "--convert-thumbnails", "jpg");
    }
    a.push("--embed-metadata");
    return a;
  }
  return fail("format_unavailable", req.formatId);
}

/** Build the yt-dlp argument list for a download (exported for tests). */
export function buildDownloadArgs(
  req: DownloadRequest,
  outDir: string,
  opts: { heightFallback?: boolean; extra?: readonly string[] } = {},
): { args: string[]; tempDir: string } {
  assertHttpUrl(req.url);
  const tempDir = keepTempOnFailure(req.id, outDir);
  const isPlaylist = req.info?.kind === "playlist";
  const outTmpl = isPlaylist ? PLAYLIST_TEMPLATE : FILE_TEMPLATE;
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
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--socket-timeout",
    "30",
    "--concurrent-fragments",
    "4",
  ];
  if (!isPlaylist) a.push("--no-playlist");
  const [kind, value = ""] = req.formatId.split(":");

  if (kind === "video") {
    a.push("-o", outTmpl, ...selectionArgs(req, { platform: "desktop", heightFallback: opts.heightFallback }));
  } else if (kind === "audio") {
    a.push("-o", outTmpl, ...selectionArgs(req, { platform: "desktop", heightFallback: opts.heightFallback }));
  } else if (kind === "thumb") {
    a.push("--skip-download", "--write-thumbnail", "-o", "thumbnail:%(title).80B [%(id)s]_thumb.%(ext)s");
    if (value === "png" || value === "jpg") a.push("--convert-thumbnails", value);
    // --skip-download never reaches after_move; print the written thumbnail path instead (INFERRED).
    a.push("--print", "after_video:KEEPSAKE_DONE|%(thumbnails.-1.filepath)s");
  } else {
    fail("format_unavailable", req.formatId);
  }
  // Ladder step args (TikTok/Instagram retries only); attempt 1 passes none, so its argv is unchanged.
  if (opts.extra) a.push(...opts.extra);
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

/** yt-dlp names a per-format part `<stem> [<id>].f<format_id>.<ext>` (prepend_extension); both templates end in `[%(id)s]`. */
const PART_RE = /\]\.f[^.\\/]+\.[A-Za-z0-9]+$/;

/**
 * True for a yt-dlp per-format part (`.f137.mp4`, `.f251.webm`): never a deliverable file (exported for tests).
 * `name`: the literal file name given to yt-dlp (Android `<name>.%(ext)s`), checked exactly as `<name>.f<id>.<ext>`.
 */
export function isFormatPart(path: string, name?: string): boolean {
  if (!name) return PART_RE.test(path);
  const file = path.split(/[\\/]/).pop() ?? "";
  return file.startsWith(`${name}.`) && /^f[^.\\/]+\.[A-Za-z0-9]+$/.test(file.slice(name.length + 1));
}

/**
 * Watches yt-dlp output for a skipped merge (exported for tests). A video that downloaded `.fNNN` parts must run
 * the `Merger` postprocessor before its `after_move` print; without it (ffmpeg not found, a warning that
 * `--no-warnings` hides and `-i` makes non-fatal) yt-dlp moves the bare video-only and audio-only parts into the
 * output folder and still exits 0. `done()` returns those parts for that video (empty when it merged), then resets.
 */
export function mergeTracker() {
  let parts = new Set<string>();
  let merged = false;
  return {
    line(line: string): void {
      const i = line.indexOf("KEEPSAKE|");
      if (i >= 0) {
        const file = line.slice(i).split("|").slice(9).join("|").trim();
        if (isFormatPart(file)) parts.add(file);
      } else if (line.includes("KEEPSAKE_PP|") && line.split("|")[2]?.trim() === "Merger") {
        merged = true;
      }
    },
    done(finalPath: string): string[] {
      const left = merged ? [] : [...parts];
      if (isFormatPart(finalPath) && !left.includes(finalPath)) left.push(finalPath);
      parts = new Set();
      merged = false;
      return left;
    },
  };
}

/** Slash- and case-insensitive form of a path, for prefix checks only. */
function normPath(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
}

const mergeError = (): AppError =>
  appError("ffmpeg_missing", "Video and audio were downloaded separately but not merged; the parts were deleted.");

/** Where yt-dlp moved a part from `tempDir` into `outDir` (`-P temp:` / `-P home:` keep the relative path). */
export function movedPartPath(part: string, tempDir: string, outDir: string): string {
  const t = normPath(tempDir);
  if (!normPath(part).startsWith(`${t}/`)) return part;
  return `${outDir.replace(/[\\/]+$/, "")}${sep(outDir)}${part.slice(tempDir.replace(/[\\/]+$/, "").length + 1)}`;
}

/**
 * Download with yt-dlp. On a bot check with Settings > Cookies "off", retries once per installed browser
 * (COOKIE_FALLBACK_ORDER) with `--cookies-from-browser`, stops at the first success and sets
 * `note: "Retried with cookies from <Browser>"`. An explicit browser choice is never overridden.
 * Every attempt reuses the job id: Rust drops the job from its table after each exit and keeps
 * `.keepsake-tmp/<id>` after a failed run (so Retry can resume), deleting it only after success or cancel.
 */
export async function downloadYtdlp(
  req: DownloadRequest,
  outDir: string,
  emit: (p: DownloadProgress) => void,
  isCancelled: () => boolean,
): Promise<DownloadProgress> {
  let first = await downloadOnce(req, outDir, emit, isCancelled);
  let heightFallback = false;
  // A picked stream that yt-dlp rejects: retry once with the height-based selector for the same request.
  if (first.status === "failed" && first.error?.code === "format_unavailable" && req.streamId && !isCancelled()) {
    heightFallback = true;
    first = await downloadOnce(req, outDir, emit, isCancelled, true);
  }
  if (first.status === "failed" && first.error && first.error.code !== "bot_check" && ladderSteps(req.url).length > 0) {
    return downloadLadder(req, outDir, emit, isCancelled, first, heightFallback);
  }
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

/**
 * TikTok/Instagram only: after a ladderable failure, retry with each LADDER_STEPS entry (same request, same cookie
 * setting, same job id and temp folder) and stop at the first success or at a final error.
 */
async function downloadLadder(
  req: DownloadRequest,
  outDir: string,
  emit: (p: DownloadProgress) => void,
  isCancelled: () => boolean,
  first: DownloadProgress,
  heightFallback: boolean,
): Promise<DownloadProgress> {
  if (!first.error || !laddersAfter(first.error.code)) return first;
  const steps = ladderSteps(req.url);
  for (const extra of steps) {
    if (isCancelled()) return { id: req.id, status: "cancelled", downloadedBytes: 0, error: appError("cancelled") };
    emit({ id: req.id, status: "downloading", downloadedBytes: 0 });
    let r: DownloadProgress;
    try {
      r = await downloadOnce(req, outDir, emit, isCancelled, heightFallback, extra);
    } catch (e) {
      if (isCancelled() || !laddersAfter(toAppError(e).code)) throw e;
      continue;
    }
    if (r.status === "done") return { ...r, note: r.note ?? "Retried with a workaround" };
    if (r.status === "cancelled" || !r.error || !laddersAfter(r.error.code)) return r;
  }
  return { ...first, error: ladderNote(first.error, steps.length) };
}

async function downloadOnce(
  req: DownloadRequest,
  outDir: string,
  emit: (p: DownloadProgress) => void,
  isCancelled: () => boolean,
  heightFallback = false,
  extra?: readonly string[],
): Promise<DownloadProgress> {
  const { args, tempDir } = buildDownloadArgs(req, outDir, { heightFallback, extra });
  let last: DownloadProgress = { id: req.id, status: "downloading", downloadedBytes: 0 };
  const files: string[] = [];
  const errors: string[] = [];
  const failedIdx = new Set<string>();
  const merge = mergeTracker();
  const unmerged: string[] = [];
  const r = await runYtdlp(
    req.id,
    args,
    (line) => {
      merge.line(line);
      if (line.startsWith("KEEPSAKE_DONE|")) {
        const left = merge.done(line.slice("KEEPSAKE_DONE|".length));
        if (left.length > 0) {
          // Skipped merge: the parts are not a result. Count the video as failed, delete them below.
          unmerged.push(...left);
          failedIdx.add(String(last.playlistIndex ?? `unmerged-${unmerged.length}`));
          return;
        }
      }
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
        failedIdx.add(String(last.playlistIndex ?? errors.length));
      }
    },
    tempDir,
    isCancelled,
  );
  // Deliver exactly one file per video: never leave unmerged video-only/audio-only parts in the user's folder.
  if (unmerged.length > 0) {
    // Loaded lazily: tests mock "@tauri-apps/api/core" process-wide without `Resource`, which plugin-fs links against.
    const fs = await import("@tauri-apps/plugin-fs").catch(() => undefined);
    for (const part of new Set(unmerged.map((p) => movedPartPath(p, tempDir, outDir)))) {
      await fs?.remove(part).catch(() => undefined);
    }
  }
  if (isCancelled()) return { ...last, status: "cancelled", error: appError("cancelled") };
  const finalPath = files[files.length - 1];
  const count = last.playlistCount;
  if (!(count && count > 1) && unmerged.length > 0) {
    return { ...last, status: "failed", error: mergeError() };
  }
  if (count && count > 1) {
    // Playlist: "N videos, M failed"; all failed = error.
    if (files.length === 0) {
      const err = unmerged.length > 0 && errors.length === 0 ? mergeError() : friendlyError(lastError(errors.length ? errors : r.stderr));
      return { ...last, status: "failed", error: err };
    }
    const failed = failedIdx.size;
    const err =
      failed && count > 0
        ? { ...appError("unknown"), message: `Saved ${files.length} of ${count} videos` }
        : undefined;
    return { ...last, status: "done", percent: 100, filePath: finalPath, error: err };
  }
  if (!finalPath) {
    return { ...last, status: "failed", error: friendlyError(lastError(errors.length ? errors : r.stderr)) };
  }
  if (r.code !== 0) {
    // File was written and its path printed: keep it, flag the non-zero exit.
    return { ...last, status: "done", percent: 100, filePath: finalPath, note: "Finished with warnings" };
  }
  return { ...last, status: "done", percent: 100, filePath: finalPath };
}
