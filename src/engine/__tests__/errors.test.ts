// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Unit tests for src/engine/errors.ts: cleanError, friendlyError (yt-dlp text -> AppError code), appError,
 * toAppError, EngineError and fail. Pure string handling; no network.
 */
import { describe, expect, test } from "bun:test";
import { appError, cleanError, EngineError, fail, friendlyError, toAppError } from "../errors";
import { ERROR_TEXT } from "../../lib/types";

describe("cleanError", () => {
  test("strips ANSI colours, ERROR: and the extractor prefix", () => {
    expect(cleanError("\x1b[0;31mERROR:\x1b[0m [youtube] abc123: Private video")).toBe("Private video");
  });

  test("keeps only the text after the last ERROR:", () => {
    expect(cleanError("WARNING: x\nERROR: first\nERROR: second thing")).toBe("second thing");
  });

  test("drops the 'please report this issue' tail", () => {
    const raw =
      "ERROR: [youtube] abc: Unable to extract uploader id; please report this issue on https://github.com/yt-dlp/yt-dlp/issues";
    expect(cleanError(raw)).toBe("Unable to extract uploader id");
  });

  test("empty input becomes 'Unknown error'", () => {
    expect(cleanError("")).toBe("Unknown error");
    expect(cleanError(null)).toBe("Unknown error");
    expect(cleanError(undefined)).toBe("Unknown error");
    expect(cleanError("ERROR:   ")).toBe("Unknown error");
  });
});

describe("friendlyError: yt-dlp messages map to codes", () => {
  const cases = [
    ["js_runtime_missing: Node.js was not found.", "js_runtime_missing"],
    ["ERROR: Unsupported URL: https://example.com/", "unsupported_url"],
    ["ERROR: [youtube] abc: This video is DRM protected", "drm"],
    ["ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate", "age_restricted"],
    ["ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser", "bot_check"],
    ["ERROR: [vimeo] 1: This video is protected by a password, use the --video-password option", "password"],
    ["ERROR: [generic] Got HTTP Error 403 caused by Cloudflare anti-bot challenge", "anti_bot"],
    ["ERROR: [tiktok] 1: Your IP address is blocked from accessing this post", "ip_blocked"],
    ["ERROR: [instagram] x: Unable to extract shared data", "parse_failed"],
    ["ERROR: [youtube] abc: The uploader has not made this video available in your country", "geo_blocked"],
    ["ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video", "private"],
    ["ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader", "unavailable"],
    ["ERROR: [youtube] abc: This video is only available for registered users", "login_required"],
    ["ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list", "format_unavailable"],
    ["ERROR: unable to download video data: HTTP Error 429: Too Many Requests", "rate_limited"],
    ["ERROR: unable to download video data: HTTP Error 403: Forbidden", "forbidden"],
    ["ERROR: Unable to download webpage: HTTP Error 404: Not Found", "not_found"],
    ["ERROR: Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>", "network"],
    ["TypeError: Failed to fetch", "network"],
    ["ERROR: Unable to download webpage: The read operation timed out", "timeout"],
    ["ERROR: Unable to download webpage: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed", "ssl"],
    ["ERROR: Postprocessing: ffmpeg not found. Please install or provide the path", "ffmpeg_missing"],
    ["ERROR: [generic] x: No video formats found!", "no_formats"],
  ];

  for (const [raw, code] of cases) {
    test(`${code}: ${raw.slice(0, 60)}`, () => {
      expect(friendlyError(raw).code).toBe(code);
    });
  }

  test("ffmpeg_missing needs both 'ffmpeg' and 'not found'/'not installed'", () => {
    expect(friendlyError("ffmpeg is not installed").code).toBe("ffmpeg_missing");
    expect(friendlyError("ffmpeg exited with code 1").code).not.toBe("ffmpeg_missing");
  });

  test("a missing ffprobe alone is not reported as ffmpeg missing", () => {
    // ffprobe is no longer bundled; yt-dlp falls back to ffmpeg. Only a missing ffmpeg is fatal.
    expect(friendlyError("WARNING: ffprobe not found").code).not.toBe("ffmpeg_missing");
  });

  test("match order: the bot check wins over the generic sign-in rule", () => {
    expect(friendlyError("Sign in to confirm you're not a bot").code).toBe("bot_check");
  });

  test("unknown text keeps the cleaned message, no cookie hint", () => {
    const e = friendlyError("ERROR: something odd happened");
    expect(e).toEqual({ code: "unknown", message: "something odd happened", detail: "something odd happened", cookiesHint: false });
  });

  test("cookie hint is set for login-type errors and not for network errors", () => {
    expect(friendlyError("Sign in to confirm you're not a bot").cookiesHint).toBe(true);
    expect(friendlyError("HTTP Error 403: Forbidden").cookiesHint).toBe(true);
    expect(friendlyError("getaddrinfo failed").cookiesHint).toBe(false);
    expect(friendlyError("Unsupported URL: x").cookiesHint).toBe(false);
  });

  test("message uses the friendly text plus the cleaned detail", () => {
    const e = friendlyError("ERROR: [youtube] abc: Private video");
    expect(e.message.startsWith(ERROR_TEXT.private)).toBe(true);
    expect(e.detail).toBe("Private video");
  });
});

describe("appError", () => {
  test("no detail gives the plain text", () => {
    expect(appError("cancelled")).toEqual({
      code: "cancelled",
      message: ERROR_TEXT.cancelled,
      detail: undefined,
      cookiesHint: false,
    });
  });

  test("detail is appended once and shortened to 300 characters", () => {
    expect(appError("network", "boom").message).toBe(`${ERROR_TEXT.network} (Details: boom)`);
    const long = appError("network", "x".repeat(1000));
    expect(long.message.endsWith("...)")).toBe(true);
    expect(long.detail.length).toBe(1000);
  });
});

describe("toAppError, EngineError, fail", () => {
  test("AbortError and TimeoutError DOMExceptions", () => {
    expect(toAppError(new DOMException("x", "AbortError")).code).toBe("cancelled");
    expect(toAppError(new DOMException("x", "TimeoutError")).code).toBe("timeout");
  });

  test("an AppError-shaped object passes through as a plain object", () => {
    const e = new EngineError(appError("private", "Private video"));
    const a = toAppError(e);
    expect(a.code).toBe("private");
    expect(a.detail).toBe("Private video");
    expect(a instanceof Error).toBe(false);
  });

  test("strings and Errors go through friendlyError", () => {
    expect(toAppError("HTTP Error 404: Not Found").code).toBe("not_found");
    expect(toAppError(new Error("connection refused")).code).toBe("network");
  });

  test("fail throws an EngineError with the code", () => {
    let caught;
    try {
      fail("ytdlp_missing", "yt-dlp not found");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe("ytdlp_missing");
    expect(caught.name).toBe("EngineError");
  });
});
