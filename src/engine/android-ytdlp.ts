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
  /**
   * Optional total / audio bitrate (kbit/s) when the Python side sends it. Becomes StreamInfo.bitrate (abr first for
   * audio-only streams, tbr first otherwise) and breaks ties between same-height variants and between audio streams.
   */
  tbr?: number | null;
  abr?: number | null;
  /** Optional frame width. Informational only; nothing ranks on it yet. */
  width?: number | null;
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
  too_large: "This video is bigger than 2 GB, which Keepsake can't save on Android yet.",
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
    const kind = f.vcodec === "none" ? "audio-only" : f.acodec === "none" ? "video-only" : "progressive";
    // Audio-only streams rank by audio bitrate; video streams by total bitrate.
    const bitrate = kind === "audio-only" ? (f.abr ?? f.tbr) : (f.tbr ?? f.abr);
    streams.push({
      id: f.format_id,
      kind,
      ext: f.ext || "mp4",
      height: f.height ?? undefined,
      fps: f.fps ?? undefined,
      vcodec: f.vcodec && f.vcodec !== "none" ? f.vcodec : undefined,
      acodec: f.acodec && f.acodec !== "none" ? f.acodec : undefined,
      sizeBytes: f.filesize ?? undefined,
      ...(typeof bitrate === "number" && Number.isFinite(bitrate) ? { bitrate } : {}),
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
  /** Set with audioFormatId: extension of the file the native muxer writes (AV1 goes to MP4, so it can differ from ext). */
  muxExt?: MuxContainer;
  /** Best single-file (muxed) format of the same info, used when formatId is unavailable. */
  fallback?: { formatId: string; ext: string };
  /** Optional user-facing note. download.ts ignores it; no skipped-height note is produced any more. */
  note?: string;
}

/** Highest video height YouTube reported. Kept as a public snapshot; no note or cap depends on it. */
export const rawMaxHeight = new WeakMap<VideoInfo, number>();

/** Container the native muxer can write without re-encoding: MP4 (AVC/HEVC + AAC) or WebM (VP8/VP9/AV1 + Opus/Vorbis). */
export type MuxContainer = "mp4" | "webm";

// yt-dlp and YouTube spell the same codecs differently: hvc1/bytevc1 are HEVC, vp09 is VP9.
const MP4_VIDEO_RE = /^(avc|h264|hev|h265|hvc1|bytevc1)/i;
const WEBM_VIDEO_RE = /^(vp8|vp08|vp9|vp09|av01|av1)/i;

/** Pure: the container `video` can be muxed into, or null when the phone cannot write it without re-encoding. */
export function muxContainerFor(video: StreamInfo): MuxContainer | null {
  const ext = (video.ext ?? "").toLowerCase();
  const codec = video.vcodec ?? "";
  if (MP4_VIDEO_RE.test(codec) && ext === "mp4") return "mp4";
  if (WEBM_VIDEO_RE.test(codec) && ext === "webm") return "webm";
  return null;
}

/** Pure: AAC in m4a/mp4, or Opus/Vorbis in webm/ogg. */
function muxableAudio(ext: string, codec: string): boolean {
  const e = ext.toLowerCase();
  if ((e === "m4a" || e === "mp4") && /^(mp4a|aac)/i.test(codec)) return true;
  if ((e === "webm" || e === "ogg") && /^(opus|vorbis)/i.test(codec)) return true;
  return false;
}

/** Pure: audio-only stream `a` can be muxed into `container` without re-encoding. */
function audioMatches(a: StreamInfo, container: MuxContainer): boolean {
  const ext = (a.ext ?? "").toLowerCase();
  if (container === "mp4") return (ext === "m4a" || ext === "mp4") && /^(mp4a|aac)/i.test(a.acodec ?? "");
  return (ext === "webm" || ext === "ogg") && /^(opus|vorbis)/i.test(a.acodec ?? "");
}

/** Audio ranking: bitrate (abr for audio-only streams) when present, then size. */
const byAudioQuality = (a: StreamInfo, b: StreamInfo) => (b.bitrate ?? 0) - (a.bitrate ?? 0) || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);

/** Best audio-only stream that can be muxed into `container` (bitrate, then size), or undefined. */
export function audioForContainer(info: VideoInfo, container: MuxContainer): StreamInfo | undefined {
  return info.streams.filter((s) => s.kind === "audio-only" && audioMatches(s, container)).toSorted(byAudioQuality)[0];
}

/** Extension of the file the native muxer writes for `video` in `container`: AV1 always goes to MP4. */
export function muxOutputExt(video: StreamInfo, container: MuxContainer): MuxContainer {
  return /^av0?1/i.test(video.vcodec ?? "") ? "mp4" : container;
}

/** What one listed height resolves to. Shared by the picker list (formats.ts) and pickYtdlpFormat. */
export interface HeightStream {
  /** The progressive or video-only stream for this height. */
  video: StreamInfo;
  /** Audio-only stream to mux with `video`; set exactly when `video` is video-only. */
  audio?: StreamInfo;
  /** Container shown in the picker row: the muxable one, else mp4/webm from the file's own ext (progressive). */
  container: MuxContainer;
  /** Extension of the file actually saved: a progressive file's own ext, or muxOutputExt for a muxed pair. */
  outExt: string;
}

/**
 * Ranks streams of the same height (negative = `a` is better): non-watermarked first, then progressive, fps,
 * bitrate (tbr), size. Watermarked streams are demoted, never dropped.
 */
function sameHeightRank(info: VideoInfo): (a: StreamInfo, b: StreamInfo) => number {
  const marked = watermarked.get(info);
  const isMarked = (s: StreamInfo) => !!marked?.has(s.id) || /^download/i.test(s.id);
  return (a, b) =>
    Number(isMarked(a)) - Number(isMarked(b)) ||
    Number(b.kind === "progressive") - Number(a.kind === "progressive") ||
    (b.fps ?? 0) - (a.fps ?? 0) ||
    (b.bitrate ?? 0) - (a.bitrate ?? 0) ||
    (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
}

/**
 * Pure, single source of truth: the best stream per height that the phone can save. Progressive streams are copied
 * as-is (any codec, e.g. TikTok's bytevc1). A video-only stream counts only when the native muxer can write its
 * codec/container and a matching audio-only stream exists (AAC for mp4, Opus/Vorbis for webm). Heightless streams
 * are not listed. The picker lists exactly these heights and pickYtdlpFormat (non-YouTube) downloads exactly these.
 */
export function bestStreamsByHeight(info: VideoInfo): Map<number, HeightStream> {
  const rank = sameHeightRank(info);
  const audio: Record<MuxContainer, StreamInfo | undefined> = {
    mp4: audioForContainer(info, "mp4"),
    webm: audioForContainer(info, "webm"),
  };
  const byHeight = new Map<number, HeightStream>();
  for (const s of info.streams) {
    if (s.kind === "audio-only" || !s.height) continue;
    let entry: HeightStream;
    if (s.kind === "video-only") {
      const container = muxContainerFor(s);
      const a = container ? audio[container] : undefined;
      if (!container || !a) continue;
      entry = { video: s, audio: a, container, outExt: muxOutputExt(s, container) };
    } else {
      const container = muxContainerFor(s) ?? ((s.ext ?? "").toLowerCase() === "webm" ? "webm" : "mp4");
      entry = { video: s, container, outExt: s.ext || "mp4" };
    }
    const prev = byHeight.get(s.height);
    if (!prev || rank(s, prev.video) < 0) byHeight.set(s.height, entry);
  }
  return byHeight;
}

const isYouTubeInfo = (info: VideoInfo) => info.site === "youtube" || isAndroidYouTubeYtdlpHost(info.url);

/**
 * TikTok / Instagram / other non-YouTube pick: the highest height from bestStreamsByHeight at or below `limit`, and
 * exactly the stream listed for it (no list/pick disagreement). The best progressive stream at or below that height,
 * when it is a different file, is kept as the error-only fallback.
 */
function pickVideoGeneric(info: VideoInfo, limit: number): YtdlpPick | null {
  const byHeight = bestStreamsByHeight(info);
  const height = [...byHeight.keys()].filter((h) => h <= limit).toSorted((a, b) => b - a)[0];
  const hs = height === undefined ? undefined : byHeight.get(height);
  if (height === undefined || !hs) return null;
  const s = hs.video;
  const rank = sameHeightRank(info);
  const fb = info.streams
    .filter((p) => p.kind === "progressive" && (p.height ?? 0) <= height)
    .toSorted((a, b) => (b.height ?? 0) - (a.height ?? 0) || rank(a, b))[0];
  const fallback = fb && fb.id !== s.id ? { formatId: fb.id, ext: fb.ext } : undefined;
  const pick: YtdlpPick = { formatId: s.id, ext: hs.outExt, needsRemux: false, height, sizeBytes: s.sizeBytes, fallback };
  if (hs.audio) {
    pick.ext = hs.container;
    pick.audioFormatId = hs.audio.id;
    pick.muxExt = muxOutputExt(s, hs.container);
  }
  return pick;
}

/**
 * YouTube video pick. Every muxable stream (progressive or video-only) up to `limit` is eligible: AVC/HEVC in mp4
 * and VP8/VP9/AV1 in webm. A video-only pick is paired with the best audio-only stream that fits the same container
 * (AAC for mp4, Opus/Vorbis for webm) and handed to the native muxer, so no re-encoding happens.
 * Ranking: height, fps, bitrate, prefer progressive, size. A lower progressive stream is kept as a fallback.
 */
/** Ranking for YouTube video candidates: height, fps, bitrate, then prefer progressive, then size. */
const byQuality = (a: StreamInfo, b: StreamInfo) =>
  (b.height ?? 0) - (a.height ?? 0) ||
  (b.fps ?? 0) - (a.fps ?? 0) ||
  (b.bitrate ?? 0) - (a.bitrate ?? 0) ||
  Number(a.kind === "video-only") - Number(b.kind === "video-only") ||
  (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);

function pickVideoYouTube(info: VideoInfo, limit: number): YtdlpPick | null {
  const audio = { mp4: audioForContainer(info, "mp4"), webm: audioForContainer(info, "webm") };
  const candidates: { s: StreamInfo; c: MuxContainer; a?: StreamInfo }[] = [];
  for (const s of info.streams) {
    if (s.kind === "audio-only" || (s.height ?? 0) > limit) continue;
    const c = muxContainerFor(s);
    if (!c) continue;
    if (s.kind === "video-only") {
      const a = audio[c];
      if (!a) continue;
      candidates.push({ s, c, a });
    } else {
      candidates.push({ s, c });
    }
  }
  const best = candidates.toSorted((x, y) => byQuality(x.s, y.s))[0];
  if (!best) return null;

  const prog = candidates
    .filter((x) => x.s.kind === "progressive" && (x.s.height ?? 0) < (best.s.height ?? 0))
    .toSorted((x, y) => byQuality(x.s, y.s))[0];
  const pick: YtdlpPick = {
    formatId: best.s.id,
    ext: best.c,
    needsRemux: false,
    height: best.s.height,
    sizeBytes: best.s.sizeBytes,
    fallback: prog ? { formatId: prog.s.id, ext: prog.c } : undefined,
  };
  if (best.a) {
    pick.audioFormatId = best.a.id;
    pick.muxExt = muxOutputExt(best.s, best.c);
  }
  return pick;
}

/** Pure: UI formatId ("video:<h>" | "video:best" | "audio:m4a") -> concrete yt-dlp format, or null when nothing fits. */
export function pickYtdlpFormat(info: VideoInfo, uiFormatId: string): YtdlpPick | null {
  if (info.source !== "ytdlp") return null;
  const [kind, arg] = uiFormatId.split(":");
  if (kind === "video") {
    const limit = arg === "best" ? 100000 : /^\d+$/.test(arg ?? "") ? Number(arg) : 0;
    if (limit <= 0) return null;
    return isYouTubeInfo(info) ? pickVideoYouTube(info, limit) : pickVideoGeneric(info, limit);
  }
  if (uiFormatId === "audio:m4a") {
    const best = info.streams.filter((s) => s.kind === "audio-only" && s.ext === "m4a").toSorted(byAudioQuality)[0];
    if (best) return { formatId: best.id, ext: "m4a", needsRemux: false, sizeBytes: best.sizeBytes };
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
  "music.youtube.com",
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

/**
 * Pure: keep only YouTube formats the phone can mux without ffmpeg: AVC/HEVC in mp4 and VP8/VP9/AV1 in webm,
 * with AAC audio in m4a/mp4 or Opus/Vorbis audio in webm/ogg. pickYtdlpFormat then takes the highest height.
 */
export function filterYouTubeMuxableFormats(info: YtdlpInfo): YtdlpInfo {
  const formats = info.formats.filter((f) => {
    const v = f.vcodec && f.vcodec !== "none" ? f.vcodec : null;
    const a = f.acodec && f.acodec !== "none" ? f.acodec : null;
    if (!v && !a) return false;
    if (v && !muxContainerFor({ id: f.format_id, kind: "video-only", ext: f.ext, vcodec: v })) return false;
    if (a && !muxableAudio(f.ext ?? "", a)) return false;
    return true;
  });
  return { ...info, formats };
}

/** Back-compat alias: the filter now keeps every container the native muxer can write, not only MP4. */
export const filterYouTubeMp4Formats = filterYouTubeMuxableFormats;

/**
 * Invokes ytdlp_info for a YouTube link (Android only) and returns muxable formats (source "ytdlp").
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
  const raw = r.info as YtdlpInfo;
  const out = ytdlpInfoToVideoInfo(filterYouTubeMuxableFormats(raw), url);
  // Kept for formats.ts consumers; the higher heights are no longer dropped, so nothing reads a "desktop only" note.
  rawMaxHeight.set(out, Math.max(0, ...raw.formats.map((f) => (f.vcodec && f.vcodec !== "none" ? f.height ?? 0 : 0))));
  return out;
}
