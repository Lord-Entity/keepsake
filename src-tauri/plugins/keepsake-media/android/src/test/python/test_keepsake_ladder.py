import copy

import pytest

import keepsake_ladder as kl

DEV = "1234567890123456789"
COMMON = {
    "source_address": "0.0.0.0",
    "extractor_retries": 5,
    "retries": 15,
    "fragment_retries": 15,
    "http_chunk_size": 10485760,
}


@pytest.mark.parametrize("host", ["www.tiktok.com", "vm.tiktok.com", "tiktok.com.", "TIKTOK.COM"])
def test_site_for_tiktok(host):
    assert kl.site_for(host) == "tiktok"


@pytest.mark.parametrize("host", ["www.instagram.com", "instagr.am"])
def test_site_for_instagram(host):
    assert kl.site_for(host) == "instagram"


@pytest.mark.parametrize("host", [
    None, "", "www.youtube.com", "youtu.be", "m.youtube.com",
    "nottiktok.com", "tiktok.com.evil.org", "x.com",
])
def test_site_for_other(host):
    assert kl.site_for(host) is None


@pytest.mark.parametrize("site", ["tiktok", "instagram", None])
@pytest.mark.parametrize("attempt", [0, 1])
def test_attempt_one_is_empty(site, attempt):
    assert kl.attempt_overrides(site, attempt, DEV) == {}


@pytest.mark.parametrize("attempt", [0, 1, 2, 3])
def test_site_none_always_empty(attempt):
    assert kl.attempt_overrides(None, attempt, DEV) == {}


def test_tiktok_attempt2():
    assert kl.attempt_overrides("tiktok", 2, DEV) == {
        **COMMON, "extractor_args": {"tiktok": {"device_id": [DEV]}},
    }


def test_tiktok_attempt3():
    assert kl.attempt_overrides("tiktok", 3, DEV) == {
        **COMMON,
        "socket_timeout": 45,
        "extractor_args": {"tiktok": {
            "device_id": [DEV], "api_hostname": ["api22-normal-c-alisg.tiktokv.com"],
        }},
    }


def test_instagram_attempt2():
    assert kl.attempt_overrides("instagram", 2, DEV) == COMMON


def test_instagram_attempt3():
    assert kl.attempt_overrides("instagram", 3, DEV) == {
        **COMMON,
        "socket_timeout": 45,
        "extractor_args": {"instagram": {"app_id": ["124024574287414"]}},
    }


def test_tiktok_attempt2_without_device_id():
    assert "extractor_args" not in kl.attempt_overrides("tiktok", 2)


@pytest.mark.parametrize("site", ["tiktok", "instagram"])
@pytest.mark.parametrize("attempt", [2, 3])
def test_extractor_args_shape(site, attempt):
    for ie, args in kl.attempt_overrides(site, attempt, DEV).get("extractor_args", {}).items():
        assert ie == ie.lower()
        for vals in args.values():
            assert isinstance(vals, list) and all(isinstance(x, str) for x in vals)


def test_merge_does_not_mutate_base():
    base = {
        "extractor_args": {"youtube": {"player_client": ["x"]}},
        "http_headers": {"A": "1"},
        "retries": 1,
    }
    snap = copy.deepcopy(base)
    out = kl.merge_opts(base, {
        "extractor_args": {"youtube": {"po_token": ["t"]}, "tiktok": {"device_id": ["9"]}},
        "http_headers": {"B": "2"},
        "retries": 15,
    })
    assert base == snap
    assert out is not base
    assert out["extractor_args"]["youtube"] is not base["extractor_args"]["youtube"]


def test_merge_extractor_args_per_ie():
    base = {"extractor_args": {"youtube": {"player_client": ["x"]}}}
    out = kl.merge_opts(base, {"extractor_args": {"tiktok": {"device_id": ["9"]}}})
    assert out == {"extractor_args": {
        "youtube": {"player_client": ["x"]}, "tiktok": {"device_id": ["9"]},
    }}


def test_merge_same_ie_merges_args():
    base = {"extractor_args": {"tiktok": {"api_hostname": ["h"], "device_id": ["1"]}}}
    out = kl.merge_opts(base, {"extractor_args": {"tiktok": {"device_id": ["2"]}}})
    assert out["extractor_args"] == {"tiktok": {"api_hostname": ["h"], "device_id": ["2"]}}


def test_merge_http_headers_and_replace():
    base = {"http_headers": {"A": "1", "B": "1"}, "retries": 1, "quiet": True}
    out = kl.merge_opts(base, {"http_headers": {"B": "2", "C": "3"}, "retries": 15})
    assert out == {"http_headers": {"A": "1", "B": "2", "C": "3"}, "retries": 15, "quiet": True}


def test_merge_empty_overrides():
    base = {"a": 1, "extractor_args": {"youtube": {"k": ["v"]}}}
    assert kl.merge_opts(base, {}) == base


def test_code_sets_disjoint_and_members():
    assert not (kl.FINAL_CODES & kl.RETRY_CODES)
    assert not (kl.FINAL_CODES & kl.BACKOFF_CODES)
    assert not (kl.RETRY_CODES & kl.BACKOFF_CODES)
    for c in ("login_required", "not_found", "cancelled", "no_space", "too_large", "unsupported_url"):
        assert c in kl.FINAL_CODES


@pytest.mark.parametrize("code", sorted(kl.FINAL_CODES))
def test_next_step_final(code):
    assert kl.next_step(code, 1, False) == "stop"


@pytest.mark.parametrize("code", sorted(kl.RETRY_CODES))
def test_next_step_retry(code):
    assert kl.MAX_ATTEMPTS == 3
    assert kl.next_step(code, 1, False) == "retry"
    assert kl.next_step(code, 2, False) == "retry"
    assert kl.next_step(code, 3, False) == "stop"
    assert kl.next_step(code, 1, False, bridge_error=True) == "stop"


def test_next_step_rate_limited():
    assert kl.next_step("rate_limited", 1, False) == "backoff"
    assert kl.next_step("rate_limited", 1, True) == "stop"
    assert kl.next_step("rate_limited", 3, False) == "stop"


def test_next_step_unlisted():
    assert kl.next_step("weird", 1, False) == "stop"


def test_final_text_instagram_no_video():
    msg = "ERROR: [Instagram] DQx1: There is no video in this post"
    assert kl.final_text("instagram", msg) is True
    assert kl.final_text("instagram", "HTTP Error 500") is False
    assert kl.final_text("instagram", None) is False


@pytest.mark.parametrize("site", ["tiktok", None, "youtube"])
def test_final_text_other_sites_never(site):
    assert kl.final_text(site, "There is no video in this post") is False


def test_partial_victims_nothing_finished():
    seen = {"/o/a.mp4.part", "/o/a.mp4"}
    assert kl.partial_victims(seen, set()) == {"/o/a.mp4.part", "/o/a.mp4.ytdl", "/o/a.mp4"}


def test_partial_victims_keeps_finished():
    seen = {"/o/a.mp4.part", "/o/a.mp4"}
    out = kl.partial_victims(seen, {"/o/a.mp4"})
    assert out == {"/o/a.mp4.part", "/o/a.mp4.ytdl"}
    assert "/o/a.mp4" not in out


def test_partial_victims_merge_case():
    seen = {"/o/c.f137.mp4", "/o/c.f137.mp4.part", "/o/c.f140.m4a.part"}
    out = kl.partial_victims(seen, {"/o/c.f137.mp4"})
    assert "/o/c.f137.mp4" not in out
    assert out == {
        "/o/c.f137.mp4.part", "/o/c.f137.mp4.ytdl",
        "/o/c.f140.m4a.part", "/o/c.f140.m4a.ytdl", "/o/c.f140.m4a",
    }


def test_partial_victims_ignores_empty():
    assert kl.partial_victims({None, "", "/o/a.mp4"}, {None, ""}) == {
        "/o/a.mp4", "/o/a.mp4.part", "/o/a.mp4.ytdl",
    }
