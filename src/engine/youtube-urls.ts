/**
 * Pure YouTube URL helpers. Mirrors the Python (keepsake_urls.py) and Rust (validate_ytdlp_url) rules.
 * Accepts only exact YouTube hosts over http(s), extracts the 11-character video ID and returns the
 * canonical https://www.youtube.com/watch?v=ID. Playlist-only URLs (list= with no video ID) yield null.
 */

const YOUTUBE_HOSTS: ReadonlySet<string> = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ID_PATH_PREFIXES: readonly string[] = ["shorts", "live", "embed"];

/** True when host is exactly one of the allowed YouTube hosts (case-insensitive, no other subdomains). */
export function isYoutubeHost(host: string): boolean {
  return YOUTUBE_HOSTS.has(host.trim().toLowerCase());
}

function validId(candidate: string | null | undefined): string | null {
  return candidate !== null && candidate !== undefined && VIDEO_ID.test(candidate) ? candidate : null;
}

function extractId(url: URL): string | null {
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (url.hostname === "youtu.be") {
    return segments.length === 1 ? validId(segments[0]) : null;
  }
  if (segments.length === 1 && segments[0] === "watch") {
    return validId(url.searchParams.get("v"));
  }
  if (segments.length === 2 && ID_PATH_PREFIXES.includes(segments[0])) {
    return validId(segments[1]);
  }
  return null;
}

/** Canonical https://www.youtube.com/watch?v=ID for any supported YouTube link form, else null. */
export function canonicalYoutubeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null;
  if (!isYoutubeHost(url.hostname)) return null;
  const id = extractId(url);
  return id === null ? null : `https://www.youtube.com/watch?v=${id}`;
}
