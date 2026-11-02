/**
 * Port of yt-python/workers/errors.py (`clean_error`, `friendly_error`), same match order.
 * Rewordings (UI_CONTENT.md section 6): COOKIE_HINT -> "Settings > Cookies"; the ffmpeg text drops
 * "place ffmpeg.exe next to the application" and says "Reinstall Keepsake".
 */
import { ERROR_TEXT, type AppError, type AppErrorCode } from "../lib/types";

// oxlint-disable-next-line no-control-regex -- ANSI escapes are the point
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const REPORT_RE = /[;.]?\s*(?:please\s+)?report this issue on[\s\S]*$/i;
const ERROR_PREFIX_RE = /^(?:ERROR:\s*)+/i;
const EXTRACTOR_PREFIX_RE = /^(?:\[[^\]]+\]\s*[^\s:]*:\s*)+/;

export function cleanError(msg: string | undefined | null): string {
  let m = (msg ?? "").replace(ANSI_RE, "").trim();
  if (m.includes("ERROR:")) m = m.split("ERROR:").pop()!.trim();
  m = m.replace(ERROR_PREFIX_RE, "");
  m = m.replace(EXTRACTOR_PREFIX_RE, "").trim();
  m = m.replace(REPORT_RE, "").replace(/^[\s;,]+|[\s;,]+$/g, "");
  return m || "Unknown error";
}

function short(detail: string, limit = 300): string {
  const d = detail.split(/\s+/).filter(Boolean).join(" ");
  return d.length <= limit ? d : `${d.slice(0, limit - 3)}...`;
}

const RULES: [AppErrorCode, string[], string[]?][] = [
  // Rust run_ytdlp rejects with "js_runtime_missing: ..." (src-tauri/src/ytdlp.rs).
  ["js_runtime_missing", ["js_runtime_missing"]],
  ["unsupported_url", ["unsupported url"]],
  ["drm", ["drm protected", "drm-protected", "drm:"]],
  ["age_restricted", ["age-restricted", "age restricted", "confirm your age", "age verification"]],
  ["bot_check", ["not a bot", "not a robot"]],
  ["password", ["password"]],
  ["anti_bot", ["cloudflare", "anti-bot", "captcha"]],
  ["ip_blocked", ["ip address is blocked", "ip is blocked", "your ip"]],
  ["parse_failed", ["cannot parse data", "unable to extract", "unable to parse"]],
  [
    "geo_blocked",
    [
      "not available in your country",
      "geo restrict",
      "geo-restrict",
      "geo-block",
      "blocked it in your country",
      "available in your country",
      "not made this video available in your country",
    ],
  ],
  ["private", ["private video", "this video is private", "is private"]],
  [
    "unavailable",
    [
      "video unavailable",
      "this video is unavailable",
      "video has been removed",
      "has been removed",
      "been deleted",
      "no longer available",
      "account associated with this video has been terminated",
    ],
  ],
  [
    "login_required",
    [
      "login required",
      "log in",
      "login",
      "sign in",
      "--cookies",
      "cookies-from-browser",
      "registered users",
      "only available for",
      "members-only",
      "members only",
      "premium",
      "rate-limit",
      "rate limit",
      "authentication",
      "need to be logged",
      "requires authentication",
    ],
  ],
  ["format_unavailable", ["requested format is not available", "requested format not available"]],
  ["rate_limited", ["http error 429", "too many requests"]],
  ["forbidden", ["http error 403", "forbidden"]],
  ["not_found", ["http error 404", "404: not found", "not found (404)"]],
  [
    "network",
    [
      "getaddrinfo",
      "name or service not known",
      "nodename nor servname",
      "temporary failure in name resolution",
      "failed to resolve",
      "network is unreachable",
      "connection refused",
      "connection reset",
      "connection aborted",
      "connectionreset",
      "10054",
      "10060",
      "10061",
      "remote end closed",
      "no route to host",
      // webview / plugin-http wording (INFERRED from common fetch error texts)
      "failed to fetch",
      "networkerror",
      "error sending request",
    ],
  ],
  ["timeout", ["timed out", "timeout"]],
  ["ssl", ["ssl:", "sslerror", "ssl error", "certificate verify"]],
  // Needs both groups, like `has("ffmpeg") and has("not found", "not installed")`.
  ["ffmpeg_missing", ["ffmpeg"], ["not found", "not installed"]],
  ["no_formats", ["no video formats found", "no formats found", "no video could be found", "no media found"]],
];

const COOKIE_CODES: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  "age_restricted",
  "bot_check",
  "anti_bot",
  "parse_failed",
  "private",
  "login_required",
  "rate_limited",
  "forbidden",
  "no_formats",
]);

/** Build an AppError from a known code. `detail` is appended as "(Details: ...)" unless already in the text. */
export function appError(code: AppErrorCode, detail?: string): AppError {
  const text = ERROR_TEXT[code];
  const d = detail ? short(detail) : undefined;
  const message = d && !text.toLowerCase().includes(d.toLowerCase()) ? `${text} (Details: ${d})` : text;
  return { code, message, detail, cookiesHint: COOKIE_CODES.has(code) };
}

/** friendly_error(): map raw yt-dlp / network / youtubei.js text to an AppError. */
export function friendlyError(raw: string): AppError {
  const detail = cleanError(raw);
  const low = detail.toLowerCase();
  const has = (needles: string[]) => needles.some((n) => low.includes(n));
  for (const [code, any, also] of RULES) {
    if (has(any) && (!also || has(also))) return appError(code, detail);
  }
  return { code: "unknown", message: detail, detail, cookiesHint: false };
}

/** Normalise anything thrown into a plain AppError object. */
export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "code" in e && "message" in e && "cookiesHint" in e) {
    const a = e as AppError;
    return { code: a.code, message: a.message, detail: a.detail, cookiesHint: a.cookiesHint };
  }
  if (e instanceof DOMException && e.name === "AbortError") return appError("cancelled");
  if (e instanceof DOMException && e.name === "TimeoutError") return appError("timeout");
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  return friendlyError(msg);
}

/** Thrown inside the engine so a friendly error survives the promise chain. */
export class EngineError extends Error implements AppError {
  code: AppErrorCode;
  detail?: string;
  cookiesHint: boolean;
  constructor(err: AppError) {
    super(err.message);
    this.name = "EngineError";
    this.code = err.code;
    this.detail = err.detail;
    this.cookiesHint = err.cookiesHint;
  }
}

export function fail(code: AppErrorCode, detail?: string): never {
  throw new EngineError(appError(code, detail));
}
