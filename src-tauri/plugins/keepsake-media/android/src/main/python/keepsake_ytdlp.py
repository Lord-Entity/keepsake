"""yt-dlp bridge for the Keepsake Android app (called from Kotlin through Chaquopy).

Both functions take plain strings and return ONE JSON string. They never raise.
Options are built only from a fixed allow-list: no postprocessors, cookies, proxy,
credentials or external downloaders, and nothing from user input except the
format id, the output folder and the file name.
"""

import glob
import json
import os
import re

import yt_dlp

MAX_FILESIZE = 500 * 1024 * 1024

BASE = {
    "noplaylist": True,
    "quiet": True,
    "no_warnings": False,  # warnings go to stderr -> logcat (tag python.stderr)
    "retries": 5,
    "fragment_retries": 5,
    "socket_timeout": 30,
    "restrictfilenames": False,
    "extract_flat": False,
    "cachedir": False,
    "noprogress": True,
}

_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

# (code, needles) in the order of the contract table; first match wins.
_RULES = (
    ("unsupported_url", ("unsupported url", "is not a valid url")),
    ("login_required", ("login", "log in", "sign in", "cookies", "private", "authentication", "not available for anonymous")),
    ("rate_limited", ("429", "too many requests", "rate-limit", "rate limit")),
    ("forbidden", ("403", "forbidden")),
    ("not_found", ("404", "not found", "video unavailable", "no longer available", "has been removed")),
    ("parse_failed", ("unable to extract", "unable to parse", "jsondecodeerror", "no video formats", "no formats")),
)
_NETWORK_TEXT = ("getaddrinfo", "timed out", "connection", "network is unreachable", "name resolution", "ssl")


class _Fail(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _clean(text):
    text = _ANSI.sub("", str(text))
    if "ERROR:" in text:
        text = text.rsplit("ERROR:", 1)[1]
    return " ".join(text.split())[:300]


def _classify(exc):
    if isinstance(exc, _Fail):
        return exc.code
    text = str(exc).lower()
    for code, needles in _RULES:
        if any(n in text for n in needles):
            return code
    inner = exc
    info = getattr(exc, "exc_info", None)
    if info and len(info) > 1 and info[1] is not None:
        inner = info[1]
    transport = getattr(getattr(getattr(yt_dlp, "networking", None), "exceptions", None), "TransportError", OSError)
    if isinstance(exc, (OSError, transport)) or isinstance(inner, (OSError, transport)):
        return "network"
    if any(n in text for n in _NETWORK_TEXT):
        return "network"
    return "unknown"


def _error(exc):
    msg = _clean(exc) or exc.__class__.__name__
    return json.dumps({"ok": False, "code": _classify(exc), "message": msg}, ensure_ascii=False)


def _int(x):
    return int(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def _float(x):
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def _str_or_none(x):
    return x if isinstance(x, str) and x else None


def _thumbnail(raw):
    thumb = _str_or_none(raw.get("thumbnail"))
    if thumb:
        return thumb
    for t in reversed(raw.get("thumbnails") or []):
        if isinstance(t, dict) and _str_or_none(t.get("url")):
            return t["url"]
    return None


def _reduce_format(f):
    return {
        "format_id": str(f.get("format_id") or ""),
        "ext": f.get("ext") or "",
        "vcodec": _str_or_none(f.get("vcodec")),
        "acodec": _str_or_none(f.get("acodec")),
        "height": _int(f.get("height")),
        "fps": _float(f.get("fps")),
        "filesize": _int(f.get("filesize") if f.get("filesize") else f.get("filesize_approx")),
        "protocol": f.get("protocol") or "",
        "format_note": _str_or_none(f.get("format_note")),
    }


def _reduce(raw, url):
    return {
        "id": str(raw.get("id") or ""),
        "title": raw.get("title") or "Untitled",
        "uploader": _str_or_none(raw.get("uploader")) or _str_or_none(raw.get("channel")),
        "duration": _float(raw.get("duration")),
        "thumbnail": _thumbnail(raw),
        "extractor": raw.get("extractor_key") or raw.get("extractor") or "",
        "webpage_url": raw.get("webpage_url") or url,
        "formats": [_reduce_format(f) for f in (raw.get("formats") or []) if isinstance(f, dict)],
    }


def _reject_playlist(raw):
    if raw is None or raw.get("_type") in ("playlist", "multi_video"):
        raise _Fail("unsupported_url", "Posts with several videos are not supported on Android yet.")


def info(url):
    try:
        with yt_dlp.YoutubeDL(dict(BASE)) as ydl:
            raw = ydl.sanitize_info(ydl.extract_info(url, download=False))
        _reject_playlist(raw)
        return json.dumps({"ok": True, "info": _reduce(raw, url)}, ensure_ascii=False)
    except BaseException as exc:  # includes KeyboardInterrupt and SystemExit: never raise into Kotlin
        return _error(exc)


def download(url, format_id, out_dir, file_name):
    try:
        if file_name:
            name_tmpl = file_name.replace("%", "%%") + ".%(ext)s"
        else:
            name_tmpl = "%(title).80B [%(id)s].%(ext)s"
        opts = dict(BASE)
        opts.update({
            "format": format_id,
            "paths": {"home": out_dir, "temp": out_dir},
            "outtmpl": {"default": os.path.join(out_dir, name_tmpl)},
            "max_filesize": MAX_FILESIZE,
            "overwrites": False,
        })
        with yt_dlp.YoutubeDL(opts) as ydl:
            res = ydl.extract_info(url, download=True)
        _reject_playlist(res)
        path = ((res.get("requested_downloads") or [{}])[0]).get("filepath")
        if not path or not os.path.isfile(path):
            size = res.get("filesize") or res.get("filesize_approx")
            if isinstance(size, (int, float)) and size > MAX_FILESIZE:
                raise _Fail("unknown", "The file is larger than the 500 MiB limit on Android.")
            raise _Fail("unknown", "yt-dlp finished without writing a file.")
        real = os.path.realpath(path)
        if not real.startswith(os.path.realpath(out_dir) + os.sep):
            raise _Fail("unknown", "yt-dlp wrote outside the output folder.")
        return json.dumps({"ok": True, "path": real, "bytes": os.path.getsize(real)})
    except BaseException as exc:
        if file_name:
            for part in glob.glob(os.path.join(glob.escape(out_dir), glob.escape(file_name) + ".*.part")):
                try:
                    os.remove(part)
                except OSError:
                    pass
        return _error(exc)
