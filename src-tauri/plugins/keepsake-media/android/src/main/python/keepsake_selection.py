"""Selection arguments for the self-contained yt-dlp route (plan 11, section 3.6/3.7).

Pure module: no yt_dlp import, so the host test suite (src/test/python) can import it.
The TS side sends a short yt-dlp style argv (only format selection flags). This module
checks it against a fixed allow-list and maps it BY HAND to the matching YoutubeDL
option keys. yt-dlp's own CLI parser (yt_dlp.parse_options) is deliberately not used:
it calls sys.exit through optparse on bad input and builds a full CLI option set we
would have to filter again. The mapping below mirrors yt_dlp/__init__.py for exactly the
allow-listed flags and nothing else.

Paths, output templates, hooks, limits, js_runtimes and ffmpeg_location never come from
this argv: the bridge sets them.
"""

import json
import re

MAX_ARGS = 24

# One concrete format id, or one "+" merge of two (needs ffmpeg). Same rule as Rust validate_format_id.
_FORMAT_ID = re.compile(r"[A-Za-z0-9_.-]{1,64}(?:\+[A-Za-z0-9_.-]{1,64})?")
# -f value: selector syntax without comma, space or quotes.
_FORMAT = re.compile(r"[A-Za-z0-9_.+/\[\]<>=!*?^$:~-]{1,200}")
_FORMAT_SORT = re.compile(r"[a-z0-9:,+_.-]{1,100}")
_AUDIO_QUALITY = re.compile(r"[0-9]{2,3}K")

_MERGE_FORMATS = frozenset(("mp4/mkv", "mp4", "mkv", "webm"))
_AUDIO_FORMATS = frozenset(("m4a",))  # phase 3 adds mp3, opus, wav, flac
_THUMB_FORMATS = frozenset(("jpg", "png"))

# flag -> canonical name, for flags that take one value (the next argv item).
_VALUE_FLAGS = {
    "-f": "format",
    "--format": "format",
    "-S": "format_sort",
    "--format-sort": "format_sort",
    "--merge-output-format": "merge_output_format",
    "--audio-format": "audio_format",
    "--audio-quality": "audio_quality",
    "--convert-thumbnails": "convert_thumbnails",
}
# flag -> canonical name, for flags without a value.
_BOOL_FLAGS = {
    "-x": "extract_audio",
    "--extract-audio": "extract_audio",
    "--embed-metadata": "embed_metadata",
    "--embed-thumbnail": "embed_thumbnail",
}

POSTPROCESSOR_KEYS = frozenset(("FFmpegExtractAudio", "FFmpegMetadata", "EmbedThumbnail", "FFmpegThumbnailsConvertor"))

# The only option keys selection_to_opts may produce.
OPTION_KEYS = frozenset(("format", "format_sort", "merge_output_format", "postprocessors", "writethumbnail", "final_ext"))


class SelectionError(ValueError):
    """The argv or format id is not allowed. The bridge reports it as code "unknown"."""


def _valid(regex, value):
    return isinstance(value, str) and regex.fullmatch(value) is not None


def check_format_id(s):
    """Returns s when it is one concrete id or one "a+b" merge; raises SelectionError otherwise."""
    if not _valid(_FORMAT_ID, s):
        raise SelectionError("Format id not allowed.")
    return s


def _check_value(name, value):
    # Values never start with "-" (same rule as Rust sel_format_ok / sel_sort_ok), so a flag is never swallowed as a value.
    if name == "format":
        ok = _valid(_FORMAT, value) and not value.startswith("-")
    elif name == "format_sort":
        ok = _valid(_FORMAT_SORT, value) and not value.startswith("-")
    elif name == "merge_output_format":
        ok = value in _MERGE_FORMATS
    elif name == "audio_format":
        ok = value in _AUDIO_FORMATS
    elif name == "audio_quality":
        ok = _valid(_AUDIO_QUALITY, value)
    elif name == "convert_thumbnails":
        ok = value in _THUMB_FORMATS
    else:
        ok = False
    if not ok:
        raise SelectionError("Selection value not allowed for %s." % name)


def _parse(argv):
    """argv -> {canonical name: value or True}. A repeated flag keeps its last value, like the CLI."""
    if not isinstance(argv, (list, tuple)) or not 1 <= len(argv) <= MAX_ARGS:
        raise SelectionError("Selection arguments must be a list of 1 to %d items." % MAX_ARGS)
    if not all(isinstance(a, str) for a in argv):
        raise SelectionError("Selection arguments must be strings.")
    out = {}
    i = 0
    while i < len(argv):
        flag = argv[i]
        if flag in _BOOL_FLAGS:
            out[_BOOL_FLAGS[flag]] = True
            i += 1
        elif flag in _VALUE_FLAGS:
            if i + 1 >= len(argv):
                raise SelectionError("Missing value for %s." % flag)
            name = _VALUE_FLAGS[flag]
            _check_value(name, argv[i + 1])
            out[name] = argv[i + 1]
            i += 2
        else:
            # Covers -o, -P, --exec*, --ffmpeg-location, --js-runtimes, --remote-components,
            # --extractor-args, --postprocessor-args, --plugin-dirs, --config-location*, --cookies*,
            # --load-info-json, "--", "--flag=value" forms and stray values.
            raise SelectionError("Selection flag not allowed: %s" % flag[:40])
    return out


def check_selection(argv):
    """Returns a copy of argv when every item is allowed; raises SelectionError otherwise."""
    _parse(argv)
    return list(argv)


def parse_args_json(args_json):
    """The Kotlin bridge passes the argv as a JSON array string. Returns the checked list."""
    try:
        argv = json.loads(args_json) if isinstance(args_json, str) else None
    except ValueError:
        argv = None
    if not isinstance(argv, list):
        raise SelectionError("Selection arguments must be a JSON array of strings.")
    return check_selection(argv)


def check_postprocessors(pps):
    """Every postprocessor must be a dict whose key is allow-listed."""
    if not isinstance(pps, list):
        raise SelectionError("Postprocessors must be a list.")
    for pp in pps:
        if not isinstance(pp, dict) or pp.get("key") not in POSTPROCESSOR_KEYS:
            raise SelectionError("Postprocessor not allowed.")
    return pps


def selection_to_opts(argv):
    """Allow-listed argv -> YoutubeDL option dict. Mirrors yt_dlp/__init__.py for these flags:
    get_postprocessors() order is FFmpegThumbnailsConvertor, FFmpegExtractAudio, FFmpegMetadata,
    EmbedThumbnail; final_ext is the audio format when -x extracts to a known extension;
    --audio-quality "192K" is stored without the K; -S is split on commas.
    --audio-format and --audio-quality without -x have no effect, as on the CLI."""
    p = _parse(argv)
    opts = {}
    if "format" in p:
        opts["format"] = p["format"]
    if "format_sort" in p:
        opts["format_sort"] = [s for s in p["format_sort"].split(",") if s]
    if "merge_output_format" in p:
        opts["merge_output_format"] = p["merge_output_format"]

    pps = []
    if "convert_thumbnails" in p:
        pps.append({"key": "FFmpegThumbnailsConvertor", "format": p["convert_thumbnails"], "when": "before_dl"})
    if p.get("extract_audio"):
        audio_format = p.get("audio_format", "best")
        quality = p.get("audio_quality", "5")
        pps.append({
            "key": "FFmpegExtractAudio",
            "preferredcodec": audio_format,
            "preferredquality": quality[:-1] if quality.endswith("K") else quality,
            "nopostoverwrites": False,
        })
        if audio_format in _AUDIO_FORMATS:
            opts["final_ext"] = audio_format
        if "format" not in opts:  # CLI: -x without -f (and without -k) downloads audio only
            opts["format"] = "bestaudio/best"
    if p.get("embed_metadata"):
        pps.append({"key": "FFmpegMetadata", "add_chapters": True, "add_metadata": True, "add_infojson": "if_exists"})
    if p.get("embed_thumbnail"):
        # already_have_thumbnail=False: yt-dlp deletes the written thumbnail after embedding it.
        pps.append({"key": "EmbedThumbnail", "already_have_thumbnail": False})
        opts["writethumbnail"] = True
    if pps:
        opts["postprocessors"] = check_postprocessors(pps)

    if not set(opts) <= OPTION_KEYS:  # unreachable; keeps the contract explicit
        raise SelectionError("Selection produced an option that is not allowed.")
    return opts


_PART_TAIL = re.compile(r"f[^.\/]+\.[A-Za-z0-9]+")
_PART_DEFAULT = re.compile(r"\]\.f[^.\/]+\.[A-Za-z0-9]+$")


def is_format_part(path, file_name=None):
    """True for a yt-dlp per-format part ("<name>.f137.mp4", "<name>.f251.webm"): the video-only or
    audio-only input of a merge, never a deliverable file. With the bridge's own file_name the
    check is exact ("<file_name>.f<id>.<ext>"); otherwise the default template "...[<id>].<ext>"."""
    base = str(path or "").replace("\\", "/").rsplit("/", 1)[-1]
    if file_name:
        head = str(file_name) + "."
        return base.startswith(head) and _PART_TAIL.fullmatch(base[len(head):]) is not None
    return _PART_DEFAULT.search(base) is not None
