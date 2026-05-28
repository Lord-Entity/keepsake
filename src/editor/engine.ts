/**
 * The editor engine the UI calls (contract: src/editor/types.ts). Picks the platform module once:
 *   windows/linux -> engine-desktop.ts, android -> engine-android.ts, web (dev preview) -> a small in-browser
 *   engine below (photos only; video export needs the app).
 * Every export is checked with validateJob against a probe of the same file first (cached per file), so the
 * platform modules only ever see valid jobs. All failures reject with EditorError.
 */
import { platform } from "../engine/platform";
import { androidEngine, discardPendingStage } from "./engine-android";
import { desktopEngine } from "./engine-desktop";
import {
  editBase,
  FULL_CAPS,
  kindFromName,
  mapNativeError,
  PHOTO_EXTS,
  probePhoto,
  renderPhoto,
  throwIfAborted,
  VIDEO_EXTS,
  type PlatformEngine,
} from "./engine-photo";
import type { EditorEngine, EditorInput, MediaKind, MediaProbe } from "./types";
import { EditorError, validateJob } from "./types";

// ---------------- web (dev preview only) ----------------

const webFiles = new Map<string, File>();

function webFile(input: EditorInput): File {
  const f = input.uri ? webFiles.get(input.uri) : undefined;
  if (!f) throw new EditorError("invalid_job", "Choose the file again");
  return f;
}

/** `accept` for the dev-preview file input: only the requested kind, or both. Exported for tests. */
export function webAccept(kind?: MediaKind): string {
  const exts = kind === "photo" ? PHOTO_EXTS : kind === "video" ? VIDEO_EXTS : [...PHOTO_EXTS, ...VIDEO_EXTS];
  return exts.map((e) => `.${e}`).join(",");
}

const webEngine: PlatformEngine = {
  capabilities(kind) {
    return Promise.resolve(
      kind === "photo" ? { ...FULL_CAPS } : { crop: false, trim: false, mute: false, exactTrim: false, note: "Video export needs the Keepsake app." },
    );
  },
  pickMedia(want) {
    return new Promise<EditorInput | null>((resolve) => {
      const el = document.createElement("input");
      el.type = "file";
      el.accept = webAccept(want);
      el.addEventListener("change", () => {
        const f = el.files?.[0];
        const kind = f ? (kindFromName(f.name) ?? (f.type.startsWith("video/") ? "video" : "photo")) : undefined;
        if (!f || !kind) return resolve(null);
        const uri = `web:${crypto.randomUUID()}`;
        webFiles.set(uri, f);
        resolve({ kind, name: f.name, uri });
      });
      el.addEventListener("cancel", () => resolve(null));
      el.click();
    });
  },
  async probe(input, signal) {
    throwIfAborted(signal);
    const f = webFile(input);
    if (input.kind === "photo") return probePhoto(f);
    const url = URL.createObjectURL(f);
    try {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.src = url;
      await new Promise<void>((res, rej) => {
        v.addEventListener("loadedmetadata", () => res(), { once: true });
        v.addEventListener("error", () => rej(new EditorError("probe_failed", "This browser can't read the video")), { once: true });
      });
      return { width: v.videoWidth, height: v.videoHeight, duration: Number.isFinite(v.duration) ? v.duration : 0, hasAudio: true, rotation: 0 };
    } finally {
      URL.revokeObjectURL(url);
    }
  },
  async previewUrl(input) {
    return URL.createObjectURL(webFile(input));
  },
  async exportEdit(job, _probe, onProgress, signal) {
    if (job.input.kind === "video") throw new EditorError("unsupported", "Video export needs the Keepsake app.");
    const r = await renderPhoto(webFile(job.input), job, signal);
    const name = `${editBase(job.input.name)}.${r.ext}`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([r.bytes], { type: r.mime }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    onProgress(1);
    return { path: name, name };
  },
};

// ---------------- dispatch ----------------

function impl(): PlatformEngine {
  const p = platform();
  if (p === "android") return androidEngine;
  if (p === "windows" || p === "linux") return desktopEngine;
  return webEngine;
}

const keyOf = (input: EditorInput) => `${input.kind}|${input.path ?? input.uri ?? input.name}`;

/** Last few probes, so export does not re-probe the file the UI just probed. */
const probes = new Map<string, MediaProbe>();

async function probeCached(input: EditorInput, signal?: AbortSignal): Promise<MediaProbe> {
  const key = keyOf(input);
  const hit = probes.get(key);
  if (hit) return hit;
  let p: MediaProbe;
  try {
    p = await impl().probe(input, signal);
  } catch (e) {
    throw mapNativeError(e, "probe_failed");
  }
  probes.set(key, p);
  if (probes.size > 8) probes.delete(probes.keys().next().value as string);
  return p;
}

/**
 * Call when the editor is left: frees the kept file of a failed Android Gallery/folder save (kept for Retry).
 * Not part of the frozen EditorEngine contract; a no-op on other platforms. Never rejects.
 */
export function releaseEditorStage(): Promise<void> {
  return platform() === "android" ? discardPendingStage() : Promise.resolve();
}

export const editorEngine: EditorEngine = {
  /** Never rejects: a failed check gives the full set so the export itself reports the real error. */
  async capabilities(kind) {
    try {
      const c = await impl().capabilities?.(kind);
      return c ? { ...c } : { ...FULL_CAPS };
    } catch {
      return { ...FULL_CAPS };
    }
  },

  /** `kind` omitted: the platform module is called with no argument, exactly as before. */
  async pickMedia(kind) {
    try {
      return await (kind === undefined ? impl().pickMedia() : impl().pickMedia(kind));
    } catch (e) {
      throw mapNativeError(e, "unsupported");
    }
  },

  probe: probeCached,

  /** Not cached: the caller owns the returned URL and revokes blob: URLs (a cached one could be handed out revoked). */
  async previewUrl(input) {
    try {
      return await impl().previewUrl(input);
    } catch (e) {
      throw mapNativeError(e, "probe_failed");
    }
  },

  async exportEdit(job, onProgress, signal) {
    throwIfAborted(signal);
    const probe = await probeCached(job.input, signal);
    const invalid = validateJob(job, probe);
    if (invalid) throw new EditorError("invalid_job", invalid);
    try {
      return await impl().exportEdit(job, probe, onProgress, signal);
    } catch (e) {
      if (signal?.aborted) throw new EditorError("cancelled", "Export cancelled.");
      throw mapNativeError(e, "export_failed");
    }
  },
};
