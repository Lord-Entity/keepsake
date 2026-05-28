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
 * - Crop without an ffmpeg encoder (the bundled build has none): edit_video rejects with editor:no_encoder, so the clip
 *   is recorded cropped in the webview (engine-webcrop.ts, real time) and remuxed to .mp4 by edit_video in copy mode.
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
import { recordWebCrop, remuxProgress, webCropSupported, type WebCropResult } from "./engine-webcrop";
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
  return /editor:(no_encoder|no_ffmpeg)/.test(rawText(e));
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
  const cache = await join(await appCacheDir(), "editor");
  await mkdir(cache, { recursive: true }).catch(() => undefined);
  const tmp = await join(cache, `rec-${crypto.randomUUID()}.tmp`);
  let fh: Awaited<ReturnType<typeof openFs>>;
  try {
    fh = await openFs(tmp, { write: true, create: true, truncate: true });
  } catch (e) {
    throw mapNativeError(e, "export_failed");
  }
  const onData = async (chunk: Uint8Array) => {
    let off = 0;
    while (off < chunk.length) {
      const n = await fh.write(chunk.subarray(off));
      if (!(n > 0)) throw editorError("export_failed", "could not write the recording");
      off += n;
    }
  };
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
  try {
    await runEditVideo(
      { input: tmp, output, crop: null, trimStart: null, trimEnd: null, audio: rec.hasAudio },
      (p) => report(remuxProgress(p)),
      signal,
    );
  } catch (e) {
    if (signal?.aborted || (e instanceof EditorError && e.code === "cancelled")) {
      await remove(tmp).catch(() => undefined);
      throw cancelled();
    }
    let kept: EditResult;
    try {
      kept = await keepRecording(tmp, src, editBase(job.input.name || baseOf(src)), rec.ext);
    } catch (err) {
      // No writable folder: don't leave the (possibly large) recording behind in the app cache.
      await remove(tmp).catch(() => undefined);
      throw err;
    }
    report(1);
    return kept;
  }
  await remove(tmp).catch(() => undefined);
  report(1);
  return { path: output, name: baseOf(output) };
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
    if (e instanceof EditorError && e.code === "cancelled") throw e;
    // ffmpeg can't do it (bundled build: no video encoder): crop in the webview instead.
    if (needsWebCrop(e) && webCropSupported()) return exportWebCrop(job, probe, input, output, report, signal);
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
const COPY_ONLY_NOTE = "Trim starts at the nearest earlier keyframe. Install ffmpeg to crop video.";
/** Shown when crop runs through the webview recorder. Exported for tests. */
export const WEBCROP_NOTE =
  "Cropped videos are recorded in real time, so a 1-minute clip takes about a minute to export; keep Keepsake open meanwhile. Trim without a crop is instant but starts at the nearest earlier keyframe.";
const NO_FFMPEG_NOTE =
  "Video editing needs ffmpeg. Install it (Windows: winget install ffmpeg, macOS: brew install ffmpeg, Linux: your distro's ffmpeg package), then reopen the video.";

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
  // No encoder: crop goes through the webview recorder when this webview can record.
  if (copyOnly) return { crop: webCropSupported(), trim: true, mute: true, exactTrim: false, note: webCropSupported() ? WEBCROP_NOTE : COPY_ONLY_NOTE };
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
