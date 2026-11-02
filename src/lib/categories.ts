/**
 * Site -> category / display name. `site` on VideoInfo, Job and LibraryItem is the
 * lower-cased yt-dlp extractor key ("youtube", "youtubetab", "instagram", "tiktok",
 * "soundcloud", "generic", ...). Hosts ("music.youtube.com", "youtu.be") are accepted too.
 */
export type Category = "YouTube" | "Instagram" | "TikTok" | "Music" | "Other";

export const CATEGORIES: readonly Category[] = ["YouTube", "Instagram", "TikTok", "Music", "Other"];

function norm(site: string): string {
  return (site ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

const MUSIC = ["soundcloud", "bandcamp", "spotify", "deezer", "mixcloud", "audiomack", "applemusic"];

export function categoryOf(site: string): Category {
  const s = norm(site);
  if (!s) return "Other";
  if (s.startsWith("music.") || s.includes("youtubemusic") || MUSIC.some((m) => s.includes(m))) return "Music";
  if (s.includes("youtube") || s.includes("youtu.be")) return "YouTube";
  if (s.includes("instagram")) return "Instagram";
  if (s.includes("tiktok")) return "TikTok";
  return "Other";
}

const LABELS: [string, string][] = [
  ["youtube", "YouTube"],
  ["youtu.be", "YouTube"],
  ["instagram", "Instagram"],
  ["tiktok", "TikTok"],
  ["soundcloud", "SoundCloud"],
  ["bandcamp", "Bandcamp"],
  ["spotify", "Spotify"],
  ["twitter", "X"],
  ["vimeo", "Vimeo"],
  ["facebook", "Facebook"],
  ["reddit", "Reddit"],
  ["twitch", "Twitch"],
];

export function siteLabel(site: string): string {
  const s = norm(site);
  if (!s || s === "generic") return "Other";
  for (const [key, label] of LABELS) if (s.includes(key)) return label;
  // Host like "example.co.uk" -> "Example"; extractor key like "dailymotion" -> "Dailymotion".
  const parts = s.split(".");
  let name = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  if (parts.length > 2 && name.length <= 3) name = parts[parts.length - 3];
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "Other";
}
