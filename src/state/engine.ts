/**
 * The only UI module that imports the engine.
 * Everything else talks to the engine through this file or the stores.
 *
 * Bundle boundary: src/engine/index.ts (and through it youtube.ts -> youtubei.js, download.ts, ytdlp.ts)
 * is loaded with a dynamic import() on first use, so it stays out of the startup chunk.
 * Only these light engine modules are imported statically and must stay free of heavy dependencies:
 * engine/platform.ts, engine/errors.ts, engine/formats.ts.
 */
import { appError, friendlyError, toAppError } from "../engine/errors";
import { listFormats as engineListFormats } from "../engine/formats";
import { platform as enginePlatform } from "../engine/platform";
import type { AppError, BinaryStatus, DownloadHandle, DownloadProgress, DownloadRequest, Platform, VideoInfo } from "../lib/types";
import type * as EngineModule from "../engine";
import type { FetchInfoOptions } from "../engine";
import { createStore, useStore } from "./store";

type Engine = typeof EngineModule;

let enginePromise: Promise<Engine> | null = null;
/** Load the full engine once. A failed load is retried on the next call. */
function loadEngine(): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = import("../engine").catch((e: unknown) => {
      enginePromise = null;
      throw e;
    });
  }
  return enginePromise;
}

export async function fetchInfo(url: string, opts?: FetchInfoOptions): Promise<VideoInfo> {
  return (await loadEngine()).fetchInfo(url, opts);
}

export const listFormats = engineListFormats;

/**
 * Same contract as engine.startDownload (sync handle, done never rejects), but the engine loads lazily.
 * cancel() before the engine has loaded resolves done as cancelled without starting the job.
 */
export function startDownload(req: DownloadRequest, onProgress: (p: DownloadProgress) => void): DownloadHandle {
  let cancelled = false;
  let inner: DownloadHandle | null = null;
  const cancelledResult = (): DownloadProgress => ({
    id: req.id,
    status: "cancelled",
    downloadedBytes: 0,
    error: appError("cancelled"),
  });
  // Never rejects: a failed chunk load or a sync throw from the engine becomes a "failed" result.
  const done = loadEngine()
    .then((engine): Promise<DownloadProgress> => {
      if (cancelled) return Promise.resolve(cancelledResult());
      // The engine's first "queued" event would arrive after the store marked the job downloading; drop it.
      inner = engine.startDownload(req, (p) => {
        if (p.status !== "queued") onProgress(p);
      });
      return inner.done;
    })
    .catch(
      (e: unknown): DownloadProgress =>
        cancelled ? cancelledResult() : { id: req.id, status: "failed", downloadedBytes: 0, error: asAppError(e) },
    );
  return {
    id: req.id,
    cancel() {
      cancelled = true;
      inner?.cancel();
    },
    done,
  };
}

let cachedPlatform: Platform | null = null;
export function getPlatform(): Platform {
  if (!cachedPlatform) {
    try {
      cachedPlatform = enginePlatform();
    } catch {
      cachedPlatform = "web";
    }
  }
  return cachedPlatform;
}

/** Normalise anything thrown by the engine into a plain AppError for display (engine's shared toAppError). */
export function asAppError(e: unknown): AppError {
  try {
    return toAppError(e);
  } catch {
    // toAppError can only throw on JSON.stringify of odd values; still route through the friendly-error table.
    return friendlyError(String(e));
  }
}

// ---- Binary status (Splash, sidebar dot, Settings > Tools) ----

export type BinaryLoad =
  | { state: "loading" }
  | { state: "ready"; status: BinaryStatus }
  | { state: "error"; error: AppError };

export const binaryStore = createStore<BinaryLoad>({ state: "loading" });

export async function refreshBinaries(): Promise<BinaryLoad> {
  binaryStore.set({ state: "loading" });
  try {
    const status = await (await loadEngine()).binaryStatus();
    const next: BinaryLoad = { state: "ready", status };
    binaryStore.set(next);
    return next;
  } catch (e) {
    const next: BinaryLoad = { state: "error", error: asAppError(e) };
    binaryStore.set(next);
    return next;
  }
}

export function useBinaries(): BinaryLoad {
  return useStore(binaryStore, (s) => s);
}

export type Health = "ready" | "ffmpeg" | "ytdlp" | "unsupported" | "loading";

/** Sidebar dot: green Ready, amber ffmpeg missing, red yt-dlp missing. */
export function healthOf(b: BinaryLoad): Health {
  if (b.state === "loading") return "loading";
  if (b.state === "error") return "ytdlp";
  const s = b.status;
  if (s.ytdlp === "unsupported" && s.ffmpeg === "unsupported") return "unsupported";
  if (s.ytdlp === "missing") return "ytdlp";
  if (s.ffmpeg === "missing") return "ffmpeg";
  return "ready";
}

export function versionsLine(s: BinaryStatus): string {
  const parts: string[] = [];
  if (s.ytdlpVersion) parts.push(`yt-dlp ${s.ytdlpVersion}`);
  if (s.ffmpegVersion) parts.push(`ffmpeg ${s.ffmpegVersion}`);
  if (s.nodeVersion) parts.push(`Node.js ${s.nodeVersion}`);
  else if (s.node === "missing") parts.push("Node.js missing (YouTube needs it)");
  if (parts.length === 0) {
    return s.ytdlp === "unsupported" ? "Built-in engine" : "Versions unavailable";
  }
  return parts.join(" · ");
}
