/**
 * PO Token (Proof of Origin) minting for Android, via Google BotGuard.
 *
 * Why: YouTube binds the URLs of every high-quality stream to a PO token. Measured behaviour in
 * youtube.ts (header) was: ANDROID_VR lists every quality but every googlevideo request answers 403;
 * IOs dies above ~1 MB ranges; WEB returns no URLs at all. The only stream that downloads without a
 * token is ANDROID itag 18 (360p). Minting a token is therefore the unlock for 720p and above.
 *
 * How: the Tauri webview already has a JavaScript engine and the CSP allows `'unsafe-eval'` (needed
 * by youtubei.js to decipher stream URLs). We run the BotGuard interpreter there with bgutils-js,
 * fetch the challenge and exchange the BotGuard response for an integrity token through YouTube's own
 * InnerTube host (`www.youtube.com/api/jnn/v1`, already allowed by the `http` capability). No Deno,
 * no Node, no Docker, no extra network host.
 *
 * Contract:
 *   getPoToken(visitorData)             -> a player/session token bound to that visitor_data, or null.
 *   mintContentPoToken(visitorData, id) -> a token bound to one video id, or null.
 *   poTokenStatus()                     -> { supported, ready, expiresAt } for diagnostics.
 *   clearPoTokenCache()                 -> forget the cached session (tests / retry).
 *
 * Every failure is swallowed and reported as null: the caller falls back to the 360p path, exactly
 * like before this module existed. Nothing here throws into the engine.
 */
import { BotGuardClient, getChallenge } from "bgutils-js/botguard";
import { WebPoMinter } from "bgutils-js/webpo";
import { base64ToU8, buildURL, GOOG_API_KEY, u8ToBase64 } from "bgutils-js/utils";
import { ytFetch } from "./http";
import { platform } from "./platform";

/** YouTube's web request key. Must pair with the `web` client's visitor_data for a player token. */
const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
/** BotGuard can take a few seconds on a cold start; the library defaults to 3 s. */
const SNAPSHOT_TIMEOUT_MS = 15_000;
/** Re-mint this long before the integrity token expires. */
const EXPIRY_MARGIN_MS = 60_000;

interface PoSession {
  visitorData: string;
  token: string;
  minter: WebPoMinter;
  expiresAt: number;
}

let session: PoSession | undefined;
let pending: Promise<PoSession | null> | undefined;

/** PO tokens only help the Android (Tauri) build; desktop downloads use yt-dlp and its own runtime. */
export function poTokenSupported(): boolean {
  return platform() === "android";
}

export interface PoTokenStatus {
  supported: boolean;
  ready: boolean;
  expiresAt?: number;
}

export function poTokenStatus(): PoTokenStatus {
  const supported = poTokenSupported();
  const ready = supported && session !== undefined && Date.now() < session.expiresAt;
  return ready && session ? { supported, ready, expiresAt: session.expiresAt } : { supported, ready };
}

export function clearPoTokenCache(): void {
  session = undefined;
  pending = undefined;
}

/**
 * A token bound to `visitorData` (the value youtubei.js uses as the request context). Cached until
 * shortly before the integrity token expires. Concurrent callers share one mint.
 */
export async function getPoToken(visitorData: string): Promise<string | null> {
  if (!poTokenSupported() || !visitorData) return null;
  if (session && session.visitorData === visitorData && Date.now() < session.expiresAt) return session.token;
  if (!pending) pending = createSession(visitorData);
  const p = pending;
  try {
    const fresh = await p;
    return fresh?.token ?? null;
  } finally {
    if (pending === p) pending = undefined;
  }
}

/**
 * A token bound to one video id. YouTube accepts these on googlevideo requests for the same session;
 * youtubei.js normally embeds the player token in the deciphered URL, so this is an escape hatch for
 * callers that hand a URL to another downloader.
 */
export async function mintContentPoToken(visitorData: string, videoId: string): Promise<string | null> {
  if (!poTokenSupported() || !visitorData || !videoId) return null;
  try {
    const current = session && session.visitorData === visitorData && Date.now() < session.expiresAt ? session : await ensureSession(visitorData);
    if (!current) return null;
    return await current.minter.mintAsWebsafeString(videoId);
  } catch {
    return null;
  }
}

async function ensureSession(visitorData: string): Promise<PoSession | null> {
  if (session && session.visitorData === visitorData && Date.now() < session.expiresAt) return session;
  if (pending) return pending;
  const p = createSession(visitorData);
  pending = p;
  try {
    return await p;
  } finally {
    if (pending === p) pending = undefined;
  }
}

async function createSession(visitorData: string): Promise<PoSession | null> {
  let botguard: BotGuardClient | undefined;
  try {
    // 1. Challenge (interpreter script + bytecode program) through YouTube's InnerTube host.
    const challenge = await getChallenge({
      requestKey: REQUEST_KEY,
      fetchFunction: ytFetch,
      useYouTubeAPI: true,
    });
    const interpreter = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    const program = challenge.program;
    const globalName = challenge.globalName;
    if (!interpreter || !program || !globalName) return null;

    // 2. Load the interpreter into the page, which publishes `globalThis[globalName]` (the VM).
    //    CSP allows 'unsafe-eval' for youtubei.js, and the script is Google's own.
    // oxlint-disable-next-line no-new-func -- BotGuard interpreter is a self-contained script
    new Function(interpreter)();

    // 3. Load the bytecode program and ask for a snapshot plus the WebPO minter callback.
    botguard = await BotGuardClient.create({
      program,
      globalName,
      globalObject: globalThis as unknown as Record<string, unknown>,
    });
    const webPoSignalOutput: unknown[] = [];
    const snapshotArgs = { webPoSignalOutput } as unknown as Parameters<BotGuardClient["snapshot"]>[0];
    const botguardResponse = await botguard.snapshot(snapshotArgs, SNAPSHOT_TIMEOUT_MS);
    if (!botguardResponse) return null;

    // 4. Exchange the response for an integrity token (same host, same headers as the web client).
    const res = await ytFetch(buildURL("GenerateIT", true), {
      method: "POST",
      headers: {
        "content-type": "application/json+protobuf",
        "x-goog-api-key": GOOG_API_KEY,
        "x-user-agent": "grpc-web-javascript/0.1",
      },
      body: JSON.stringify([REQUEST_KEY, botguardResponse]),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data) || typeof data[0] !== "string") return null;

    const integrityToken = data[0];
    const ttlSecs = typeof data[1] === "number" && data[1] > 0 ? data[1] : 3600;
    const mintRefreshThreshold = typeof data[2] === "number" ? data[2] : undefined;
    const websafeFallbackToken = typeof data[3] === "string" ? data[3] : undefined;

    // 5. Build the minter and mint the session token bound to this visitor_data.
    const minter = await WebPoMinter.create(
      {
        integrityToken,
        estimatedTtlSecs: ttlSecs,
        ...(mintRefreshThreshold !== undefined ? { mintRefreshThreshold } : {}),
        ...(websafeFallbackToken ? { websafeFallbackToken } : {}),
      },
      webPoSignalOutput as unknown as Parameters<typeof WebPoMinter.create>[1],
    );
    const token = await minter.mintAsWebsafeString(visitorData);
    if (!token) return null;

    const expiresAt = Date.now() + Math.max(60_000, ttlSecs * 1000 - EXPIRY_MARGIN_MS);
    session = { visitorData, token, minter, expiresAt };
    return session;
  } catch {
    // Missing interpreter, blocked challenge, network error, changed BotGuard: fall back silently.
    return null;
  } finally {
    try {
      await botguard?.shutdown(1000);
    } catch {
      // best effort
    }
  }
}

/**
 * Exported only so the unit tests can exercise the pure helpers without running BotGuard.
 * `u8ToBase64(base64ToU8(x), true) === x` for URL-safe base64 inputs.
 */
export function roundTripBase64(value: string): string {
  return u8ToBase64(base64ToU8(value), true);
}
