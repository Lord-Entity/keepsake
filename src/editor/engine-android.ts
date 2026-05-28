/**
 * Editor engine for Android.
 * - pickMedia: plugin-dialog `open` with the system media picker; returns a content:// URI.
 * - Reading the source in JS (photos, previews): plugin-fs `readFile`/`open` accept content:// URIs on Android.
 * - Video: keepsake-media plugin (Kotlin KeepsakeEditor on Media3 Transformer, H.264 + AAC MP4):
 *     "editor_probe"        { uri }                                                  -> { width, height, duration, hasAudio, rotation }
 *     "editor_export_video" { uri, outPath, crop?, trimStart?, trimEnd?, audio }     -> { path }
 *     progress: plugin event "keepsake-editor-progress" { fraction }
 *     errors: "editor:<code>: message" (unsupported | cancelled | no_space | permission | export_failed)
 *     cancel: "editor_cancel" {} (best effort; a missing command is ignored).
 *   The plugin only writes inside the app cache, so a video is always exported into a staging dir there.
 * - Saving follows androidSaveMode like download.ts: gallery -> publishToGallery, folder -> saveToFolder (both from the
 *   staging dir $APPCACHE/gallery-editor-<id>, the only prefix the plugin accepts), legacy -> photos written straight
 *   into Settings saveDir (or Downloads), videos copied there in chunks. As in download.ts runStaged, the stage is
 *   removed only after a successful save; a failed save keeps it so Retry (the same edit) saves it again.
 */
import { addPluginListener, invoke, type PluginListener } from "@tauri-apps/api/core";
import { appCacheDir, downloadDir, join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as fsAll from "@tauri-apps/plugin-fs";
import { exists, mkdir, open as openFs, readFile, remove, writeFile } from "@tauri-apps/plugin-fs";
import { FolderError, saveToFolder } from "../engine/android-folder";
import { androidSaveMode, GALLERY_SAVE, GalleryError, publishToGallery } from "../engine/android-gallery";
import { settingsStore } from "../state/settings";
import {
  baseOf,
  cancelled,
  editBase,
  editorError,
  extOf,
  FULL_CAPS,
  kindFromName,
  mapNativeError,
  markSaveStep,
  MIME,
  parseProbe,
  probePhoto,
  progressGate,
  rawText,
  renderPhoto,
  throwIfAborted,
  videoCrop,
  videoTrim,
  type PlatformEngine,
} from "./engine-photo";
import type { EditJob, EditorErrorCode, EditorInput, EditResult, MediaKind, MediaProbe } from "./types";
import { EditorError } from "./types";

const PLUGIN = "keepsake-media";
/** Videos above this are not copied into a preview Blob (the webview cannot stream a content:// URI). */
const PREVIEW_MAX_BYTES = 1024 * 1024 * 1024;
const READ_CHUNK = 8 * 1024 * 1024;

function uriOf(input: EditorInput): string {
  const u = input.uri ?? input.path;
  if (!u) throw new EditorError("invalid_job", "No file to edit");
  return u;
}

/** Probes made while picking (to learn the kind of an opaque picker URI), reused by the first probe() call. */
const pickProbes = new Map<string, MediaProbe>();

async function nativeProbe(uri: string): Promise<MediaProbe> {
  let res: unknown;
  try {
    res = await invoke<unknown>(`plugin:${PLUGIN}|editor_probe`, { uri });
  } catch (e) {
    throw mapNativeError(e, "probe_failed");
  }
  return parseProbe(res);
}

async function readBlob(uri: string, type: string): Promise<Blob> {
  try {
    return new Blob([await readFile(uri)], { type });
  } catch (e) {
    throw mapNativeError(e, "probe_failed");
  }
}

/** Reads a (possibly large) file into a Blob in chunks, so no single IPC message holds the whole video. */
async function readBlobChunked(uri: string, type: string): Promise<Blob> {
  const parts: BlobPart[] = [];
  let total = 0;
  try {
    const fh = await openFs(uri, { read: true });
    try {
      const buf = new Uint8Array(READ_CHUNK);
      for (;;) {
        const n = await fh.read(buf);
        if (n === null || n <= 0) break;
        total += n;
        if (total > PREVIEW_MAX_BYTES) {
          throw new EditorError("unsupported", "This video is too large to preview on this phone (over 1 GB).");
        }
        parts.push(buf.slice(0, n));
      }
    } finally {
      await fh.close().catch(() => undefined);
    }
  } catch (e) {
    throw mapNativeError(e, "probe_failed");
  }
  return new Blob(parts, { type });
}

/** Best-effort display name from a content:// URI: the last path segment when it looks like a file name. */
function nameFromUri(uri: string): string {
  let s = uri;
  try {
    s = decodeURIComponent(uri);
  } catch {
    // keep the raw text
  }
  const last = s.split(/[/:]/).pop() ?? "";
  return kindFromName(last) ? last : "";
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function stamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

async function kindOf(uri: string, name: string, want?: MediaKind): Promise<MediaKind> {
  const byName = kindFromName(name);
  if (byName) return byName;
  if (/\bvideo[:/]/i.test(uri)) return "video";
  if (/\bimage[:/]/i.test(uri)) return "photo";
  // The picker was limited to one MIME family (image/* or video/*), so an opaque URI is that kind.
  if (want) return want;
  // Opaque photo-picker URI: a file with a duration is a video, anything else is treated as a photo.
  try {
    const p = await nativeProbe(uri);
    if (p.duration > 0) {
      pickProbes.set(uri, p);
      return "video";
    }
  } catch {
    // not a video the native side can read
  }
  return "photo";
}

// ---------------- saving ----------------

type Mode = ReturnType<typeof androidSaveMode>;

function saveMode(): Mode {
  const s = settingsStore.get();
  return androidSaveMode({ saveDir: s.saveDir, saveTreeUri: s.saveTreeUri });
}

/** Legacy mode folder: Settings saveDir, else Downloads (same as download.ts androidOutDir). */
async function legacyDir(): Promise<string> {
  const s = settingsStore.get().saveDir.trim();
  const dir = s && s !== GALLERY_SAVE ? s : await downloadDir();
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    throw mapNativeError(e, "permission");
  }
  return dir.replace(/[\\/]+$/, "");
}

async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  for (let i = 0; i < 1000; i++) {
    const p = await join(dir, `${base}${i ? ` (${i})` : ""}.${ext}`);
    if (!(await exists(p))) return p;
  }
  return join(dir, `${base}-${Date.now()}.${ext}`);
}

/**
 * Stage folder name prefix. MUST start with "gallery-": the plugin's gallery_publish / folder_save only accept a
 * source under cacheDir/gallery-<id>/ (KeepsakeMediaPlugin.kt stagedSource) and refuse anything else before any
 * copy. The old "editor-<id>" stage was refused, so every Gallery/folder save of an edit failed
 * (folder mode: "folder:source_missing ... went missing"; Gallery mode: "gallery:unknown: The source must be a staged
 * download"). Same construction as download.ts runStaged: join(appCacheDir(), "gallery-...").
 */
export const STAGE_PREFIX = "gallery-editor-";

/** A finished edit waiting in its stage to be saved. */
interface Staged {
  key: string;
  stage: string;
  src: string;
  fileName: string;
  mime: string;
  kind: "video" | "image";
}

/**
 * The last edit whose save failed while the file stayed in its stage. Exporting the same edit again (Retry) re-saves
 * this file instead of encoding it again. Only one is kept; any other export, or leaving the editor, drops it.
 */
let pending: Staged | undefined;

/** Stages older than this are left over from a crash or an abandoned Retry and are swept. */
const STALE_MS = 60 * 60 * 1000;
/** Stages in use by a running export (never swept). */
const activeStages = new Set<string>();
let swept = false;

/** Creation time encoded in a stage name `gallery-editor-<base36 ms>-<rand>`, or NaN. */
export function stageTime(name: string): number {
  if (!name.startsWith(STAGE_PREFIX)) return NaN;
  const ms = Number.parseInt(name.slice(STAGE_PREFIX.length).split("-")[0] ?? "", 36);
  return Number.isFinite(ms) && ms > 0 ? ms : NaN;
}

/**
 * Best effort (run once per app run, at the first stage): removes `gallery-editor-*` stages older than an hour (a
 * crash, or a failed save the user never retried). Never the active or pending stage. download.ts's own
 * `gallery-<jobId>-*` stages never match the prefix and are untouched. Exported for tests. Never throws.
 */
export async function sweepStaleStages(cache: string): Promise<void> {
  try {
    // Namespace access: test files mock plugin-fs process-wide without readDir, and a named import would fail to link.
    const readDir = (fsAll as Partial<typeof fsAll>).readDir;
    if (typeof readDir !== "function") return;
    const now = Date.now();
    for (const e of await readDir(cache)) {
      const t = stageTime(e.name);
      if (!e.isDirectory || !(now - t > STALE_MS)) continue;
      const dir = await join(cache, e.name);
      if (activeStages.has(dir) || pending?.stage === dir) continue;
      await dropStage(dir);
    }
  } catch {
    // listing the cache is optional
  }
}

async function makeStage(): Promise<string> {
  const cache = await appCacheDir();
  if (!swept) {
    swept = true;
    await sweepStaleStages(cache);
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6) || "0"}`;
  const stage = await join(cache, `${STAGE_PREFIX}${id}`);
  try {
    await mkdir(stage, { recursive: true });
  } catch (e) {
    throw mapNativeError(e, "export_failed");
  }
  activeStages.add(stage);
  return stage;
}

function dropStage(stage: string): Promise<void> {
  activeStages.delete(stage);
  return remove(stage, { recursive: true }).catch(() => undefined);
}

/** Drops the kept stage of a failed save (the editor was left). Never throws. */
export async function discardPendingStage(): Promise<void> {
  const p = pending;
  pending = undefined;
  if (p) await dropStage(p.stage);
}

const isInside = (p: string, dir: string) => p === dir || p.startsWith(`${dir.replace(/[\\/]+$/, "")}/`);

const jobKey = (job: EditJob, mode: Mode) => `${mode}|${JSON.stringify(job)}`;

/** The pending staged file for this exact edit when it is still on disk; otherwise drops any pending stage. */
async function takePending(key: string): Promise<Staged | undefined> {
  const p = pending;
  pending = undefined;
  if (!p) return undefined;
  if (p.key === key && (await exists(p.src).catch(() => false))) {
    activeStages.add(p.stage);
    return p;
  }
  await dropStage(p.stage);
  return undefined;
}

/** Throws (export step) when the file the export wrote is not there. An exists() failure is not proof: carry on. */
async function requireStaged(s: Staged): Promise<void> {
  if (await exists(s.src).catch(() => true)) return;
  await dropStage(s.stage);
  throw markSaveStep(
    new EditorError("export_failed", `The edit finished but its file was not found, so nothing was saved. Tap Retry to export it again. (Details: export: missing ${s.src})`),
    "export",
  );
}

/** EditorError for a failed save step: says the edit itself worked, which step failed, what to do, and the plugin code. */
function saveFailed(where: string, code: EditorErrorCode, reason: string, detail: string, kept: boolean): EditorError {
  const next = kept ? "Tap Retry to save it again (it will not be re-encoded)." : "Tap Retry to export it again.";
  const text = `Your edit was made, but Keepsake couldn't save it to ${where}. ${reason ? `${reason} ` : ""}${next} (Details: ${detail})`;
  return markSaveStep(new EditorError(code, text), "save");
}

/**
 * Publish a staged file to the Gallery or the chosen SAF folder: the same helpers, argument shape and cleanup order
 * as download.ts runStaged (stage removed only after a successful publish; on failure the file stays in its stage).
 */
async function saveStaged(mode: "gallery" | "folder", s: Staged, signal?: AbortSignal): Promise<EditResult> {
  await requireStaged(s);
  if (signal?.aborted) {
    await dropStage(s.stage);
    throw cancelled();
  }
  let keepStage = false;
  try {
    if (mode === "folder") {
      const out = await saveToFolder({ src: s.src, treeUri: settingsStore.get().saveTreeUri, fileName: s.fileName, mime: s.mime });
      return { path: out.uri, name: out.name };
    }
    const out = await publishToGallery({ src: s.src, kind: s.kind, fileName: s.fileName, mime: s.mime });
    return { path: out.uri, name: s.fileName };
  } catch (e) {
    if (e instanceof FolderError) {
      // The plugin deletes src only on success; source_missing means it is gone, so Retry must export again.
      keepStage = e.folderCode !== "source_missing";
      const code: EditorErrorCode =
        e.folderCode === "no_space" ? "no_space" : e.folderCode === "permission" || e.folderCode === "not_found" ? "permission" : "export_failed";
      const reason =
        e.folderCode === "source_missing" ? "The edited file was gone from the app cache before it could be copied." : e.message;
      throw saveFailed("your folder", code, reason, `folder:${e.folderCode}: ${e.detail ?? "no detail"}`, keepStage);
    }
    if (e instanceof GalleryError) {
      const kept = e.keptPath?.trim();
      const keptSafe = kept !== undefined && kept.startsWith("/") && !isInside(kept, s.stage);
      // Storage permission denied but the plugin moved the file to its own kept folder: report that location.
      if (keptSafe && kept !== undefined && e.galleryCode === "permission") return { path: kept, name: baseOf(kept) };
      keepStage = !keptSafe;
      const code: EditorErrorCode = e.galleryCode === "no_space" ? "no_space" : e.galleryCode === "permission" ? "permission" : "export_failed";
      const reason = e.galleryCode === "unknown" ? "" : e.message;
      const where = keptSafe ? `file kept at ${kept}` : `file left at ${s.src}`;
      throw saveFailed("the Gallery", code, reason, `gallery:${e.galleryCode}: ${e.detail ?? "no detail"} (${where})`, keepStage);
    }
    keepStage = true;
    const err = mapNativeError(e, "export_failed");
    throw saveFailed(mode === "folder" ? "your folder" : "the Gallery", err.code, "", rawText(e), true);
  } finally {
    // Kept for Retry only after a real failure; an abort during the save (or any success) removes the stage.
    if (keepStage && !signal?.aborted) {
      pending = s;
      activeStages.delete(s.stage);
    } else await dropStage(s.stage);
  }
}

// ---------------- export ----------------

/** Stops the running native export (one at a time). Best effort: an older plugin without the command is ignored. */
const sendCancel = () => void invoke<void>(`plugin:${PLUGIN}|editor_cancel`, {}).catch(() => undefined);

async function exportPhoto(job: EditJob, signal?: AbortSignal): Promise<EditResult> {
  const uri = uriOf(job.input);
  const mode = saveMode();
  const key = jobKey(job, mode);
  // Retry after a failed save: the rendered file is still staged, save it again.
  const again = await takePending(key);
  if (again && mode !== "legacy") return saveStaged(mode, again, signal);
  const rendered = await renderPhoto(await readBlob(uri, MIME[extOf(job.input.name)] ?? "image/*"), job, signal);
  const base = editBase(job.input.name);
  if (mode === "legacy") {
    const out = await uniquePath(await legacyDir(), base, rendered.ext);
    try {
      await writeFile(out, rendered.bytes);
    } catch (e) {
      throw mapNativeError(e, "permission");
    }
    return { path: out, name: baseOf(out) };
  }
  const stage = await makeStage();
  const fileName = `${base}.${rendered.ext}`;
  const src = await join(stage, fileName);
  try {
    await writeFile(src, rendered.bytes);
  } catch (e) {
    await dropStage(stage);
    throw mapNativeError(e, "export_failed");
  }
  return saveStaged(mode, { key, stage, src, fileName, mime: rendered.mime, kind: "image" }, signal);
}

async function exportVideo(
  job: EditJob,
  probe: MediaProbe,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<EditResult> {
  throwIfAborted(signal);
  const uri = uriOf(job.input);
  const base = editBase(job.input.name);
  const mode = saveMode();
  const key = jobKey(job, mode);
  // Retry after a failed save: the encoded file is still staged, save it again without re-encoding.
  const again = await takePending(key);
  if (again && mode !== "legacy") {
    const r = await saveStaged(mode, again, signal);
    onProgress(1);
    return r;
  }
  // Legacy target first, so an unwritable save folder fails before any encoding.
  const target = mode === "legacy" ? await uniquePath(await legacyDir(), base, "mp4") : undefined;
  const stage = await makeStage();
  const report = progressGate(onProgress);
  const crop = videoCrop(job.crop, probe);
  const { trimStart, trimEnd } = videoTrim(job, probe);

  let listener: PluginListener | undefined;
  try {
    listener = await addPluginListener<{ fraction?: unknown }>(PLUGIN, "keepsake-editor-progress", (p) => {
      if (typeof p?.fraction === "number") report(p.fraction);
    });
  } catch {
    // progress is optional: the bar stays where it is until the export ends
  }
  signal?.addEventListener("abort", sendCancel, { once: true });
  let staged: Staged | undefined;
  try {
    // An abort during the awaits above fired before the listener existed: don't start an export nobody can cancel.
    throwIfAborted(signal);
    const outPath = await join(stage, `${base}.mp4`);
    let res: unknown;
    try {
      res = await invoke<unknown>(`plugin:${PLUGIN}|editor_export_video`, {
        uri,
        outPath,
        ...(crop ? { crop } : {}),
        ...(trimStart !== undefined ? { trimStart } : {}),
        ...(trimEnd !== undefined ? { trimEnd } : {}),
        audio: job.audio && probe.hasAudio,
      });
    } catch (e) {
      if (signal?.aborted) throw cancelled();
      throw mapNativeError(e, "export_failed");
    }
    const path = (res as { path?: unknown } | null)?.path;
    const written = typeof path === "string" && path ? path : undefined;
    if (!written) throw editorError("export_failed", `editor_export_video returned ${rawText(res)}`);
    if (signal?.aborted) throw cancelled();
    report(1);
    if (mode === "legacy" && target) {
      await copyOut(written, target);
      if (signal?.aborted) throw cancelled();
      return { path: target, name: baseOf(target) };
    }
    // Save the file this module asked Media3 to write (outPath), not a re-spelled path: the plugin's reply is the
    // canonical form of the same file (e.g. /data/data vs /data/user/0), and stage checks compare against `stage`.
    staged = { key, stage, src: outPath, fileName: baseOf(outPath), mime: "video/mp4", kind: "video" };
  } catch (e) {
    // Legacy mode copies into the user's folder: never leave a half or cancelled file there.
    if (target) await remove(target).catch(() => undefined);
    throw e;
  } finally {
    signal?.removeEventListener("abort", sendCancel);
    await listener?.unregister().catch(() => undefined);
    // The stage outlives this block only when the file still has to be saved (saveStaged owns it from here).
    if (!staged) await dropStage(stage);
  }
  if (!staged || mode === "legacy") throw editorError("export_failed", "no staged file to save");
  return saveStaged(mode, staged, signal);
}

/** Copies a staged file to `dst` in chunks (no single IPC message holds the whole video). */
async function copyOut(src: string, dst: string): Promise<void> {
  try {
    const from = await openFs(src, { read: true });
    try {
      const to = await openFs(dst, { write: true, create: true, truncate: true });
      try {
        const buf = new Uint8Array(READ_CHUNK);
        for (;;) {
          const n = await from.read(buf);
          if (n === null || n <= 0) break;
          for (let off = 0; off < n; ) {
            const w = await to.write(buf.subarray(off, n));
            if (!(w > 0)) throw new Error(`write to ${dst} stalled`);
            off += w;
          }
        }
      } finally {
        await to.close().catch(() => undefined);
      }
    } finally {
      await from.close().catch(() => undefined);
    }
  } catch (e) {
    throw mapNativeError(e, "permission");
  }
}

/**
 * plugin-dialog options. pickerMode "image"/"video" makes the Android intent type image/* or video/*
 * (tauri-plugin-dialog 2.8 DialogPlugin.kt); "media" keeps both MIME families, as before.
 */
export function pickerOptions(want?: MediaKind) {
  if (want === "photo") {
    return { multiple: false, directory: false, pickerMode: "image" as const, filters: [{ name: "Photos", extensions: ["image/*"] }] };
  }
  if (want === "video") {
    return { multiple: false, directory: false, pickerMode: "video" as const, filters: [{ name: "Videos", extensions: ["video/*"] }] };
  }
  return {
    multiple: false,
    directory: false,
    pickerMode: "media" as const,
    filters: [{ name: "Photos and videos", extensions: ["image/*", "video/*"] }],
  };
}

export const androidEngine: PlatformEngine = {
  /** Media3 Transformer does crop and frame-accurate trim for every video it can open. */
  capabilities() {
    return Promise.resolve({ ...FULL_CAPS });
  },

  async pickMedia(want) {
    let res: unknown;
    try {
      res = await openDialog(pickerOptions(want));
    } catch (e) {
      const err = mapNativeError(e, "permission");
      // plugin-dialog rejects "File picker cancelled" when the user backs out: that is a cancel, not an error.
      if (err.code === "cancelled") return null;
      throw err;
    }
    if (typeof res !== "string" || !res) return null;
    const fromUri = nameFromUri(res);
    const kind = await kindOf(res, fromUri, want);
    const name = fromUri || `${kind === "video" ? "VID" : "IMG"}_${stamp()}.${kind === "video" ? "mp4" : "jpg"}`;
    return { kind, name, uri: res };
  },

  async probe(input, signal) {
    throwIfAborted(signal);
    const uri = uriOf(input);
    let p: MediaProbe;
    if (input.kind === "photo") {
      p = await probePhoto(await readBlob(uri, MIME[extOf(input.name)] ?? "image/*"));
    } else {
      const cached = pickProbes.get(uri);
      pickProbes.delete(uri);
      p = cached ?? (await nativeProbe(uri));
    }
    throwIfAborted(signal);
    return p;
  },

  async previewUrl(input) {
    const uri = uriOf(input);
    const type = MIME[extOf(input.name)] ?? (input.kind === "video" ? "video/mp4" : "image/*");
    const blob = input.kind === "photo" ? await readBlob(uri, type) : await readBlobChunked(uri, type);
    return URL.createObjectURL(blob);
  },

  exportEdit(job, probe, onProgress, signal) {
    if (job.input.kind === "photo") {
      return exportPhoto(job, signal).then((r) => {
        onProgress(1);
        return r;
      });
    }
    return exportVideo(job, probe, onProgress, signal);
  },
};
