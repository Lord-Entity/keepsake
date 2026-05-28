/**
 * In-app video crop/trim/mute without any ffmpeg encoder: WebCodecs in the webview (WebView2 uses the Windows
 * Media Foundation H.264 encoder, hardware when present; WebKitGTK may or may not expose WebCodecs).
 *   mp4 bytes -> mp4-demux.ts -> VideoDecoder -> crop/rotate on a canvas -> VideoEncoder (H.264, avc format)
 *   -> mp4-mux.ts. Audio packets are copied unchanged (their sample entry too): no audio re-encode, no AAC encoder.
 * Faster than real time: nothing plays, frames are decoded and encoded as fast as the codecs go.
 * The caller (engine-desktop.ts) hands in a non-fragmented .mp4 (the bundled ffmpeg's stream-copy output, or the
 * source itself) and writes the returned chunks to disk. Pure helpers are exported for tests.
 */
import { FLUSH_BYTES, Mp4Muxer, avc1Entry, ticks } from "./mp4-mux";
import { parseMp4, sampleTime, type Mp4Sample, type Mp4Track } from "./mp4-demux";
import type { CropRect, MediaProbe } from "./types";
import { EditorError } from "./types";

/** Output video timescale (ticks per second). */
export const VIDEO_TIMESCALE = 90_000;
/** A keyframe at least this often (microseconds). */
const KEY_EVERY_US = 2_000_000;
/** Codec queues are kept below this many items (bounds memory; decoders have small frame pools). */
const MAX_QUEUE = 8;

const unsupported = (why: string) => new EditorError("unsupported", why);
const cancelledErr = () => new EditorError("cancelled", "Export cancelled.");

/** H.264 levels: [level_idc, MaxFS (macroblocks), MaxMBPS]. ITU-T H.264 Table A-1. */
const AVC_LEVELS: readonly [number, number, number][] = [
  [0x1f, 3600, 108_000], // 3.1
  [0x20, 5120, 216_000], // 3.2
  [0x28, 8192, 245_760], // 4.0
  [0x2a, 8704, 522_240], // 4.2
  [0x32, 22_080, 589_824], // 5.0
  [0x33, 36_864, 983_040], // 5.1
  [0x34, 36_864, 2_073_600], // 5.2
  [0x3c, 139_264, 4_177_920], // 6.0
  [0x3e, 139_264, 16_711_680], // 6.2
];

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/**
 * H.264 codec strings to try for a w x h stream at `fps`, best first: High, Main, Constrained Baseline, each at the
 * smallest level that fits the frame size (and width/height <= sqrt(8 * MaxFS) macroblocks) and rate, plus the next
 * level up (some encoders refuse the tightest fit).
 */
export function avcCandidates(w: number, h: number, fps: number): string[] {
  const mbw = Math.ceil(w / 16);
  const mbh = Math.ceil(h / 16);
  const fs = mbw * mbh;
  const mbps = fs * Math.max(1, fps);
  const fit = AVC_LEVELS.findIndex(([, maxFs, maxMbps]) => fs <= maxFs && mbps <= maxMbps && Math.max(mbw, mbh) <= Math.sqrt(8 * maxFs));
  const from = fit < 0 ? AVC_LEVELS.length - 1 : fit;
  const levels = AVC_LEVELS.slice(from, from + 2).map(([l]) => l);
  const out: string[] = [];
  for (const profile of ["6400", "4d00", "42e0"]) for (const l of levels) out.push(`avc1.${profile}${hex2(l)}`);
  return out;
}

/** Video bitrate: about 4 bits per pixel per second at 30 fps, scaled by fps, 1..40 Mb/s (same rule as editor.rs). */
export function videoBitrate(w: number, h: number, fps: number): number {
  return Math.min(40_000_000, Math.max(1_000_000, Math.round(w * h * 4 * Math.min(2, Math.max(0.5, fps / 30)))));
}

/** Average frame rate of a track (samples per second), 30 when unknown; clamped to 1..240. */
export function trackFps(t: Mp4Track): number {
  const first = t.samples[0];
  const last = t.samples[t.samples.length - 1];
  if (!first || !last || t.samples.length < 2) return 30;
  const span = (last.dts + last.duration - first.dts) / t.timescale;
  const fps = span > 0 ? t.samples.length / span : 30;
  return Math.min(240, Math.max(1, Number.isFinite(fps) ? fps : 30));
}

/**
 * Canvas transform [a, b, c, d, e, f] (setTransform order) that draws a decoded, UNROTATED frame of rawW x rawH at
 * 0,0 so that the display picture (frame rotated `rotation` degrees clockwise, then scaled to the probe size pw x ph)
 * has the crop's top-left at the canvas origin. X = a*u + c*v + e, Y = b*u + d*v + f for a raw pixel (u, v).
 */
export function frameMatrix(crop: CropRect, pw: number, ph: number, rotation: number, rawW: number, rawH: number): [number, number, number, number, number, number] {
  const turned = rotation === 90 || rotation === 270;
  const kx = pw / (turned ? rawH : rawW);
  const ky = ph / (turned ? rawW : rawH);
  // rotate 90 cw: (u, v) -> (rawH - v, u); 180: (rawW - u, rawH - v); 270 cw: (v, rawW - u).
  if (rotation === 90) return [0, ky, -kx, 0, kx * rawH - crop.x, -crop.y];
  if (rotation === 180) return [-kx, 0, 0, -ky, kx * rawW - crop.x, ky * rawH - crop.y];
  if (rotation === 270) return [0, -ky, kx, 0, -crop.x, ky * rawW - crop.y];
  return [kx, 0, 0, ky, -crop.x, -crop.y];
}

/** Progress 0..1 of the encode step from the last encoded frame time (microseconds) inside [t0, end). */
export function encodeProgress(tUs: number, t0Us: number, endUs: number): number {
  const len = endUs - t0Us;
  if (!(len > 0) || !Number.isFinite(tUs)) return 0;
  return Math.min(1, Math.max(0, (tUs - t0Us) / len));
}

/**
 * Index of the sync sample to start decoding at for `start` seconds: the last sync sample presented at or before it
 * (the first sample when none is). Samples are in decode order.
 */
export function decodeStart(track: Mp4Track, start: number): number {
  let k = 0;
  track.samples.forEach((s, i) => {
    if (s.sync && sampleTime(track, s) <= start + 1e-6) k = i;
  });
  return k;
}

/**
 * Index one past the last sample to feed so that every frame presented before `end` seconds is decoded: stop where
 * every later sample (in decode order) is presented at or after `end`.
 */
export function decodeEnd(track: Mp4Track, end: number): number {
  const s = track.samples;
  let i = s.length;
  // Walk back while the suffix minimum stays >= end.
  while (i > 0) {
    const prev = s[i - 1];
    if (!prev || sampleTime(track, prev) < end) break;
    i--;
  }
  return i;
}

/** Audio samples overlapping [t0, end) seconds, in order. */
export function audioRange(track: Mp4Track, t0: number, end: number): Mp4Sample[] {
  return track.samples.filter((s) => {
    const a = sampleTime(track, s);
    const b = a + s.duration / track.timescale;
    return b > t0 + 1e-6 && a < end - 1e-6;
  });
}

/** True when this webview has the WebCodecs pieces this module uses (no codec check yet). */
export function webCodecsPresent(): boolean {
  return (
    typeof VideoEncoder === "function" &&
    typeof VideoDecoder === "function" &&
    typeof VideoFrame === "function" &&
    (typeof OffscreenCanvas === "function" || typeof document === "object")
  );
}

let encoderCheck: Promise<{ ok: boolean; info: string }> | null = null;

/** Present-check text for diagnostics, e.g. "VideoEncoder=function VideoDecoder=function VideoFrame=function". */
function presentInfo(): string {
  return `VideoEncoder=${typeof VideoEncoder} VideoDecoder=${typeof VideoDecoder} VideoFrame=${typeof VideoFrame} OffscreenCanvas=${typeof OffscreenCanvas}`;
}

/**
 * H.264 encoder probe (checked once at 1280x720, then cached): `ok` plus a short line for the dev console and the
 * error details, e.g. "VideoEncoder=function ... avc1.64001F=no avc1.4D401F=yes".
 */
export function webCodecsEncoderProbe(): Promise<{ ok: boolean; info: string }> {
  if (!webCodecsPresent()) return Promise.resolve({ ok: false, info: presentInfo() });
  encoderCheck ??= (async () => {
    const seen: string[] = [];
    for (const codec of avcCandidates(1280, 720, 30)) {
      try {
        const r = await VideoEncoder.isConfigSupported({ codec, width: 1280, height: 720, bitrate: 4_000_000, framerate: 30, avc: { format: "avc" } });
        seen.push(`${codec}=${r.supported ? "yes" : "no"}`);
        if (r.supported) return { ok: true, info: `${presentInfo()} ${seen.join(" ")}` };
      } catch (e) {
        seen.push(`${codec}=threw(${e instanceof Error ? e.message : String(e)})`);
      }
    }
    return { ok: false, info: `${presentInfo()} ${seen.join(" ")}` };
  })();
  return encoderCheck;
}

/** True when an H.264 encoder is available (cached probe, see webCodecsEncoderProbe). */
export function webCodecsCanEncode(): Promise<boolean> {
  return webCodecsEncoderProbe().then((p) => p.ok);
}

async function pickEncoderConfig(w: number, h: number, fps: number): Promise<VideoEncoderConfig> {
  const base = { width: w, height: h, bitrate: videoBitrate(w, h, fps), framerate: fps, avc: { format: "avc" as const } };
  for (const codec of avcCandidates(w, h, fps)) {
    try {
      const r = await VideoEncoder.isConfigSupported({ ...base, codec });
      if (r.supported) return { ...base, codec };
    } catch {
      // next
    }
  }
  throw unsupported(`This system's built-in H.264 encoder (WebCodecs) can't encode ${w}x${h} video.`);
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Canvas2D } {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (ctx) return { canvas, ctx };
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw unsupported("Canvas drawing is not available.");
  return { canvas, ctx };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface WebCodecsJob {
  /** The whole .mp4 file. */
  bytes: Uint8Array;
  probe: MediaProbe;
  /** Even crop in probe (display) pixels; undefined = whole frame. */
  crop?: CropRect;
  /** Seconds. */
  start: number;
  end: number;
  audio: boolean;
  onProgress: (fraction: number) => void;
  /** Receives the output file bytes in order; awaited. */
  write: (chunk: Uint8Array) => Promise<void>;
  signal?: AbortSignal;
}

/** Crops/trims/mutes `job.bytes` into a new .mp4 streamed to `job.write`. Rejects with EditorError. */
export async function transcodeWebCodecs(job: WebCodecsJob): Promise<{ hasAudio: boolean }> {
  if (!webCodecsPresent()) throw unsupported("This system's web engine has no WebCodecs video encoder.");
  const { probe, signal } = job;
  if (signal?.aborted) throw cancelledErr();
  let file: ReturnType<typeof parseMp4>;
  try {
    file = parseMp4(job.bytes);
  } catch (e) {
    throw unsupported(`Keepsake can't read this video's MP4 structure (${e instanceof Error ? e.message : String(e)}).`);
  }
  const v = file.tracks.find((t) => t.type === "video" && t.samples.length > 0);
  if (!v) throw unsupported("The file has no video track.");
  if (!v.codec) throw unsupported(`This video's codec (${v.fourcc}) can't be decoded in the app.`);
  const decConfig: VideoDecoderConfig = { codec: v.codec, codedWidth: v.width, codedHeight: v.height, ...(v.description ? { description: v.description } : {}) };
  const ds = await VideoDecoder.isConfigSupported(decConfig).catch(() => ({ supported: false }));
  if (!ds.supported) throw unsupported(`This system can't decode ${v.codec} video in the app.`);

  const crop = job.crop ?? { x: 0, y: 0, w: probe.width - (probe.width % 2), h: probe.height - (probe.height % 2) };
  const outW = crop.w;
  const outH = crop.h;
  const fps = trackFps(v);
  const encConfig = await pickEncoderConfig(outW, outH, fps);
  const a = job.audio ? file.tracks.find((t) => t.type === "audio" && t.samples.length > 0) : undefined;

  const startUs = Math.round(job.start * 1e6);
  const endUs = Math.round(job.end * 1e6);
  const first = decodeStart(v, job.start);
  const stop = decodeEnd(v, job.end);
  if (stop <= first) throw new EditorError("export_failed", "The trimmed range has no video frames.");

  const mux = new Mp4Muxer([{ kind: "video", timescale: VIDEO_TIMESCALE, width: outW, height: outH }, ...(a ? [{ kind: "audio" as const, timescale: a.timescale, sampleEntry: a.sampleEntry }] : [])]);
  const { canvas, ctx } = makeCanvas(outW, outH);
  let failure: unknown = null;
  const fail = (e: unknown) => {
    failure ??= e;
  };
  let t0Us = -1;
  let lastKeyUs = -Infinity;
  let lastOutUs = 0;
  let gotConfig = false;
  // Audio is interleaved by time and copied as is.
  const audioSamples: Mp4Sample[] = [];
  let audioNext = 0;
  let audioBase = 0;
  const addAudioUntil = (us: number) => {
    if (!a) return;
    while (audioNext < audioSamples.length) {
      const s = audioSamples[audioNext];
      if (!s || sampleTime(a, s) * 1e6 > us) break;
      // pts relative to the first copied sample, so output audio starts at 0 like the video.
      mux.add(1, job.bytes.subarray(s.offset, s.offset + s.size), s.cts - audioBase, true);
      audioNext++;
    }
  };

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        const desc = meta?.decoderConfig?.description;
        if (desc && !gotConfig) {
          const bytes = ArrayBuffer.isView(desc) ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength).slice() : new Uint8Array(desc).slice();
          // avc1 width/height are the display size; the coded size (e.g. 1088 rows) is in the SPS.
          mux.setSampleEntry(0, avc1Entry(outW, outH, bytes), outW, outH);
          gotConfig = true;
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        addAudioUntil(chunk.timestamp + t0Us);
        mux.add(0, data, ticks(chunk.timestamp, VIDEO_TIMESCALE), chunk.type === "key");
        if (chunk.duration) mux.setLastDuration(0, ticks(chunk.duration, VIDEO_TIMESCALE));
        lastOutUs = chunk.timestamp + t0Us;
      } catch (e) {
        fail(e);
      }
    },
    error: (e) => fail(e),
  });
  encoder.configure(encConfig);

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const ts = frame.timestamp;
        if (failure || ts < startUs - 500 || ts >= endUs) return;
        if (t0Us < 0) {
          t0Us = ts;
          if (a) {
            audioSamples.push(...audioRange(a, ts / 1e6, job.end));
            audioBase = audioSamples[0]?.cts ?? 0;
          }
        }
        const m = frameMatrix(crop, probe.width, probe.height, v.rotation, frame.displayWidth, frame.displayHeight);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, outW, outH);
        ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
        ctx.drawImage(frame, 0, 0, frame.displayWidth, frame.displayHeight);
        const rel = ts - t0Us;
        const out = new VideoFrame(canvas, { timestamp: rel, ...(frame.duration ? { duration: frame.duration } : {}) });
        const key = rel - lastKeyUs >= KEY_EVERY_US;
        if (key) lastKeyUs = rel;
        try {
          encoder.encode(out, { keyFrame: key });
        } finally {
          out.close();
        }
      } catch (e) {
        fail(e);
      } finally {
        frame.close();
      }
    },
    error: (e) => fail(e),
  });

  const closeAll = () => {
    for (const c of [decoder, encoder]) {
      try {
        if (c.state !== "closed") c.close();
      } catch {
        // already closed
      }
    }
  };

  const check = () => {
    if (signal?.aborted) throw cancelledErr();
    if (failure) throw failure instanceof EditorError ? failure : new EditorError("export_failed", `In-app encoding failed: ${failure instanceof Error ? failure.message : String(failure)}`);
  };

  try {
    await job.write(mux.start());
    decoder.configure(decConfig);
    for (let i = first; i < stop; i++) {
      check();
      while (decoder.decodeQueueSize > MAX_QUEUE || encoder.encodeQueueSize > MAX_QUEUE) {
        await sleep(2);
        check();
      }
      const s = v.samples[i];
      if (!s) break;
      decoder.decode(
        new EncodedVideoChunk({
          type: i === first || s.sync ? "key" : "delta",
          timestamp: Math.round(sampleTime(v, s) * 1e6),
          duration: Math.round((s.duration / v.timescale) * 1e6),
          data: job.bytes.subarray(s.offset, s.offset + s.size),
        }),
      );
      if (mux.pendingBytes >= FLUSH_BYTES) {
        const b = mux.flush();
        if (b) await job.write(b);
      }
      if (t0Us >= 0) job.onProgress(encodeProgress(lastOutUs, t0Us, endUs));
    }
    await decoder.flush();
    check();
    await encoder.flush();
    check();
    if (t0Us < 0 || mux.tracks[0]?.samples.length === 0) throw new EditorError("export_failed", "No video frames were decoded in the trimmed range.");
    if (!gotConfig) throw new EditorError("export_failed", "The H.264 encoder gave no stream header (avcC).");
    addAudioUntil(Number.POSITIVE_INFINITY);
    await job.write(mux.finish());
    job.onProgress(1);
    return { hasAudio: (mux.tracks[1]?.samples.length ?? 0) > 0 };
  } catch (e) {
    // decode()/encode()/flush() throw DOMExceptions once a codec has failed: report the first real cause.
    if (signal?.aborted) throw cancelledErr();
    const err = failure ?? e;
    throw err instanceof EditorError ? err : new EditorError("export_failed", `In-app encoding failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    closeAll();
  }
}
