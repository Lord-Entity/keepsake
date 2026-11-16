/**
 * A plain-text snapshot for bug reports ("Settings > Components > Copy diagnostics").
 *
 * What it answers: which build, which platform/WebView, whether YouTube's PO token is actually
 * minting (the difference between 360p and every quality), and the desktop sidecar versions.
 * It deliberately contains no URLs, titles, file paths or cookies: copy-safe.
 */
import type { BinaryStatus, Platform } from "../lib/types";
import { binaryStatus } from "./index";
import { inTauri, platform } from "./platform";
import { poTokenStatus, type PoTokenStatus } from "./po-token";

export interface DiagnosticsSnapshot {
  appVersion: string;
  platform: Platform;
  userAgent: string;
  poToken: PoTokenStatus;
  binaries?: BinaryStatus;
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
  return formatDiagnostics({
    appVersion,
    platform: platform(),
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    poToken: poTokenStatus(),
    binaries,
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
