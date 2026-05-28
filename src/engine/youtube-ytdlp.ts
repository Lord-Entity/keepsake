/**
 * Android YouTube through the self-contained yt-dlp (Chaquopy + bundled QuickJS-NG, yt-dlp-ejs and ffmpeg;
 * plan-docs/11-android-selfcontained-ytdlp.md). With a JS runtime and the EJS solver, yt-dlp uses its default
 * clients like the desktop sidecar does, and those serve every quality without a PO token. youtubei.js (with the
 * BGUtils PO token) stays as the fallback whenever this route is not ready or fails.
 * The route is taken only when the build flag is on AND the phone's `ytdlp_status` says ready.
 * TikTok / Instagram do not use this file: they stay on the legacy yt-dlp route in this release.
 */
import type { VideoInfo } from "../lib/types";
import { androidYtdlpStatus, fetchAndroidYouTubeInfo, pickYtdlpFormat } from "./android-ytdlp";
import { platform } from "./platform";
import { canonicalYoutubeUrl } from "./youtube-urls";

/** Build flag for the self-contained Android route (plan-docs 11 section 8). false = every path behaves as before. */
export const ANDROID_SELFCONTAINED = true;

/** True on Android when the build flag is on and the bundled yt-dlp reports ready (cached status). Never rejects. */
export async function androidYtdlpReady(): Promise<boolean> {
  if (!ANDROID_SELFCONTAINED || platform() !== "android") return false;
  try {
    return (await androidYtdlpStatus())?.ready === true;
  } catch {
    return false;
  }
}

/** Pure: "ytdlp" only when the route is ready and the link is an https YouTube video; otherwise "innertube". */
export function youtubeRoute(url: string, ready: boolean = false): "ytdlp" | "innertube" {
  // https only, like the Rust gate: a plain http link keeps today's path.
  return ready && /^https:\/\//i.test(url.trim()) && canonicalYoutubeUrl(url) !== null ? "ytdlp" : "innertube";
}

/**
 * Legacy helper (muxable-format yt-dlp info, no bundled runtime). No longer used by index.ts; kept for its tests.
 * Resolves the info whenever a format can be picked; resolves null on any error.
 */
export async function tryYouTubeViaYtdlp(url: string, signal?: AbortSignal): Promise<VideoInfo | null> {
  try {
    const canon = canonicalYoutubeUrl(url);
    if (!canon) return null;
    const info = await fetchAndroidYouTubeInfo(canon, signal);
    return pickYtdlpFormat(info, "video:best") ? info : null;
  } catch {
    return null;
  }
}
