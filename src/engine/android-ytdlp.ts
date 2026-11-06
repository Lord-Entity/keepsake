/**
 * Android TikTok / Instagram downloads through yt-dlp running in-process (Chaquopy) behind the native
 * "keepsake-media" Tauri plugin. Contract: plan-docs/07-android-ytdlp-plan.md section 2, src/engine/CONTRACT.md.
 *
 *   command "ytdlp_info",     args { url },                                   resolves { ok: true, info: YtdlpInfo }
 *   command "ytdlp_download", args { url, formatId, outDir, fileName?, jobId }, resolves { path, bytes }
 *   command "ytdlp_cancel",   args { jobId },                                 resolves {}
 *   command "ytdlp_mux",      args { videoPath, audioPath, outDir, fileName }, resolves { path, bytes }
 *   jobId: caller-chosen id; "-v" / "-a" suffixes for the video and audio parts of a muxed download.
 *   Both reject with a string containing "ytdlp:<code>: <message>" (code in YTDLP_ERROR_CODES).
 *   Needs "keepsake-media:allow-ytdlp-info" and "keepsake-media:allow-ytdlp-download" in src-tauri/capabilities/mobile.json.
 * VERIFIED (node_modules/@tauri-apps/api/core.d.ts 2.12.4): `invoke<T>(cmd, args?)`; plugin commands are
 *   addressed as "plugin:<name>|<command>".
 * INFERRED: Tauri may wrap the plugin's reject text, so mapYtdlpError searches for the "ytdlp:<code>:" marker.
 * No ffmpeg on Android: only single http(s) files are offered (no merge, no HLS/DASH). cookiesHint is always false
 * here because Android has no Settings > Cookies. Must not import download.ts, index.ts or formats.ts (no cycles).
 */
import { invoke } from "@tauri-apps/api/core";
import type { AppError, AppErrorCode, StreamInfo, VideoInfo } from "../lib/types";
import { appError, cleanError, EngineError, fail } from "./errors";
import { platform } from "./platform";

/** Hosts served by yt-dlp on Android. Exact host or any subdomain; https only. Keep identical to YTDLP_HOSTS in lib.rs. */
export const ANDROID_YTDLP_HOSTS: readonly string[] = [
  "tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
  "instagram.com",
  "instagr.am",
] as const;

export const YTDLP_ERROR_CODES: readonly string[] = [
  "unsupported_url",
  "login_required",
  "rate_limited",
  "forbidden",
  "not_found",
  "parse_failed",
  "network",
  "timeout",
  "no_space",
  "permission",
  "too_large",
  "cancelled",
  "format_unavailable",
  "mux_failed",
  "empty",
  "unknown",
];

export interface YtdlpFormat {
  format_id: string;
  ext: string;
  vcodec: string | null;
  acodec: string | null;
  height: number | null;
  fps: number | null;
  filesize: number | null;
  protocol: string;
  format_note: string | null;
}

export interface YtdlpInfo {
  id: string;
  title: string;
  uploader: string | null;
  duration: number | null;
  thumbnail: string | null;
  extractor: string;
  webpage_url: string;
  formats: YtdlpFormat[];
}

export const PERMISSION_TEXT = "Keepsake can't save to this folder. Pick Downloads, Music or Movies in Settings.";
export const MP3_TEXT = "MP3 isn't available on Android yet. Choose M4A.";

const ANDROID_TEXT: Record<string, string> = {
  unsupported_url: "This link isn't supported. Paste a TikTok or Instagram video link.",
  login_required:
    "This post needs you to be signed in, which Keepsake can't do on Android yet. Try a public post, or use the desktop app.",
  rate_limited: "Instagram or TikTok is asking us to slow down. Wait a few minutes, then try again.",
  forbidden: "The site refused access. The post may be private or restricted.",
  not_found: "The post wasn't found. The link may be wrong or the video was removed.",
  parse_failed: "Couldn't read this page. The site may have changed; a Keepsake update may fix it.",
  network: "The connection dropped. Check your signal and tap Retry.",
  timeout: "The connection timed out. Check your signal and tap Retry.",
  no_space: "Your phone may be out of storage. Free some space and try again.",
  permission: PERMISSION_TEXT,
  too_large: "This video is bigger than 500 MB, which Keepsake can't save on Android yet.",
  cancelled: "Download cancelled.",
  format_unavailable: "This quality isn't available for this post. Pick another quality.",
  mux_failed: "Keepsake couldn't combine the video and audio. Try a different quality.",
  empty: "No downloadable video was found on this page.",
  unknown: "Something went wrong while saving. Tap Retry.",
};

const MISSING_TEXT = "TikTok and Instagram downloads aren't available in this build. Reinstall Keepsake.";

/** Plugin not registered, command unknown, or the capability does not allow it. */
const MISSING_RE = /plugin\b.*\bnot (found|initialized|registered)|command\b.*\bnot found|unknown command|not allowed|denied/i;

function rawText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Pure host check (no platform check): https + allow-listed host (exact or subdomain). */
export function isAndroidYtdlpHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase().replace(/\.$/, "");
    return ANDROID_YTDLP_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** platform() === "android" && isAndroidYtdlpHost(url). */
export function isAndroidYtdlpSupported(url: string): boolean {
  return platform() === "android" && isAndroidYtdlpHost(url);
}

/** format_ids marked as watermarked, per converted info (format_note is not part of StreamInfo). */
const watermarked = new WeakMap<VideoInfo, Set<string>>();

/** Pure: reduced yt-dlp info -> VideoInfo (source "ytdlp"). Drops formats whose protocol is not http/https. */
export function ytdlpInfoToVideoInfo(info: YtdlpInfo, requestedUrl: string): VideoInfo {
  const marked = new Set<string>();
  const streams: StreamInfo[] = [];
  for (const f of info.formats) {
    if (f.protocol !== "https" && f.protocol !== "http") continue;
    if (f.vcodec === "none" && f.acodec === "none") continue;
    if ((f.format_note && /watermark/i.test(f.format_note)) || /^download/i.test(f.format_id)) marked.add(f.format_id);
    streams.push({
      id: f.format_id,
      kind: f.vcodec === "none" ? "audio-only" : f.acodec === "none" ? "video-only" : "progressive",
      ext: f.ext || "mp4",
      height: f.height ?? undefined,
      fps: f.fps ?? undefined,
      vcodec: f.vcodec && f.vcodec !== "none" ? f.vcodec : undefined,
      acodec: f.acodec && f.acodec !== "none" ? f.acodec : undefined,
      sizeBytes: f.filesize ?? undefined,
    });
  }
  const fpsByHeight: Record<number, number> = {};
  for (const s of streams) {
    if (s.height && s.kind !== "audio-only") fpsByHeight[s.height] = Math.max(fpsByHeight[s.height] ?? 0, s.fps ?? 0);
  }
  const heights = Object.keys(fpsByHeight)
    .map(Number)
    .toSorted((a, b) => b - a);
  const hasVideo = streams.some((s) => s.kind !== "audio-only");
  const out: VideoInfo = {
    id: info.id,
    url: info.webpage_url || requestedUrl,
    site: (info.extractor || "generic").toLowerCase(),
    kind: hasVideo ? "video" : "audio",
    title: info.title || "Untitled",
    channel: info.uploader ?? undefined,
    durationSec: info.duration ?? undefined,
    thumbnails: info.thumbnail ? [{ url: info.thumbnail }] : [],
    hasVideo,
    heights,
    fpsByHeight,
    streams,
    previewOnly: false,
    source: "ytdlp",
  };
  watermarked.set(out, marked);
  return out;
}

export interface YtdlpPick {
  formatId: string;
  ext: string;
  needsRemux: boolean;
  height?: number;
  sizeBytes?: number;
  /** Set when formatId is video-only: the audio-only stream to download and mux with it. */
  audioFormatId?: string;
  /** Best single-file (muxed) format of the same info, used when formatId is unavailable. */
  fallback?: { formatId: string; ext: string };
}

const isH264 = (s: StreamInfo) => /^(avc|h264)/i.test(s.vcodec ?? "");

/** Pure: UI formatId ("video:<h>" | "video:best" | "audio:m4a") -> concrete yt-dlp format, or null when nothing fits. */
export function pickYtdlpFormat(info: VideoInfo, uiFormatId: string): YtdlpPick | null {
  if (info.source !== "ytdlp") return null;
  const [kind, arg] = uiFormatId.split(":");
  if (kind === "video") {
    const limit = arg === "best" ? 100000 : /^\d+$/.test(arg ?? "") ? Number(arg) : 0;
    if (limit <= 0) return null;
    const marked = watermarked.get(info) ?? new Set<string>();
    const isMarked = (s: StreamInfo) => marked.has(s.id) || /^download/i.test(s.id);
    const cmp = (a: StreamInfo, b: StreamInfo) =>
      (b.height ?? 0) - (a.height ?? 0) ||
      Number(isMarked(a)) - Number(isMarked(b)) ||
      Number(a.kind === "video-only") - Number(b.kind === "video-only") ||
      Number(isH264(b)) - Number(isH264(a)) ||
      (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
    const prog = info.streams.filter((s) => s.kind === "progressive" && (s.height ?? 0) <= limit).toSorted(cmp);
    const audio = info.streams.filter((s) => s.kind === "audio-only");
    const bestAudio = audio.filter((s) => s.ext === "m4a").toSorted((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0];
    const vids = info.streams
      .filter((s) => (s.kind === "progressive" || (s.kind === "video-only" && bestAudio)) && (s.height ?? 0) <= limit)
      .toSorted(cmp);
    const s = vids[0];
    if (!s) return null;
    const fb = prog[0];
    const fallback = fb && fb.id !== s.id ? { formatId: fb.id, ext: fb.ext } : undefined;
    if (s.kind === "video-only") {
      return {
        formatId: s.id,
        ext: "mp4",
        needsRemux: false,
        height: s.height,
        sizeBytes: s.sizeBytes,
        audioFormatId: bestAudio!.id,
        fallback,
      };
    }
    return { formatId: s.id, ext: s.ext, needsRemux: false, height: s.height, sizeBytes: s.sizeBytes, fallback };
  }
  if (uiFormatId === "audio:m4a") {
    const audio = info.streams.filter((s) => s.kind === "audio-only" && s.ext === "m4a");
    if (audio.length > 0) {
      const best = audio.reduce((a, b) => ((b.sizeBytes ?? 0) >= (a.sizeBytes ?? 0) ? b : a));
      return { formatId: best.id, ext: "m4a", needsRemux: false, sizeBytes: best.sizeBytes };
    }
    const prog = info.streams
      .filter((s) => s.kind === "progressive" && s.ext === "mp4" && (!s.acodec || /^(mp4a|aac)/i.test(s.acodec)))
      .toSorted((a, b) => (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity));
    const s = prog[0];
    return s ? { formatId: s.id, ext: "mp4", needsRemux: true, height: s.height, sizeBytes: s.sizeBytes } : null;
  }
  return null;
}

/** Any rejection text -> AppError. Never throws. */
export function mapYtdlpError(message: string): AppError {
  const text = typeof message === "string" ? message : rawText(message);
  const m = /ytdlp:([a-z_]+):\s*([\s\S]*)/.exec(text);
  if (m && YTDLP_ERROR_CODES.includes(m[1])) {
    // Marker-less "unknown" still maps below; known codes map here.
    const code = m[1];
    const detail = m[2].replace(/\s+/g, " ").trim().slice(0, 300) || undefined;
    return {
      code: code as AppErrorCode,
      message: ANDROID_TEXT[code] ?? ANDROID_TEXT.unknown,
      detail,
      cookiesHint: false,
    };
  }
  if (!m && MISSING_RE.test(text)) {
    return { code: "ytdlp_missing", message: MISSING_TEXT, detail: text, cookiesHint: false };
  }
  return { code: "unknown", message: ANDROID_TEXT.unknown, detail: cleanError(text), cookiesHint: false };
}

function badInfo(): EngineError {
  return new EngineError({
    code: "parse_failed",
    message: ANDROID_TEXT.parse_failed,
    detail: "bad ytdlp_info response",
    cookiesHint: false,
  });
}

/** Invokes ytdlp_info. Rejects with EngineError. Abort -> "cancelled" at once (the native call keeps running, its result is dropped). */
export async function fetchAndroidInfo(url: string, signal?: AbortSignal): Promise<VideoInfo> {
  if (!isAndroidYtdlpSupported(url)) throw new EngineError(appError("unsupported_url", url));
  if (signal?.aborted) fail("cancelled");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new EngineError(appError("cancelled")));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  let res: unknown;
  try {
    // invoke() can throw synchronously when the Tauri bridge is missing; the async wrapper turns that into a rejection.
    res = await Promise.race([invoke<unknown>("plugin:keepsake-media|ytdlp_info", { url }), aborted]);
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError(mapYtdlpError(rawText(e)));
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    aborted.catch(() => undefined);
  }
  const r = res as { ok?: unknown; info?: Partial<YtdlpInfo> } | null;
  if (!r || typeof r !== "object" || r.ok !== true || !r.info || typeof r.info.id !== "string" || !Array.isArray(r.info.formats)) {
    throw badInfo();
  }
  return ytdlpInfoToVideoInfo(r.info as YtdlpInfo, url);
}

/** Invokes ytdlp_download. Rejects with EngineError. Validates the response shape. */
export async function downloadAndroid(args: {
  url: string;
  formatId: string;
  outDir: string;
  fileName?: string;
  jobId?: string;
}): Promise<{ path: string; bytes: number }> {
  let res: unknown;
  try {
    res = await invoke<unknown>("plugin:keepsake-media|ytdlp_download", {
      url: args.url,
      formatId: args.formatId,
      outDir: args.outDir,
      ...(args.fileName ? { fileName: args.fileName } : {}),
      jobId: args.jobId ?? "job",
    });
  } catch (e) {
    throw new EngineError(mapYtdlpError(rawText(e)));
  }
  const r = res as { path?: unknown; bytes?: unknown } | null;
  if (!r || typeof r.path !== "string" || r.path === "" || typeof r.bytes !== "number" || !Number.isFinite(r.bytes)) {
    throw new EngineError({
      code: "unknown",
      message: ANDROID_TEXT.unknown,
      detail: "bad ytdlp_download response",
      cookiesHint: false,
    });
  }
  return { path: r.path, bytes: r.bytes };
}

/** Invokes ytdlp_cancel. Never throws. */
export async function cancelAndroid(jobId: string): Promise<void> {
  try {
    await invoke<unknown>("plugin:keepsake-media|ytdlp_cancel", { jobId });
  } catch {
    // nothing to cancel, or the plugin is gone
  }
}

/** Invokes ytdlp_mux (video-only + audio-only -> one file). Rejects with EngineError. */
export async function muxAndroid(args: {
  videoPath: string;
  audioPath: string;
  outDir: string;
  fileName: string;
}): Promise<{ path: string; bytes: number }> {
  let res: unknown;
  try {
    res = await invoke<unknown>("plugin:keepsake-media|ytdlp_mux", { ...args });
  } catch (e) {
    throw new EngineError(mapYtdlpError(rawText(e)));
  }
  const r = res as { path?: unknown; bytes?: unknown } | null;
  if (!r || typeof r.path !== "string" || r.path === "") {
    throw new EngineError({ code: "mux_failed", message: ANDROID_TEXT.mux_failed, detail: "bad ytdlp_mux response", cookiesHint: false });
  }
  return { path: r.path, bytes: typeof r.bytes === "number" ? r.bytes : 0 };
}

const RETRYABLE: ReadonlySet<string> = new Set(["network", "timeout", "rate_limited"]);

/**
 * Run `fn`, retrying network / timeout / rate_limited failures up to `retries` times with `delays` (ms) between
 * attempts (default 2 s then 6 s). Checks `signal` before every retry; an abort throws "cancelled".
 */
export async function runWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { signal?: AbortSignal; retries?: number; delays?: number[] } = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  const delays = opts.delays ?? [2000, 6000];
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw new EngineError(appError("cancelled"));
    try {
      return await fn(attempt);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (attempt >= retries || typeof code !== "string" || !RETRYABLE.has(code)) throw e;
      const ms = delays[Math.min(attempt, delays.length - 1)] ?? 0;
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, ms);
        function done() {
          clearTimeout(t);
          opts.signal?.removeEventListener("abort", done);
          resolve();
        }
        opts.signal?.addEventListener("abort", done, { once: true });
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// YouTube through yt-dlp (flagged, see youtube-ytdlp.ts). Separate from ANDROID_YTDLP_HOSTS on purpose: the
// TikTok / Instagram list, isAndroidYtdlpHost and fetchAndroidInfo are unchanged and still reject YouTube.
// ---------------------------------------------------------------------------------------------------------------

/** Hosts the YouTube yt-dlp path accepts. Exact host match, https only. Keep identical to YOUTUBE_YTDLP_HOSTS in lib.rs. */
export const ANDROID_YTDLP_YOUTUBE_HOSTS: readonly string[] = [
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
] as const;

/** Pure host check for the YouTube path: https + exact host in ANDROID_YTDLP_YOUTUBE_HOSTS. */
export function isAndroidYouTubeYtdlpHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase().replace(/\.$/, "");
    return ANDROID_YTDLP_YOUTUBE_HOSTS.includes(h);
  } catch {
    return false;
  }
}

const isAvc = (c: string | null) => /^(avc|h264)/i.test(c ?? "");
const isAac = (c: string | null) => /^(mp4a|aac)/i.test(c ?? "");

/**
 * Pure: keep only YouTube formats the phone can save as MP4 without ffmpeg: AVC (avc1) video in mp4, AAC audio in
 * m4a/mp4, progressive AVC+AAC mp4. VP9 / AV1 / Opus / webm are dropped because ytdlp_mux (MediaMuxer) writes MP4.
 * pickYtdlpFormat then takes the highest height (res first, AVC/AAC guaranteed by this filter).
 */
export function filterYouTubeMp4Formats(info: YtdlpInfo): YtdlpInfo {
  const formats = info.formats.filter((f) => {
    const v = f.vcodec && f.vcodec !== "none" ? f.vcodec : null;
    const a = f.acodec && f.acodec !== "none" ? f.acodec : null;
    if (v && !(isAvc(v) && f.ext === "mp4")) return false;
    if (a && !isAac(a)) return false;
    if (!v && a && f.ext !== "m4a" && f.ext !== "mp4") return false;
    return Boolean(v || a);
  });
  return { ...info, formats };
}

/**
 * Invokes ytdlp_info for a YouTube link (Android only) and returns MP4-safe formats (source "ytdlp").
 * Rejects with EngineError. Callers fall back to youtubei.js on any rejection.
 */
export async function fetchAndroidYouTubeInfo(url: string, signal?: AbortSignal): Promise<VideoInfo> {
  if (platform() !== "android" || !isAndroidYouTubeYtdlpHost(url)) throw new EngineError(appError("unsupported_url", url));
  if (signal?.aborted) fail("cancelled");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new EngineError(appError("cancelled")));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  let res: unknown;
  try {
    res = await Promise.race([invoke<unknown>("plugin:keepsake-media|ytdlp_info", { url }), aborted]);
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError(mapYtdlpError(rawText(e)));
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    aborted.catch(() => undefined);
  }
  const r = res as { ok?: unknown; info?: Partial<YtdlpInfo> } | null;
  if (!r || typeof r !== "object" || r.ok !== true || !r.info || typeof r.info.id !== "string" || !Array.isArray(r.info.formats)) {
    throw badInfo();
  }
  return ytdlpInfoToVideoInfo(filterYouTubeMp4Formats(r.info as YtdlpInfo), url);
}
