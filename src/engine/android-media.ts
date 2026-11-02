/**
 * Android audio transcoding through the native "keepsake-media" Tauri plugin (Kotlin, platform
 * MediaExtractor / MediaCodec / MediaMuxer). Replaces ffmpeg.wasm.
 *
 * Contract (src-tauri/plugins/keepsake-media):
 *   command "transcode", args { input: string; output: string; format: "wav" | "m4a"; kbps?: number },
 *   resolves { path: string }. `input` and `output` are absolute filesystem paths.
 *   - "m4a": copy the AAC track into an M4A container (no re-encode; drops any video track).
 *   - "wav": decode the audio track to 16-bit PCM WAV.
 *   Needs the capability permission "keepsake-media:allow-transcode" (src-tauri/capabilities/mobile.json).
 * VERIFIED (node_modules/@tauri-apps/api/core.d.ts 2.12.4): `invoke<T>(cmd, args?)`; plugin commands are
 *   addressed as "plugin:<name>|<command>".
 */
import { invoke } from "@tauri-apps/api/core";
import { EngineError } from "./errors";
import { platform } from "./platform";

export type AndroidAudioFormat = "wav" | "m4a";

export interface TranscodeArgs {
  input: string;
  output: string;
  format: AndroidAudioFormat;
  kbps?: number;
}

export interface TranscodeResult {
  path: string;
}

/** True only inside the Tauri Android app, where the keepsake-media plugin is registered. */
export function isAndroidMediaAvailable(): boolean {
  return platform() === "android";
}

const MISSING_TEXT = "Audio conversion isn't available in this build of Keepsake. Choose M4A, or reinstall the app.";

function rawText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Plugin not registered, command unknown, or the capability does not allow it. */
const MISSING_RE = /plugin\b.*\bnot (found|initialized|registered)|command\b.*\bnot found|unknown command|not allowed|denied/i;

/**
 * Convert `input` to `format` at `output` on the device. Never throws synchronously; every failure
 * (not Android, plugin missing, native error, bad response) rejects with an EngineError whose message
 * is shown to the user.
 */
export async function transcodeAudio(args: TranscodeArgs): Promise<TranscodeResult> {
  if (!isAndroidMediaAvailable()) {
    throw new EngineError({ code: "format_unavailable", message: MISSING_TEXT, detail: "keepsake-media: not running on Android", cookiesHint: false });
  }
  if (args.format !== "wav" && args.format !== "m4a") {
    throw new EngineError({
      code: "format_unavailable",
      message: `${String(args.format).toUpperCase()} isn't available on Android yet. Choose M4A or WAV.`,
      cookiesHint: false,
    });
  }
  let res: unknown;
  try {
    res = await invoke<TranscodeResult>("plugin:keepsake-media|transcode", {
      input: args.input,
      output: args.output,
      format: args.format,
      ...(args.kbps ? { kbps: args.kbps } : {}),
    });
  } catch (e) {
    const detail = rawText(e);
    if (MISSING_RE.test(detail)) {
      throw new EngineError({ code: "format_unavailable", message: MISSING_TEXT, detail, cookiesHint: false });
    }
    throw new EngineError({ code: "unknown", message: `Couldn't convert the audio. (Details: ${detail})`, detail, cookiesHint: false });
  }
  const path = res && typeof res === "object" && "path" in res ? (res as { path: unknown }).path : undefined;
  if (typeof path !== "string" || !path) {
    throw new EngineError({
      code: "unknown",
      message: "Couldn't convert the audio. The converter returned no file.",
      detail: `keepsake-media|transcode returned ${rawText(res)}`,
      cookiesHint: false,
    });
  }
  return { path };
}
