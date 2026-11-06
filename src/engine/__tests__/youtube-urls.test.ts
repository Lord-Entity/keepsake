/**
 * Unit tests for src/engine/youtube-urls.ts. Pure string work, no network.
 */
import { describe, expect, test } from "bun:test";
import { canonicalYoutubeUrl, isYoutubeHost } from "../youtube-urls";

const ID = "dQw4w9WgXcQ";
const CANON = `https://www.youtube.com/watch?v=${ID}`;

describe("isYoutubeHost", () => {
  test("accepts the exact host set", () => {
    for (const h of ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]) {
      expect(isYoutubeHost(h)).toBe(true);
    }
  });
  test("is case-insensitive", () => {
    expect(isYoutubeHost("WWW.YouTube.com")).toBe(true);
  });
  test("rejects other hosts and subdomains", () => {
    for (const h of ["evil.com", "foo.youtube.com", "youtube.com.evil.com", "notyoutube.com", "", "youtu.be.evil.com"]) {
      expect(isYoutubeHost(h)).toBe(false);
    }
  });
});

describe("canonicalYoutubeUrl accepted forms", () => {
  test("watch on every youtube host", () => {
    for (const host of ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]) {
      expect(canonicalYoutubeUrl(`https://${host}/watch?v=${ID}`)).toBe(CANON);
    }
  });
  test("watch with extra params and v not first", () => {
    expect(canonicalYoutubeUrl(`https://www.youtube.com/watch?list=PLabc&v=${ID}&t=42s`)).toBe(CANON);
  });
  test("youtu.be short link, with query and trailing slash", () => {
    expect(canonicalYoutubeUrl(`https://youtu.be/${ID}`)).toBe(CANON);
    expect(canonicalYoutubeUrl(`https://youtu.be/${ID}?si=xyz&t=5`)).toBe(CANON);
    expect(canonicalYoutubeUrl(`https://youtu.be/${ID}/`)).toBe(CANON);
  });
  test("shorts, live and embed on youtube hosts", () => {
    for (const host of ["youtube.com", "www.youtube.com", "m.youtube.com"]) {
      for (const kind of ["shorts", "live", "embed"]) {
        expect(canonicalYoutubeUrl(`https://${host}/${kind}/${ID}`)).toBe(CANON);
      }
    }
  });
  test("ids with dash and underscore", () => {
    expect(canonicalYoutubeUrl("https://youtu.be/a-b_c-d_e-f")).toBe("https://www.youtube.com/watch?v=a-b_c-d_e-f");
  });
  test("http is upgraded to https", () => {
    expect(canonicalYoutubeUrl(`http://youtu.be/${ID}`)).toBe(CANON);
  });
  test("uppercase host and surrounding whitespace", () => {
    expect(canonicalYoutubeUrl(`  https://WWW.YOUTUBE.COM/watch?v=${ID}  `)).toBe(CANON);
  });
  test("video with a list param still downloads the single video", () => {
    expect(canonicalYoutubeUrl(`https://www.youtube.com/watch?v=${ID}&list=PLxyz`)).toBe(CANON);
  });
});

describe("canonicalYoutubeUrl rejections", () => {
  test("playlist-only URLs", () => {
    expect(canonicalYoutubeUrl("https://www.youtube.com/playlist?list=PLabc123")).toBeNull();
    expect(canonicalYoutubeUrl("https://www.youtube.com/watch?list=PLabc123")).toBeNull();
  });
  test("userinfo trick", () => {
    expect(canonicalYoutubeUrl(`https://www.youtube.com@evil.com/watch?v=${ID}`)).toBeNull();
    expect(canonicalYoutubeUrl(`https://user:pass@www.youtube.com/watch?v=${ID}`)).toBeNull();
    expect(canonicalYoutubeUrl(`https://youtu.be@evil.com/${ID}`)).toBeNull();
  });
  test("wrong hosts and lookalikes", () => {
    for (const u of [
      `https://evil.com/watch?v=${ID}`,
      `https://youtube.com.evil.com/watch?v=${ID}`,
      `https://foo.youtube.com/watch?v=${ID}`,
      `https://notyoutu.be/${ID}`,
      `https://youtu.be.evil.com/${ID}`,
    ]) {
      expect(canonicalYoutubeUrl(u)).toBeNull();
    }
  });
  test("non-http schemes", () => {
    expect(canonicalYoutubeUrl(`ftp://www.youtube.com/watch?v=${ID}`)).toBeNull();
    expect(canonicalYoutubeUrl(`javascript:alert(1)//youtube.com/watch?v=${ID}`)).toBeNull();
    expect(canonicalYoutubeUrl(`file:///watch?v=${ID}`)).toBeNull();
  });
  test("explicit port", () => {
    expect(canonicalYoutubeUrl(`https://www.youtube.com:8443/watch?v=${ID}`)).toBeNull();
  });
  test("malformed or empty input", () => {
    expect(canonicalYoutubeUrl("")).toBeNull();
    expect(canonicalYoutubeUrl("not a url")).toBeNull();
    expect(canonicalYoutubeUrl("youtube.com/watch?v=" + ID)).toBeNull();
  });
  test("bad video ids", () => {
    expect(canonicalYoutubeUrl("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(canonicalYoutubeUrl(`https://www.youtube.com/watch?v=${ID}x`)).toBeNull();
    expect(canonicalYoutubeUrl("https://www.youtube.com/watch?v=bad!chars!!")).toBeNull();
    expect(canonicalYoutubeUrl("https://www.youtube.com/watch")).toBeNull();
    expect(canonicalYoutubeUrl("https://www.youtube.com/watch?v=")).toBeNull();
    expect(canonicalYoutubeUrl("https://youtu.be/")).toBeNull();
    expect(canonicalYoutubeUrl("https://www.youtube.com/shorts/tooshort")).toBeNull();
  });
  test("unsupported paths", () => {
    expect(canonicalYoutubeUrl("https://www.youtube.com/")).toBeNull();
    expect(canonicalYoutubeUrl("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv")).toBeNull();
    expect(canonicalYoutubeUrl(`https://www.youtube.com/other/${ID}`)).toBeNull();
    expect(canonicalYoutubeUrl(`https://www.youtube.com/shorts/${ID}/extra`)).toBeNull();
    expect(canonicalYoutubeUrl(`https://youtu.be/${ID}/extra`)).toBeNull();
    expect(canonicalYoutubeUrl(`https://youtu.be/watch?v=${ID}`)).toBeNull();
  });
});
