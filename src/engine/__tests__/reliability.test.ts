// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Download-reliability tests (plan-docs/08): runWithRetry, mapYtdlpError for the new Android codes, and the
 * friendlyError rate-limit rule order. runWithRetry lives in ../android-ytdlp: runWithRetry(fn, { signal?, retries?, delays? }).
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../platform", () => ({
  platform: () => "android",
  inTauri: () => true,
  isDesktop: () => false,
}));
// No "@tauri-apps/api/core" mock: nothing here calls invoke, and a partial mock ({ invoke, isTauri } only) replaces the
// module process-wide, breaking any already-linked importer of its other exports (ytdlp.ts imports Channel).

const { mapYtdlpError, runWithRetry } = await import("../android-ytdlp");
const { friendlyError, EngineError, appError } = await import("../errors");

const fast = { delays: [0, 0] };

describe("runWithRetry", () => {
  test("retries a network error twice, then succeeds", async () => {
    let calls = 0;
    const out = await runWithRetry(async () => {
      calls++;
      if (calls <= 2) throw new EngineError(appError("network", "reset"));
      return "ok";
    }, fast);
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  test("does not retry no_space", async () => {
    let calls = 0;
    await expect(
      runWithRetry(async () => {
        calls++;
        throw new EngineError(appError("no_space"));
      }, fast),
    ).rejects.toMatchObject({ code: "no_space" });
    expect(calls).toBe(1);
  });
});

describe("mapYtdlpError: new codes", () => {
  for (const code of ["no_space", "permission", "too_large", "mux_failed", "cancelled", "empty"]) {
    test(`${code} maps to the same code with a non-empty message and no cookie hint`, () => {
      const e = mapYtdlpError(`ytdlp:${code}: details here`);
      expect(e.code).toBe(code);
      expect(e.message.length).toBeGreaterThan(0);
      expect(e.cookiesHint).toBe(false);
    });
  }
});

describe("friendlyError: rate-limit rule order", () => {
  test("an HTTP 429 is rate_limited, not login_required", () => {
    expect(friendlyError("ERROR: HTTP Error 429: Too Many Requests").code).toBe("rate_limited");
  });

  test("'rate limit' wording is rate_limited", () => {
    expect(friendlyError("ERROR: [instagram] x: rate-limit reached, try later").code).toBe("rate_limited");
  });

  test("a real login prompt is still login_required", () => {
    expect(friendlyError("ERROR: [instagram] x: login required to view this post").code).toBe("login_required");
  });
});
