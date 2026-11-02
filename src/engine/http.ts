/**
 * One fetch for the whole engine.
 *
 * VERIFIED (node_modules/@tauri-apps/plugin-http/dist-js/index.d.ts, v2.8.3):
 *   `fetch(input: URL | Request | string, init?: RequestInit & ClientOptions): Promise<Response>`;
 *   "The request is performed by the Rust backend instead of the webview, so it is not subject to CORS,
 *   but the URL must be allowed by the plugin scope." `signal` aborts the request; `connectTimeout` is in ms.
 * INFERRED: the Response body streams (response.body is a ReadableStream) in plugin-http 2.x.
 * On the web build (no Tauri) we fall back to window.fetch, which CORS blocks for YouTube; see ERROR_TEXT.web_cors.
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { inTauri } from "./platform";

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface HttpInit extends RequestInit {
  /** Total time budget; aborts with a TimeoutError DOMException. 0 = none. Default 15 s. */
  timeoutMs?: number;
}

/** Combine an optional caller signal with a timeout signal. */
export function timeoutSignal(ms: number, outer?: AbortSignal | null): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (outer) signals.push(outer);
  if (ms > 0) signals.push(AbortSignal.timeout(ms));
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

const YT_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|googlevideo\.com|ytimg\.com)$/i;
const YT_ORIGIN = "https://www.youtube.com";

function hostOf(input: string | URL | Request): string {
  try {
    return new URL(input instanceof Request ? input.url : String(input)).hostname;
  } catch {
    return "";
  }
}

/**
 * Without an explicit Origin, plugin-http sends the webview origin (http://tauri.localhost), which YouTube
 * may reject. For YouTube hosts set Origin and Referer to https://www.youtube.com unless the caller set them.
 * Needs the plugin-http `unsafe-headers` Cargo feature (enabled in src-tauri/Cargo.toml).
 * Headers of a Request input are merged in first, because init.headers would otherwise replace them.
 */
function youtubeHeaders(input: string | URL | Request, headers: HeadersInit | undefined): Headers | undefined {
  if (!YT_HOST.test(hostOf(input))) return undefined;
  const h = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(headers).forEach((v, k) => h.set(k, v));
  if (!h.has("origin")) h.set("Origin", YT_ORIGIN);
  if (!h.has("referer")) h.set("Referer", `${YT_ORIGIN}/`);
  return h;
}

export function httpFetch(input: string | URL | Request, init: HttpInit = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
  const sig = timeoutSignal(timeoutMs, signal ?? (input instanceof Request ? input.signal : undefined));
  if (inTauri()) {
    const headers = youtubeHeaders(input, rest.headers) ?? rest.headers;
    return tauriFetch(input, { ...rest, headers, signal: sig, connectTimeout: DEFAULT_TIMEOUT_MS });
  }
  return window.fetch(input, { ...rest, signal: sig });
}

/**
 * Fetch function handed to youtubei.js (`Innertube.create({ fetch })`, typed `typeof fetch`).
 * youtubei.js passes Request objects; the 15 s budget applies to each API call.
 */
export const ytFetch: typeof fetch = (input, init) =>
  httpFetch(input as string | URL | Request, { ...init, timeoutMs: DEFAULT_TIMEOUT_MS });
