/**
 * Video crop in the webview, for desktops whose ffmpeg has no video encoder (the bundled minimal build).
 * The (trimmed) source plays once at 1x in a hidden <video>; every decoded frame is drawn, cropped, onto a canvas;
 * `canvas.captureStream` plus the source audio (Web Audio, so the user hears nothing; `video.captureStream` as a
 * fallback) are recorded with MediaRecorder. Export therefore takes as long as the clip plays (real time).
 * Chunks are handed to `onData` as they arrive, so a long clip never sits in memory.
 * The caller (engine-desktop.ts) remuxes the recording to .mp4 with the bundled ffmpeg (stream copy).
 * Pure helpers (mime choice, progress mapping, draw transform) are exported for tests.
 */
import type { CropRect, MediaProbe } from "./types";
import { EditorError } from "./types";

/** Recording takes this share of the progress bar; the remux after it takes the rest. */
export const RECORD_SHARE = 0.95;
/** Highest frame rate captured from the canvas. */
export const CAPTURE_FPS = 60;
/** Playback that does not advance for this long fails the export. */
const STALL_MS = 20_000;

/** Recorder formats, best first. mp4 needs no remux; VP9 + Opus remuxes into .mp4 by stream copy. */
export function recorderMimes(audio: boolean): string[] {
  const a = audio ? ",mp4a.40.2" : "";
  const o = audio ? ",opus" : "";
  return [
    `video/mp4;codecs=avc1.640033${a}`,
    `video/mp4;codecs=avc1.640028${a}`,
    `video/mp4;codecs=avc1.42E01F${a}`,
    `video/mp4;codecs=avc1${a}`,
    `video/webm;codecs=vp9${o}`,
    `video/webm;codecs=vp8${o}`,
    "video/webm",
    "video/mp4",
  ];
}

/** First mime the recorder supports, or null. */
export function pickRecorderMime(isSupported: (mime: string) => boolean, audio: boolean): string | null {
  for (const m of recorderMimes(audio)) {
    try {
      if (isSupported(m)) return m;
    } catch {
      // a throwing isTypeSupported counts as unsupported
    }
  }
  return null;
}

/** File extension for a recorder mime ("mp4" or "webm"). */
export function extForMime(mime: string): "mp4" | "webm" {
  return /^video\/mp4/i.test(mime) ? "mp4" : "webm";
}

/** Recording progress 0..RECORD_SHARE from the playhead inside [start, end]. */
export function recordProgress(t: number, start: number, end: number): number {
  const len = end - start;
  if (!(len > 0) || !Number.isFinite(t)) return 0;
  return Math.min(1, Math.max(0, (t - start) / len)) * RECORD_SHARE;
}

/** Overall progress during the remux step (p = remux fraction 0..1). */
export function remuxProgress(p: number): number {
  return RECORD_SHARE + (1 - RECORD_SHARE) * Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
}

/** Video bitrate for a w x h recording: about 4 bits per pixel per second, 1..40 Mb/s (same rule as editor.rs). */
export function bitrateFor(w: number, h: number): number {
  return Math.min(40_000_000, Math.max(1_000_000, Math.round(w * h * 4)));
}

const near = (a: number, b: number) => Math.abs(a - b) <= 0.02 * Math.max(a, b);

/**
 * Canvas transform [a, b, c, d, e, f] (ctx.setTransform order) that draws the video, at its intrinsic size
 * `natW` x `natH` placed at 0,0, so the crop (in probe display pixels) lands at the canvas origin.
 * Handles an intrinsic size that differs from the probe (scale) and a webview that did not apply a 90/270
 * rotation (intrinsic size swapped against the probe).
 */
export function drawMatrix(crop: CropRect, probe: MediaProbe, natW: number, natH: number): [number, number, number, number, number, number] {
  const pw = probe.width;
  const ph = probe.height;
  const w = natW > 0 ? natW : pw;
  const h = natH > 0 ? natH : ph;
  const swapped = (probe.rotation === 90 || probe.rotation === 270) && w !== h && !near(w / h, pw / ph) && near(w / h, ph / pw);
  if (!swapped) {
    return [pw / w, 0, 0, ph / h, -crop.x, -crop.y];
  }
  // Display is the raw frame rotated; then scaled to the probe size.
  const kx = pw / h;
  const ky = ph / w;
  if (probe.rotation === 90) return [0, ky, -kx, 0, kx * h - crop.x, -crop.y];
  return [0, -ky, kx, 0, -crop.x, ky * w - crop.y];
}

/** Diagnostics line for the dev console and error details: recorder pieces and the format it would pick. */
export function webCropInfo(audio: boolean): string {
  const rec = typeof MediaRecorder;
  const cap = typeof HTMLCanvasElement === "function" ? typeof HTMLCanvasElement.prototype.captureStream : "no-canvas";
  let mime = "n/a";
  if (rec === "function") {
    try {
      mime = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m), audio) ?? "none";
    } catch (e) {
      mime = `threw(${e instanceof Error ? e.message : String(e)})`;
    }
  }
  return `MediaRecorder=${rec} captureStream=${cap} document=${typeof document} mime=${mime}`;
}

/** True when this webview can record a cropped video (MediaRecorder + canvas capture). */
export function webCropSupported(): boolean {
  return (
    typeof MediaRecorder === "function" &&
    typeof HTMLCanvasElement === "function" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    typeof document === "object"
  );
}

export interface WebCropJob {
  /** Source URL the webview can play with CORS (asset protocol sends Access-Control-Allow-Origin). */
  url: string;
  probe: MediaProbe;
  /** Even display-pixel crop; undefined = whole frame. */
  crop?: CropRect;
  /** Seconds. */
  start: number;
  end: number;
  audio: boolean;
  onProgress: (fraction: number) => void;
  /** Receives recorded chunks in order; awaited before the promise resolves. */
  onData: (chunk: Uint8Array) => Promise<void>;
  signal?: AbortSignal;
}

export interface WebCropResult {
  mime: string;
  ext: "mp4" | "webm";
  /** The recording has an audio track. */
  hasAudio: boolean;
}

type CaptureVideo = HTMLVideoElement & { captureStream?: () => MediaStream };
type FrameVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (h: number) => void };

const cancelledErr = () => new EditorError("cancelled", "Export cancelled.");

/** Waits for `ok` on `el`; rejects on its error event, on abort, or after `ms` without the event. */
function once(el: EventTarget, ok: string, signal?: AbortSignal, ms = STALL_MS): Promise<void> {
  return new Promise<void>((res, rej) => {
    if (signal?.aborted) {
      rej(cancelledErr());
      return;
    }
    const timer = setTimeout(() => {
      done();
      rej(new EditorError("export_failed", "The video took too long to load for recording."));
    }, ms);
    const done = () => {
      clearTimeout(timer);
      el.removeEventListener(ok, onOk);
      el.removeEventListener("error", onErr);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOk = () => {
      done();
      res();
    };
    const onErr = () => {
      done();
      rej(new EditorError("unsupported", "Keepsake can't play this video here, so it can't be cropped without a full ffmpeg."));
    };
    const onAbort = () => {
      done();
      rej(cancelledErr());
    };
    el.addEventListener(ok, onOk);
    el.addEventListener("error", onErr);
    signal?.addEventListener("abort", onAbort);
  });
}

/** Records the cropped, trimmed clip in real time. Rejects with EditorError (cancelled on abort). */
export async function recordWebCrop(job: WebCropJob): Promise<WebCropResult> {
  if (!webCropSupported()) throw new EditorError("unsupported", "This system can't record video in the app, so it can't crop without a full ffmpeg.");
  const { probe, signal } = job;
  if (signal?.aborted) throw cancelledErr();
  const crop = job.crop ?? { x: 0, y: 0, w: probe.width - (probe.width % 2), h: probe.height - (probe.height % 2) };

  const video = document.createElement("video") as FrameVideo & CaptureVideo;
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  video.playsInline = true;
  video.muted = !job.audio;
  // Kept in the document (tiny and almost transparent) so the webview keeps decoding and presenting frames.
  video.setAttribute("aria-hidden", "true");
  video.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1";
  const canvas = document.createElement("canvas");
  canvas.width = crop.w;
  canvas.height = crop.h;

  let audioCtx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let frameHandle = 0;
  let rafHandle = 0;
  let stallTimer: ReturnType<typeof setInterval> | undefined;
  /** Set once cleanup starts: late recorder chunks are dropped instead of written to a closing file. */
  let closed = false;
  // A missing duration (0) must not end the recording at once: then only the `ended` event stops it.
  const end = job.end > job.start ? job.end : Number.POSITIVE_INFINITY;

  const cleanup = () => {
    closed = true;
    if (frameHandle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
    if (rafHandle) cancelAnimationFrame(rafHandle);
    clearInterval(stallTimer);
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch {
      // already stopped
    }
    stream?.getTracks().forEach((t) => t.stop());
    void audioCtx?.close().catch(() => undefined);
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
  };

  try {
    document.body.append(video);
    video.src = job.url;
    await once(video, "loadedmetadata", signal);
    if (job.start > 0) {
      video.currentTime = job.start;
      await once(video, "seeked", signal);
    } else if (video.readyState < 2) {
      // Already at 0: some players fire no `seeked` for an unchanged position, so wait for the first frame instead.
      await once(video, "loadeddata", signal);
    }

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new EditorError("unsupported", "Canvas drawing is not available.");
    const m = drawMatrix(crop, probe, video.videoWidth, video.videoHeight);
    const draw = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, crop.w, crop.h);
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.drawImage(video, 0, 0, video.videoWidth || probe.width, video.videoHeight || probe.height);
    };
    draw();

    const tracks: MediaStreamTrack[] = [...canvas.captureStream(CAPTURE_FPS).getVideoTracks()];
    if (job.audio) {
      const AC = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      if (AC) {
        const ac = new AC();
        audioCtx = ac;
        // A context the webview will not start (autoplay policy) would record silence: check before routing.
        if (ac.state !== "running") {
          await Promise.race([ac.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
        }
        if ((ac.state as string) !== "running") {
          void ac.close().catch(() => undefined);
          audioCtx = null;
        }
      }
      if (audioCtx) {
        // Routed only into the recorder, so playback is silent for the user.
        const src = audioCtx.createMediaElementSource(video);
        const dest = audioCtx.createMediaStreamDestination();
        src.connect(dest);
        tracks.push(...dest.stream.getAudioTracks());
      } else if (typeof video.captureStream === "function") {
        tracks.push(...video.captureStream().getAudioTracks());
      }
    }
    if (signal?.aborted) throw cancelledErr();
    const hasAudio = tracks.some((t) => t.kind === "audio");
    stream = new MediaStream(tracks);

    const mime = pickRecorderMime((t) => MediaRecorder.isTypeSupported(t), hasAudio);
    if (!mime) throw new EditorError("unsupported", "This system can't record MP4 or WebM video.");
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: bitrateFor(crop.w, crop.h),
      ...(hasAudio ? { audioBitsPerSecond: 160_000 } : {}),
    });
    recorder = rec;

    // Chunks are written strictly in order.
    let writes: Promise<void> = Promise.resolve();
    let writeError: unknown = null;
    rec.addEventListener("dataavailable", (ev: BlobEvent) => {
      if (closed || !ev.data || ev.data.size === 0) return;
      const blob = ev.data;
      writes = writes.then(async () => {
        if (writeError) return;
        try {
          await job.onData(new Uint8Array(await blob.arrayBuffer()));
        } catch (e) {
          writeError = e;
        }
      });
    });

    const finished = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (err) {
          reject(err);
          return;
        }
        video.pause();
        // Already stopped on its own (e.g. its tracks ended): `stop` has fired, so waiting for it would hang.
        if (rec.state === "inactive") {
          resolve();
          return;
        }
        rec.addEventListener("stop", () => resolve(), { once: true });
        try {
          rec.stop();
        } catch {
          resolve();
        }
      };
      const onAbort = () => finish(cancelledErr());
      signal?.addEventListener("abort", onAbort, { once: true });
      rec.addEventListener("error", () => finish(new EditorError("export_failed", "Recording failed.")), { once: true });
      video.addEventListener("error", () => finish(new EditorError("export_failed", "Playback failed while recording.")), { once: true });
      video.addEventListener("ended", () => finish(), { once: true });

      let lastT = -1;
      let lastMove = Date.now();
      const onFrame = () => {
        if (settled) return;
        const t = video.currentTime;
        if (t >= end - 0.001) {
          finish();
          return;
        }
        draw();
        job.onProgress(recordProgress(t, job.start, end));
        if (t !== lastT) {
          lastT = t;
          lastMove = Date.now();
        }
        schedule();
      };
      const schedule = () => {
        if (video.requestVideoFrameCallback) frameHandle = video.requestVideoFrameCallback(onFrame);
        else rafHandle = requestAnimationFrame(onFrame);
      };
      // rVFC only fires on new frames; this also catches the end when the last frame never repeats.
      stallTimer = setInterval(() => {
        if (settled) return;
        if (video.currentTime >= end - 0.001) finish();
        else if (Date.now() - lastMove > STALL_MS) finish(new EditorError("export_failed", "Playback stopped while recording. Keep Keepsake open and try again."));
      }, 250);

      rec.start(1000);
      schedule();
      video.play().catch((e: unknown) => finish(new EditorError("export_failed", `The video could not play for recording (${e instanceof Error ? e.message : String(e)}).`)));
    });

    await finished;
    await writes;
    if (writeError) throw writeError;
    if (signal?.aborted) throw cancelledErr();
    job.onProgress(RECORD_SHARE);
    return { mime, ext: extForMime(mime), hasAudio };
  } finally {
    cleanup();
  }
}
