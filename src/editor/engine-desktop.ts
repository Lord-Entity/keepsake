/**
 * Editor engine for Windows/Linux.
 * - pickMedia: plugin-dialog `open` (adds the picked file to the fs and asset-protocol scopes).
 * - previewUrl: convertFileSrc (asset protocol). Needs `app.security.assetProtocol.enable` and a CSP that allows
 *   asset: / http://asset.localhost in img-src and media-src.
 * - Video: Rust commands (src-tauri/src/editor.rs):
 *     editor_probe { path } -> { width, height, duration, hasAudio, rotation }
 *     editor_capabilities -> { copyOnly, canReencode, encoder }
 *     edit_video { jobId, input, output, crop, trimStart, trimEnd, audio, onEvent: Channel<{progress}|{done}> }
 *     cancel_edit { jobId }
 *   Rust writes the output file itself (and validates the path). Rejections "editor:<code>[: detail]" map through
 *   mapNativeError: invalid -> invalid_job, no_encoder / no_ffmpeg -> unsupported, no_video -> probe_failed,
 *   failed -> the caller's fallback (probe_failed / export_failed), cancelled / unsupported as is.
 * - Crop without an ffmpeg encoder (the bundled build has none): edit_video rejects with the plain string
 *   "editor:no_encoder: ..." (Tauri rejects with the Err(String) value itself, not an Error). exportInApp then tries
 *   1) WebCodecs (engine-webcodecs.ts: decode, crop, H.264 encode, own mp4 muxer; faster than real time), then
 *   2) the webview recorder (engine-webcrop.ts, real time); both outputs are moved into place by edit_video in copy
 *   mode. If both fail, the error lists every attempt and says trim / sound off still work (NO_CROP_HELP).
 * - Photo: decoded and encoded in the webview (engine-photo.ts), written with plugin-fs.
 * Output goes to Settings > save folder when set, otherwise next to the source, as `<name>_edit.<ext>`.
 * Invoke/Channel style copied from src/engine/ytdlp.ts.
 */
import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appCacheDir, dirname, downloadDir, join } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
// No `rename` import: the other editor tests mock plugin-fs without it (bun mock.module is process-wide).
import { exists, mkdir, open as openFs, readFile, remove, writeFile } from "@tauri-apps/plugin-fs";
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
  MIME,
  parseProbe,
  PHOTO_EXTS,
  probePhoto,
  progressGate,
  rawText,
  renderPhoto,
  throwIfAborted,
  VIDEO_EXTS,
  videoCrop,
  videoTrim,
  type PlatformEngine,
} from "./engine-photo";
import { transcodeWebCodecs, webCodecsCanEncode, webCodecsEncoderProbe } from "./engine-webcodecs";
import { recordWebCrop, remuxProgress, webCropInfo, webCropSupported, type WebCropResult } from "./engine-webcrop";
import type { CropRect, EditJob, EditorCapabilities, EditorInput, EditResult, MediaKind, MediaProbe } from "./types";
import { EditorError } from "./types";

type EditEvent = { progress: number } | { done: true };

function pathOf(input: EditorInput): string {
  if (!input.path) throw new EditorError("invalid_job", "No file path to edit");
  return input.path;
}

async function readBlob(path: string, ext: string): Promise<Blob> {
  try {
    const bytes = await readFile(path);
    return new Blob([bytes], { type: MIME[ext] ?? "application/octet-stream" });
  } catch (e) {
    throw mapNativeError(e, "probe_failed");
  }
}

/** Folders to try, in order: the save folder (or the source's folder), then Downloads. */
async function outDirs(src: string): Promise<string[]> {
  const saved = settingsStore.get().saveDir.trim();
  const first = saved && /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(saved) ? saved : await dirname(src);
  const dirs = [first.replace(/[\\/]+$/, "") || first];
  try {
    const dl = await downloadDir();
    if (dl && !dirs.includes(dl)) dirs.push(dl);
  } catch {
    // no Downloads folder: only the first choice
  }
  return dirs;
}

/** `<dir>/<base>.<ext>`, or `<base> (n).<ext>` when taken. Throws when the folder is outside the fs scope. */
async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  for (let i = 0; i < 1000; i++) {
    const p = await join(dir, `${base}${i ? ` (${i})` : ""}.${ext}`);
    if (!(await exists(p))) return p;
  }
  return join(dir, `${base}-${Date.now()}.${ext}`);
}

/** Video output path. Rust writes it, so a folder outside the JS fs scope is fine: fall back to a timestamped name. */
async function videoOutPath(src: string, base: string): Promise<string> {
  const [dir] = await outDirs(src);
  try {
    return await uniquePath(dir, base, "mp4");
  } catch {
    return join(dir, `${base}-${Date.now()}.mp4`);
  }
}

async function probeDesktop(input: EditorInput, signal?: AbortSignal): Promise<MediaProbe> {
  throwIfAborted(signal);
  const path = pathOf(input);
  if (input.kind === "photo") return probePhoto(await readBlob(path, extOf(path)));
  let res: unknown;
  try {
    res = await invoke<unknown>("editor_probe", { path });
  } catch (e) {
    throw mapNativeError(e, "probe_failed");
  }
  throwIfAborted(signal);
  const size = (res as { size?: unknown } | null)?.size;
  if (typeof size === "number" && size > 0) sourceSizes.set(path, size);
  return parseProbe(res);
}

async function exportPhoto(job: EditJob, signal?: AbortSignal): Promise<EditResult> {
  const src = pathOf(job.input);
  const rendered = await renderPhoto(await readBlob(src, extOf(src)), job, signal);
  const base = editBase(job.input.name || baseOf(src));
  let last: unknown;
  // The source folder is usually outside the fs scope (the dialog grants only the file): fall back to Downloads.
  for (const dir of await outDirs(src)) {
    try {
      const out = await uniquePath(dir, base, rendered.ext);
      await writeFile(out, rendered.bytes);
      return { path: out, name: baseOf(out) };
    } catch (e) {
      const err = mapNativeError(e, "permission");
      if (err.code === "no_space") throw err;
      last = e;
    }
  }
  throw mapNativeError(last, "permission");
}

interface EditArgs {
  input: string;
  output: string;
  crop: CropRect | null;
  trimStart: number | null;
  trimEnd: number | null;
  audio: boolean;
}

/**
 * One `edit_video` run with cancel handling. Rejects with `cancelled()` after an abort (the output is removed),
 * otherwise with the raw native error so the caller can decide on a fallback.
 */
async function runEditVideo(args: EditArgs, report: (f: number) => void, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const jobId = `edit-${crypto.randomUUID()}`;
  // Cancel race (same as ytdlp.ts): a cancel_edit sent before Rust registers the job is a no-op, so it is
  // re-sent on the first event and once shortly after start.
  const sendCancel = () => void invoke<void>("cancel_edit", { jobId }).catch(() => undefined);
  let resent = false;
  const ch = new Channel<EditEvent>();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Tauri Channel only exposes onmessage
  ch.onmessage = (m) => {
    if (!resent && signal?.aborted) {
      resent = true;
      sendCancel();
    }
    if ("progress" in m) report(m.progress);
    else if (m.done) report(1);
  };
  signal?.addEventListener("abort", sendCancel, { once: true });
  const timer = signal
    ? setTimeout(() => {
        if (signal.aborted) sendCancel();
      }, 500)
    : undefined;
  try {
    await invoke<void>("edit_video", { jobId, ...args, onEvent: ch });
  } catch (e) {
    if (signal?.aborted) {
      await remove(args.output).catch(() => undefined);
      throw cancelled();
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", sendCancel);
  }
  if (signal?.aborted) {
    await remove(args.output).catch(() => undefined);
    throw cancelled();
  }
}

/** True for edit_video rejections the webview recorder can work around (no encoder / no ffmpeg). */
export function needsWebCrop(e: unknown): boolean {
  return /editor:(no_encoder|no_ffmpeg)\b/.test(rawText(e));
}

/** Bytes the in-app encoder may read into memory (the source up to the trim end). Above it: the recorder. */
export const MAX_IN_APP_BYTES = 768 * 1024 * 1024;
/** Source file sizes from editor_probe (`size`), so the in-app encoder can skip files too large for memory. */
const sourceSizes = new Map<string, number>();

/** Short text of a failed attempt for the final message. */
function why(e: unknown): string {
  return rawText(e)
    .replace(/^editor:[a-z_]+:\s*/, "")
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

const isCancel = (e: unknown, signal?: AbortSignal) => signal?.aborted === true || (e instanceof EditorError && e.code === "cancelled");

async function editorCache(): Promise<string> {
  const cache = await join(await appCacheDir(), "editor");
  await mkdir(cache, { recursive: true }).catch(() => undefined);
  return cache;
}

type FileHandle = Awaited<ReturnType<typeof openFs>>;

async function writeAll(fh: FileHandle, chunk: Uint8Array): Promise<void> {
  let off = 0;
  while (off < chunk.length) {
    const n = await fh.write(chunk.subarray(off));
    if (!(n > 0)) throw editorError("export_failed", "could not write the video");
    off += n;
  }
}

/**
 * Moves a finished temp .mp4/.webm from the app cache to `output`: edit_video in stream-copy mode (faststart, and
 * Rust may write folders the webview's fs scope can't). If that fails, the file is copied as is to the first writable
 * output folder. The temp file is always removed.
 */
async function deliver(tmp: string, output: string, hasAudio: boolean, src: string, job: EditJob, ext: string, report: (f: number) => void, signal?: AbortSignal): Promise<EditResult> {
  try {
    await runEditVideo({ input: tmp, output, crop: null, trimStart: null, trimEnd: null, audio: hasAudio }, (p) => report(remuxProgress(p)), signal);
  } catch (e) {
    if (isCancel(e, signal)) {
      await remove(tmp).catch(() => undefined);
      throw cancelled();
    }
    try {
      const kept = await keepRecording(tmp, src, editBase(job.input.name || baseOf(src)), ext);
      report(1);
      return kept;
    } finally {
      // No writable folder: don't leave the (possibly large) file behind in the app cache.
      await remove(tmp).catch(() => undefined);
    }
  }
  await remove(tmp).catch(() => undefined);
  report(1);
  return { path: output, name: baseOf(output) };
}

/**
 * Crop without an ffmpeg encoder, fast path: the bundled ffmpeg stream-copies the source (up to the trim end, plus
 * 1 s) into a plain .mp4 in the app cache; WebCodecs decodes, crops and H.264-encodes it in the webview
 * (engine-webcodecs.ts, faster than real time), audio packets are copied; the result is moved into place by deliver().
 */
async function exportWebCodecs(job: EditJob, probe: MediaProbe, src: string, output: string, report: (f: number) => void, signal?: AbortSignal): Promise<EditResult> {
  throwIfAborted(signal);
  const { trimStart, trimEnd } = videoTrim(job, probe);
  const start = trimStart ?? 0;
  // Unknown duration (0): encode to the end of the file.
  const end = trimEnd ?? (probe.duration > 0 ? probe.duration : Number.POSITIVE_INFINITY);
  const audio = job.audio && probe.hasAudio;
  const size = sourceSizes.get(src);
  if (size && probe.duration > 0 && (size * Math.min(1, (end + 1) / probe.duration)) > MAX_IN_APP_BYTES) {
    throw editorError("unsupported", `the clip is too large to encode in memory (${Math.round(size / 1048576)} MB file); trim it shorter or crop a shorter part`);
  }
  const cache = await editorCache();
  const id = crypto.randomUUID();
  const pre = await join(cache, `src-${id}.mp4`);
  const tmp = await join(cache, `enc-${id}.mp4`);
  try {
    const cut = end < probe.duration - 0.01 ? Math.min(probe.duration, end + 1) : null;
    await runEditVideo({ input: src, output: pre, crop: null, trimStart: null, trimEnd: cut, audio }, (p) => report(0.05 * p), signal);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(pre);
    } catch (e) {
      throw mapNativeError(e, "export_failed");
    }
    await remove(pre).catch(() => undefined);
    let fh: FileHandle;
    try {
      fh = await openFs(tmp, { write: true, create: true, truncate: true });
    } catch (e) {
      throw mapNativeError(e, "export_failed");
    }
    let res: { hasAudio: boolean };
    try {
      res = await transcodeWebCodecs({
        bytes,
        probe,
        crop: videoCrop(job.crop, probe),
        start,
        end,
        audio,
        onProgress: (f) => report(0.05 + 0.9 * f),
        write: (c) => writeAll(fh, c),
        signal,
      });
    } finally {
      await fh.close().catch(() => undefined);
    }
    return await deliver(tmp, output, res.hasAudio, src, job, "mp4", report, signal);
  } catch (e) {
    await remove(tmp).catch(() => undefined);
    throw isCancel(e, signal) ? cancelled() : e;
  } finally {
    await remove(pre).catch(() => undefined);
  }
}

/** Shown when no in-app path can crop. Exported for tests. */
export const NO_CROP_HELP =
  "You can still trim the video and turn its sound off: reset the crop and export again. To crop here, update Microsoft Edge WebView2 (Windows N editions also need the Media Feature Pack) or, on Linux, install the GStreamer H.264 plugins (gst-plugins-bad/ugly or openh264); a full ffmpeg on PATH also works.";

/** One fallback step in the dev console (DevTools), so a failed crop can be diagnosed. */
const step = (s: string) => console.warn(`[keepsake-editor] ${s}`);

/**
 * edit_video could not do it (no encoder / no ffmpeg). Tries, in order: WebCodecs (fast), the webview recorder (real
 * time). Every failure is collected so the final message says exactly what was missing.
 */
async function exportInApp(job: EditJob, probe: MediaProbe, src: string, output: string, report: (f: number) => void, first: unknown, signal?: AbortSignal): Promise<EditResult> {
  // Each step goes to the dev console ([keepsake-editor]) and, on total failure, into the dialog's Details.
  const tried = [`ffmpeg: ${why(first)}`];
  step(`1/3 ffmpeg (bundled, then PATH) failed: ${rawText(first)}`);
  const enc = await webCodecsEncoderProbe().catch((e: unknown) => ({ ok: false, info: `probe threw: ${why(e)}` }));
  step(`2/3 in-app encoder (WebCodecs) probe: ${enc.ok ? "usable" : "unusable"}; ${enc.info}`);
  if (enc.ok) {
    try {
      const r = await exportWebCodecs(job, probe, src, output, report, signal);
      step("2/3 in-app encoder: done");
      return r;
    } catch (e) {
      if (isCancel(e, signal)) throw cancelled();
      step(`2/3 in-app encoder failed: ${rawText(e)}`);
      tried.push(`in-app encoder: ${why(e)} [${enc.info}]`);
    }
  } else {
    tried.push(`in-app encoder: this system's web engine has no H.264 encoder (WebCodecs) [${enc.info}]`);
  }
  const recInfo = webCropInfo(job.audio && probe.hasAudio);
  const rec = webCropSupported();
  step(`3/3 real-time recording probe: ${rec ? "usable" : "unusable"}; ${recInfo}`);
  if (rec) {
    try {
      const r = await exportWebCrop(job, probe, src, output, report, signal);
      step("3/3 real-time recording: done");
      return r;
    } catch (e) {
      if (isCancel(e, signal)) throw cancelled();
      step(`3/3 real-time recording failed: ${rawText(e)}`);
      tried.push(`real-time recording: ${why(e)} [${recInfo}]`);
    }
  } else {
    tried.push(`real-time recording: not available in this web engine [${recInfo}]`);
  }
  throw new EditorError("unsupported", `Keepsake couldn't crop this video on this computer. ${NO_CROP_HELP} (Details: Tried: ${tried.join("; ")}.)`);
}

/** Moves a recording the remux could not convert to `<base>.<ext>` in the first writable output folder. */
async function keepRecording(tmp: string, src: string, base: string, ext: string): Promise<EditResult> {
  let last: unknown;
  for (const dir of await outDirs(src)) {
    let out: string;
    try {
      out = await uniquePath(dir, base, ext);
    } catch (e) {
      last = e;
      continue;
    }
    try {
      await writeFile(out, await readFile(tmp));
      await remove(tmp).catch(() => undefined);
      return { path: out, name: baseOf(out) };
    } catch (e) {
      const err = mapNativeError(e, "permission");
      if (err.code === "no_space") throw err;
      last = e;
    }
  }
  throw mapNativeError(last, "permission");
}

/**
 * Crop without an ffmpeg encoder: record the cropped clip in the webview (engine-webcrop.ts, real time) into the app
 * cache, then remux it to `output` (.mp4) with edit_video in stream-copy mode. If the remux fails, the recording is
 * kept as is (.mp4 or .webm, named after the recorder format).
 */
async function exportWebCrop(job: EditJob, probe: MediaProbe, src: string, output: string, report: (f: number) => void, signal?: AbortSignal): Promise<EditResult> {
  throwIfAborted(signal);
  const { trimStart, trimEnd } = videoTrim(job, probe);
  const tmp = await join(await editorCache(), `rec-${crypto.randomUUID()}.tmp`);
  let fh: FileHandle;
  try {
    fh = await openFs(tmp, { write: true, create: true, truncate: true });
  } catch (e) {
    throw mapNativeError(e, "export_failed");
  }
  const onData = (chunk: Uint8Array) => writeAll(fh, chunk);
  let rec: WebCropResult;
  try {
    rec = await recordWebCrop({
      url: convertFileSrc(src),
      probe,
      crop: videoCrop(job.crop, probe),
      start: trimStart ?? 0,
      end: trimEnd ?? probe.duration,
      audio: job.audio && probe.hasAudio,
      onProgress: report,
      onData,
      signal,
    });
  } catch (e) {
    await fh.close().catch(() => undefined);
    await remove(tmp).catch(() => undefined);
    if (signal?.aborted) throw cancelled();
    throw mapNativeError(e, "export_failed");
  }
  await fh.close().catch(() => undefined);
  return deliver(tmp, output, rec.hasAudio, src, job, rec.ext, report, signal);
}

async function exportVideo(
  job: EditJob,
  probe: MediaProbe,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<EditResult> {
  throwIfAborted(signal);
  const input = pathOf(job.input);
  const output = await videoOutPath(input, editBase(job.input.name || baseOf(input)));
  const report = progressGate(onProgress);
  const crop = videoCrop(job.crop, probe);
  const { trimStart, trimEnd } = videoTrim(job, probe);
  try {
    await runEditVideo(
      { input, output, crop: crop ?? null, trimStart: trimStart ?? null, trimEnd: trimEnd ?? null, audio: job.audio && probe.hasAudio },
      report,
      signal,
    );
  } catch (e) {
    if (isCancel(e, signal)) throw cancelled();
    // ffmpeg can't do it (bundled build: no video encoder): encode in the app instead (WebCodecs, then recorder).
    // `e` is the plain string Tauri rejects with for a Rust Err(String), e.g. "editor:no_encoder: cropping needs ...".
    if (needsWebCrop(e)) return exportInApp(job, probe, input, output, report, e, signal);
    throw mapNativeError(e, "export_failed");
  }
  report(1);
  return { path: output, name: baseOf(output) };
}

/** Dialog title and filters: only the asked kind, or both (photos and videos first) when none is asked. */
export function dialogFilters(want?: MediaKind): { title: string; filters: { name: string; extensions: string[] }[] } {
  if (want === "video") return { title: "Choose a video to edit", filters: [{ name: "Videos", extensions: [...VIDEO_EXTS] }] };
  if (want === "photo") return { title: "Choose a photo to edit", filters: [{ name: "Photos", extensions: [...PHOTO_EXTS] }] };
  return {
    title: "Choose a photo or video to edit",
    filters: [
      { name: "Photos and videos", extensions: [...VIDEO_EXTS, ...PHOTO_EXTS] },
      { name: "Videos", extensions: VIDEO_EXTS },
      { name: "Photos", extensions: PHOTO_EXTS },
    ],
  };
}

const NONE_CAPS: EditorCapabilities = { crop: false, trim: false, mute: false, exactTrim: false };
/** Copy-only ffmpeg and no in-app encoder: crop is off. Exported for tests. */
export const COPY_ONLY_NOTE = `Crop is off: this computer has no video encoder Keepsake can use. Trim (starts at the nearest earlier keyframe) and sound on/off work. ${NO_CROP_HELP}`;
/** Shown when crop runs through the in-app WebCodecs encoder. Exported for tests. */
export const WEBCODECS_NOTE =
  "Cropped videos are re-encoded inside Keepsake, usually faster than real time. Trim without a crop is instant but starts at the nearest earlier keyframe.";
/** Shown when crop runs through the webview recorder. Exported for tests. */
export const WEBCROP_NOTE =
  "Cropped videos are recorded in real time, so a 1-minute clip takes about a minute to export; keep Keepsake open meanwhile. Trim without a crop is instant but starts at the nearest earlier keyframe.";
const NO_FFMPEG_NOTE =
  "Keepsake's built-in ffmpeg (keepsake-ffmpeg, next to the app) is missing, so videos can't be read. Reinstall Keepsake (or install ffmpeg on PATH), then reopen the video.";

/** Maps `editor_capabilities` (cached in Rust; the first call may run a test encode). Rejects on a bad reply. */
async function videoCapabilities(): Promise<EditorCapabilities> {
  let r: unknown;
  try {
    r = await invoke<unknown>("editor_capabilities");
  } catch (e) {
    if (rawText(e).includes("editor:unsupported")) return { ...NONE_CAPS, note: "Video editing isn't available on this device." };
    throw e;
  }
  if (typeof r !== "object" || r === null) throw new Error("bad editor_capabilities reply");
  const { copyOnly, canReencode } = r as { copyOnly?: unknown; canReencode?: unknown };
  if (typeof copyOnly !== "boolean" || typeof canReencode !== "boolean") throw new Error("bad editor_capabilities reply");
  if (canReencode) return { ...FULL_CAPS };
  // No ffmpeg encoder: crop goes through the in-app encoder (fast) or the webview recorder (real time).
  if (copyOnly) {
    if (await webCodecsCanEncode().catch(() => false)) return { crop: true, trim: true, mute: true, exactTrim: false, note: WEBCODECS_NOTE };
    const rec = webCropSupported();
    return { crop: rec, trim: true, mute: true, exactTrim: false, note: rec ? WEBCROP_NOTE : COPY_ONLY_NOTE };
  }
  return { ...NONE_CAPS, note: NO_FFMPEG_NOTE };
}

export const desktopEngine: PlatformEngine = {
  capabilities(kind) {
    return kind === "photo" ? Promise.resolve({ ...FULL_CAPS }) : videoCapabilities();
  },

  async pickMedia(want?: MediaKind) {
    let res: unknown;
    try {
      res = await openDialog({ multiple: false, directory: false, ...dialogFilters(want) });
    } catch (e) {
      throw mapNativeError(e, "permission");
    }
    if (typeof res !== "string" || !res) return null;
    const name = baseOf(res);
    const kind = kindFromName(name);
    if (!kind) throw editorError("unsupported", name);
    return { kind, name, path: res };
  },

  probe: probeDesktop,

  async previewUrl(input) {
    return convertFileSrc(pathOf(input));
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
