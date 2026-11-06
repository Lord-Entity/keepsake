"""yt-dlp bridge for the Keepsake Android app (called from Kotlin through Chaquopy).

Functions take plain strings and return ONE JSON string. They never raise.
Options are built only from a fixed allow-list: no postprocessors, cookies, proxy,
credentials or external downloaders, and nothing from user input except the
format id, the output folder and the file name.
Failures are FLAT: {"ok": false, "code": ..., "message": ...}.
"""

import errno
import glob
import json
import os
import re
import threading
import time

import yt_dlp

MAX_FILESIZE = 500 * 1024 * 1024

BASE = {
    "noplaylist": True,
    "quiet": True,
    "no_warnings": False,  # warnings go to stderr -> logcat (tag python.stderr)
    "retries": 10,
    "fragment_retries": 10,
    "socket_timeout": 30,
    "concurrent_fragment_downloads": 4,
    "restrictfilenames": False,
    "extract_flat": False,
    "cachedir": False,
    "noprogress": True,
}

_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

_cancel_flags = {}
_lock = threading.Lock()


class CancelledError(Exception):
    pass


# (code, needles); first match wins.
_RULES = (
    ("cancelled", ("cancelled by user",)),
    ("format_unavailable", ("requested format", "requested format is not available")),
    ("too_large", ("larger than max-filesize", "max-filesize", "max_filesize", "larger than the 500 mib")),
    ("unsupported_url", ("unsupported url", "is not a valid url")),
    ("timeout", ("timed out",)),
    ("login_required", ("login", "log in", "sign in", "cookies", "private", "authentication", "not available for anonymous")),
    ("rate_limited", ("429", "too many requests", "rate-limit", "rate limit")),
    ("forbidden", ("403", "forbidden")),
    ("not_found", ("404", "not found", "video unavailable", "no longer available", "has been removed")),
    ("parse_failed", ("unable to extract", "unable to parse", "jsondecodeerror", "no video formats", "no formats")),
)
_NETWORK_TEXT = ("getaddrinfo", "connection reset", "connection refused", "connection aborted", "network is unreachable", "name resolution", "ssl")


class _Fail(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _clean(text):
    text = _ANSI.sub("", str(text))
    if "ERROR:" in text:
        text = text.rsplit("ERROR:", 1)[1]
    return " ".join(text.split())[:300]


def _inner(exc):
    info = getattr(exc, "exc_info", None)
    if info and len(info) > 1 and info[1] is not None:
        return info[1]
    return exc


def _classify(exc):
    if isinstance(exc, _Fail):
        return exc.code
    if isinstance(exc, CancelledError):
        return "cancelled"
    inner = _inner(exc)
    if isinstance(inner, CancelledError):
        return "cancelled"
    for e in (exc, inner):
        if isinstance(e, OSError) and e.errno is not None:
            if e.errno == errno.ENOSPC:
                return "no_space"
            if e.errno in (errno.EACCES, errno.EPERM):
                return "permission"
            if e.errno == errno.ECONNRESET:
                return "network"
    text = str(exc).lower()
    for code, needles in _RULES:
        if any(n in text for n in needles):
            return code
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


def cancel(job_id):
    try:
        with _lock:
            now = time.time()
            for k in [k for k, t in _cancel_flags.items() if now - t > 600]:
                del _cancel_flags[k]
            _cancel_flags[str(job_id)] = now
        return json.dumps({"ok": True})
    except BaseException as exc:
        return _error(exc)


def _is_cancelled(job_id):
    with _lock:
        return bool(_cancel_flags.get(job_id))


def _remove_files(seen, out_dir, file_name):
    root = os.path.realpath(out_dir) + os.sep
    victims = set()
    for f in seen:
        if not f:
            continue
        victims.update((f, f + ".part", f + ".ytdl"))
        victims.update(glob.glob(glob.escape(f) + "-Frag*"))
        if f.endswith(".part"):
            base = f[:-5]
            victims.update((base, base + ".ytdl"))
            victims.update(glob.glob(glob.escape(base) + "-Frag*"))
    if not seen and file_name:
        victims.update(glob.glob(os.path.join(glob.escape(out_dir), glob.escape(file_name) + ".*.part")))
    for v in victims:
        try:
            if os.path.realpath(v).startswith(root):
                os.remove(v)
        except OSError:
            pass


def download(url, format_id, out_dir, file_name, job_id):
    job = str(job_id) if job_id is not None else ""
    seen = set()
    try:
        if job and _is_cancelled(job):
            raise CancelledError("Cancelled by user.")

        def hook(d):
            for k in ("tmpfilename", "filename"):
                if d.get(k):
                    seen.add(d[k])
            if job and _is_cancelled(job):
                raise CancelledError("Cancelled by user.")
            for k in ("total_bytes", "total_bytes_estimate", "downloaded_bytes"):
                v = d.get(k)
                if isinstance(v, (int, float)) and v > MAX_FILESIZE:
                    raise _Fail("too_large", "The file is larger than the 500 MiB limit on Android.")

        if file_name:
            name_tmpl = file_name.replace("%", "%%") + ".%(ext)s"
        else:
            name_tmpl = "%(title).80B [%(id)s].%(ext)s"
        opts = dict(BASE)
        opts.update({
            "format": format_id,
            "paths": {"home": out_dir, "temp": out_dir},
            "outtmpl": {"default": name_tmpl},
            "max_filesize": MAX_FILESIZE,
            "overwrites": False,
            "progress_hooks": [hook],
        })
        with yt_dlp.YoutubeDL(opts) as ydl:
            res = ydl.extract_info(url, download=True)
        _reject_playlist(res)
        path = ((res.get("requested_downloads") or [{}])[0]).get("filepath")
        if not path or not os.path.isfile(path):
            rd = (res.get("requested_downloads") or [{}])[0]
            size = rd.get("filesize") or rd.get("filesize_approx") or res.get("filesize") or res.get("filesize_approx")
            if isinstance(size, (int, float)) and size > MAX_FILESIZE:
                raise _Fail("too_large", "The file is larger than the 500 MiB limit on Android.")
            raise _Fail("empty", "yt-dlp finished without writing a file.")
        real = os.path.realpath(path)
        if not real.startswith(os.path.realpath(out_dir) + os.sep):
            raise _Fail("unknown", "yt-dlp wrote outside the output folder.")
        seen.add(real)
        size = os.path.getsize(real)
        if size <= 0:
            raise _Fail("empty", "The downloaded file is empty.")
        return json.dumps({"ok": True, "path": real, "bytes": size})
    except BaseException as exc:
        try:
            _remove_files(seen, out_dir, file_name)
        except BaseException:
            pass
        return _error(exc)
    finally:
        with _lock:
            _cancel_flags.pop(job, None)
