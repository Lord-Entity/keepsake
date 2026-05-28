/**
 * Photo crop + export (both platforms) and helpers shared by the platform editor engines.
 * Photos never touch native code: the source is decoded in the webview with createImageBitmap
 * (imageOrientation "from-image", so EXIF rotation is applied and crop coordinates match the displayed picture),
 * the crop is drawn on an OffscreenCanvas (or a <canvas> fallback) and encoded to JPEG or PNG.
 * VERIFIED (TS lib.dom 5.9): ImageBitmapOptions.imageOrientation accepts "from-image"; OffscreenCanvas.convertToBlob.
 * Must not import engine.ts, engine-desktop.ts or engine-android.ts (no cycles).
 */
import type { CropRect, EditJob, EditorCapabilities, EditorErrorCode, EditorInput, EditResult, MediaKind, MediaProbe } from "./types";
import { EditorError } from "./types";

// ---------------- shared: platform engine shape ----------------

/** Everything available. Also the fallback when capabilities cannot be read, so the export reports the real error. */
export const FULL_CAPS: EditorCapabilities = { crop: true, trim: true, mute: true, exactTrim: true };

/** What each platform module implements. engine.ts validates the job and passes the probe in. */
export interface PlatformEngine {
  /** Optional; omitted means FULL_CAPS. May reject (engine.ts falls back to FULL_CAPS). */
  capabilities?(kind: MediaKind): Promise<EditorCapabilities>;
  /** `kind` limits the picker where the platform can; omitted means photos and videos. */
  pickMedia(kind?: MediaKind): Promise<EditorInput | null>;
  probe(input: EditorInput, signal?: AbortSignal): Promise<MediaProbe>;
  previewUrl(input: EditorInput): Promise<string>;
  exportEdit(job: EditJob, probe: MediaProbe, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<EditResult>;
}

// ---------------- shared: names and kinds ----------------

export const PHOTO_EXTS = ["jpg", "jpeg", "png", "webp", "bmp", "gif", "avif"];
export const VIDEO_EXTS = ["mp4", "mov", "m4v", "mkv", "webm", "avi", "3gp", "ts", "mts"];

export const MIME: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
  "3gp": "video/3gpp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  bmp: "image/bmp",
  gif: "image/gif",
  avif: "image/avif",
};

/** File name without folders (either separator). */
export function baseOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** Lower-case extension without the dot, or "". */
export function extOf(name: string): string {
  const b = baseOf(name);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
}

export function kindFromName(name: string): MediaKind | undefined {
  const e = extOf(name);
  if (VIDEO_EXTS.includes(e)) return "video";
  if (PHOTO_EXTS.includes(e)) return "photo";
  return undefined;
}

/** `<name without extension>_edit`, safe for Windows/Android file names. */
export function editBase(name: string): string {
  const b = baseOf(name);
  const i = b.lastIndexOf(".");
  const stem = (i > 0 ? b.slice(0, i) : b)
    // oxlint-disable-next-line no-control-regex -- strip C0 control characters from file names
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .replace(/^[.\s]+/, "");
  return `${Array.from(stem || "keepsake").slice(0, 80).join("")}_edit`;
}

// ---------------- shared: errors ----------------

const TEXT: Record<EditorErrorCode, string> = {
  unsupported: "This file can't be edited on this device.",
  cancelled: "Export cancelled.",
  probe_failed: "Keepsake couldn't read this file. It may be damaged or in a format this device can't open.",
  export_failed: "The export failed. Try again, or try a different file.",
  no_space: "There isn't enough free storage to save the edit. Free some space and try again.",
  permission: "Keepsake isn't allowed to read or write this file. Choose another file or save folder.",
  invalid_job: "These edit settings can't be used.",
};

const CODES = Object.keys(TEXT) as EditorErrorCode[];

export function rawText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** EditorError with the friendly text for `code`, plus the native detail when there is one. */
export function editorError(code: EditorErrorCode, detail?: string): EditorError {
  const d = detail?.replace(/\s+/g, " ").trim().slice(0, 300);
  return new EditorError(code, d ? `${TEXT[code]} (Details: ${d})` : TEXT[code]);
}

export const cancelled = (): EditorError => editorError("cancelled");

/** Which step of an Android export failed: "export" (making the file) or "save" (Gallery / folder). */
export type ExportStep = "export" | "save";

/** Tags an EditorError with the step that failed (an extra own property; the frozen EditorError shape is unchanged). */
export function markSaveStep(e: EditorError, step: ExportStep): EditorError {
  (e as EditorError & { step?: ExportStep }).step = step;
  return e;
}

/** The step an error was tagged with by markSaveStep, if any. */
export function stepOf(e: unknown): ExportStep | undefined {
  const s = e instanceof EditorError ? (e as EditorError & { step?: unknown }).step : undefined;
  return s === "export" || s === "save" ? s : undefined;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

/** Plugin not registered, command unknown, or the capability does not allow it. */
const MISSING_RE = /plugin\b.*\bnot (found|initialized|registered)|command\b.*\bnot found|unknown command|not allowed/i;

/**
 * Codes the desktop Rust side (src-tauri/src/editor.rs) uses that are not EditorErrorCode values.
 * `editor:failed` is not listed: it becomes the caller's fallback (probe_failed while probing, export_failed on export).
 */
const NATIVE_ALIASES: Record<string, EditorErrorCode> = {
  invalid: "invalid_job",
  no_encoder: "unsupported",
  no_ffmpeg: "unsupported",
  no_video: "probe_failed",
};

/**
 * Any native rejection -> EditorError. Understands "editor:<code>: message" and a bare "editor:<code>" (Android
 * plugin and desktop editor.rs) and common OS texts; anything else becomes `fallback`. An EditorError passes through.
 */
export function mapNativeError(e: unknown, fallback: EditorErrorCode): EditorError {
  if (e instanceof EditorError) return e;
  const text = rawText(e);
  const m = /editor:([a-z_]+)(?::\s*([\s\S]*))?/.exec(text);
  if (m) {
    const raw = m[1] ?? "";
    const code = (CODES as string[]).includes(raw) ? (raw as EditorErrorCode) : Object.hasOwn(NATIVE_ALIASES, raw) ? NATIVE_ALIASES[raw] : fallback;
    return editorError(code, m[2]);
  }
  if (MISSING_RE.test(text)) return new EditorError("unsupported", "Editing isn't available in this build of Keepsake. Update or reinstall the app.");
  if (/\bcancel(l?ed)?\b/i.test(text)) return cancelled();
  if (/no space|disk (is )?full|ENOSPC|os error (28|112)\b/i.test(text)) return editorError("no_space", text);
  if (/permission|access (is )?denied|forbidden|EACCES|EPERM|os error (5|13)\b/i.test(text)) return editorError("permission", text);
  return editorError(fallback, text);
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

/** Shape-checks a probe object from Rust or Kotlin. */
export function parseProbe(r: unknown): MediaProbe {
  const o = (r ?? {}) as Record<string, unknown>;
  const width = num(o.width);
  const height = num(o.height);
  const duration = num(o.duration);
  if (!(width > 0) || !(height > 0) || !(duration >= 0)) throw editorError("probe_failed", `bad probe response ${rawText(r)}`);
  const rot = num(o.rotation);
  return {
    width: Math.round(width),
    height: Math.round(height),
    duration,
    hasAudio: o.hasAudio === true,
    rotation: [0, 90, 180, 270].includes(rot) ? rot : 0,
  };
}

/** Monotonic 0..1 progress (native encoders sometimes step back when they switch tracks). */
export function progressGate(onProgress: (fraction: number) => void): (f: number) => void {
  let last = -1;
  return (f) => {
    if (!Number.isFinite(f)) return;
    const v = Math.min(1, Math.max(0, f));
    if (v <= last) return;
    last = v;
    onProgress(v);
  };
}

const even = (n: number) => Math.max(0, Math.floor(n / 2) * 2);

/**
 * Video crop in whole, even display pixels (yuv420 needs even sizes and offsets), clamped to the frame.
 * Undefined when there is no crop or it covers the whole frame (no crop filter needed).
 */
export function videoCrop(crop: CropRect | undefined, probe: MediaProbe): CropRect | undefined {
  if (!crop) return undefined;
  const x = Math.min(even(crop.x), even(probe.width - 2));
  const y = Math.min(even(crop.y), even(probe.height - 2));
  const w = Math.max(2, Math.min(even(crop.w), even(probe.width - x)));
  const h = Math.max(2, Math.min(even(crop.h), even(probe.height - y)));
  if (x === 0 && y === 0 && w >= even(probe.width) && h >= even(probe.height)) return undefined;
  return { x, y, w, h };
}

/** Trim points worth sending: undefined when they match the file's own start/end. */
export function videoTrim(job: EditJob, probe: MediaProbe): { trimStart?: number; trimEnd?: number } {
  const s = job.trimStart;
  const e = job.trimEnd;
  return {
    ...(s !== undefined && s > 0.001 ? { trimStart: s } : {}),
    ...(e !== undefined && e < probe.duration - 0.01 ? { trimEnd: e } : {}),
  };
}

// ---------------- photo ----------------

async function decode(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch (e) {
    throw new EditorError("unsupported", `This picture format can't be opened on this device. Try a JPG, PNG or WebP. (Details: ${rawText(e)})`);
  }
}

/** Probe a photo from its bytes. width/height are display-oriented (EXIF applied), so rotation is 0. */
export async function probePhoto(blob: Blob): Promise<MediaProbe> {
  const bmp = await decode(blob);
  try {
    return { width: bmp.width, height: bmp.height, duration: 0, hasAudio: false, rotation: 0 };
  } finally {
    bmp.close();
  }
}

export interface RenderedPhoto {
  bytes: Uint8Array<ArrayBuffer>;
  ext: "jpg" | "png";
  mime: string;
}

async function encode(
  w: number,
  h: number,
  draw: (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => void,
  type: string,
  quality: number | undefined,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error(`canvas ${w}x${h} unavailable`);
    draw(ctx);
    return c.convertToBlob({ type, quality });
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error(`canvas ${w}x${h} unavailable`);
  draw(ctx);
  return new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), type, quality));
}

/** Crop and encode a photo. `blob` is the source file's bytes. Rejects with EditorError. */
export async function renderPhoto(blob: Blob, job: EditJob, signal?: AbortSignal): Promise<RenderedPhoto> {
  if (job.output !== "jpg" && job.output !== "png") throw new EditorError("invalid_job", "A photo exports as JPG or PNG");
  throwIfAborted(signal);
  const bmp = await decode(blob);
  try {
    throwIfAborted(signal);
    const c = job.crop;
    if (c && ![c.x, c.y, c.w, c.h].every(Number.isFinite)) throw editorError("invalid_job", "crop is not a number");
    const sx = c ? Math.min(Math.max(0, Math.round(c.x)), bmp.width - 1) : 0;
    const sy = c ? Math.min(Math.max(0, Math.round(c.y)), bmp.height - 1) : 0;
    const sw = c ? Math.max(1, Math.min(Math.round(c.w), bmp.width - sx)) : bmp.width;
    const sh = c ? Math.max(1, Math.min(Math.round(c.h), bmp.height - sy)) : bmp.height;
    const jpg = job.output === "jpg";
    const mime = jpg ? "image/jpeg" : "image/png";
    const quality = jpg ? Math.min(100, Math.max(1, Math.round(job.quality ?? 92))) / 100 : undefined;
    let out: Blob;
    try {
      out = await encode(
        sw,
        sh,
        (ctx) => {
          if (jpg) {
            // JPEG has no transparency: put see-through pixels on white instead of black.
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, sw, sh);
          }
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
        },
        mime,
        quality,
      );
    } catch (e) {
      // Browsers refuse big canvases (Android WebView often above ~16 MP); say so instead of a bare "failed".
      const hint = sw * sh >= 16_000_000 ? "This picture is too large for this device to export; try cropping a smaller area. " : "";
      throw editorError("export_failed", `${hint}${sw}x${sh} ${job.output}: ${rawText(e)}`);
    }
    throwIfAborted(signal);
    return { bytes: new Uint8Array(await out.arrayBuffer()), ext: job.output, mime };
  } finally {
    bmp.close();
  }
}
