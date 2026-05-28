/**
 * Minimal MP4 (ISO BMFF, non-fragmented) writer for the in-app video encoder (engine-webcodecs.ts).
 * Layout: ftyp, then one or more mdat boxes (one per flush, so nothing needs a seek), then moov at the end.
 * Every sample is its own chunk (stsc = 1 sample per chunk, one stco/co64 entry per sample): simple and valid.
 * Timing: samples are added in decode order with a presentation time (pts, track ticks). At finish the decode times
 * are the sorted pts (made strictly increasing; stts implies the first dts is 0, so a reader sees pts - first pts);
 * pts - dts goes into ctts (version 1 when
 * an offset is negative). Encoders without B-frames give pts in decode order, so then there is no ctts at all.
 * Pure: no IO, no DOM. The caller writes the bytes start(), flush() and finish() return, in that order.
 * References: ISO/IEC 14496-12 (boxes), 14496-14 (esds), 14496-15 (avcC is passed through as the encoder gave it).
 */

export type Bytes = Uint8Array<ArrayBuffer>;

const U32_MAX = 0xffff_ffff;
const TWO_32 = 0x1_0000_0000;

export function concat(parts: readonly Uint8Array[]): Bytes {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function int(v: number, name: string, max: number): number {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new RangeError(`mp4: ${name} out of range: ${v}`);
  return v;
}

export const u8 = (v: number): Bytes => Uint8Array.of(int(v, "u8", 0xff));
export const u16 = (v: number): Bytes => Uint8Array.of(int(v, "u16", 0xffff) >> 8, v & 0xff);
export const u24 = (v: number): Bytes => Uint8Array.of(int(v, "u24", 0xff_ffff) >> 16, (v >> 8) & 0xff, v & 0xff);
export function u32(v: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, int(v, "u32", U32_MAX));
  return b;
}
export function i32(v: number): Bytes {
  if (!Number.isInteger(v) || v < -0x8000_0000 || v > 0x7fff_ffff) throw new RangeError(`mp4: i32 out of range: ${v}`);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v);
  return b;
}
export function u64(v: number): Bytes {
  int(v, "u64", Number.MAX_SAFE_INTEGER);
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, Math.floor(v / TWO_32));
  dv.setUint32(4, v % TWO_32);
  return b;
}
const zeros = (n: number): Bytes => new Uint8Array(n);

function fourcc(type: string): Bytes {
  if (!/^[\x20-\x7e]{4}$/.test(type)) throw new RangeError(`mp4: bad box type ${JSON.stringify(type)}`);
  return Uint8Array.from(type, (c) => c.charCodeAt(0));
}

/** `size type payload...` with a 32-bit size. */
export function box(type: string, ...parts: Uint8Array[]): Bytes {
  let n = 8;
  for (const p of parts) n += p.length;
  return concat([u32(n), fourcc(type), ...parts]);
}

/** Full box: version (8 bits) and flags (24 bits) before the payload. */
export function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Bytes {
  return box(type, u8(version), u24(flags), ...parts);
}

/** 8-byte mdat header for `payload` bytes of samples that follow it. */
export function mdatHeader(payload: number): Bytes {
  return concat([u32(int(payload + 8, "mdat size", U32_MAX)), fourcc("mdat")]);
}

export function ftyp(): Bytes {
  return box("ftyp", fourcc("isom"), u32(0x200), fourcc("isom"), fourcc("iso2"), fourcc("avc1"), fourcc("mp41"));
}

const MATRIX = concat([u32(0x0001_0000), u32(0), u32(0), u32(0), u32(0x0001_0000), u32(0), u32(0), u32(0), u32(0x4000_0000)]);

// ---------------- sample entries ----------------

/** `avc1` visual sample entry around the avcC record (AVCDecoderConfigurationRecord) the encoder produced. */
export function avc1Entry(width: number, height: number, avcC: Uint8Array): Bytes {
  const name = zeros(32); // compressorname: empty Pascal string
  return box(
    "avc1",
    zeros(6), // reserved
    u16(1), // data_reference_index
    u16(0), // pre_defined
    u16(0), // reserved
    zeros(12), // pre_defined
    u16(width),
    u16(height),
    u32(0x0048_0000), // 72 dpi
    u32(0x0048_0000),
    u32(0), // reserved
    u16(1), // frame_count
    name,
    u16(0x0018), // depth
    Uint8Array.of(0xff, 0xff), // pre_defined = -1
    box("avcC", avcC),
  );
}

/** MPEG-4 descriptor length in the expandable form (7 bits per byte, high bit = more bytes follow). */
export function descriptorLength(n: number): Bytes {
  int(n, "descriptor length", 0x0fff_ffff);
  const out: number[] = [n & 0x7f];
  for (let v = n >> 7; v > 0; v >>= 7) out.unshift((v & 0x7f) | 0x80);
  return Uint8Array.from(out);
}

const descriptor = (tag: number, ...parts: Uint8Array[]): Bytes => {
  const body = concat(parts);
  return concat([u8(tag), descriptorLength(body.length), body]);
};

/** `esds` for AAC: ES_Descriptor > DecoderConfigDescriptor (OTI 0x40, audio stream) > DecoderSpecificInfo (the ASC). */
export function esds(asc: Uint8Array, avgBitrate = 0, maxBitrate = 0): Bytes {
  const dcd = descriptor(
    0x04,
    u8(0x40), // objectTypeIndication: MPEG-4 Audio
    u8((0x05 << 2) | 1), // streamType audio, upStream 0, reserved 1
    u24(0), // bufferSizeDB
    u32(maxBitrate),
    u32(avgBitrate),
    descriptor(0x05, asc),
  );
  const es = descriptor(0x03, u16(0), u8(0), dcd, descriptor(0x06, u8(0x02)));
  return fullBox("esds", 0, 0, es);
}

/** `mp4a` audio sample entry for AAC with the AudioSpecificConfig `asc`. */
export function mp4aEntry(channels: number, sampleRate: number, asc: Uint8Array, avgBitrate = 0): Bytes {
  return box(
    "mp4a",
    zeros(6),
    u16(1), // data_reference_index
    zeros(8), // reserved
    u16(channels),
    u16(16), // samplesize
    u16(0), // pre_defined
    u16(0), // reserved
    u32(sampleRate > 0 && sampleRate < 0x1_0000 ? sampleRate * 0x1_0000 : 0), // 16.16; 0 when it does not fit
    esds(asc, avgBitrate, avgBitrate),
  );
}

// ---------------- timing ----------------

/** Microseconds -> track ticks (rounded). */
export function ticks(us: number, timescale: number): number {
  return Math.round((us * timescale) / 1_000_000);
}

export interface Timing {
  /** stts: decode-time delta of every sample (the last one is `lastDuration` or the previous delta). */
  deltas: number[];
  /** ctts: pts - dts of every sample. All 0 when pts is already in decode order. */
  offsets: number[];
}

/**
 * Decode deltas and composition offsets for samples in decode order with presentation times `pts` (ticks).
 * dts = sorted pts, forced strictly increasing (a repeated pts gets +1 tick), so every delta is >= 1.
 */
export function timing(pts: readonly number[], lastDuration?: number): Timing {
  const n = pts.length;
  const sorted = pts.toSorted((a, b) => a - b);
  const dts: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = sorted[i] ?? 0;
    const prev = dts[i - 1];
    dts.push(prev === undefined ? s : Math.max(s, prev + 1));
  }
  const deltas: number[] = [];
  for (let i = 0; i + 1 < n; i++) deltas.push((dts[i + 1] ?? 0) - (dts[i] ?? 0));
  if (n > 0) {
    const last = lastDuration !== undefined && Number.isFinite(lastDuration) && lastDuration >= 1 ? Math.round(lastDuration) : (deltas[n - 2] ?? 1);
    deltas.push(last);
  }
  const offsets = pts.map((p, i) => p - (dts[i] ?? 0));
  return { deltas, offsets };
}

/** Run-length pairs [count, value]. */
export function runs(values: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0]++;
    else out.push([1, v]);
  }
  return out;
}

// ---------------- moov ----------------

export interface MuxSample {
  /** Absolute file offset. */
  offset: number;
  size: number;
  /** Presentation time in track ticks. */
  pts: number;
  sync: boolean;
}

export interface MuxTrack {
  kind: "video" | "audio";
  timescale: number;
  /** Complete sample entry box (avc1Entry, mp4aEntry, or one copied from a source file). */
  sampleEntry?: Uint8Array;
  /** Display size of a video track (tkhd). */
  width: number;
  height: number;
  /** Duration of the last sample in ticks (default: the delta before it). */
  lastDuration?: number;
  samples: MuxSample[];
}

const fits32 = (v: number) => v <= U32_MAX;

function stbl(t: MuxTrack, tm: Timing): Bytes {
  const s = t.samples;
  const parts: Uint8Array[] = [fullBox("stsd", 0, 0, u32(1), t.sampleEntry ?? new Uint8Array(0))];
  const stts = runs(tm.deltas);
  parts.push(fullBox("stts", 0, 0, u32(stts.length), ...stts.flatMap(([c, d]) => [u32(c), u32(d)])));
  if (tm.offsets.some((o) => o !== 0)) {
    const neg = tm.offsets.some((o) => o < 0);
    const r = runs(tm.offsets);
    parts.push(fullBox("ctts", neg ? 1 : 0, 0, u32(r.length), ...r.flatMap(([c, o]) => [u32(c), neg ? i32(o) : u32(o)])));
  }
  if (s.some((x) => !x.sync)) {
    const sync: Bytes[] = [];
    s.forEach((x, i) => {
      if (x.sync) sync.push(u32(i + 1));
    });
    parts.push(fullBox("stss", 0, 0, u32(sync.length), ...sync));
  }
  const first = s[0]?.size ?? 0;
  const uniform = s.every((x) => x.size === first);
  parts.push(uniform ? fullBox("stsz", 0, 0, u32(first), u32(s.length)) : fullBox("stsz", 0, 0, u32(0), u32(s.length), ...s.map((x) => u32(x.size))));
  parts.push(fullBox("stsc", 0, 0, u32(1), u32(1), u32(1), u32(1)));
  const big = s.some((x) => !fits32(x.offset));
  parts.push(big ? fullBox("co64", 0, 0, u32(s.length), ...s.map((x) => u64(x.offset))) : fullBox("stco", 0, 0, u32(s.length), ...s.map((x) => u32(x.offset))));
  return box("stbl", ...parts);
}

function trak(t: MuxTrack, id: number, movieTimescale: number): { trak: Bytes; movieDuration: number } {
  const tm = timing(
    t.samples.map((x) => x.pts),
    t.lastDuration,
  );
  const mediaDuration = tm.deltas.reduce((a, b) => a + b, 0);
  const movieDuration = Math.round((mediaDuration * movieTimescale) / t.timescale);
  const video = t.kind === "video";
  const v1t = !fits32(movieDuration);
  const tkhd = fullBox(
    "tkhd",
    v1t ? 1 : 0,
    3, // enabled | in movie
    ...(v1t ? [u64(0), u64(0)] : [u32(0), u32(0)]),
    u32(id),
    u32(0),
    v1t ? u64(movieDuration) : u32(movieDuration),
    zeros(8),
    u16(0), // layer
    u16(0), // alternate_group
    u16(video ? 0 : 0x0100), // volume
    u16(0),
    MATRIX,
    u32(video ? t.width * 0x1_0000 : 0),
    u32(video ? t.height * 0x1_0000 : 0),
  );
  const v1m = !fits32(mediaDuration);
  const mdhd = fullBox(
    "mdhd",
    v1m ? 1 : 0,
    0,
    ...(v1m ? [u64(0), u64(0)] : [u32(0), u32(0)]),
    u32(t.timescale),
    v1m ? u64(mediaDuration) : u32(mediaDuration),
    u16(0x55c4), // "und"
    u16(0),
  );
  const name = new TextEncoder().encode(video ? "VideoHandler\0" : "SoundHandler\0");
  const hdlr = fullBox("hdlr", 0, 0, u32(0), fourcc(video ? "vide" : "soun"), zeros(12), name);
  const mhd = video ? fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0)) : fullBox("smhd", 0, 0, u16(0), u16(0));
  const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
  const minf = box("minf", mhd, dinf, stbl(t, tm));
  return { trak: box("trak", tkhd, box("mdia", mdhd, hdlr, minf)), movieDuration };
}

/** `moov` for the tracks that have samples (track IDs 1..n in order). */
export function moov(tracks: readonly MuxTrack[], movieTimescale = 1000): Bytes {
  const used = tracks.filter((t) => t.samples.length > 0);
  if (used.length === 0) throw new Error("mp4: nothing to write");
  for (const t of used) {
    if (!t.sampleEntry || t.sampleEntry.length < 8) throw new Error(`mp4: ${t.kind} track has no sample entry`);
    int(t.timescale, "timescale", U32_MAX);
    if (t.timescale < 1) throw new RangeError("mp4: timescale must be positive");
  }
  const traks = used.map((t, i) => trak(t, i + 1, movieTimescale));
  const duration = Math.max(...traks.map((t) => t.movieDuration));
  const v1 = !fits32(duration);
  const mvhd = fullBox(
    "mvhd",
    v1 ? 1 : 0,
    0,
    ...(v1 ? [u64(0), u64(0)] : [u32(0), u32(0)]),
    u32(movieTimescale),
    v1 ? u64(duration) : u32(duration),
    u32(0x0001_0000), // rate 1.0
    u16(0x0100), // volume 1.0
    zeros(10), // reserved
    MATRIX,
    zeros(24), // pre_defined
    u32(used.length + 1), // next_track_ID
  );
  return box("moov", mvhd, ...traks.map((t) => t.trak));
}

// ---------------- streaming writer ----------------

/** Flush size the caller should aim for (bytes of pending sample data). */
export const FLUSH_BYTES = 8 * 1024 * 1024;
/** Hard cap of one mdat payload (32-bit box size). */
const MAX_MDAT = U32_MAX - 16;

/**
 * Collects samples and hands back the file bytes in order: start() (ftyp), flush() (an mdat with the pending samples,
 * or null), finish() (the last mdat plus moov). Offsets are absolute because the writer counts every byte it returns.
 */
export class Mp4Muxer {
  readonly tracks: MuxTrack[];
  private pending: Uint8Array[] = [];
  private pendingSize = 0;
  private pos = 0;
  private state: "new" | "open" | "done" = "new";

  constructor(tracks: { kind: "video" | "audio"; timescale: number; width?: number; height?: number; sampleEntry?: Uint8Array }[]) {
    this.tracks = tracks.map((t) => ({ kind: t.kind, timescale: t.timescale, width: t.width ?? 0, height: t.height ?? 0, sampleEntry: t.sampleEntry, samples: [] }));
  }

  private track(i: number): MuxTrack {
    const t = this.tracks[i];
    if (!t) throw new RangeError(`mp4: no track ${i}`);
    return t;
  }

  setSampleEntry(i: number, entry: Uint8Array, width?: number, height?: number): void {
    const t = this.track(i);
    t.sampleEntry = entry;
    if (width !== undefined) t.width = width;
    if (height !== undefined) t.height = height;
  }

  setLastDuration(i: number, duration: number): void {
    this.track(i).lastDuration = duration;
  }

  /** Bytes of sample data not yet returned by flush(). */
  get pendingBytes(): number {
    return this.pendingSize;
  }

  /** Total bytes returned so far (the file size once finished). */
  get written(): number {
    return this.pos;
  }

  start(): Bytes {
    if (this.state !== "new") throw new Error("mp4: already started");
    this.state = "open";
    const f = ftyp();
    this.pos = f.length;
    return f;
  }

  /** Queues one sample (decode order within its track). `pts` in track ticks. */
  add(i: number, data: Uint8Array, pts: number, sync: boolean): void {
    if (this.state !== "open") throw new Error("mp4: not open");
    const t = this.track(i);
    if (!Number.isFinite(pts)) throw new RangeError("mp4: pts must be finite");
    if (this.pendingSize + data.length > MAX_MDAT) throw new RangeError("mp4: flush before adding more data");
    // This sample lands after the next mdat header (8 bytes) and the samples queued before it.
    t.samples.push({ offset: this.pos + 8 + this.pendingSize, size: data.length, pts: Math.round(pts), sync });
    this.pending.push(data);
    this.pendingSize += data.length;
  }

  flush(): Bytes | null {
    if (this.state !== "open") throw new Error("mp4: not open");
    if (this.pendingSize === 0) return null;
    const out = concat([mdatHeader(this.pendingSize), ...this.pending]);
    this.pos += out.length;
    this.pending = [];
    this.pendingSize = 0;
    return out;
  }

  finish(): Bytes {
    const last = this.flush();
    this.state = "done";
    const m = moov(this.tracks);
    this.pos += m.length;
    return last ? concat([last, m]) : m;
  }
}
