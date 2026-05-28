/**
 * A plain-text snapshot for bug reports ("Settings > Components > Copy diagnostics").
 *
 * What it answers: which build, which platform/WebView, whether YouTube's PO token is actually
 * minting (the difference between 360p and every quality), the desktop sidecar versions, and on
 * Android the self-contained yt-dlp status (EJS solver, JS runtime, ffmpeg, whether that route is on).
 * It deliberately contains no URLs, titles, file paths or cookies: copy-safe.
 */
import type { BinaryStatus, Platform } from "../lib/types";
import { androidYtdlpStatus, type YtdlpStatus } from "./android-ytdlp";
import { binaryStatus } from "./index";
import { inTauri, platform } from "./platform";
import { poTokenStatus, type PoTokenStatus } from "./po-token";
import { ANDROID_SELFCONTAINED } from "./youtube-ytdlp";

export interface DiagnosticsSnapshot {
  appVersion: string;
  platform: Platform;
  userAgent: string;
  poToken: PoTokenStatus;
  binaries?: BinaryStatus;
  /** Android self-contained yt-dlp status; undefined off Android, null when unavailable. */
  android?: YtdlpStatus | null;
  /** Build flag ANDROID_SELFCONTAINED (passed in so the formatter stays pure). */
  selfContained?: boolean;
}

/** Pure formatter so the exact text can be asserted in tests without a Tauri webview. */
export function formatDiagnostics(s: DiagnosticsSnapshot): string {
  const lines: string[] = [];
  lines.push(`Keepsake ${s.appVersion}`);
  lines.push(`Platform: ${s.platform}`);
  lines.push(`WebView: ${s.userAgent || "unknown"}`);
  lines.push(`YouTube quality: ${describePoToken(s.poToken)}`);
  if (s.binaries) {
    lines.push(`yt-dlp: ${versionOf(s.binaries.ytdlp, s.binaries.ytdlpVersion)}`);
    lines.push(`ffmpeg: ${versionOf(s.binaries.ffmpeg, s.binaries.ffmpegVersion)}`);
    if (s.binaries.node) lines.push(`JS runtime: ${versionOf(s.binaries.node, s.binaries.nodeVersion)}`);
  }
  if (s.android !== undefined) {
    const a = s.android;
    if (a === null) {
      lines.push("Android yt-dlp: status unavailable");
    } else {
      lines.push(
        `Android yt-dlp: yt-dlp ${a.ytdlp}, EJS ${a.ejs ?? "missing"}, JS runtime ${a.jsRuntime ?? "missing"}, ffmpeg ${a.ffmpeg ?? "missing"}, ready: ${a.ready ? "yes" : "no"}`,
      );
      if (a.problems.length > 0) lines.push(`Android problems: ${a.problems.join(", ")}`);
    }
    lines.push(`Self-contained route: ${s.selfContained === true && a?.ready === true ? "on" : "off"}`);
  }
  return lines.join("\n");
}

/** Collect a fresh snapshot. Never throws: missing pieces are reported as "unknown". */
export async function collectDiagnostics(): Promise<string> {
  let appVersion = "web preview";
  if (inTauri()) {
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      appVersion = await getVersion();
    } catch {
      appVersion = "unknown";
    }
  }
  let binaries: BinaryStatus | undefined;
  try {
    binaries = await binaryStatus();
  } catch {
    binaries = undefined;
  }
  const plat = platform();
  let android: YtdlpStatus | null | undefined;
  let selfContained: boolean | undefined;
  if (plat === "android") {
    try {
      android = await androidYtdlpStatus({ refresh: true });
    } catch {
      android = null;
    }
    selfContained = ANDROID_SELFCONTAINED;
  }
  return formatDiagnostics({
    appVersion,
    platform: plat,
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    poToken: poTokenStatus(),
    binaries,
    android,
    selfContained,
  });
}

/**
 * PO token status in plain words. "not minted yet" is the state every fresh launch starts in: the
 * token is only requested when a YouTube link is opened, so it is not a failure. "ready" proves the
 * BotGuard path works on this device.
 */
function describePoToken(s: PoTokenStatus): string {
  if (!s.supported) return "not used on this platform";
  if (s.ready) {
    const mins = s.expiresAt ? Math.max(1, Math.round((s.expiresAt - Date.now()) / 60_000)) : undefined;
    return mins ? `PO token ready (expires in ~${mins} min)` : "PO token ready";
  }
  return "PO token not minted yet";
}

function versionOf(state: string, version?: string): string {
  if (version) return version;
  return state === "unsupported" ? "built-in (not applicable)" : state;
}
