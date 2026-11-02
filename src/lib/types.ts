/**
 * Shared contract types. ENGINE owns this file; APP and PLATFORM consume it.
 * Engine entry point: src/engine/index.ts.
 */

export type Platform = "windows" | "linux" | "android" | "web";

/** FormatPicker segment. Same values as `PickerMode` in src/state/settings.ts. */
export type DownloadMode = "video" | "audio" | "thumbnail";

export type AudioFormat = "mp3" | "m4a" | "opus" | "wav" | "flac";
export type AudioBitrate = 128 | 192 | 256 | 320;
export type ThumbnailFormat = "original" | "png" | "jpg";

export interface Thumbnail {
  url: string;
  width?: number;
  height?: number;
}

/** One raw stream from the source (shown in the "Advanced" streams table). */
export interface StreamInfo {
  /** itag (YouTube) or yt-dlp format_id. */
  id: string;
  kind: "progressive" | "video-only" | "audio-only";
  ext: string;
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  bitrate?: number;
  sizeBytes?: number;
}

export interface VideoInfo {
  /** Video id (YouTube id or yt-dlp id). */
  id: string;
  /** Normalised source URL to download from. */
  url: string;
  /** Lower-case site name, e.g. "youtube", "soundcloud". */
  site: string;
  kind: "video" | "audio" | "playlist";
  title: string;
  channel?: string;
  durationSec?: number;
  viewCount?: number;
  /** ISO date (YYYY-MM-DD) when known. */
  uploadDate?: string;
  description?: string;
  /** Best first. */
  thumbnails: Thumbnail[];
  /** False when the link has audio only (Video segment disabled). */
  hasVideo: boolean;
  /** Heights the link offers, highest first. */
  heights: number[];
  /** Highest fps seen per height. */
  fpsByHeight: Record<number, number>;
  streams: StreamInfo[];
  /** True when only a preview is playable (sign-in may be needed). */
  previewOnly: boolean;
  playlistCount?: number;
  /** Which backend produced this info. */
  source: "youtubei" | "ytdlp";
}

/** One choice in the FormatPicker. */
export interface FormatOption {
  /** Stable id to pass back in DownloadRequest.formatId, e.g. "video:1080", "video:best", "audio:mp3", "thumb:png". */
  id: string;
  mode: DownloadMode;
  /** Display label, e.g. "1080p60 Full HD", "MP3", "PNG". */
  label: string;
  height?: number;
  fps?: number;
  audioFormat?: AudioFormat;
  thumbnailFormat?: ThumbnailFormat;
  /** Container of the final file, e.g. "mp4", "mp3", "webp". */
  ext: string;
  /** Picker default for this mode. */
  isDefault: boolean;
  /** Needs a merge of separate video + audio streams (desktop yt-dlp only). */
  needsMerge: boolean;
  /** Needs a conversion step: ffmpeg via yt-dlp on desktop, the keepsake-media plugin on Android. */
  needsConversion: boolean;
  /** Set when the option is shown but cannot be used yet (e.g. "Fetch a video first"). */
  disabledReason?: string;
}

export interface DownloadRequest {
  /** Caller-generated job id (crypto.randomUUID()). */
  id: string;
  url: string;
  /** Pass the fetched info when available; Android/web need it to avoid a second fetch. */
  info?: VideoInfo;
  mode: DownloadMode;
  /** FormatOption.id from listFormats(). */
  formatId: string;
  /** Optional explicit stream (StreamInfo.id) from the Advanced table. Desktop only. */
  streamId?: string;
  audioBitrate?: AudioBitrate;
  preferH264?: boolean;
  /** Audio (MP3/M4A): embed the thumbnail as cover art. Default on (undefined = on). Desktop only. */
  embedThumbnail?: boolean;
  /** Video: embed thumbnail and metadata (each pass rewrites the file). Default off (only `true` turns it on). Desktop only. */
  embedVideoMeta?: boolean;
  /** Absolute folder. Empty/undefined = system Downloads folder. */
  outputDir?: string;
  /** Settings > Cookies value ("off" or a browser name). Desktop only. */
  cookiesBrowser?: string;
}

export type DownloadStatus =
  | "queued"
  | "downloading"
  | "merging"
  | "converting"
  | "done"
  | "failed"
  | "cancelled";

export interface DownloadProgress {
  id: string;
  status: DownloadStatus;
  downloadedBytes: number;
  totalBytes?: number;
  /** 0..100, undefined when unknown (indeterminate bar). */
  percent?: number;
  /** Bytes per second. */
  speedBps?: number;
  etaSec?: number;
  /** Playlist position, 1-based, desktop only. */
  playlistIndex?: number;
  playlistCount?: number;
  /** Final file path (status "done"). On web: the suggested file name. */
  filePath?: string;
  error?: AppError;
  /** Short status note on a final result, e.g. "Retried with cookies from Edge". */
  note?: string;
}

export interface DownloadHandle {
  id: string;
  cancel(): void;
  /** Resolves with the last progress (done, failed or cancelled). Never rejects. */
  done: Promise<DownloadProgress>;
}

export type BinaryState = "ok" | "missing" | "unsupported";

export interface BinaryStatus {
  platform: Platform;
  ytdlp: BinaryState;
  ffmpeg: BinaryState;
  ytdlpVersion?: string;
  ffmpegVersion?: string;
  /**
   * Desktop: JS runtime for yt-dlp's YouTube challenge solver (bundled QuickJS, else a user-installed Node.js).
   * "missing" = YouTube downloads fail. Field name kept as `node` for compatibility.
   */
  node?: BinaryState;
  nodeVersion?: string;
}

export type AppErrorCode =
  | "unsupported_url"
  | "drm"
  | "age_restricted"
  | "bot_check"
  | "password"
  | "anti_bot"
  | "ip_blocked"
  | "parse_failed"
  | "geo_blocked"
  | "private"
  | "unavailable"
  | "login_required"
  | "format_unavailable"
  | "rate_limited"
  | "forbidden"
  | "not_found"
  | "network"
  | "timeout"
  | "ssl"
  | "ffmpeg_missing"
  | "ytdlp_missing"
  | "js_runtime_missing"
  | "no_formats"
  | "bad_folder"
  | "empty_url"
  | "web_cors"
  | "cancelled"
  | "unknown";

export interface AppError {
  code: AppErrorCode;
  /** Friendly text. Includes "(Details: ...)" when the raw text adds information. */
  message: string;
  /** Cleaned raw error, for the "Show details" disclosure and "Copy error". */
  detail?: string;
  /** True when the message points at Settings > Cookies (show "Open Settings"). */
  cookiesHint: boolean;
}

/** Reworded COOKIE_HINT from workers/errors.py (UI_CONTENT.md section 6). */
export const COOKIE_HINT =
  "Try choosing your browser under Settings > Cookies (Firefox works best on Windows).";

/** Friendly texts ported from workers/errors.py `friendly_error`, word for word except the two rewordings. */
export const ERROR_TEXT: Record<AppErrorCode, string> = {
  unsupported_url:
    "This site or link isn't supported by yt-dlp. Check that the URL points to a video or audio page, not a homepage or search page.",
  drm: "This video is DRM protected and can't be downloaded.",
  age_restricted: `This video is age restricted and needs a logged-in account. ${COOKIE_HINT}`,
  bot_check:
    "YouTube asked us to sign in. Open Settings > Cookies and choose the browser you're signed in to, then retry.",
  password: "This video is password protected, which isn't supported yet.",
  anti_bot: `The site blocked the request with an anti-bot check. ${COOKIE_HINT}`,
  ip_blocked: "The site is blocking your IP address. A different network or VPN may help.",
  parse_failed: `Couldn't read this page. It may need a login, or the site changed and yt-dlp needs updating. ${COOKIE_HINT}`,
  geo_blocked: "This video isn't available in your country. A VPN may help.",
  private: `This video is private. If your account can view it, ${COOKIE_HINT[0].toLowerCase()}${COOKIE_HINT.slice(1)}`,
  unavailable: "This video is unavailable (removed, deleted or private).",
  login_required: `This content needs you to be logged in, or the site is rate-limiting anonymous access. ${COOKIE_HINT}`,
  format_unavailable:
    "The selected quality isn't available for this video. Pick another quality or use Best.",
  rate_limited: `The site is rate-limiting you (HTTP 429). Wait a few minutes and try again. ${COOKIE_HINT}`,
  forbidden: `The site refused access (HTTP 403). The video may be restricted or need a login. ${COOKIE_HINT}`,
  not_found: "Not found (HTTP 404). The link may be wrong or the video was removed.",
  network: "Couldn't reach the site. Check your internet connection and try again.",
  timeout: "The connection timed out. Check your internet connection and try again.",
  ssl: "A secure connection (SSL) to the site failed. Check your connection, system clock, or any proxy/antivirus interfering.",
  ffmpeg_missing: "ffmpeg is missing. Merging and audio conversion won't work. Reinstall Keepsake.",
  ytdlp_missing: "yt-dlp is missing or damaged. Reinstall Keepsake.",
  js_runtime_missing: "Install Node.js (https://nodejs.org) so YouTube downloads work.",
  no_formats: `No downloadable video was found on this page. If the video requires a login, ${COOKIE_HINT[0].toLowerCase()}${COOKIE_HINT.slice(1)}`,
  bad_folder: "Can't save to this folder. Choose another folder in Settings.",
  empty_url: "Paste a link first.",
  web_cors:
    "The browser preview can't read video links (the browser blocks cross-site requests). Use the Keepsake desktop or Android app.",
  cancelled: "Cancelled",
  unknown: "Unknown error",
};
