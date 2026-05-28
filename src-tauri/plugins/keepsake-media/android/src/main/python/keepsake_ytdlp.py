"""yt-dlp bridge for the Keepsake Android app (called from Kotlin through Chaquopy).

Functions take plain strings and return ONE JSON string. They never raise.
Options are built only from a fixed allow-list: no cookies, proxy, credentials or
external downloaders, no postprocessors except the allow-listed ones of the full route,
and nothing from user input except the format id or selection argv, the output folder
and the file name.
Failures are FLAT: {"ok": false, "code": ..., "message": ...}.

Two routes (plan 11). full=False (default) is the legacy route and its options are unchanged.
full=True (the TS side sends it only when status() is ready) adds the bundled QuickJS-NG
(js_runtimes), the bundled ffmpeg (ffmpeg_location) and a player cache, drops the YouTube
player_client override (yt-dlp defaults, like desktop) and accepts selection argv
(keepsake_selection) or a "+" merge of two format ids.
"""

import errno
import glob
import json
import os
import re
import random
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

import yt_dlp

try:
    from keepsake_urls import canonical_youtube_url
except Exception:  # module missing or broken: keep the original URL rather than fail to load the bridge
    def canonical_youtube_url(url):
        return None

try:
    import keepsake_selection as _sel
except Exception:  # broken module only disables the full route, never the legacy one
    _sel = None

try:
    import keepsake_ladder as _lad
except Exception:  # broken module only disables the TikTok/Instagram retry ladder (one attempt, as before)
    _lad = None

MAX_FILESIZE = 2 * 1024 * 1024 * 1024

# MUST equal the yt-dlp-ejs pin in build.gradle.kts (yt-dlp 2026.10.26 pyproject pins 0.8.0).
_EJS_PIN = "0.8.0"
_QJS_NAME = "libqjs.so"
_FFMPEG_NAME = "libffmpeg.so"

# Set by configure(); None until then (full route then fails with js_runtime_missing / ytdlp_missing).
_NATIVE_DIR = None
_QJS = None
_FFMPEG = None
_CACHE = None

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

# YouTube only: these clients need no JS runtime. yt-dlp merges the formats of every client in the list.
# Order: android_vr first (most reliable without a PO token, though it often tops out at 360p), then ios
# (MP4 AVC/AAC up to 1080p when it works), then mweb (last resort; may need a PO token). A PO token may
# still be required for some videos; the TS side reports the best height actually returned.
# TikTok/Instagram never get these options.
_YT_HOSTS = ("youtube.com", "youtu.be", "youtube-nocookie.com")
_YT_ARGS = {"youtube": {"player_client": ["android_vr", "ios", "mweb"]}}


def _host(url):
    try:
        return (urllib.parse.urlsplit(str(url)).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


def _is_youtube(url):
    host = _host(url)
    return any(host == h or host.endswith("." + h) for h in _YT_HOSTS)


def _prepare_url(url):
    """YouTube links become https://www.youtube.com/watch?v=ID; everything else is returned unchanged.
    A YouTube playlist-only link (list= without a video id) is rejected before yt-dlp walks the list."""
    if not _is_youtube(url):
        return url
    try:
        canon = canonical_youtube_url(url)
    except Exception:
        canon = None
    if canon:
        return canon
    try:
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(str(url)).query)
    except ValueError:
        query = {}
    if query.get("list") or "/playlist" in str(url).lower():
        raise _Fail("unsupported_url", "Playlists are not supported on Android yet. Open a single video link.")
    return url


def _is_best_video(format_id):
    f = str(format_id or "").strip()
    return f == "best" or f.startswith("bestvideo") or f.startswith("best[")


def _opts_for(url, format_id=None, full=False):
    """BASE copy; YouTube hosts additionally get extractor_args and a 10 MiB chunk size
    (and, for a best-video selector, resolution-first format_sort).
    full=True: no player_client override and no format_sort (yt-dlp defaults, like desktop);
    js_runtimes, ffmpeg_location and the on-disk cache instead."""
    o = dict(BASE)
    if full:
        youtube = _is_youtube(url)
        if youtube and not _QJS:
            raise _Fail("js_runtime_missing", "The bundled JavaScript runtime is not available.")
        if not _FFMPEG:
            raise _Fail("ytdlp_missing", "The bundled ffmpeg is not available.")
        if youtube:
            o["http_chunk_size"] = 10 * 1024 * 1024
        if _QJS:
            o["js_runtimes"] = {"quickjs": {"path": _QJS}}
        o["ffmpeg_location"] = _FFMPEG
        if _CACHE:
            o["cachedir"] = _CACHE  # player JS + solver cache; re-solving on every call is slow on a phone
        return o
    if _is_youtube(url):
        o["extractor_args"] = {"youtube": {"player_client": list(_YT_ARGS["youtube"]["player_client"])}}
        o["http_chunk_size"] = 10 * 1024 * 1024
        # The Android TS side sends concrete format IDs (e.g. "137+140"), so this sort only
        # applies when a best-style selector ("best", "bestvideo...", "best[...") reaches us.
        if _is_best_video(format_id):
            # Approach adapted from the client's MIT-licensed yt-delp app (Copyright (c) 2026 Abdullah Masood, MIT):
            # sort resolution first, codec second, so 1080p+ is not capped by a codec preference.
            o["format_sort"] = ["res", "fps", "vcodec:h264", "acodec:aac"]
    return o


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
    # Before login_required: YouTube says "Sign in to confirm you're not a bot".
    ("bot_check", ("confirm you're not a bot", "confirm you are not a bot", "confirm you’re not a bot")),
    # Before login_required: Instagram's anonymous rate limit says "redirected to the login page.
    # You have exceeded the rate-limit for accessing posts anonymously".
    ("rate_limited", ("exceeded the rate-limit",)),
    ("js_runtime_missing", ("no supported javascript runtime",)),
    # Before not_found ("ffmpeg not found").
    ("ytdlp_missing", ("ffmpeg not found", "ffmpeg-location", "ffprobe and ffmpeg not found", "ffmpeg is not installed")),
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
    if isinstance(inner, _Fail):  # e.g. too_large raised in a hook and wrapped by yt-dlp
        return inner.code
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


def _ladder_site(url):
    """"tiktok" / "instagram" when the retry ladder applies to url, else None (YouTube and every other host)."""
    if _lad is None:
        return None
    try:
        return _lad.site_for(_host(url))
    except Exception:
        return None


def _wait(seconds, job):
    """Sleeps up to seconds; raises CancelledError as soon as job is cancelled."""
    end = time.time() + seconds
    while True:
        if job and _is_cancelled(job):
            raise CancelledError("Cancelled by user.")
        left = end - time.time()
        if left <= 0:
            return
        time.sleep(min(0.25, left))


def _ladder(url, job, run, between=None):
    """Runs run(overrides) and returns its result. Non-ladder hosts: exactly one call, run({}).
    TikTok/Instagram: attempt 1 is run({}) too (the normal options); after a retryable failure
    (keepsake_ladder.next_step) attempts 2 and 3 get keepsake_ladder.attempt_overrides. Errors the
    bridge raised itself (_Fail) and final codes are never retried. between() runs before every
    retry (download: remove partial files). The last error is re-raised unchanged."""
    site = _ladder_site(url)
    if site is None:
        return run({})
    device_id = str(random.SystemRandom().randrange(10 ** 18, 10 ** 19)) if site == "tiktok" else None
    attempt = 1
    backed_off = False
    while True:
        if attempt > 1 and job and _is_cancelled(job):
            raise CancelledError("Cancelled by user.")
        try:
            return run(_lad.attempt_overrides(site, attempt, device_id))
        except Exception as exc:  # KeyboardInterrupt / SystemExit are never retried
            code = _classify(exc)
            step = _lad.next_step(code, attempt, backed_off, isinstance(exc, _Fail))
            if step == "stop" or _lad.final_text(site, exc):
                raise
            try:
                sys.stderr.write("keepsake_ytdlp: %s attempt %d failed (%s), %s\n" % (site, attempt, code, step))
            except Exception:
                pass
            if step == "backoff":
                backed_off = True
                _wait(_lad.BACKOFF_SECONDS, job)
            if between is not None:
                between()
            attempt += 1


def _with(opts, overrides):
    """opts unchanged (same object) when there is nothing to add: attempt 1 keeps the exact options."""
    return _lad.merge_opts(opts, overrides) if overrides else opts


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
        "width": _int(f.get("width")),
        "fps": _float(f.get("fps")),
        "tbr": _float(f.get("tbr")),
        "abr": _float(f.get("abr")),
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


def _exe(name):
    """(path or None, problem or None) for a bundled executable in nativeLibraryDir."""
    stem = "qjs" if name == _QJS_NAME else "ffmpeg"
    path = os.path.join(_NATIVE_DIR, name) if _NATIVE_DIR else None
    if not path or not os.path.isfile(path):
        return None, stem + "_missing"
    if not os.access(path, os.X_OK):
        return None, stem + "_exec_denied"
    return path, None


def configure(native_dir, cache_dir):
    """Called once by Kotlin after Python.start. Idempotent; never raises; returns {"ok": true}."""
    global _NATIVE_DIR, _QJS, _FFMPEG, _CACHE
    try:
        _NATIVE_DIR = str(native_dir) if native_dir else None
        _QJS = _exe(_QJS_NAME)[0]
        _FFMPEG = _exe(_FFMPEG_NAME)[0]
    except BaseException:
        _QJS = _FFMPEG = None
    if cache_dir:
        try:
            tmp = os.path.join(str(cache_dir), "ytdlp-tmp")
            os.makedirs(tmp, exist_ok=True)
            tempfile.tempdir = tmp  # the EJS solver writes its script here (read by qjs, never executed)
        except BaseException:
            pass
        try:
            cache = os.path.join(str(cache_dir), "yt-dlp")
            os.makedirs(cache, exist_ok=True)
            _CACHE = cache
        except BaseException:
            _CACHE = None
    return json.dumps({"ok": True})


def _run_version(argv):
    """Combined stdout+stderr text of a short version probe. Raises OSError / TimeoutExpired."""
    r = subprocess.run(argv, capture_output=True, timeout=10)
    return (r.stdout or b"").decode("utf-8", "replace") + "\n" + (r.stderr or b"").decode("utf-8", "replace"), r.returncode


def _qjs_status():
    """(label like "quickjs-ng 0.18.0" or None, problem or None)."""
    path, problem = _exe(_QJS_NAME)
    if problem:
        return None, problem
    try:
        # Private yt-dlp API: the same probe yt-dlp itself runs before using the runtime.
        from yt_dlp.utils._jsruntime import QuickJsRuntime
        ri = QuickJsRuntime(path=path).info
        if ri is not None:
            label = "%s %s" % (ri.name, ri.version)
            return (label, None) if ri.supported else (label, "qjs_unsupported")
    except Exception:
        pass
    # Fallback (and the way to tell "cannot exec" from "bad output"): run `--help` ourselves.
    try:
        out, _ = _run_version([path, "--help"])
    except OSError:
        return None, "qjs_exec_denied"
    except Exception:
        return None, "qjs_broken"
    m = re.search(r"^QuickJS(-ng)?\s+version\s+(\S+)", out, re.M)
    if not m:
        return None, "qjs_broken"
    return ("quickjs-ng " if m.group(1) else "quickjs ") + m.group(2), None


def _ffmpeg_status():
    path, problem = _exe(_FFMPEG_NAME)
    if problem:
        return None, problem
    try:
        out, code = _run_version([path, "-version"])
    except OSError:
        return None, "ffmpeg_exec_denied"
    except Exception:
        return None, "ffmpeg_broken"
    first = out.strip().splitlines()[0].strip() if out.strip() else ""
    if code != 0 or not first.lower().startswith("ffmpeg"):
        return None, "ffmpeg_broken"
    return first[:200], None


def _ejs_version():
    try:
        import yt_dlp_ejs
        v = getattr(yt_dlp_ejs, "version", None)
        if isinstance(v, str) and v:
            return v
    except Exception:
        return None
    try:
        import importlib.metadata
        return importlib.metadata.version("yt-dlp-ejs")
    except Exception:
        return None


def status():
    """{"ok":true,"ytdlp","ejs","jsRuntime","ffmpeg","ready","problems"} (plan 3.7). Offline; never raises."""
    try:
        problems = []
        try:
            from yt_dlp.version import __version__ as ytdlp_version
        except Exception:
            ytdlp_version = ""
        if not ytdlp_version:
            problems.append("ytdlp_missing")
        ejs = _ejs_version()
        if ejs is None:
            problems.append("ejs_missing")
        elif ejs != _EJS_PIN:
            problems.append("ejs_mismatch")
        js, p = _qjs_status()
        if p:
            problems.append(p)
        ff, p = _ffmpeg_status()
        if p:
            problems.append(p)
        if _sel is None:
            problems.append("selection_missing")
        ready = not problems and bool(ytdlp_version and ejs and js and ff)
        return json.dumps({
            "ok": True, "ytdlp": ytdlp_version, "ejs": ejs, "jsRuntime": js, "ffmpeg": ff,
            "ready": ready, "problems": problems,
        }, ensure_ascii=False)
    except BaseException as exc:
        return _error(exc)


def info(url, full=False):
    try:
        url = _prepare_url(url)
        # Every format is returned (reduced); the TS side picks the phone-muxable one (legacy)
        # or shows every height (full).
        def run(overrides):
            with yt_dlp.YoutubeDL(_with(_opts_for(url, None, full is True), overrides)) as ydl:
                return ydl.sanitize_info(ydl.extract_info(url, download=False))

        raw = _ladder(url, None, run)
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


def _remove_files(seen, out_dir, file_name, full=False):
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
        if full:
            # ffmpeg merge/fixup output before its rename: "<name>.temp.<ext>".
            stem, ext = os.path.splitext(f[:-5] if f.endswith(".part") else f)
            victims.add(stem + ".temp" + ext)
    if full and file_name:
        # Merge intermediates "<name>.f137.mp4", "<name>.f140.m4a(.part)" and "<name>.temp.mp4".
        prefix = os.path.join(glob.escape(out_dir), glob.escape(file_name))
        victims.update(glob.glob(prefix + ".f*.*"))
        victims.update(glob.glob(prefix + ".temp.*"))
    if not seen and file_name:
        victims.update(glob.glob(os.path.join(glob.escape(out_dir), glob.escape(file_name) + ".*.part")))
    for v in victims:
        try:
            if os.path.realpath(v).startswith(root):
                os.remove(v)
        except OSError:
            pass


def _remove_partials(seen, finished, out_dir, file_name, full=False):
    """Between ladder attempts: like _remove_files, but complete downloads (finished) are kept."""
    root = os.path.realpath(out_dir) + os.sep
    victims = set(_lad.partial_victims(seen, finished))
    for f in seen:
        if f:
            base = f[:-5] if f.endswith(".part") else f
            victims.update(glob.glob(glob.escape(base) + "-Frag*"))
    if file_name:
        prefix = os.path.join(glob.escape(out_dir), glob.escape(file_name))
        victims.update(glob.glob(prefix + ".*.part"))
        victims.update(glob.glob(prefix + ".*.ytdl"))
        if full:
            victims.update(glob.glob(prefix + ".temp.*"))
    keep = set(os.path.realpath(f) for f in finished if f)
    for v in victims:
        try:
            real = os.path.realpath(v)
            if real.startswith(root) and real not in keep:
                os.remove(v)
        except OSError:
            pass


def _full_selection(format_id, args_json):
    """Option keys for the full route: from the selection argv, or {"format": id} / {"format": "a+b"}.
    Exactly one of format_id / args_json must be given."""
    if _sel is None:
        raise _Fail("ytdlp_missing", "The selection module is not available.")
    has_args = args_json is not None
    has_id = format_id is not None and format_id != ""
    if has_args == has_id:
        raise _Fail("unknown", "Give exactly one of a format id or selection arguments.")
    try:
        if has_args:
            return _sel.selection_to_opts(_sel.parse_args_json(args_json))
        return {"format": _sel.check_format_id(format_id)}
    except _sel.SelectionError as exc:
        raise _Fail("unknown", str(exc))


def download(url, format_id, out_dir, file_name, job_id, args_json=None, full=False):
    """Legacy route (full=False, args_json=None): unchanged. Selection argv (args_json, a JSON
    array string) is only accepted on the full route, because it may need ffmpeg."""
    job = str(job_id) if job_id is not None else ""
    seen = set()
    finished = set()  # complete downloads: kept between ladder attempts (overwrites=False reuses them)
    full = full is True
    try:
        if job and _is_cancelled(job):
            raise CancelledError("Cancelled by user.")
        if args_json is not None and not full:
            raise _Fail("unknown", "Selection arguments need the full route.")
        url = _prepare_url(url)

        def hook(d):
            for k in ("tmpfilename", "filename"):
                if d.get(k):
                    seen.add(d[k])
            if d.get("status") == "finished" and d.get("filename"):
                finished.add(d["filename"])
            if job and _is_cancelled(job):
                raise CancelledError("Cancelled by user.")
            for k in ("total_bytes", "total_bytes_estimate", "downloaded_bytes"):
                v = d.get(k)
                if isinstance(v, (int, float)) and v > MAX_FILESIZE:
                    raise _Fail("too_large", "The file is larger than the 2 GiB limit on Android.")

        if file_name:
            name_tmpl = file_name.replace("%", "%%") + ".%(ext)s"
        else:
            name_tmpl = "%(title).80B [%(id)s].%(ext)s"
        if full:
            def pp_hook(d):
                # Runs between postprocessors (merge, fixups, extract audio). A running ffmpeg is
                # not interrupted; its output is removed by _remove_files.
                fp = (d.get("info_dict") or {}).get("filepath")
                if isinstance(fp, str) and fp:
                    seen.add(fp)
                if job and _is_cancelled(job):
                    raise CancelledError("Cancelled by user.")

            selection = _full_selection(format_id, args_json)

        def build():
            if full:
                opts = _opts_for(url, None, True)
                opts.update(selection)
                opts.update({
                    # temp == home, so merge intermediates stay under out_dir (checked and cleaned below).
                    "paths": {"home": out_dir, "temp": out_dir},
                    "outtmpl": {"default": name_tmpl},
                    "max_filesize": MAX_FILESIZE,
                    "overwrites": False,
                    "progress_hooks": [hook],
                    "postprocessor_hooks": [pp_hook],
                })
            else:
                opts = _opts_for(url, format_id)
                opts.update({
                    "format": format_id,
                    "paths": {"home": out_dir, "temp": out_dir},
                    "outtmpl": {"default": name_tmpl},
                    "max_filesize": MAX_FILESIZE,
                    "overwrites": False,
                    "progress_hooks": [hook],
                })
            return opts

        def run(overrides):
            with yt_dlp.YoutubeDL(_with(build(), overrides)) as ydl:
                return ydl.extract_info(url, download=True)

        def between():
            # Before a ladder retry: drop partial files (a .part from another session/IP must not be
            # resumed), keep complete ones so they are not downloaded again.
            try:
                _remove_partials(seen, finished, out_dir, file_name, full)
            except Exception:
                pass

        res = _ladder(url, job, run, between)
        _reject_playlist(res)
        path = ((res.get("requested_downloads") or [{}])[0]).get("filepath")
        if not path or not os.path.isfile(path):
            rd = (res.get("requested_downloads") or [{}])[0]
            size = rd.get("filesize") or rd.get("filesize_approx") or res.get("filesize") or res.get("filesize_approx")
            if isinstance(size, (int, float)) and size > MAX_FILESIZE:
                raise _Fail("too_large", "The file is larger than the 2 GiB limit on Android.")
            raise _Fail("empty", "yt-dlp finished without writing a file.")
        if full and _sel.is_format_part(path, file_name):
            # A skipped merge leaves a video-only or audio-only part: never deliver it (except: removes all parts).
            seen.add(path)
            raise _Fail("empty", "yt-dlp did not merge video and audio.")
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
            _remove_files(seen, out_dir, file_name, full)
        except BaseException:
            pass
        return _error(exc)
    finally:
        with _lock:
            _cancel_flags.pop(job, None)
