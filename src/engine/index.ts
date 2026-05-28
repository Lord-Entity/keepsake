/**
 * Engine public API (shared contract, TEAM_BRIEF.md). Everything else in src/engine is internal.
 *
 * Errors: every rejected promise from this module rejects with an `EngineError`, which is an `Error` that also
 * satisfies `AppError` ({ code, message, detail, cookiesHint }). Use `toAppError(e)` to get a plain object.
 */
import type { BinaryStatus, VideoInfo } from "../lib/types";
import {
  bestStreamsByHeight,
  fetchAndroidInfo,
  fetchAndroidYouTubeInfo,
  forgetHiddenStreams,
  hiddenStreams,
  isAndroidYtdlpSupported,
  isInstagramHost,
  offerInstagramFullRoute,
} from "./android-ytdlp";
import { EngineError, fail, toAppError } from "./errors";
import { isDesktop, platform } from "./platform";
import { fetchYouTubeInfo, isYouTubeUrl } from "./youtube";
import { androidYtdlpReady, youtubeRoute } from "./youtube-ytdlp";
import { canonicalYoutubeUrl } from "./youtube-urls";
import { binaryVersions, fetchInfoYtdlp } from "./ytdlp";

export { listFormats, qualityLabel } from "./formats";
export { startDownload } from "./download";
export { platform } from "./platform";
export { toAppError, friendlyError, EngineError } from "./errors";
export type * from "../lib/types";

export interface FetchInfoOptions {
  /** Esc cancels a fetch. */
  signal?: AbortSignal;
  /** Settings > Cookies browser ("off" or a name). Desktop yt-dlp only. */
  cookiesBrowser?: string;
}

function checkUrl(raw: string): string {
  const url = raw.trim();
  if (!url) fail("empty_url");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    fail("unsupported_url", url);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") fail("unsupported_url", url);
  return url;
}

async function fetchInfoInner(url: string, opts: FetchInfoOptions): Promise<VideoInfo> {
  const p = platform();
  const yt = isYouTubeUrl(url);
  if (p === "web") {
    if (!yt) fail("web_cors");
    try {
      return await fetchYouTubeInfo(url);
    } catch (e) {
      if (toAppError(e).code === "network") fail("web_cors", String(e));
      throw e;
    }
  }
  if (p === "android") {
    if (yt) {
      // A playlist-only link has no video ID: say so instead of sending it down the single-video path.
      if (!canonicalYoutubeUrl(url) && /[?&]list=|\/playlist/i.test(url)) {
        fail("unsupported_url", "Playlists can be downloaded in the desktop app only.");
      }
      // Self-contained yt-dlp (bundled JS runtime + EJS + ffmpeg) when the build flag is on and the phone reports
      // ready; any failure other than a cancel falls back to youtubei.js (today's path).
      const canon = canonicalYoutubeUrl(url);
      if (canon && youtubeRoute(url, await androidYtdlpReady()) === "ytdlp") {
        if (opts.signal?.aborted) fail("cancelled");
        try {
          return await fetchAndroidYouTubeInfo(canon, opts.signal, { full: true });
        } catch (e) {
          if (opts.signal?.aborted || toAppError(e).code === "cancelled") fail("cancelled");
          console.warn("[keepsake] self-contained yt-dlp info failed, using youtubei.js:", toAppError(e).code);
        }
      }
      return fetchYouTubeInfo(url);
    }
    if (isAndroidYtdlpSupported(url)) {
      const info = await fetchAndroidInfo(url, opts.signal);
      // HLS/DASH-only TikTok / Instagram post: its "Best available" row needs the full route. When that is not ready,
      // drop the private copy so the picker shows the disabled "No video we can save" row (as before), not a dead end.
      if (bestStreamsByHeight(info).size === 0 && hiddenStreams(info).some((s) => s.kind !== "audio-only")) {
        if (!(await androidYtdlpReady())) forgetHiddenStreams(info);
      } else if (isInstagramHost(info.url) && bestStreamsByHeight(info).size === 0 && info.streams.some((s) => s.kind !== "audio-only")) {
        // Instagram only: video the phone cannot mux (VP9 DASH + AAC). With the full route ready, offer "Best
        // available" through it; otherwise the picker says the built-in engine is needed (formats.ts).
        if (await androidYtdlpReady()) offerInstagramFullRoute(info);
      }
      return info;
    }
    fail("unsupported_url", "Only YouTube, TikTok and Instagram links work in the Android app. Other sites need the desktop app.");
  }
  // Desktop: youtubei.js is fast for YouTube; yt-dlp covers everything else and YouTube fallbacks.
  if (yt) {
    try {
      return await fetchYouTubeInfo(url);
    } catch {
      if (opts.signal?.aborted) fail("cancelled");
    }
  }
  return fetchInfoYtdlp(url, opts);
}

/** Read a link's info. Rejects with EngineError (AppError). */
export async function fetchInfo(url: string, opts: FetchInfoOptions = {}): Promise<VideoInfo> {
  try {
    const clean = checkUrl(url);
    const info = await fetchInfoInner(clean, opts);
    if (opts.signal?.aborted) fail("cancelled");
    return info;
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError(toAppError(e));
  }
}

/** Desktop: yt-dlp / ffmpeg sidecar status. Android/web: "unsupported" (no sidecars). */
export async function binaryStatus(): Promise<BinaryStatus> {
  const p = platform();
  if (!isDesktop()) return { platform: p, ytdlp: "unsupported", ffmpeg: "unsupported" };
  try {
    const v = await binaryVersions();
    return {
      platform: p,
      ytdlp: v.ytdlp ? "ok" : "missing",
      ffmpeg: v.ffmpeg ? "ok" : "missing",
      ytdlpVersion: v.ytdlp ?? undefined,
      ffmpegVersion: v.ffmpeg ?? undefined,
      node: v.node ? "ok" : "missing",
      nodeVersion: v.node ?? undefined,
    };
  } catch {
    return { platform: p, ytdlp: "missing", ffmpeg: "missing" };
  }
}
