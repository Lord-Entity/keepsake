/**
 * Android YouTube through yt-dlp (Chaquopy, keepsake-media ytdlp_info / ytdlp_download / ytdlp_mux), flag OFF.
 * The in-process yt-dlp cannot mint PO tokens without a Node runtime, so youtubei.js + BGUtils is the supported
 * high-quality path; yt-dlp stays for TikTok / Instagram. The helpers below are kept for that route and for tests.
 */
import type { VideoInfo } from "../lib/types";
import { fetchAndroidYouTubeInfo, pickYtdlpFormat } from "./android-ytdlp";
import { canonicalYoutubeUrl } from "./youtube-urls";

/**
 * Off on purpose: in-process yt-dlp cannot mint PO tokens without a Node runtime, so youtubei.js + BGUtils is the
 * supported high-quality path on Android. yt-dlp stays for TikTok / Instagram.
 */
export const YOUTUBE_VIA_YTDLP = false;

/** "ytdlp" only when the flag is on and the host is YouTube; otherwise "innertube" (today's path). */
export function youtubeRoute(url: string, flag: boolean = YOUTUBE_VIA_YTDLP): "ytdlp" | "innertube" {
  // https only, like the Rust gate: a plain http link keeps today's path.
  return flag && /^https:\/\//i.test(url.trim()) && canonicalYoutubeUrl(url) !== null ? "ytdlp" : "innertube";
}

/**
 * Try yt-dlp for a YouTube link. Resolves the info whenever a format can be picked; resolves null on any error
 * (including a missing Rust host gate, PO-token failures and aborts) so the caller uses youtubei.js.
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
