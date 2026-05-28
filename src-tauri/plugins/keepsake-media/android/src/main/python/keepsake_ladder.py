"""Workaround ladder for TikTok and Instagram (Android yt-dlp bridge).

Pure module: no yt_dlp import, so the host test suite (src/test/python) can import it.

Attempt 1 always runs with the bridge's normal options (nothing added here). Only after a
classified, retryable failure does the bridge run attempt 2 and then attempt 3 with the extra
options below merged on top. YouTube (and every other host) never gets a ladder: site_for()
returns None and the bridge makes exactly one attempt, as before.

Option names verified against yt-dlp 2026.10.26:
- source_address "0.0.0.0": what --force-ipv4 sets (yt_dlp/__init__.py).
- extractor_retries / retries / fragment_retries / socket_timeout / http_chunk_size / http_headers:
  YoutubeDL params.
- extractor_args shape {ie_key_lowercase: {arg: [values]}}. TikTok reads (ie_key TikTokIE -> "tiktok")
  device_id (set => mobile app API first, the extractor itself falls back to the web page with a
  warning when that fails) and api_hostname (default api16-normal-c-useast1a.tiktokv.com).
  Instagram reads app_id (ie_key InstagramIE -> "instagram"). Values are lists of strings.
"""

FINAL_CODES = frozenset((
    "login_required", "not_found", "cancelled", "no_space", "too_large", "unsupported_url",
    "permission", "empty", "bot_check", "js_runtime_missing", "ytdlp_missing", "mux_failed",
))
RETRY_CODES = frozenset(("parse_failed", "unknown", "forbidden", "network", "timeout", "format_unavailable"))
BACKOFF_CODES = frozenset(("rate_limited",))

MAX_ATTEMPTS = 3
BACKOFF_SECONDS = 8.0

_SITES = (
    ("tiktok", ("tiktok.com",)),
    ("instagram", ("instagram.com", "instagr.am")),
)

# Alternative app API host for attempt 3 (README example of yt-dlp's tiktok:api_hostname).
TIKTOK_ALT_API_HOST = "api22-normal-c-alisg.tiktokv.com"
# Instagram attempt 3: the iOS app id instead of the web one (936619743392459) in the X-IG-App-ID
# header. instagram.py: _APP_IDS.get(user_input, user_input or _APP_IDS['web']), so a raw id passes through.
INSTAGRAM_ALT_APP_ID = "124024574287414"

_CHUNK = 10 * 1024 * 1024


def site_for(host):
    """"tiktok" / "instagram" for a ladder host (or a subdomain such as vm.tiktok.com), else None."""
    h = str(host or "").lower().rstrip(".")
    if not h:
        return None
    for site, roots in _SITES:
        if any(h == r or h.endswith("." + r) for r in roots):
            return site
    return None


def attempt_overrides(site, attempt, device_id=None):
    """Extra YoutubeDL options for attempt `attempt` (1-based). Attempt 1 is always {}.
    Attempt 3 includes everything of attempt 2 plus its own changes.
    device_id: 19-digit string for TikTok (the bridge makes a random one); ignored elsewhere."""
    if site is None or attempt <= 1:
        return {}
    o = {
        "source_address": "0.0.0.0",  # force IPv4: broken IPv6 is common on mobile networks
        "extractor_retries": 5,
        "retries": 15,
        "fragment_retries": 15,
        "http_chunk_size": _CHUNK,  # ranged chunks survive CDN resets / throttling better
    }
    if site == "tiktok":
        tt = {}
        if device_id:
            tt["device_id"] = [str(device_id)]  # app API first, web page fallback (inside the extractor)
        if attempt >= 3:
            tt["api_hostname"] = [TIKTOK_ALT_API_HOST]
        if tt:
            o["extractor_args"] = {"tiktok": tt}
    if attempt >= 3:
        o["socket_timeout"] = 45
        if site == "instagram":
            o["extractor_args"] = {"instagram": {"app_id": [INSTAGRAM_ALT_APP_ID]}}
    return o


def merge_opts(base, overrides):
    """New dict: base updated with overrides; extractor_args and http_headers are merged one
    level deeper (per extractor key / per header) instead of replaced. base is not modified."""
    out = dict(base)
    for k, v in overrides.items():
        if k == "extractor_args" and isinstance(out.get(k), dict):
            ea = {ie: dict(args) for ie, args in out[k].items()}
            for ie, args in v.items():
                ea.setdefault(ie, {}).update(args)
            out[k] = ea
        elif k == "http_headers" and isinstance(out.get(k), dict):
            hh = dict(out[k])
            hh.update(v)
            out[k] = hh
        else:
            out[k] = v
    return out


def next_step(code, attempt, backed_off, bridge_error=False):
    """What to do after attempt `attempt` failed with `code`:
    "stop" (report the error), "retry" (next attempt now) or "backoff" (wait BACKOFF_SECONDS, then next attempt).
    bridge_error: the bridge raised the error itself (bad arguments, file checks): never retried.
    rate_limited is retried once, after a wait; a second rate limit stops."""
    if bridge_error or attempt >= MAX_ATTEMPTS or code in FINAL_CODES:
        return "stop"
    if code in BACKOFF_CODES:
        return "stop" if backed_off else "backoff"
    if code in RETRY_CODES:
        return "retry"
    return "stop"


# Instagram only: yt-dlp's expected "no video" error (instagram.py raise_no_formats) is classified
# "unknown" by the bridge, but a retry cannot change it. Other sites: none (their ladder is unchanged).
_FINAL_TEXT = {
    "instagram": ("there is no video in this post",),
}


def final_text(site, text):
    """True when the error text of a failed attempt is final for `site` (stop, never retry)."""
    t = str(text or "").lower()
    return any(n in t for n in _FINAL_TEXT.get(site, ()))


def partial_victims(seen, finished):
    """Paths to delete before a download retry: unfinished downloads and their .part / .ytdl /
    -Frag* leftovers (the -Frag glob is done by the bridge). Files in `finished` (complete
    downloads, e.g. the video half of a merge) are kept, so yt-dlp (overwrites=False) reuses them
    instead of downloading them again."""
    out = set()
    done = set(f for f in finished if f)
    for f in seen:
        if not f:
            continue
        if f.endswith(".part"):
            base = f[:-5]
            out.update((f, base + ".ytdl"))
            if base not in done:
                out.add(base)
            continue
        out.update((f + ".part", f + ".ytdl"))
        if f not in done:
            out.add(f)
    return out
