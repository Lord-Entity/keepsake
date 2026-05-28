import pytest

import keepsake_selection as ks

VIDEO_ARGV = ["-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
              "-S", "res,fps,vcodec:h264,acodec:aac", "--merge-output-format", "mp4/mkv"]
AUDIO_ARGV = ["-f", "bestaudio[ext=m4a]/bestaudio/best", "-x", "--audio-format", "m4a"]


def pp_keys(argv):
    return [p["key"] for p in ks.selection_to_opts(argv)["postprocessors"]]


@pytest.mark.parametrize("argv", [
    ["-f", "best"], ["--format", "best"], ["-S", "res,fps"], ["--format-sort", "res"],
    ["--merge-output-format", "mp4/mkv"], ["--merge-output-format", "mp4"],
    ["--merge-output-format", "mkv"], ["--merge-output-format", "webm"],
    ["-x"], ["--extract-audio"], ["-x", "--audio-format", "m4a"],
    ["-x", "--audio-quality", "192K"], ["-x", "--audio-quality", "96K"],
    ["--embed-metadata"], ["--embed-thumbnail"],
    ["--convert-thumbnails", "jpg"], ["--convert-thumbnails", "png"],
    VIDEO_ARGV, AUDIO_ARGV, ["-x"] * 24, ["-f", "b" * 200],
])
def test_check_selection_accepts(argv):
    out = ks.check_selection(argv)
    assert out == argv
    assert out is not argv


def test_video_argv_maps_exactly():
    assert ks.selection_to_opts(VIDEO_ARGV) == {
        "format": "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        "format_sort": ["res", "fps", "vcodec:h264", "acodec:aac"],
        "merge_output_format": "mp4/mkv",
    }


def test_audio_argv_maps_exactly():
    assert ks.selection_to_opts(AUDIO_ARGV) == {
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "final_ext": "m4a",
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a",
                            "preferredquality": "5", "nopostoverwrites": False}],
    }


def test_audio_quality_strips_k():
    pp = ks.selection_to_opts(["-x", "--audio-quality", "192K"])["postprocessors"][0]
    assert pp["preferredquality"] == "192"


def test_extract_without_format_defaults_to_audio_only():
    assert ks.selection_to_opts(["-x"])["format"] == "bestaudio/best"
    assert "format" not in ks.selection_to_opts(["--embed-metadata"])


def test_embed_metadata_matches_cli_defaults():
    assert ks.selection_to_opts(["--embed-metadata"])["postprocessors"] == [
        {"key": "FFmpegMetadata", "add_chapters": True, "add_metadata": True, "add_infojson": "if_exists"}]
    assert ks.selection_to_opts(["--embed-thumbnail"])["postprocessors"] == [
        {"key": "EmbedThumbnail", "already_have_thumbnail": False}]


def test_audio_format_without_extract_has_no_effect():
    opts = ks.selection_to_opts(["--audio-format", "m4a"])
    assert "postprocessors" not in opts
    assert "final_ext" not in opts


def test_full_postprocessor_chain_order():
    argv = ["--embed-thumbnail", "--convert-thumbnails", "jpg", "--embed-metadata",
            "-x", "--audio-format", "m4a"]
    opts = ks.selection_to_opts(argv)
    assert pp_keys(argv) == ["FFmpegThumbnailsConvertor", "FFmpegExtractAudio",
                             "FFmpegMetadata", "EmbedThumbnail"]
    assert opts["writethumbnail"] is True
    assert opts["postprocessors"][0] == {"key": "FFmpegThumbnailsConvertor", "format": "jpg",
                                         "when": "before_dl"}


@pytest.mark.parametrize("argv", [
    VIDEO_ARGV, AUDIO_ARGV, ["--embed-thumbnail", "--convert-thumbnails", "png", "--embed-metadata", "-x"],
    ["-f", "best"], ["--embed-metadata"],
])
def test_opts_keys_are_allow_listed(argv):
    opts = ks.selection_to_opts(argv)
    assert set(opts) <= ks.OPTION_KEYS
    for pp in opts.get("postprocessors", []):
        assert pp["key"] in ks.POSTPROCESSOR_KEYS


def test_repeated_flag_keeps_last():
    assert ks.selection_to_opts(["-f", "a", "-f", "b"])["format"] == "b"


BAD_ARGV = [
    ["-o", "x"], ["-P", "x"], ["--exec", "x"], ["--exec-before-download", "x"],
    ["--ffmpeg-location", "/x"], ["--js-runtimes", "quickjs"], ["--remote-components", "ejs:github"],
    ["--extractor-args", "youtube:player_client=web"], ["--postprocessor-args", "x"],
    ["--plugin-dirs", "x"], ["--config-location", "x"], ["--config-locations", "x"],
    ["--cookies", "x"], ["--cookies-from-browser", "chrome"], ["--load-info-json", "x"],
    ["--"], ["--", "-f", "best"], ["--format=best"], ["best"], ["--verbose"],
    ["-f"], [], ["-x"] * 25, ["-f", 1], "-f best", None, {"-f": "best"},
    # -f values
    ["-f", "bv,ba"], ["-f", "best video"], ["-f", "it's"], ["-f", 'a"b'], ["-f", "best\n"],
    ["-f", ""], ["-f", "b" * 201], ["-f", "-o"], ["-S", "-o"],
    # -S values
    ["-S", "RES"], ["-S", "res fps"],
    # other values
    ["--merge-output-format", "avi"], ["--merge-output-format", "mp4/webm/mkv"],
    ["-x", "--audio-format", "mp3"], ["-x", "--audio-format", "opus"],
    ["-x", "--audio-format", "wav"], ["-x", "--audio-format", "flac"],
    ["--audio-quality", "192"], ["--audio-quality", "192k"], ["--audio-quality", "1K"],
    ["--audio-quality", "1000K"], ["--audio-quality", "192K\n"],
    ["--convert-thumbnails", "webp"],
]


@pytest.mark.parametrize("argv", BAD_ARGV)
def test_rejections(argv):
    with pytest.raises(ks.SelectionError):
        ks.check_selection(argv)
    with pytest.raises(ks.SelectionError):
        ks.selection_to_opts(argv)


@pytest.mark.parametrize("s", ["137", "137+140", "dash-1+2", "hls-720p.0", "a" * 64,
                               "a" * 64 + "+" + "b" * 64])
def test_check_format_id_ok(s):
    assert ks.check_format_id(s) == s


@pytest.mark.parametrize("s", ["a+b+c", "a+", "+a", "a,b", "a b", "", "a" * 65, "137\n",
                               None, 137, "best[height<=720]"])
def test_check_format_id_rejected(s):
    with pytest.raises(ks.SelectionError):
        ks.check_format_id(s)


def test_parse_args_json_ok():
    assert ks.parse_args_json('["-f","best"]') == ["-f", "best"]


@pytest.mark.parametrize("s", ["not json", '{"-f":"best"}', '"-f"', None, '["-o","x"]'])
def test_parse_args_json_rejected(s):
    with pytest.raises(ks.SelectionError):
        ks.parse_args_json(s)


@pytest.mark.parametrize("key", sorted(ks.POSTPROCESSOR_KEYS))
def test_check_postprocessors_accepts(key):
    pps = [{"key": key}]
    assert ks.check_postprocessors(pps) == pps


@pytest.mark.parametrize("pps", [
    [{"key": "Exec"}], [{"key": "FFmpegCopyStream"}], ["FFmpegMetadata"], [{"format": "jpg"}],
    "FFmpegMetadata", None, {"key": "FFmpegMetadata"},
])
def test_check_postprocessors_rejected(pps):
    with pytest.raises(ks.SelectionError):
        ks.check_postprocessors(pps)


# Regression (desktop bug: unmerged .f137.mp4 + .f251.webm delivered as the result). The full route
# rejects a returned per-format part instead of reporting it as the download.
@pytest.mark.parametrize("path,name,expected", [
    ("/o/clip.f137.mp4", "clip", True),
    ("/o/clip.f251.webm", "clip", True),
    ("/o/clip.fhls-1080p.mp4", "clip", True),
    ("/o/clip.mp4", "clip", False),
    ("/o/clip.mkv", "clip", False),
    ("/o/my.file.mp4", "my.file", False),
    ("/o/my.file.f140.m4a", "my.file", True),
    ("/o/other.f137.mp4", "clip", False),
    ("/o/Clip [abc].f137.mp4", None, True),
    ("/o/Clip [abc].mp4", None, False),
    ("/o/Clip [abc].flv", None, False),
    ("", None, False),
])
def test_is_format_part(path, name, expected):
    assert ks.is_format_part(path, name) is expected
