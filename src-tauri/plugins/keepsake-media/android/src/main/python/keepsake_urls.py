"""YouTube URL canonicalization for Keepsake (Android yt-dlp path).

The rules here mirror the Rust (validate_ytdlp_url) and TypeScript
(src/engine/youtube-urls.ts) validators: https only (http is upgraded),
exact host match, no userinfo, and an 11-character video ID.
Playlist-only URLs (no video ID) are rejected.
"""

import re
from urllib.parse import parse_qs, urlsplit

_HOSTS = frozenset(
    {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}
)
_SHORT_HOST = "youtu.be"
_ID_RE = re.compile(r"[A-Za-z0-9_-]{11}")
_PATH_PREFIXES = ("shorts", "live", "embed")


def _valid_id(value):
    return value if value and _ID_RE.fullmatch(value) else None


def canonical_youtube_url(url):
    """Return https://www.youtube.com/watch?v=ID, or None if not acceptable."""
    if not isinstance(url, str):
        return None
    try:
        parts = urlsplit(url.strip())
        if parts.scheme.lower() not in ("https", "http"):
            return None
        # Reject userinfo tricks like https://youtube.com@evil.com/...
        if "@" in parts.netloc:
            return None
        host = (parts.hostname or "").lower()
        if parts.port not in (None, 443 if parts.scheme.lower() == "https" else 80):
            return None
    except ValueError:
        return None

    segments = [s for s in parts.path.split("/") if s]
    vid = None
    if host == _SHORT_HOST:
        if segments:
            vid = _valid_id(segments[0])
    elif host in _HOSTS:
        if segments and segments[0] == "watch":
            vid = _valid_id((parse_qs(parts.query).get("v") or [None])[0])
        elif len(segments) >= 2 and segments[0] in _PATH_PREFIXES:
            vid = _valid_id(segments[1])
    if vid is None:
        return None
    return "https://www.youtube.com/watch?v=" + vid
