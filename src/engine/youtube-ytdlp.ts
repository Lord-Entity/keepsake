/**
 * Android YouTube through yt-dlp (Chaquopy, keepsake-media ytdlp_info / ytdlp_download / ytdlp_mux), flag ON.
 * The Python side sets player clients and format_sort; this side keeps only AVC video + AAC audio (MP4-safe for
 * the on-phone mux) and picks the highest height. A PO token may still be required for some videos, so this is
 * not a guaranteed fix: callers fall back to the innertube (youtubei.js) path on any error or when nothing above
 * 360p comes back.
 */
import type { VideoInfo } from "../lib/types";
import { fetchAndroidYouTubeInfo, isAndroidYouTubeYtdlpHost, pickYtdlpFormat } from "./android-ytdlp";

export const YOUTUBE_VIA_YTDLP = true;

/** https + exact host in ANDROID_YTDLP_YOUTUBE_HOSTS (youtube.com, www.youtube.com, m.youtube.com, youtu.be). */
function isYouTubeHost(url: string): boolean {
  return isAndroidYouTubeYtdlpHost(url);
}

/** "ytdlp" only when the flag is on and the host is YouTube; otherwise "innertube" (today's path). */
export function youtubeRoute(url: string, flag: boolean = YOUTUBE_VIA_YTDLP): "ytdlp" | "innertube" {
  return flag && isYouTubeHost(url) ? "ytdlp" : "innertube";
}

/**
 * Try yt-dlp for a YouTube link. Resolves the info only when its best pick is above 360p; resolves null on any
 * error (including a missing Rust host gate, PO-token failures and aborts) so the caller uses youtubei.js.
 */
export async function tryYouTubeViaYtdlp(url: string, signal?: AbortSignal): Promise<VideoInfo | null> {
  try {
    const info = await fetchAndroidYouTubeInfo(url, signal);
    const best = pickYtdlpFormat(info, "video:best");
    return best && (best.height ?? 0) > 360 ? info : null;
  } catch {
    return null;
  }
}
