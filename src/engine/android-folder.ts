/**
 * Android "save to a chosen folder" (Storage Access Framework tree) through the keepsake-media plugin.
 *   "folder_pick"   args { initialUri? }                       resolves { uri: string|null, name: string|null }
 *   "folder_status" args { treeUri }                           resolves { ok: boolean, name?: string }
 *   "folder_save"   args { src, treeUri, fileName, mime }      resolves { uri, name, bytes }
 *   Rejections contain "folder:<code>: <message>" (code in FOLDER_ERROR_CODES).
 * Invoke style copied from android-ytdlp.ts. Must not import download.ts, index.ts or formats.ts (no cycles).
 */
import { invoke } from "@tauri-apps/api/core";
import type { AppErrorCode } from "../lib/types";
import { EngineError } from "./errors";

export const FOLDER_ERROR_CODES: readonly string[] = ["permission", "not_found", "no_space", "source_missing", "bad_uri", "io"];

const FOLDER_TEXT: Record<string, string> = {
  permission: "Keepsake no longer has access to that folder. Choose the folder again in Settings.",
  not_found: "That folder couldn't be found. Choose the folder again in Settings.",
  no_space: "Your phone may be out of storage. Free some space and try again.",
  source_missing: "The downloaded file went missing before it could be saved. Tap Retry.",
  bad_uri: "That folder isn't valid. Choose the folder again in Settings.",
  io: "Keepsake couldn't write to that folder. Tap Retry or choose another folder.",
  unknown: "Keepsake couldn't save to that folder.",
};

const MISSING_TEXT = "Choosing a save folder isn't available in this build. Reinstall Keepsake.";
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

/** EngineError for a failed folder operation. `folderCode` is the plugin code. */
export class FolderError extends EngineError {
  folderCode: string;
  constructor(folderCode: string, message: string, detail?: string) {
    const code: AppErrorCode =
      folderCode === "no_space" ? "no_space" : folderCode === "permission" ? "permission" : folderCode === "not_found" ? "not_found" : "unknown";
    super({ code, message, detail, cookiesHint: false });
    this.name = "FolderError";
    this.folderCode = folderCode;
  }
}

/** Any rejection text -> FolderError. Never throws. */
export function mapFolderError(input: unknown): FolderError {
  const text = rawText(input);
  const m = /folder:([a-z_]+):\s*([\s\S]*)/.exec(text);
  if (m) {
    const code = FOLDER_ERROR_CODES.includes(m[1]) ? m[1] : "unknown";
    const detail = m[2].replace(/\s+/g, " ").trim().slice(0, 300) || undefined;
    return new FolderError(code, FOLDER_TEXT[code] ?? FOLDER_TEXT.unknown, detail);
  }
  if (MISSING_RE.test(text)) return new FolderError("unknown", MISSING_TEXT, text);
  return new FolderError("unknown", FOLDER_TEXT.unknown, text.replace(/\s+/g, " ").trim().slice(0, 300));
}

/** Opens the system folder picker. Resolves null when the user cancels. Rejects with FolderError. */
export async function pickAndroidFolder(initialUri?: string): Promise<{ uri: string; name: string } | null> {
  let res: unknown;
  try {
    res = await invoke<unknown>("plugin:keepsake-media|folder_pick", initialUri ? { initialUri } : {});
  } catch (e) {
    throw mapFolderError(e);
  }
  const r = res as { uri?: unknown; name?: unknown } | null;
  if (!r || typeof r.uri !== "string" || r.uri === "") return null;
  return { uri: r.uri, name: typeof r.name === "string" && r.name ? r.name : "Folder" };
}

/** Checks the persisted write grant. Never throws: any failure resolves { ok: false }. */
export async function folderStatus(treeUri: string): Promise<{ ok: boolean; name?: string }> {
  try {
    const res = await invoke<unknown>("plugin:keepsake-media|folder_status", { treeUri });
    const r = res as { ok?: unknown; name?: unknown } | null;
    return { ok: r?.ok === true, ...(typeof r?.name === "string" && r.name ? { name: r.name } : {}) };
  } catch {
    return { ok: false };
  }
}

/** Copies `src` into the tree (the plugin deletes src on success). Rejects with FolderError. */
export async function saveToFolder(args: {
  src: string;
  treeUri: string;
  fileName: string;
  mime: string;
}): Promise<{ uri: string; name: string; bytes: number }> {
  let res: unknown;
  try {
    res = await invoke<unknown>("plugin:keepsake-media|folder_save", {
      src: args.src,
      treeUri: args.treeUri,
      fileName: args.fileName,
      mime: args.mime,
    });
  } catch (e) {
    throw mapFolderError(e);
  }
  const r = res as { uri?: unknown; name?: unknown; bytes?: unknown } | null;
  if (!r || typeof r.uri !== "string" || r.uri === "") {
    throw new FolderError("unknown", FOLDER_TEXT.unknown, "bad folder_save response");
  }
  return {
    uri: r.uri,
    name: typeof r.name === "string" && r.name ? r.name : args.fileName,
    bytes: typeof r.bytes === "number" && Number.isFinite(r.bytes) ? r.bytes : 0,
  };
}
