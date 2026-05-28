/**
 * FormatPicker options (UI_CONTENT.md section 2).
 * Every option listed here is one the engine can produce on the current platform; nothing is shown greyed out
 * for platform reasons.
 * - Desktop (yt-dlp + ffmpeg): every height the link offers (yt-dlp merges), all audio formats, all thumbnails.
 * - Android (youtubei.js + keepsake-media plugin): every height that has a muxable video stream; the native mux
 *   writes MP4 (AVC/HEVC + AAC) or WebM (VP8/VP9/AV1 + Opus/Vorbis) without re-encoding. Audio M4A (default, no
 *   conversion) and WAV (AAC decoded to PCM). MP3, FLAC and Opus need encoders Android does not ship yet.
 * - Android, TikTok/Instagram (yt-dlp via Chaquopy, info.source === "ytdlp"): "Best available" plus every height in
 *   bestStreamsByHeight (shared with pickYtdlpFormat), audio M4A and WAV (MP3 shown disabled), no thumbnails.
 * - Android, YouTube through the self-contained yt-dlp route (info.ytdlpFull): the desktop video rows (yt-dlp + bundled ffmpeg merge), audio M4A and WAV, no MP3 yet, no thumbnails.
 * - Web (dev preview without Tauri): progressive MP4 at or below 360p and thumbnails; no audio (nothing can extract
 *   or convert it in the browser).
 */
import type { AudioFormat, FormatOption, Platform, ThumbnailFormat, VideoInfo } from "../lib/types";
import { bestStreamsByHeight, hiddenStreams, instagramBestFallback, instagramNeedsFullEngine, pickYtdlpFormat } from "./android-ytdlp";
import { platform } from "./platform";

/** Instagram video only the bundled ffmpeg can save (VP9 video + AAC audio) while that engine is not ready. */
export const INSTAGRAM_FULL_ENGINE_TEXT =
  "This Instagram video needs Keepsake's built-in video engine, which isn't ready on this phone. Try Audio, reinstall Keepsake, or use the desktop app.";

/** Heights offered when the link gives none (playlists, and the Android pre-fetch placeholders): 2160 down to 360. */
const PLAYLIST_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
/** Web preview only: the browser can play one progressive stream and nothing above 360p is offered there. */
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

/** Web preview: only progressive (video + audio) streams at or below 360p; no merging, no "Best available". */
function webVideoOptions(info: VideoInfo): FormatOption[] {
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

function noVideoRow(label: string): FormatOption {
  return { id: "video:none", mode: "video", label, ext: "mp4", isDefault: false, needsMerge: false, needsConversion: false, disabledReason: label };
}

/**
 * Android (youtubei.js): every height with a muxable video stream. Ext comes from the stream's codec (mp4 for
 * AVC/HEVC, webm for VP8/VP9/AV1); video-only heights need a merge with the matching audio-only stream.
 * Default: highest height <= 1080, else the highest.
 */
function youtubeiVideoOptions(info: VideoInfo): FormatOption[] {
  const byHeight = bestStreamsByHeight(info);
  const heights = [...byHeight.keys()].toSorted((a, b) => b - a);
  if (heights.length === 0) return [noVideoRow("No video we can save on this link")];
  const def = heights.find((h) => h <= 1080) ?? heights[0];
  return heights.map((h) => {
    const s = byHeight.get(h)!;
    return {
      id: `video:${h}`,
      mode: "video" as const,
      label: qualityLabel(h, info.fpsByHeight[h]),
      height: h,
      fps: info.fpsByHeight[h] || undefined,
      ext: s.container,
      isDefault: h === def,
      needsMerge: !!s.audio,
      needsConversion: false,
    };
  });
}

function videoOptions(info: VideoInfo | null | undefined, p: Platform): FormatOption[] {
  const desktop = isDesktopPlatform(p);
  if (!info) {
    const heights = desktop || p === "android" ? PLAYLIST_HEIGHTS : [SINGLE_FILE_MAX_HEIGHT];
    return heights.map((h) => placeholderRow(h, desktop, "Fetch a video first"));
  }
  if (!info.hasVideo) return [];
  if (desktop) return desktopVideoOptions(info);
  return p === "android" ? youtubeiVideoOptions(info) : webVideoOptions(info);
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

/**
 * Android, yt-dlp via Chaquopy (TikTok/Instagram/...): "Best available" plus every height from bestStreamsByHeight
 * (the same map pickYtdlpFormat uses, so each row downloads exactly the stream it shows), M4A/WAV audio, no
 * thumbnails. "Best available" resolves to the highest listed height. Default: highest height <= 1080, else Best.
 */
function androidYtdlpOptions(info: VideoInfo): FormatOption[] {
  const out: FormatOption[] = [];
  const byHeight = bestStreamsByHeight(info);
  const heights = [...byHeight.keys()].toSorted((a, b) => b - a);
  const top = heights.length > 0 ? byHeight.get(heights[0]) : undefined;
  if (top) {
    const def = heights.find((h) => h <= 1080);
    out.push({
      id: "video:best",
      mode: "video",
      label: "Best available",
      ext: top.container,
      isDefault: def === undefined,
      needsMerge: !!top.audio,
      needsConversion: false,
    });
    for (const h of heights) {
      const s = byHeight.get(h);
      if (!s) continue;
      out.push({
        id: `video:${h}`,
        mode: "video",
        // fps of the stream this row downloads, not the height's max over all streams.
        label: qualityLabel(h, s.video.fps),
        height: h,
        fps: s.video.fps || undefined,
        ext: s.container,
        isDefault: h === def,
        needsMerge: !!s.audio,
        needsConversion: false,
      });
    }
  } else if (hiddenStreams(info).some((s) => s.kind !== "audio-only") || instagramBestFallback(info)) {
    // TikTok / Instagram post offered only as HLS/DASH: nothing the phone can mux, so one "Best available" row that
    // the download ladder sends to the full yt-dlp route (bundled ffmpeg). Never YouTube (hiddenStreams is empty).
    // Instagram also: no listable height but heightless files / guessed pairs to try first (instagramBestFallback).
    out.push({
      id: "video:best",
      mode: "video",
      label: "Best available",
      ext: "mp4",
      isDefault: true,
      needsMerge: true,
      needsConversion: false,
    });
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
      : instagramNeedsFullEngine(info)
        ? INSTAGRAM_FULL_ENGINE_TEXT
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

/**
 * Android self-contained yt-dlp route (YouTube, bundled QuickJS + ffmpeg): yt-dlp selects and merges like desktop,
 * so the rows are the desktop video rows (every height + Best available), plus audio M4A (first, so the default
 * when there is no video) and WAV (WAV = M4A download then the native transcode). No MP3 (phase 3), no thumbnails.
 */
function androidFullOptions(info: VideoInfo): FormatOption[] {
  const video = info.hasVideo ? desktopVideoOptions(info) : [];
  return [...video, ...audioOptions("android")];
}

/** All picker options for a fetched link (or the pre-fetch placeholders when `info` is null). */
export function listFormats(info: VideoInfo | null | undefined): FormatOption[] {
  const p = platform();
  if (p === "android" && info?.source === "ytdlp" && info.ytdlpFull === true) return androidFullOptions(info);
  if (p === "android" && info?.source === "ytdlp") return androidYtdlpOptions(info);
  return [...videoOptions(info, p), ...audioOptions(p), ...thumbOptions()];
}
