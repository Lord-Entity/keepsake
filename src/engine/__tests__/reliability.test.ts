// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Download-reliability tests (plan-docs/08): runWithRetry, mapYtdlpError for the new Android codes, and the
 * friendlyError rate-limit rule order. runWithRetry lives in ../android-ytdlp: runWithRetry(fn, { signal?, retries?, delays? }).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../platform", () => ({
  platform: () => "android",
  inTauri: () => true,
  isDesktop: () => false,
}));
let invokeImpl = async () => {
  throw new Error("unexpected invoke");
};
const invokeMock = mock((cmd, args) => invokeImpl(cmd, args));
class FakeChannel {
  onmessage = () => {};
}
// bun's mock.module is process-wide: export every name any engine/editor module imports from this module.
mock.module("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: FakeChannel,
  convertFileSrc: (p) => `asset://localhost/${p}`,
  addPluginListener: async () => ({ unregister: async () => {} }),
  isTauri: () => true,
}));

const { mapYtdlpError, runWithRetry } = await import("../android-ytdlp");
const { friendlyError, EngineError, appError } = await import("../errors");
const { fetchInfoYtdlp, downloadYtdlp, LADDER_STEPS } = await import("../ytdlp");

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

// ---------------- desktop TikTok / Instagram workaround ladder (behavioural) ----------------

const TIKTOK = "https://www.tiktok.com/@u/video/1";
const INSTAGRAM = "https://www.instagram.com/p/C2P/";
const TIMEOUT_LINE =
  "ERROR: [TikTok] 1: Unable to download webpage: Failed to perform, curl: (28) Connection timed out after 20014 milliseconds";
const INSTAGRAM_LINE =
  "ERROR: [Instagram] C2P: Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in. If it is not, then use --cookies-from-browser or --cookies for the authentication.";
const PRIVATE_LINE = "ERROR: [TikTok] 1: This video is private";
const BOT_LINE = "ERROR: [youtube] abc: Sign in to confirm you're not a bot";

const INFO_OK = {
  code: 0,
  stdout: [
    JSON.stringify({
      id: "1",
      title: "t",
      extractor_key: "TikTok",
      formats: [{ format_id: "h264", ext: "mp4", vcodec: "h264", acodec: "aac", height: 1024 }],
    }),
  ],
};
const DL_OK = { code: 0, stdout: ["KEEPSAKE_DONE|/out/t [1].mp4"] };
const failWith = (line) => ({ code: 1, stderr: [line] });

let calls = [];

/** Script yt-dlp: run_ytdlp attempt N plays attempts[N] (its args are recorded in `calls`); other commands return []. */
function runScript(attempts) {
  let n = 0;
  const seen = [];
  invokeImpl = async (cmd, args) => {
    seen.push(cmd);
    if (cmd !== "run_ytdlp") return [];
    calls.push(args.args);
    const a = attempts[n++];
    if (!a) throw new Error("unscripted yt-dlp attempt");
    for (const line of a.stdout ?? []) args.onEvent.onmessage({ event: "stdout", line });
    for (const line of a.stderr ?? []) args.onEvent.onmessage({ event: "stderr", line });
    return a.code;
  };
  return seen;
}

/** `call` with `step` inserted right before its final "--". */
function withStep(call, step) {
  const i = call.lastIndexOf("--");
  return [...call.slice(0, i), ...step, ...call.slice(i)];
}

const LADDER_FLAGS = ["--extractor-args", "--force-ipv4", "--impersonate"];
const req = (url) => ({ id: "job-1", url, mode: "video", formatId: "video:best" });
const noop = () => {};
const never = () => false;

async function rejection(p) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("fetchInfoYtdlp: TikTok/Instagram ladder", () => {
  beforeEach(() => {
    calls = [];
    invokeImpl = async () => {
      throw new Error("unexpected invoke");
    };
  });

  test("tiktok: timeout then success retries once with step 1 inserted before --", async () => {
    runScript([failWith(TIMEOUT_LINE), INFO_OK]);
    const info = await fetchInfoYtdlp(TIKTOK);
    expect(info.id).toBe("1");
    expect(calls.length).toBe(2);
    for (const f of LADDER_FLAGS) expect(calls[0]).not.toContain(f);
    expect(calls[1]).toEqual(withStep(calls[0], LADDER_STEPS.tiktok[0]));
  });

  test("tiktok: three failures reject with the first error plus the workaround note", async () => {
    runScript([failWith(TIMEOUT_LINE), failWith(TIMEOUT_LINE), failWith(TIMEOUT_LINE)]);
    const e = await rejection(fetchInfoYtdlp(TIKTOK));
    expect(e.code).toBe("timeout");
    expect(e.detail).toContain("Also tried 2 workarounds.");
    expect(calls.length).toBe(3);
    expect(calls[2]).toEqual(withStep(calls[0], LADDER_STEPS.tiktok[1]));
    const before = calls[2].slice(0, calls[2].lastIndexOf("--"));
    for (const f of ["--force-ipv4", "--impersonate", "safari"]) expect(before).toContain(f);
  });

  test("instagram: login_required then success on step 2; no cookie args or browser lookup without a setting", async () => {
    const seen = runScript([failWith(INSTAGRAM_LINE), INFO_OK]);
    await fetchInfoYtdlp(INSTAGRAM, {});
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain("instagram:app_id=ios");
    for (const c of calls) expect(c).not.toContain("--cookies-from-browser");
    expect(seen).not.toContain("list_installed_browsers");
  });

  test("instagram with an explicit browser: every attempt carries it exactly once", async () => {
    runScript([failWith(INSTAGRAM_LINE), failWith(INSTAGRAM_LINE), INFO_OK]);
    await fetchInfoYtdlp(INSTAGRAM, { cookiesBrowser: "firefox" });
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(c.filter((a) => a === "--cookies-from-browser").length).toBe(1);
      expect(c.filter((a) => a === "firefox").length).toBe(1);
      expect(c[c.indexOf("--cookies-from-browser") + 1]).toBe("firefox");
    }
  });

  test("a final error does not ladder (tiktok private)", async () => {
    runScript([failWith(PRIVATE_LINE)]);
    const e = await rejection(fetchInfoYtdlp(TIKTOK));
    expect(e.code).toBe("private");
    expect(calls.length).toBe(1);
  });

  test("youtube is immune: timeout makes one call", async () => {
    runScript([failWith("ERROR: [youtube] abc: Connection timed out")]);
    const e = await rejection(fetchInfoYtdlp("https://www.youtube.com/watch?v=abc"));
    expect(e.code).toBe("timeout");
    expect(calls.length).toBe(1);
    for (const f of LADDER_FLAGS) expect(calls[0]).not.toContain(f);
  });

  test("youtube bot check with an explicit browser: one call, no fallback, no ladder flags", async () => {
    const seen = runScript([failWith(BOT_LINE)]);
    const e = await rejection(fetchInfoYtdlp("https://www.youtube.com/watch?v=abc", { cookiesBrowser: "firefox" }));
    expect(e.code).toBe("bot_check");
    expect(calls.length).toBe(1);
    for (const f of LADDER_FLAGS) expect(calls[0]).not.toContain(f);
    expect(seen).not.toContain("list_installed_browsers");
  });
});

describe("downloadYtdlp: TikTok/Instagram ladder", () => {
  beforeEach(() => {
    calls = [];
    invokeImpl = async () => {
      throw new Error("unexpected invoke");
    };
  });

  test("tiktok: fail then success is done with a workaround note and step 1 before --", async () => {
    runScript([failWith(TIMEOUT_LINE), DL_OK]);
    const r = await downloadYtdlp(req(TIKTOK), "/out", noop, never);
    expect(r.status).toBe("done");
    expect(r.note).toBe("Retried with a workaround");
    expect(calls.length).toBe(2);
    for (const f of LADDER_FLAGS) expect(calls[0]).not.toContain(f);
    expect(calls[1]).toEqual(withStep(calls[0], LADDER_STEPS.tiktok[0]));
  });

  test("tiktok: all attempts fail", async () => {
    runScript([failWith(TIMEOUT_LINE), failWith(TIMEOUT_LINE), failWith(TIMEOUT_LINE)]);
    const r = await downloadYtdlp(req(TIKTOK), "/out", noop, never);
    expect(r.status).toBe("failed");
    expect(r.error.code).toBe("timeout");
    expect(r.error.detail).toContain("Also tried 2 workarounds.");
    expect(calls.length).toBe(3);
  });

  test("vimeo never ladders", async () => {
    runScript([failWith("ERROR: [vimeo] 1: Connection timed out")]);
    const r = await downloadYtdlp(req("https://vimeo.com/1"), "/out", noop, never);
    expect(r.status).toBe("failed");
    expect(calls.length).toBe(1);
  });

  test("tiktok: a private first failure is final", async () => {
    runScript([failWith(PRIVATE_LINE)]);
    const r = await downloadYtdlp(req(TIKTOK), "/out", noop, never);
    expect(r.status).toBe("failed");
    expect(r.error.code).toBe("private");
    expect(calls.length).toBe(1);
  });
});
