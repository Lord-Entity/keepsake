/**
 * Android "save to Gallery" through the native keepsake-media plugin.
 *   command "gallery_publish", args { src, kind, fileName, mime }, resolves { uri, displayPath, bytes }.
 *   Rejects with "gallery:<code>: <message> kept=<path>" (code in GALLERY_ERROR_CODES; kept= present when the
 *   file was moved to the app's kept folder or left in staging).
 *   Needs "keepsake-media:allow-gallery-publish" in src-tauri/capabilities/mobile.json.
 * Invoke style copied from android-ytdlp.ts. Must not import download.ts, index.ts or formats.ts (no cycles).
 */
import { invoke } from "@tauri-apps/api/core";
import type { AppErrorCode } from "../lib/types";
import { EngineError } from "./errors";

export type AndroidSaveMode = "gallery" | "folder" | "legacy";
export type GalleryKind = "video" | "audio" | "image";

export const GALLERY_ERROR_CODES: readonly string[] = ["no_space", "permission", "unknown"];

/** Value of the saveDir setting that means "save to the Gallery". An empty saveDir keeps the old app folder. */
export const GALLERY_SAVE = "gallery";

/** "folder" for a SAF tree; "gallery" when saveDir is GALLERY_SAVE; otherwise "legacy" (the old app folder). */
export function androidSaveMode(settings: { saveDir: string; saveTreeUri: string }): AndroidSaveMode {
  if (settings.saveTreeUri) return "folder";
  if (settings.saveDir === GALLERY_SAVE) return "gallery";
  return "legacy";
}

export interface GalleryPublishResult {
  uri: string;
  displayPath: string;
  bytes: number;
}

const GALLERY_TEXT: Record<string, string> = {
  no_space: "Your phone may be out of storage. Free some space and try again.",
  permission: "Keepsake can't save to the Gallery without storage permission.",
  unknown: "Keepsake couldn't save to the Gallery.",
};

const MISSING_TEXT = "Saving to the Gallery isn't available in this build. Reinstall Keepsake.";
const MISSING_RE = /plugin\b.*\bnot (found|initialized|registered)|command\b.*\bnot found|unknown command|not allowed|denied/i;

function rawText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** EngineError for a failed gallery publish. `galleryCode` is the plugin code; `keptPath` is where the file was kept. */
export class GalleryError extends EngineError {
  galleryCode: string;
  keptPath?: string;
  constructor(galleryCode: string, message: string, detail?: string, keptPath?: string) {
    const code: AppErrorCode = galleryCode === "no_space" ? "no_space" : galleryCode === "permission" ? "permission" : "unknown";
    super({ code, message, detail, cookiesHint: false });
    this.name = "GalleryError";
    this.galleryCode = galleryCode;
    this.keptPath = keptPath;
  }
}

/** Any rejection text -> GalleryError. Never throws. */
export function mapGalleryError(input: unknown): GalleryError {
  const text = rawText(input);
  const m = /gallery:([a-z_]+):\s*([\s\S]*)/.exec(text);
  if (m) {
    const code = GALLERY_ERROR_CODES.includes(m[1]) ? m[1] : "unknown";
    let rest = m[2];
    let kept: string | undefined;
    const k = /\bkept=(.+?)\s*$/s.exec(rest);
    if (k) {
      kept = k[1].trim() || undefined;
      rest = rest.slice(0, k.index);
    }
    const detail = rest.replace(/\s+/g, " ").trim().slice(0, 300) || undefined;
    return new GalleryError(code, GALLERY_TEXT[code] ?? GALLERY_TEXT.unknown, detail, kept);
  }
  if (MISSING_RE.test(text)) return new GalleryError("unknown", MISSING_TEXT, text);
  return new GalleryError("unknown", GALLERY_TEXT.unknown, text.replace(/\s+/g, " ").trim().slice(0, 300));
}

/** Invokes gallery_publish. Rejects with GalleryError (an EngineError). Validates the response shape. */
export async function publishToGallery(args: {
  src: string;
  kind: GalleryKind;
  fileName: string;
  mime: string;
}): Promise<GalleryPublishResult> {
  let res: unknown;
  try {
    res = await invoke<unknown>("plugin:keepsake-media|gallery_publish", {
      src: args.src,
      kind: args.kind,
      fileName: args.fileName,
      mime: args.mime,
    });
  } catch (e) {
    throw mapGalleryError(e);
  }
  const r = res as { uri?: unknown; displayPath?: unknown; bytes?: unknown } | null;
  if (!r || typeof r.uri !== "string" || r.uri === "") {
    throw new GalleryError("unknown", GALLERY_TEXT.unknown, "bad gallery_publish response");
  }
  return {
    uri: r.uri,
    displayPath: typeof r.displayPath === "string" ? r.displayPath : "",
    bytes: typeof r.bytes === "number" && Number.isFinite(r.bytes) ? r.bytes : 0,
  };
}
