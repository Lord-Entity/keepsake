/**
 * FormatPicker options (UI_CONTENT.md section 2).
 * Every option listed here is one the engine can produce on the current platform; nothing is shown greyed out
 * for platform reasons.
 * - Desktop (yt-dlp + ffmpeg): every height the link offers (yt-dlp merges), all audio formats, all thumbnails.
 * - Android (youtubei.js + keepsake-media plugin): progressive MP4 at or below 360p (no merging), audio M4A
 *   (default, no conversion) and WAV (AAC decoded to PCM). MP3, FLAC and Opus need encoders Android does not ship yet.
 * - Android, TikTok/Instagram (yt-dlp via Chaquopy, info.source === "ytdlp"): any height (muxed or merged on device,
 *   no 360 cap), audio M4A and WAV (MP3 shown disabled), no thumbnails.
 * - Web (dev preview without Tauri): progressive MP4 at or below 360p and thumbnails; no audio (nothing can extract
 *   or convert it in the browser).
 */
import type { AudioFormat, FormatOption, Platform, ThumbnailFormat, VideoInfo } from "../lib/types";
import { pickYtdlpFormat, rawMaxHeight } from "./android-ytdlp";
import { platform } from "./platform";

/** Heights offered when the link gives none (playlists): 2160 down to 360 per spec. */
const PLAYLIST_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
/** Android/web download one progressive stream (ANDROID itag 18 is the one that works without a PO token). */
const SINGLE_FILE_MAX_HEIGHT = 360;

function heightName(h: number): string {
  if (h >= 4320) return "8K";
  if (h >= 2160) return "4K";
  if (h >= 1440) return "QHD";
  if (h >= 1080) return "Full HD";
  if (h >= 720) return "HD";
  return "";
}

export function qualityLabel(h: number, fps?: number): string {
  const f = fps && fps > 30 ? String(Math.round(fps)) : "";
  const name = heightName(h);
  return `${h}p${f}${name ? ` ${name}` : ""}`;
}

const AUDIO_LABEL: Record<AudioFormat, string> = { mp3: "MP3", m4a: "M4A", opus: "OPUS", wav: "WAV", flac: "FLAC" };

/** Audio formats each platform can produce, in picker order. The first entry is the default. */
const AUDIO_BY_PLATFORM: Record<Platform, AudioFormat[]> = {
  windows: ["mp3", "m4a", "opus", "wav", "flac"],
  linux: ["mp3", "m4a", "opus", "wav", "flac"],
  android: ["m4a", "wav"],
  web: [],
};

const THUMBS: { f: ThumbnailFormat; label: string; ext: string }[] = [
  { f: "original", label: "Original (WebP/JPG)", ext: "webp" },
  { f: "png", label: "PNG", ext: "png" },
  { f: "jpg", label: "JPG", ext: "jpg" },
];

function isDesktopPlatform(p: Platform): boolean {
  return p === "windows" || p === "linux";
}

function placeholderRow(h: number, needsMerge: boolean, disabledReason: string): FormatOption {
  return {
    id: `video:${h}`,
    mode: "video",
    label: qualityLabel(h),
    height: h,
    ext: "mp4",
    isDefault: false,
    needsMerge,
    needsConversion: false,
    disabledReason,
  };
}

/** Desktop: every height plus "Best available"; yt-dlp merges video-only streams with audio. */
function desktopVideoOptions(info: VideoInfo): FormatOption[] {
  const heights = [...new Set(info.heights.length ? info.heights : info.kind === "playlist" ? PLAYLIST_HEIGHTS : [])].toSorted(
    (a, b) => b - a,
  );
  const progressive = new Set(info.streams.filter((s) => s.kind === "progressive" && s.height).map((s) => s.height!));
  const opts: FormatOption[] = heights.map((h) => ({
    id: `video:${h}`,
    mode: "video",
    label: qualityLabel(h, info.fpsByHeight[h]),
    height: h,
    fps: info.fpsByHeight[h] || undefined,
    ext: "mp4",
    isDefault: false,
    needsMerge: !progressive.has(h),
    needsConversion: false,
  }));
  const best: FormatOption = {
    id: "video:best",
    mode: "video",
    label: "Best available",
    ext: "mp4",
    isDefault: false,
    needsMerge: true,
    needsConversion: false,
  };
  // Default: highest <= 1080, else Best available.
  const def = opts.find((o) => (o.height ?? 0) <= 1080);
  if (def) def.isDefault = true;
  else best.isDefault = true;
  return [best, ...opts];
}

/** Android/web: only progressive (video + audio) streams at or below 360p; no merging, no "Best available". */
function singleFileVideoOptions(info: VideoInfo): FormatOption[] {
  const heights = [
    ...new Set(
      info.streams
        .filter((s) => s.kind === "progressive" && s.height && s.height <= SINGLE_FILE_MAX_HEIGHT)
        .map((s) => s.height!),
    ),
  ].toSorted((a, b) => b - a);
  if (heights.length === 0) {
    return [placeholderRow(SINGLE_FILE_MAX_HEIGHT, false, "No single-file video for this link")];
  }
  return heights.map((h, i) => ({
    id: `video:${h}`,
    mode: "video",
    label: qualityLabel(h, info.fpsByHeight[h]),
    height: h,
    fps: info.fpsByHeight[h] || undefined,
    ext: "mp4",
    isDefault: i === 0,
    needsMerge: false,
    needsConversion: false,
  }));
}

function videoOptions(info: VideoInfo | null | undefined, p: Platform): FormatOption[] {
  const desktop = isDesktopPlatform(p);
  if (!info) {
    const heights = desktop ? PLAYLIST_HEIGHTS : [SINGLE_FILE_MAX_HEIGHT];
    return heights.map((h) => placeholderRow(h, desktop, "Fetch a video first"));
  }
  if (!info.hasVideo) return [];
  return desktop ? desktopVideoOptions(info) : singleFileVideoOptions(info);
}

function audioOptions(p: Platform): FormatOption[] {
  const formats = AUDIO_BY_PLATFORM[p];
  return formats.map((f, i) => ({
    id: `audio:${f}`,
    mode: "audio" as const,
    label: AUDIO_LABEL[f],
    audioFormat: f,
    ext: f,
    isDefault: i === 0,
    needsMerge: false,
    // M4A is the native AAC stream (desktop: no -x when the link has one; Android: remux only).
    // Others: yt-dlp + ffmpeg on desktop; WAV via the keepsake-media plugin on Android.
    needsConversion: f !== "m4a",
  }));
}

function thumbOptions(): FormatOption[] {
  return THUMBS.map(({ f, label, ext }) => ({
    id: `thumb:${f}`,
    mode: "thumbnail" as const,
    label,
    thumbnailFormat: f,
    ext,
    isDefault: f === "original",
    needsMerge: false,
    needsConversion: f !== "original",
  }));
}

const YT_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** AVC (H.264) video that the phone can mux as MP4. */
const isAvc = (s: { vcodec?: string; ext?: string }) => /^(avc|h264)/i.test(s.vcodec ?? "") && (!s.ext || s.ext === "mp4");

/**
 * Android, TikTok/Instagram (yt-dlp via Chaquopy): single-file http(s) streams only, no height cap, M4A as the only
 * audio option, no thumbnails. YouTube links: AVC MP4 heights <= 1080 only, plus a "desktop app" note row.
 */
function androidYtdlpOptions(info: VideoInfo): FormatOption[] {
  const out: FormatOption[] = [];
  const progressive = new Set(info.streams.filter((s) => s.kind === "progressive" && s.height).map((s) => s.height!));
  const hasAudioOnly = info.streams.some((s) => s.kind === "audio-only");
  // Video-only heights are usable only when a separate audio stream exists to merge with.
  // YouTube: the phone muxes MP4 with AVC only, so keep AVC heights <= 1080 (VP9/AV1 above that is desktop-only).
  const yt = YT_HOSTS.has(hostOf(info.url).toLowerCase());
  const videoOnlyStreams = hasAudioOnly ? info.streams.filter((s) => s.kind === "video-only" && s.height) : [];
  const videoOnly = videoOnlyStreams.filter((s) => !yt || (isAvc(s) && s.height! <= 1080)).map((s) => s.height!);
  const heights = [...new Set([...progressive, ...videoOnly])]
    .filter((h) => !yt || h <= 1080)
    .toSorted((a, b) => b - a);
  // VP9/AV1 streams above 1080 were filtered out before this info reached here, so read the raw height.
  const hiddenHigh = yt && (rawMaxHeight.get(info) ?? 0) > 1080;
  if (heights.length > 0) {
    // Default: highest <= 1080, else the lowest available (closest to 1080).
    const found = heights.findIndex((h) => h <= 1080);
    const defIdx = found >= 0 ? found : heights.length - 1;
    heights.forEach((h, i) =>
      out.push({
        id: `video:${h}`,
        mode: "video",
        label: qualityLabel(h, info.fpsByHeight[h]),
        height: h,
        fps: info.fpsByHeight[h] || undefined,
        ext: "mp4",
        isDefault: i === defIdx,
        needsMerge: !progressive.has(h),
        needsConversion: false,
      }),
    );
    if (hiddenHigh) {
      const reason = "1440p and 4K need the desktop app";
      out.push({
        id: "video:desktop-only",
        mode: "video",
        label: reason,
        ext: "mp4",
        isDefault: false,
        needsMerge: false,
        needsConversion: false,
        disabledReason: reason,
      });
    }
  } else {
    let path = "";
    try {
      path = new URL(info.url).pathname;
    } catch {
      /* ignore */
    }
    const photo = !info.hasVideo && (info.thumbnails.length > 0 || path.startsWith("/p/"));
    const reason = photo
      ? "This post has photos, not a video. Save images with the desktop app."
      : "No video we can save on Android for this link. Try Audio, or use the desktop app.";
    out.push({
      id: "video:none",
      mode: "video",
      label: reason,
      ext: "mp4",
      isDefault: false,
      needsMerge: false,
      needsConversion: false,
      disabledReason: reason,
    });
  }
  const pick = pickYtdlpFormat(info, "audio:m4a");
  out.push({
    id: "audio:m4a",
    mode: "audio",
    label: AUDIO_LABEL.m4a,
    audioFormat: "m4a",
    ext: "m4a",
    isDefault: !!pick,
    needsMerge: false,
    needsConversion: !!pick?.needsRemux,
    ...(pick ? {} : { disabledReason: "No AAC audio in this link" }),
  });
  out.push({
    id: "audio:mp3",
    mode: "audio",
    label: AUDIO_LABEL.mp3,
    audioFormat: "mp3",
    ext: "mp3",
    isDefault: false,
    needsMerge: false,
    needsConversion: true,
    disabledReason: "MP3 needs the desktop app.",
  });
  out.push({
    id: "audio:wav",
    mode: "audio",
    label: AUDIO_LABEL.wav,
    audioFormat: "wav",
    ext: "wav",
    isDefault: false,
    needsMerge: false,
    needsConversion: true,
  });
  return out;
}

/** All picker options for a fetched link (or the pre-fetch placeholders when `info` is null). */
export function listFormats(info: VideoInfo | null | undefined): FormatOption[] {
  const p = platform();
  if (p === "android" && info?.source === "ytdlp") return androidYtdlpOptions(info);
  return [...videoOptions(info, p), ...audioOptions(p), ...thumbOptions()];
}
