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
 * Legacy route (TikTok / Instagram, and YouTube when the self-contained route is not ready): only single http(s)
 * files are offered (no HLS/DASH) and video-only + audio-only pairs are merged by the native muxer. For TikTok /
 * Instagram the dropped HLS/DASH formats are kept privately (hiddenStreams) and ytdlpAlternatives lists the next-best
 * concrete formats for download.ts's workaround ladder (used only after the first attempt fails).
 * Self-contained route (plan-docs 11, YouTube only in this release): `ytdlp_status` reports the bundled QuickJS-NG,
 * EJS solver and ffmpeg; `ytdlp_info { url, full: true }` keeps every format; `ytdlp_download { url, args, full }`
 * lets yt-dlp select and merge with its own ffmpeg.
 *   command "ytdlp_status",   args {},                                         resolves YtdlpStatus
 * cookiesHint is always false here because Android has no Settings > Cookies. Must not import download.ts,
 * index.ts or formats.ts (no cycles).
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

/**
 * Extra codes the self-contained route can send (plan-docs 11 section 3.7). Kept out of YTDLP_ERROR_CODES so that
 * list stays the legacy contract; mapYtdlpError accepts both.
 */
export const YTDLP_FULL_ERROR_CODES: readonly string[] = ["js_runtime_missing", "ytdlp_missing", "bot_check"];

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
  js_runtime_missing: "Keepsake's built-in YouTube helper couldn't start. Reinstall Keepsake.",
  ytdlp_missing: "Keepsake's built-in downloader tools are missing or damaged. Reinstall Keepsake.",
  bot_check: "YouTube asked to confirm you're not a bot. Try again later or use the desktop app.",
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

/** Instagram part of ANDROID_YTDLP_HOSTS (exact host or any subdomain). */
const INSTAGRAM_HOSTS: readonly string[] = ["instagram.com", "instagr.am"];

/** Pure: isAndroidYtdlpHost(url) and the host is Instagram. Gates every Instagram-only rule below. */
export function isInstagramHost(url: string): boolean {
  if (!isAndroidYtdlpHost(url)) return false;
  const h = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  return INSTAGRAM_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

const isInstagramInfo = (info: VideoInfo) => isInstagramHost(info.url);

/** platform() === "android" && isAndroidYtdlpHost(url). */
export function isAndroidYtdlpSupported(url: string): boolean {
  return platform() === "android" && isAndroidYtdlpHost(url);
}

/** format_ids marked as watermarked, per converted info (format_note is not part of StreamInfo). */
const watermarked = new WeakMap<VideoInfo, Set<string>>();

/**
 * Non-YouTube legacy infos only: the formats the http-only filter dropped (HLS/DASH), kept privately for the
 * download workaround ladder (download.ts) and the picker's HLS-only row. Never part of `info.streams`, so the
 * primary pick and the listed heights do not see them.
 */
const hidden = new WeakMap<VideoInfo, StreamInfo[]>();

/** Pure: one reduced yt-dlp format -> StreamInfo. `kindOverride`: Instagram only (instagramKind). */
function toStream(f: YtdlpFormat, kindOverride?: StreamInfo["kind"]): StreamInfo {
  const kind = kindOverride ?? (f.vcodec === "none" ? "audio-only" : f.acodec === "none" ? "video-only" : "progressive");
  // Audio-only streams rank by audio bitrate; video streams by total bitrate.
  const bitrate = kind === "audio-only" ? (f.abr ?? f.tbr) : (f.tbr ?? f.abr);
  return {
    id: f.format_id,
    kind,
    ext: f.ext || "mp4",
    height: f.height ?? undefined,
    fps: f.fps ?? undefined,
    vcodec: f.vcodec && f.vcodec !== "none" ? f.vcodec : undefined,
    acodec: f.acodec && f.acodec !== "none" ? f.acodec : undefined,
    sizeBytes: f.filesize ?? undefined,
    ...(typeof bitrate === "number" && Number.isFinite(bitrate) ? { bitrate } : {}),
  };
}

/**
 * Instagram only: a format with no codec at all (yt-dlp leaves both null when the DASH manifest or the API omits
 * them) is classified by its ext / format_note ("DASH audio", "DASH video") instead of being taken as progressive.
 */
function instagramKind(f: YtdlpFormat): StreamInfo["kind"] | undefined {
  if (f.vcodec || f.acodec) return undefined;
  const note = f.format_note ?? "";
  if (/^(m4a|aac|mp3|opus|ogg|oga)$/i.test(f.ext ?? "") || /\baudio\b/i.test(note)) return "audio-only";
  if (/\bvideo\b/i.test(note)) return "video-only";
  return undefined;
}

/** Instagram only: toStream with instagramKind, and a missing height taken from format_note ("720p", "1080p60"). */
function toInstagramStream(f: YtdlpFormat): StreamInfo {
  const s = toStream(f, instagramKind(f));
  if (s.kind !== "audio-only" && s.height === undefined) {
    const m = /(?:^|\D)(\d{3,4})p(?:\d{2,3})?\b/i.exec(f.format_note ?? "");
    if (m) s.height = Number(m[1]);
  }
  return s;
}

/**
 * Pure: reduced yt-dlp info -> VideoInfo (source "ytdlp"). Legacy: drops formats whose protocol is not http/https
 * (for non-YouTube links a private copy is kept, see hiddenStreams). `full` (self-contained route): keeps HLS/DASH
 * formats too (yt-dlp downloads and ffmpeg merges them) and marks the result `ytdlpFull: true`.
 */
export function ytdlpInfoToVideoInfo(info: YtdlpInfo, requestedUrl: string, opts: { full?: boolean } = {}): VideoInfo {
  const full = opts.full === true;
  const marked = new Set<string>();
  const streams: StreamInfo[] = [];
  const dropped: StreamInfo[] = [];
  // Instagram only: codec-less formats are classified by ext / note, heights come from format_note when missing, and
  // http_dash_segments formats stay listable (one concrete format_id downloads through yt-dlp's native DashSegmentsFD,
  // no ffmpeg). TikTok / YouTube: unchanged.
  const ig = isInstagramHost(info.webpage_url || requestedUrl);
  const conv = ig ? toInstagramStream : (f: YtdlpFormat) => toStream(f);
  for (const f of info.formats) {
    if (f.vcodec === "none" && f.acodec === "none") continue;
    if (!full && f.protocol !== "https" && f.protocol !== "http" && !(ig && f.protocol === "http_dash_segments")) {
      dropped.push(conv(f));
      continue;
    }
    if ((f.format_note && /watermark/i.test(f.format_note)) || /^download/i.test(f.format_id)) marked.add(f.format_id);
    streams.push(conv(f));
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
    ...(full ? { ytdlpFull: true } : {}),
  };
  watermarked.set(out, marked);
  if (dropped.length > 0 && !isYouTubeInfo(out)) {
    hidden.set(out, dropped);
    // HLS/DASH-only video post (TikTok / Instagram): still a video; the full yt-dlp route can save it.
    if (!hasVideo && dropped.some((s) => s.kind !== "audio-only")) {
      out.hasVideo = true;
      out.kind = "video";
    }
  }
  return out;
}

/**
 * Formats the legacy info dropped (HLS/DASH) for a non-YouTube link; empty for YouTube, full infos, infos that were
 * copied (the store is keyed by object) and infos with nothing dropped.
 */
export function hiddenStreams(info: VideoInfo): readonly StreamInfo[] {
  return hidden.get(info) ?? [];
}

/** Drops the private HLS/DASH copy (index.ts: the full route is not ready, so the "Best available" row would be a dead end). */
export function forgetHiddenStreams(info: VideoInfo): void {
  hidden.delete(info);
}

/**
 * Instagram only (index.ts, full route ready): nothing is listable on the phone (e.g. VP9-in-MP4 DASH video, which
 * the native muxer cannot pair with AAC) but video streams exist, so hand them to the full route: they join the
 * private copy, the picker shows its "Best available" row and the ladder reaches the bundled-ffmpeg step.
 * No-op for any other host or when a height is listable.
 */
export function offerInstagramFullRoute(info: VideoInfo): void {
  if (info.source !== "ytdlp" || !isInstagramInfo(info) || bestStreamsByHeight(info).size > 0) return;
  const video = info.streams.filter((s) => s.kind !== "audio-only");
  if (video.length === 0) return;
  const prev = hidden.get(info) ?? [];
  hidden.set(info, [...prev, ...video.filter((s) => !prev.some((p) => p.id === s.id))]);
}

/**
 * Instagram only: no listable height, but the legacy route still has concrete things to try for "video:best"
 * (heightless progressive files, or pairs the native muxer may accept). formats.ts then offers one "Best available"
 * row; the ladder tries those (path A) and then the full route when it is ready (path B). False for any other host.
 */
export function instagramBestFallback(info: VideoInfo): boolean {
  if (info.source !== "ytdlp" || !isInstagramInfo(info) || bestStreamsByHeight(info).size > 0) return false;
  const alts = ytdlpAlternatives(info, "video:best", null);
  return alts.clean.length + alts.watermarked.length > 0;
}

/**
 * Instagram only: video streams exist but none can be saved without the bundled ffmpeg (typically VP9-in-MP4 DASH
 * with AAC audio) and the full route did not take them. formats.ts shows a specific disabled row instead of the
 * generic "No video" one. False for any other host.
 */
export function instagramNeedsFullEngine(info: VideoInfo): boolean {
  if (info.source !== "ytdlp" || !isInstagramInfo(info)) return false;
  return info.streams.some((s) => s.kind !== "audio-only") && !instagramBestFallback(info) && bestStreamsByHeight(info).size === 0;
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

/**
 * Instagram only: muxContainerFor, plus MP4 for a video-only MP4 whose codec name is missing or not one we map
 * (yt-dlp leaves vcodec null on API video_versions; AV1 in MP4 is written by KeepsakeMux on API 29+). The native
 * muxer probes the real codec, and a refusal sends the ladder on. VP8/VP9 in MP4 stays null: KeepsakeMux can only
 * write VP9 into WebM, and WebM cannot hold Instagram's AAC, so that pair is left to the full route.
 */
function instagramMuxContainer(video: StreamInfo): MuxContainer | null {
  const strict = muxContainerFor(video);
  if (strict) return strict;
  if ((video.ext ?? "").toLowerCase() !== "mp4") return null;
  return /^(vp8|vp08|vp9|vp09)/i.test(video.vcodec ?? "") ? null : "mp4";
}

/** Instagram only: AAC audio for MP4, accepting an m4a/mp4 audio-only stream whose codec name is missing. */
function instagramAudioMatches(a: StreamInfo, container: MuxContainer): boolean {
  if (audioMatches(a, container)) return true;
  const ext = (a.ext ?? "").toLowerCase();
  return container === "mp4" && !a.acodec && (ext === "m4a" || ext === "mp4");
}

/** Instagram audio ranking: a named AAC codec before a missing one, then byAudioQuality. */
const igAudioRank = (a: StreamInfo, b: StreamInfo) => Number(!a.acodec) - Number(!b.acodec) || byAudioQuality(a, b);

/** Instagram only: a stream listed on a guess (unnamed or AV1-in-MP4 codec) ranks below a confident one. */
const igGuessed = (s: StreamInfo) => s.kind === "video-only" && muxContainerFor(s) === null;

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

/** Instagram only: audioForContainer with instagramAudioMatches (named AAC first). */
function instagramAudioFor(info: VideoInfo, container: MuxContainer): StreamInfo | undefined {
  return info.streams.filter((s) => s.kind === "audio-only" && instagramAudioMatches(s, container)).toSorted(igAudioRank)[0];
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
  const ig = isInstagramInfo(info);
  const base = sameHeightRank(info);
  const rank = ig ? (a: StreamInfo, b: StreamInfo) => Number(igGuessed(a)) - Number(igGuessed(b)) || base(a, b) : base;
  const audio: Record<MuxContainer, StreamInfo | undefined> = {
    mp4: ig ? instagramAudioFor(info, "mp4") : audioForContainer(info, "mp4"),
    webm: audioForContainer(info, "webm"),
  };
  const containerOf = ig ? instagramMuxContainer : muxContainerFor;
  const byHeight = new Map<number, HeightStream>();
  for (const s of info.streams) {
    if (s.kind === "audio-only" || !s.height) continue;
    let entry: HeightStream;
    if (s.kind === "video-only") {
      const container = containerOf(s);
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

/** Identity of a concrete attempt: "<video or single id>+<audio id or empty>". */
export const ytdlpPickKey = (p: Pick<YtdlpPick, "formatId" | "audioFormatId">): string => `${p.formatId}+${p.audioFormatId ?? ""}`;

/** Concrete alternatives for the download workaround ladder (download.ts), split by watermark. */
export interface YtdlpAlternatives {
  /** Non-watermarked, best first: single files (progressive, or audio-only for audio), then muxable pairs. */
  clean: YtdlpPick[];
  /** Watermarked versions (TikTok "download" ids or a "watermark" note), same order. Tried only after every other step. */
  watermarked: YtdlpPick[];
}

/**
 * Pure, TikTok / Instagram / other non-YouTube legacy infos only (YouTube and non-ytdlp infos give two empty
 * lists): every concrete format worth trying after `primary` (the pickYtdlpFormat result, or null) failed.
 * The primary itself is left out. Video ("video:<h>" | "video:best"): progressive files at or below the primary's
 * height (or the requested limit), highest first, streams with a known audio codec before unknown ones; heightless
 * progressive files after those; then video-only + audio-only pairs the native muxer accepts (every matching audio,
 * best first). Audio ("audio:m4a"): the other audio-only M4A streams, then progressive MP4s (AAC or unknown audio
 * codec) for a remux. Only http(s) formats from `info.streams`; HLS/DASH are left to the full yt-dlp route.
 */
export function ytdlpAlternatives(info: VideoInfo, uiFormatId: string, primary: YtdlpPick | null): YtdlpAlternatives {
  const out: YtdlpAlternatives = { clean: [], watermarked: [] };
  if (info.source !== "ytdlp" || isYouTubeInfo(info)) return out;
  const marked = watermarked.get(info);
  const isMarked = (s: StreamInfo) => !!marked?.has(s.id) || /^download/i.test(s.id);
  const rank = sameHeightRank(info);
  const seen = new Set<string>(primary ? [ytdlpPickKey(primary)] : []);
  const add = (s: StreamInfo, p: YtdlpPick) => {
    const key = ytdlpPickKey(p);
    if (seen.has(key)) return;
    seen.add(key);
    (isMarked(s) ? out.watermarked : out.clean).push(p);
  };
  // Known heights first (highest first), heightless last; same height: known audio codec, then the picker's rank.
  const byHeightThenRank = (a: StreamInfo, b: StreamInfo) =>
    Number(a.height === undefined) - Number(b.height === undefined) ||
    (b.height ?? 0) - (a.height ?? 0) ||
    Number(!a.acodec) - Number(!b.acodec) ||
    rank(a, b);

  const [kind, arg] = uiFormatId.split(":");
  if (kind === "video") {
    const limit = arg === "best" ? 100000 : /^\d+$/.test(arg ?? "") ? Number(arg) : 0;
    if (limit <= 0) return out;
    const cap = Math.min(limit, primary?.height ?? limit);
    const fits = (s: StreamInfo) => s.height === undefined || s.height <= cap;
    const progressive = info.streams.filter((s) => s.kind === "progressive" && fits(s)).toSorted(byHeightThenRank);
    for (const s of progressive) add(s, { formatId: s.id, ext: s.ext || "mp4", needsRemux: false, height: s.height, sizeBytes: s.sizeBytes });
    const videoOnly = info.streams.filter((s) => s.kind === "video-only" && fits(s)).toSorted(byHeightThenRank);
    // Instagram: the same relaxed container / audio rules as bestStreamsByHeight. Others: unchanged.
    const ig = isInstagramInfo(info);
    for (const v of videoOnly) {
      const container = ig ? instagramMuxContainer(v) : muxContainerFor(v);
      if (!container) continue;
      const audios = ig
        ? info.streams.filter((s) => s.kind === "audio-only" && instagramAudioMatches(s, container)).toSorted(igAudioRank)
        : info.streams.filter((s) => s.kind === "audio-only" && audioMatches(s, container)).toSorted(byAudioQuality);
      for (const a of audios) {
        add(v, {
          formatId: v.id,
          ext: container,
          needsRemux: false,
          height: v.height,
          sizeBytes: v.sizeBytes,
          audioFormatId: a.id,
          muxExt: muxOutputExt(v, container),
        });
      }
    }
    return out;
  }
  if (uiFormatId === "audio:m4a") {
    const audio = info.streams.filter((s) => s.kind === "audio-only" && s.ext === "m4a").toSorted(byAudioQuality);
    for (const s of audio) add(s, { formatId: s.id, ext: "m4a", needsRemux: false, sizeBytes: s.sizeBytes });
    const prog = info.streams
      .filter((s) => s.kind === "progressive" && s.ext === "mp4" && (!s.acodec || /^(mp4a|aac)/i.test(s.acodec)))
      .toSorted((a, b) => Number(!a.acodec) - Number(!b.acodec) || (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity));
    for (const s of prog) add(s, { formatId: s.id, ext: "mp4", needsRemux: true, height: s.height, sizeBytes: s.sizeBytes });
  }
  return out;
}

/** Any rejection text -> AppError. Never throws. */
export function mapYtdlpError(message: string): AppError {
  const text = typeof message === "string" ? message : rawText(message);
  const m = /ytdlp:([a-z_]+):\s*([\s\S]*)/.exec(text);
  if (m && (YTDLP_ERROR_CODES.includes(m[1]) || YTDLP_FULL_ERROR_CODES.includes(m[1]))) {
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

/**
 * Invokes ytdlp_download. Rejects with EngineError. Validates the response shape.
 * Exactly one of `formatId` (a concrete yt-dlp format id, legacy route) or `args` (selection argv from
 * ytdlp.ts selectionArgs, self-contained route) must be given; otherwise rejects "unknown" without invoking.
 * `full: true` asks the bridge to enable the bundled JS runtime and ffmpeg. Omitted keys are not sent, so a legacy
 * call sends exactly { url, formatId, outDir, fileName?, jobId } as before.
 */
export async function downloadAndroid(args: {
  url: string;
  formatId?: string;
  args?: string[];
  full?: boolean;
  outDir: string;
  fileName?: string;
  jobId?: string;
}): Promise<{ path: string; bytes: number }> {
  const hasFormat = typeof args.formatId === "string";
  const hasArgs = Array.isArray(args.args) && args.args.length > 0;
  if (hasFormat === hasArgs) {
    throw new EngineError({
      code: "unknown",
      message: ANDROID_TEXT.unknown,
      detail: "ytdlp_download needs exactly one of formatId or args",
      cookiesHint: false,
    });
  }
  let res: unknown;
  try {
    res = await invoke<unknown>("plugin:keepsake-media|ytdlp_download", {
      url: args.url,
      ...(hasFormat ? { formatId: args.formatId } : { args: [...(args.args ?? [])] }),
      outDir: args.outDir,
      ...(args.fileName ? { fileName: args.fileName } : {}),
      jobId: args.jobId ?? "job",
      ...(args.full === true ? { full: true } : {}),
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

/** Codes the TS side may retry once on top of the Python bridge's own ladder (never rate_limited: it already waited). */
export const TIKTOK_IG_TS_RETRY: ReadonlySet<string> = new Set(["network", "timeout"]);

/**
 * Run `fn`, retrying network / timeout / rate_limited failures (or `codes`) up to `retries` times with `delays` (ms)
 * between attempts (default 2 s then 6 s). Checks `signal` before every retry; an abort throws "cancelled".
 * TikTok / Instagram: the Python bridge already retries (3 attempts, one 8 s rate-limit wait), so the ladder passes
 * at most one extra TS attempt for network / timeout only (TIKTOK_IG_TS_RETRY).
 */
export async function runWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { signal?: AbortSignal; retries?: number; delays?: number[]; codes?: ReadonlySet<string> } = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  const delays = opts.delays ?? [2000, 6000];
  const retryable = opts.codes ?? RETRYABLE;
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw new EngineError(appError("cancelled"));
    try {
      return await fn(attempt);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (attempt >= retries || typeof code !== "string" || !retryable.has(code)) throw e;
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
 * Invokes ytdlp_info for a YouTube link (Android only), source "ytdlp". Rejects with EngineError. Callers fall back
 * to youtubei.js on any rejection other than "cancelled".
 * Legacy (`full` unset): sends { url } and keeps only formats the native muxer can write.
 * `full: true` (self-contained route): sends { url, full: true }, keeps every format (HLS/DASH included, no muxable
 * filter) and marks the info `ytdlpFull: true`.
 */
export async function fetchAndroidYouTubeInfo(url: string, signal?: AbortSignal, opts: { full?: boolean } = {}): Promise<VideoInfo> {
  const full = opts.full === true;
  if (platform() !== "android" || !isAndroidYouTubeYtdlpHost(url)) throw new EngineError(appError("unsupported_url", url));
  if (signal?.aborted) fail("cancelled");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new EngineError(appError("cancelled")));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  let res: unknown;
  try {
    res = await Promise.race([
      invoke<unknown>("plugin:keepsake-media|ytdlp_info", full ? { url, full: true } : { url }),
      aborted,
    ]);
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
  const out = full
    ? ytdlpInfoToVideoInfo(raw, url, { full: true })
    : ytdlpInfoToVideoInfo(filterYouTubeMuxableFormats(raw), url);
  // Kept for formats.ts consumers; the higher heights are no longer dropped, so nothing reads a "desktop only" note.
  rawMaxHeight.set(out, Math.max(0, ...raw.formats.map((f) => (f.vcodec && f.vcodec !== "none" ? f.height ?? 0 : 0))));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Self-contained route status (plan-docs 11 section 3.7).
// ---------------------------------------------------------------------------------------------------------------

/** Result of `ytdlp_status`: what the bundled yt-dlp found on this phone. Offline; no network. */
export interface YtdlpStatus {
  /** yt_dlp.version.__version__ */
  ytdlp: string;
  /** yt-dlp-ejs version, null when not importable. */
  ejs: string | null;
  /** JS runtime info, e.g. "quickjs-ng 0.18.0", null when not runnable. */
  jsRuntime: string | null;
  /** First line of `libffmpeg.so -version`, null when not runnable. */
  ffmpeg: string | null;
  /** All four present and the EJS version matches the pin. */
  ready: boolean;
  /** Short machine words, e.g. "qjs_missing", "ffmpeg_exec_denied", "ejs_missing". */
  problems: string[];
}

/** Cold status runs Python start-up plus two small processes; a hung bridge must not block YouTube fetches. */
const STATUS_TIMEOUT_MS = 30_000;

let statusPromise: Promise<YtdlpStatus | null> | undefined;

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** Pure: validates a raw `ytdlp_status` response. null when the shape is wrong. `ready` needs every part present. */
function parseStatus(res: unknown): YtdlpStatus | null {
  if (!res || typeof res !== "object") return null;
  const r = res as Record<string, unknown>;
  if (typeof r.ytdlp !== "string" || typeof r.ready !== "boolean") return null;
  const s: YtdlpStatus = {
    ytdlp: r.ytdlp,
    ejs: strOrNull(r.ejs),
    jsRuntime: strOrNull(r.jsRuntime),
    ffmpeg: strOrNull(r.ffmpeg),
    ready: false,
    problems: Array.isArray(r.problems) ? r.problems.filter((p): p is string => typeof p === "string").slice(0, 20) : [],
  };
  s.ready = r.ready === true && !!s.ytdlp && s.ejs !== null && s.jsRuntime !== null && s.ffmpeg !== null;
  return s;
}

async function loadStatus(): Promise<YtdlpStatus | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), STATUS_TIMEOUT_MS);
  });
  try {
    // invoke() can throw synchronously when the Tauri bridge is missing; the async wrapper catches that too.
    const res = await Promise.race([invoke<unknown>("plugin:keepsake-media|ytdlp_status", {}), timeout]);
    return parseStatus(res);
  } catch {
    // Old plugin without the command, missing permission, or a Python error: "not ready".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Status of the self-contained yt-dlp (Android only). Cached for the session; `refresh: true` asks again.
 * Resolves null off Android, on any error (old plugin, missing permission, bad response) and on timeout.
 * Never rejects.
 */
export function androidYtdlpStatus(opts: { refresh?: boolean } = {}): Promise<YtdlpStatus | null> {
  if (platform() !== "android") return Promise.resolve(null);
  if (opts.refresh === true || !statusPromise) statusPromise = loadStatus();
  return statusPromise;
}
