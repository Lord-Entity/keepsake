/**
 * Platform detection.
 * VERIFIED: `isTauri()` is exported by @tauri-apps/api/core 2.12.4 (node_modules/@tauri-apps/api/core.d.ts).
 * INFERRED: OS from navigator.userAgent (Android WebView UA contains "Android"; WebView2 UA contains "Windows").
 * @tauri-apps/plugin-os would be exact but is not installed; not worth a new dependency.
 */
import { isTauri } from "@tauri-apps/api/core";
import type { Platform } from "../lib/types";

let cached: Platform | undefined;

export function inTauri(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

export function platform(): Platform {
  if (cached) return cached;
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (!inTauri()) cached = "web";
  else if (/Android/i.test(ua)) cached = "android";
  else if (/Windows/i.test(ua)) cached = "windows";
  else cached = "linux";
  return cached;
}

export function isDesktop(): boolean {
  const p = platform();
  return p === "windows" || p === "linux";
}
