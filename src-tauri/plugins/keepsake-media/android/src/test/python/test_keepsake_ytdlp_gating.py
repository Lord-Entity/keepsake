"""Regression pins for the user's rule: YouTube / TikTok / Instagram must not break.

keepsake_ytdlp imports yt_dlp at top level, so it is imported here against an empty stub module
(no yt_dlp install needed, no network, no sleeps: the retry loop is driven with fake run() callables
and BACKOFF is never reached because the errors used classify as "forbidden").
"""
import importlib
import sys
import types

import pytest

import keepsake_ladder as kl

BASE = {
    "noplaylist": True,
    "quiet": True,
    "no_warnings": False,
    "retries": 10,
    "fragment_retries": 10,
    "socket_timeout": 30,
    "concurrent_fragment_downloads": 4,
    "restrictfilenames": False,
    "extract_flat": False,
    "cachedir": False,
    "noprogress": True,
}
COMMON = {
    "source_address": "0.0.0.0",
    "extractor_retries": 5,
    "retries": 15,
    "fragment_retries": 15,
    "http_chunk_size": 10485760,
}
YT_URLS = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
]
TT = "https://www.tiktok.com/@a/video/1"
IG = "https://www.instagram.com/reel/abc/"


@pytest.fixture
def ky(monkeypatch):
    monkeypatch.setitem(sys.modules, "yt_dlp", types.ModuleType("yt_dlp"))
    monkeypatch.delitem(sys.modules, "keepsake_ytdlp", raising=False)
    mod = importlib.import_module("keepsake_ytdlp")
    yield mod
    sys.modules.pop("keepsake_ytdlp", None)


@pytest.mark.parametrize("host", ["music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com",
                                  "accounts.youtube.com"])
def test_more_youtube_hosts_have_no_ladder_site(host):
    assert kl.site_for(host) is None


@pytest.mark.parametrize("url", YT_URLS)
def test_youtube_never_enters_ladder(ky, url):
    assert ky._ladder_site(url) is None
    calls = []

    def run(overrides):
        calls.append(overrides)
        raise Exception("HTTP Error 403: Forbidden")  # retryable on TikTok/Instagram, must not retry here

    with pytest.raises(Exception, match="403"):
        ky._ladder(url, None, run)
    assert calls == [{}]


@pytest.mark.parametrize("url,site", [(TT, "tiktok"), ("https://vm.tiktok.com/Z/", "tiktok"), (IG, "instagram")])
def test_ladder_site_for_tiktok_instagram(ky, url, site):
    assert ky._ladder_site(url) == site


@pytest.mark.parametrize("url", [TT, IG])
def test_first_attempt_runs_with_no_overrides(ky, url):
    calls = []

    def run(overrides):
        calls.append(overrides)
        return "ok"

    assert ky._ladder(url, None, run) == "ok"
    assert calls == [{}]
    opts = {"a": 1}
    assert ky._with(opts, {}) is opts  # attempt 1 keeps the exact options object


def test_tiktok_three_attempts_then_error(ky):
    calls = []

    def run(overrides):
        calls.append(overrides)
        raise Exception("HTTP Error 403: Forbidden")  # classify -> "forbidden" (RETRY_CODES)

    with pytest.raises(Exception, match="403"):
        ky._ladder(TT, None, run)
    assert len(calls) == 3
    assert calls[0] == {}
    dev = calls[1]["extractor_args"]["tiktok"]["device_id"]
    assert len(dev) == 1 and len(dev[0]) == 19 and dev[0].isdigit()
    assert calls[1] == {**COMMON, "extractor_args": {"tiktok": {"device_id": dev}}}
    assert calls[2] == {
        **COMMON, "socket_timeout": 45,
        "extractor_args": {"tiktok": {"device_id": dev, "api_hostname": [kl.TIKTOK_ALT_API_HOST]}},
    }


def test_instagram_three_attempts_then_error(ky):
    calls = []

    def run(overrides):
        calls.append(overrides)
        raise Exception("HTTP Error 403: Forbidden")

    with pytest.raises(Exception, match="403"):
        ky._ladder(IG, None, run)
    assert calls == [
        {},
        COMMON,
        {**COMMON, "socket_timeout": 45, "extractor_args": {"instagram": {"app_id": ["124024574287414"]}}},
    ]


def test_instagram_no_video_is_not_retried(ky):
    calls = []

    def run(overrides):
        calls.append(overrides)
        raise Exception("ERROR: [Instagram] DQx1: There is no video in this post")

    with pytest.raises(Exception, match="no video"):
        ky._ladder(IG, None, run)
    assert calls == [{}]


def test_tiktok_same_text_still_retried(ky):
    calls = []

    def run(overrides):
        calls.append(overrides)
        raise Exception("There is no video in this post")  # "unknown" -> retried, as before

    with pytest.raises(Exception):
        ky._ladder(TT, None, run)
    assert len(calls) == 3


@pytest.mark.parametrize("url", [TT, IG])
@pytest.mark.parametrize("fmt", [None, "best", "137+140"])
def test_tiktok_instagram_first_attempt_options_are_plain_base(ky, url, fmt):
    # No extractor_args, http_chunk_size or format_sort: those are YouTube-only.
    assert ky._opts_for(url, fmt) == BASE


@pytest.mark.parametrize("url", [TT, IG])
def test_tiktok_instagram_full_route_first_attempt_options(ky, monkeypatch, url):
    monkeypatch.setattr(ky, "_QJS", "/qjs")
    monkeypatch.setattr(ky, "_FFMPEG", "/ff")
    monkeypatch.setattr(ky, "_CACHE", "/c")
    assert ky._opts_for(url, None, True) == {
        **BASE, "js_runtimes": {"quickjs": {"path": "/qjs"}}, "ffmpeg_location": "/ff", "cachedir": "/c",
    }


@pytest.mark.parametrize("url", YT_URLS[:3])
def test_youtube_legacy_options_unchanged(ky, url):
    yt = {**BASE, "extractor_args": {"youtube": {"player_client": ["android_vr", "ios", "mweb"]}},
          "http_chunk_size": 10485760}
    assert ky._opts_for(url, "137+140") == yt
    assert ky._opts_for(url, "best") == {**yt, "format_sort": ["res", "fps", "vcodec:h264", "acodec:aac"]}
