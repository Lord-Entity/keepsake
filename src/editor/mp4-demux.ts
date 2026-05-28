/**
 * Small pure MP4/MOV (ISO BMFF) demuxer. Reads the sample tables (stts, ctts, stss, stsz, stsc, stco/co64) of every
 * track of a non-fragmented file held in memory and returns exact per-sample offsets, sizes and times, plus the codec
 * string, decoder description, dimensions, audio parameters, rotation and edit-list start for each track.
 * The editor decodes video samples with WebCodecs and copies audio samples verbatim into a new mp4.
 * Fragmented files (mvex / moof) are rejected. Any malformed input throws Mp4ParseError.
 * No dependencies. Codec helpers are exported for tests.
 */

export interface Mp4Sample {
  /** Absolute byte offset in the file. */
  offset: number;
  size: number;
  /** Decode time in track timescale units (stts cumulative, first = 0). */
  dts: number;
  /** Composition (presentation) time = dts + ctts offset. */
  cts: number;
  /** stts delta of this sample. */
  duration: number;
  sync: boolean;
}

export interface Mp4Track {
  id: number;
  type: "video" | "audio" | "other";
  timescale: number;
  duration: number;
  fourcc: string;
  /** Complete first stsd entry box (8-byte header included), a copy. */
  sampleEntry: Uint8Array;
  /** WebCodecs codec string, "" when unknown. */
  codec: string;
  /** Body of avcC / hvcC / av1C (no 8-byte header); undefined otherwise. */
  description?: Uint8Array;
  width: number;
  height: number;
  channels: number;
  sampleRate: number;
  /** Clockwise display rotation from the tkhd matrix. */
  rotation: 0 | 90 | 180 | 270;
  /** elst media_time of the first non-empty edit (track timescale); 0 when no elst. */
  mediaStart: number;
  samples: Mp4Sample[];
}

export interface Mp4File {
  movieTimescale: number;
  tracks: Mp4Track[];
}

export class Mp4ParseError extends Error {}

interface Box {
  type: string;
  start: number;
  body: number;
  end: number;
}

/** Sanity cap on samples per track, so garbage counts cannot exhaust memory. */
const MAX_SAMPLES = 50_000_000;

function fail(msg: string): never {
  throw new Mp4ParseError(msg);
}

function u64(dv: DataView, p: number): number {
  return dv.getUint32(p) * 4294967296 + dv.getUint32(p + 4);
}

function i64(dv: DataView, p: number): number {
  return dv.getInt32(p) * 4294967296 + dv.getUint32(p + 4);
}

function str4(dv: DataView, p: number): string {
  return String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
}

/** Boxes directly inside [start, end). Headers only; bodies are not read. */
function readBoxes(dv: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p < end) {
    if (end - p < 8) fail("truncated box header");
    let size = dv.getUint32(p);
    const type = str4(dv, p + 4);
    let hdr = 8;
    if (size === 1) {
      if (end - p < 16) fail("truncated box header");
      size = u64(dv, p + 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < hdr || p + size > end) fail(`bad box size (${type})`);
    out.push({ type, start: p, body: p + hdr, end: p + size });
    p += size;
  }
  return out;
}

function find(boxes: Box[], type: string): Box | undefined {
  return boxes.find((b) => b.type === type);
}

function need(boxes: Box[], type: string): Box {
  return find(boxes, type) ?? fail(`missing ${type}`);
}

/** The table of `count` entries of `entrySize` bytes at `pos` must lie inside the box. */
function checkTable(box: Box, pos: number, count: number, entrySize: number): void {
  if (pos + count * entrySize > box.end) fail(`truncated ${box.type} table`);
}

const hex = (n: number): string => n.toString(16).padStart(2, "0");

export function avcCodec(prefix: string, avcC: Uint8Array): string {
  if (avcC.length < 4) return "";
  return `${prefix}.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
}

export function hevcCodec(prefix: string, hvcC: Uint8Array): string {
  if (hvcC.length < 13) return "";
  const space = hvcC[1] >> 6;
  const tier = (hvcC[1] >> 5) & 1;
  const profile = hvcC[1] & 31;
  const compat = ((hvcC[2] << 24) | (hvcC[3] << 16) | (hvcC[4] << 8) | hvcC[5]) >>> 0;
  let rev = 0;
  for (let i = 0; i < 32; i++) {
    if ((compat >>> i) & 1) rev |= 1 << (31 - i);
  }
  let last = -1;
  for (let i = 0; i < 6; i++) {
    if (hvcC[6 + i] !== 0) last = i;
  }
  let s = `${prefix}.${["", "A", "B", "C"][space]}${profile}.${(rev >>> 0).toString(16).toUpperCase()}.${tier ? "H" : "L"}${hvcC[12]}`;
  for (let i = 0; i <= last; i++) s += `.${hvcC[6 + i].toString(16).toUpperCase()}`;
  return s;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export function vp9Codec(vpcC: Uint8Array): string {
  if (vpcC.length < 7) return "";
  return `vp09.${pad2(vpcC[4])}.${pad2(vpcC[5])}.${pad2(vpcC[6] >> 4)}`;
}

export function av1Codec(av1C: Uint8Array): string {
  if (av1C.length < 3) return "";
  const profile = av1C[1] >> 5;
  const level = av1C[1] & 31;
  const tier = av1C[2] >> 7;
  const high = (av1C[2] >> 6) & 1;
  const twelve = (av1C[2] >> 5) & 1;
  const depth = twelve ? 12 : high ? 10 : 8;
  return `av01.${profile}.${pad2(level)}${tier ? "H" : "M"}.${pad2(depth)}`;
}

/** MPEG-4 descriptor header: tag, expandable length (up to 4 bytes of 7 bits), body offset. */
function descHeader(b: Uint8Array, p: number): { tag: number; len: number; body: number } | null {
  if (p >= b.length) return null;
  const tag = b[p];
  let q = p + 1;
  let len = 0;
  for (let i = 0; i < 4; i++) {
    if (q >= b.length) return null;
    const c = b[q++];
    len = (len << 7) | (c & 0x7f);
    if (!(c & 0x80)) break;
  }
  return { tag, len, body: q };
}

/** Codec string from an esds box body (version/flags included). */
function esdsCodec(b: Uint8Array): string {
  const es = descHeader(b, 4);
  if (!es || es.tag !== 0x03) return "";
  let p = es.body + 2; // ES_ID
  if (p >= b.length) return "";
  const flags = b[p++];
  if (flags & 0x80) p += 2;
  if (flags & 0x40) {
    if (p >= b.length) return "";
    p += 1 + b[p];
  }
  if (flags & 0x20) p += 2;
  const dc = descHeader(b, p);
  if (!dc || dc.tag !== 0x04 || dc.body >= b.length) return "";
  const oti = b[dc.body];
  if (oti === 0x6b || oti === 0x69) return "mp3";
  if (oti !== 0x40) return "";
  const dsi = descHeader(b, dc.body + 13); // oti + 12 bytes
  if (!dsi || dsi.tag !== 0x05 || dsi.len < 1 || dsi.body >= b.length) return "mp4a.40.2";
  let aot = b[dsi.body] >> 3;
  if (aot === 31) {
    if (dsi.body + 1 >= b.length) return "mp4a.40.2";
    aot = 32 + (((b[dsi.body] & 7) << 3) | (b[dsi.body + 1] >> 5));
  }
  return `mp4a.40.${aot}`;
}

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

/**
 * Rotation from the tkhd matrix (a, b, c, d; signs only). ffmpeg writes "displaymatrix: rotation of -90.00 degrees"
 * for a phone portrait video shown rotated 90 degrees clockwise as a=0, b=0x10000, c=-0x10000, d=0.
 */
function rotationOf(a: number, b: number, c: number, d: number): 0 | 90 | 180 | 270 {
  const k = `${sign(a)},${sign(b)},${sign(c)},${sign(d)}`;
  if (k === "0,1,-1,0") return 90;
  if (k === "-1,0,0,-1") return 180;
  if (k === "0,-1,1,0") return 270;
  return 0;
}

interface EntryInfo {
  fourcc: string;
  sampleEntry: Uint8Array;
  codec: string;
  description?: Uint8Array;
  width: number;
  height: number;
  channels: number;
  sampleRate: number;
}

function parseEntry(dv: DataView, buf: Uint8Array, entry: Box, handler: string): EntryInfo {
  const info: EntryInfo = {
    fourcc: entry.type,
    sampleEntry: buf.slice(entry.start, entry.end),
    codec: "",
    width: 0,
    height: 0,
    channels: 0,
    sampleRate: 0,
  };
  const len = entry.end - entry.start;
  if (handler === "vide") {
    if (len < 36) fail("short video sample entry");
    info.width = dv.getUint16(entry.start + 32);
    info.height = dv.getUint16(entry.start + 34);
    const kids = len > 86 ? readBoxes(dv, entry.start + 86, entry.end) : [];
    const body = (b: Box): Uint8Array => buf.slice(b.body, b.end);
    const avcC = find(kids, "avcC");
    const hvcC = find(kids, "hvcC");
    const vpcC = find(kids, "vpcC");
    const av1C = find(kids, "av1C");
    if ((entry.type === "avc1" || entry.type === "avc3") && avcC) {
      info.description = body(avcC);
      info.codec = avcCodec(entry.type, info.description);
    } else if ((entry.type === "hvc1" || entry.type === "hev1") && hvcC) {
      info.description = body(hvcC);
      info.codec = hevcCodec(entry.type, info.description);
    } else if (entry.type === "vp09" && vpcC) {
      info.codec = vp9Codec(body(vpcC));
    } else if (entry.type === "av01" && av1C) {
      info.description = body(av1C);
      info.codec = av1Codec(info.description);
    }
  } else if (handler === "soun") {
    if (len < 36) fail("short audio sample entry");
    const ver = dv.getUint16(entry.start + 16);
    let childStart = 36;
    info.channels = dv.getUint16(entry.start + 24);
    info.sampleRate = dv.getUint32(entry.start + 32) >>> 16;
    if (ver === 1) childStart = 52;
    else if (ver === 2) {
      if (len < 72) fail("short audio sample entry");
      info.sampleRate = Math.round(dv.getFloat64(entry.start + 40));
      info.channels = dv.getUint32(entry.start + 48);
      childStart = 72;
    }
    if (entry.type === "mp4a") {
      const kids = len > childStart ? readBoxes(dv, entry.start + childStart, entry.end) : [];
      const esds = find(kids, "esds");
      if (esds) info.codec = esdsCodec(buf.subarray(esds.body, esds.end));
    } else if (entry.type === "Opus") info.codec = "opus";
    else if (entry.type === "fLaC") info.codec = "flac";
  }
  return info;
}

function readSamples(dv: DataView, stbl: Box[]): Mp4Sample[] {
  const stsz = find(stbl, "stsz");
  if (!stsz) fail(find(stbl, "stz2") ? "stz2 unsupported" : "missing stsz");
  const uniform = dv.getUint32(stsz.body + 4);
  const count = dv.getUint32(stsz.body + 8);
  if (count > MAX_SAMPLES) fail("too many samples");
  if (uniform === 0) checkTable(stsz, stsz.body + 12, count, 4);

  const samples: Mp4Sample[] = [];
  const stts = need(stbl, "stts");
  const nStts = dv.getUint32(stts.body + 4);
  checkTable(stts, stts.body + 8, nStts, 8);
  let t = 0;
  for (let e = 0; e < nStts; e++) {
    const c = dv.getUint32(stts.body + 8 + e * 8);
    const d = dv.getUint32(stts.body + 12 + e * 8);
    if (samples.length + c > count) fail("stts count mismatch");
    for (let j = 0; j < c; j++) {
      samples.push({ offset: 0, size: 0, dts: t, cts: t, duration: d, sync: true });
      t += d;
    }
  }
  if (samples.length !== count) fail("stts count mismatch");

  for (let i = 0; i < count; i++) {
    samples[i].size = uniform !== 0 ? uniform : dv.getUint32(stsz.body + 12 + i * 4);
  }

  const ctts = find(stbl, "ctts");
  if (ctts) {
    const n = dv.getUint32(ctts.body + 4);
    checkTable(ctts, ctts.body + 8, n, 8);
    let k = 0;
    let total = 0;
    for (let e = 0; e < n; e++) {
      const c = dv.getUint32(ctts.body + 8 + e * 8);
      // Read as signed for version 0 too: some muxers write negative offsets with version 0, and a real
      // offset above 2^31 ticks never occurs.
      const off = dv.getInt32(ctts.body + 12 + e * 8);
      total += c;
      for (let j = 0; j < c && k < count; j++, k++) samples[k].cts = samples[k].dts + off;
    }
    if (total < count) fail("ctts count mismatch");
  }

  const stss = find(stbl, "stss");
  if (stss) {
    const n = dv.getUint32(stss.body + 4);
    checkTable(stss, stss.body + 8, n, 4);
    for (const s of samples) s.sync = false;
    for (let e = 0; e < n; e++) {
      const num = dv.getUint32(stss.body + 8 + e * 4);
      if (num < 1 || num > count) fail("bad stss entry");
      samples[num - 1].sync = true;
    }
  }

  const stsc = need(stbl, "stsc");
  const nStsc = dv.getUint32(stsc.body + 4);
  checkTable(stsc, stsc.body + 8, nStsc, 12);
  const co64 = find(stbl, "co64");
  const stco = co64 ?? find(stbl, "stco") ?? fail("missing stco");
  const nChunks = dv.getUint32(stco.body + 4);
  const wide = co64 !== undefined;
  checkTable(stco, stco.body + 8, nChunks, wide ? 8 : 4);
  let e = 0;
  let s = 0;
  for (let ci = 1; ci <= nChunks; ci++) {
    while (e + 1 < nStsc && dv.getUint32(stsc.body + 8 + (e + 1) * 12) <= ci) e++;
    if (nStsc === 0) fail("empty stsc");
    const per = dv.getUint32(stsc.body + 12 + e * 12);
    let off = wide ? u64(dv, stco.body + 8 + (ci - 1) * 8) : dv.getUint32(stco.body + 8 + (ci - 1) * 4);
    for (let j = 0; j < per; j++) {
      if (s >= count) fail("stsc/stco sample count mismatch");
      samples[s].offset = off;
      off += samples[s].size;
      s++;
    }
  }
  if (s !== count) fail("stsc/stco sample count mismatch");
  return samples;
}

function parseTrack(dv: DataView, buf: Uint8Array, trak: Box): Mp4Track {
  const kids = readBoxes(dv, trak.body, trak.end);
  const tkhd = need(kids, "tkhd");
  const v1 = dv.getUint8(tkhd.body) === 1;
  const matrix = tkhd.body + (v1 ? 52 : 40);
  if (matrix + 36 > tkhd.end) fail("truncated tkhd");
  const id = dv.getUint32(tkhd.body + (v1 ? 20 : 12));
  // matrix order: a, b, u, c, d, v, x, y, w
  const rotation = rotationOf(
    dv.getInt32(matrix),
    dv.getInt32(matrix + 4),
    dv.getInt32(matrix + 12),
    dv.getInt32(matrix + 16),
  );

  let mediaStart = 0;
  const edts = find(kids, "edts");
  const elst = edts ? find(readBoxes(dv, edts.body, edts.end), "elst") : undefined;
  if (elst) {
    const wide = dv.getUint8(elst.body) === 1;
    const n = dv.getUint32(elst.body + 4);
    const step = wide ? 20 : 12;
    checkTable(elst, elst.body + 8, n, step);
    for (let i = 0; i < n; i++) {
      const p = elst.body + 8 + i * step;
      const mt = wide ? i64(dv, p + 8) : dv.getInt32(p + 4);
      if (mt >= 0) {
        mediaStart = mt;
        break;
      }
    }
  }

  const mdia = readBoxes(dv, need(kids, "mdia").body, need(kids, "mdia").end);
  const mdhd = need(mdia, "mdhd");
  const mv1 = dv.getUint8(mdhd.body) === 1;
  if (mdhd.body + (mv1 ? 32 : 20) > mdhd.end) fail("truncated mdhd");
  const timescale = dv.getUint32(mdhd.body + (mv1 ? 20 : 12));
  const duration = mv1 ? u64(dv, mdhd.body + 24) : dv.getUint32(mdhd.body + 16);
  const hdlr = need(mdia, "hdlr");
  // hdlr body: version/flags (4), pre_defined (4), handler_type (4).
  if (hdlr.body + 12 > hdlr.end) fail("truncated hdlr");
  const handler = str4(dv, hdlr.body + 8);

  const minf = need(mdia, "minf");
  const stblBox = need(readBoxes(dv, minf.body, minf.end), "stbl");
  const stbl = readBoxes(dv, stblBox.body, stblBox.end);
  const stsd = need(stbl, "stsd");
  if (stsd.body + 8 > stsd.end || dv.getUint32(stsd.body + 4) < 1) fail("empty stsd");
  const entry = readBoxes(dv, stsd.body + 8, stsd.end)[0];
  if (!entry) fail("empty stsd");
  const info = parseEntry(dv, buf, entry, handler);
  const samples = readSamples(dv, stbl);

  const track: Mp4Track = {
    id,
    type: handler === "vide" ? "video" : handler === "soun" ? "audio" : "other",
    timescale,
    duration,
    fourcc: info.fourcc,
    sampleEntry: info.sampleEntry,
    codec: info.codec,
    width: info.width,
    height: info.height,
    channels: info.channels,
    sampleRate: info.sampleRate,
    rotation,
    mediaStart,
    samples,
  };
  if (info.description) track.description = info.description;
  return track;
}

function parseInner(buf: Uint8Array): Mp4File {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const top = readBoxes(dv, 0, buf.length);
  if (find(top, "moof")) fail("fragmented");
  const moov = find(top, "moov") ?? fail("no moov");
  const kids = readBoxes(dv, moov.body, moov.end);
  if (find(kids, "mvex")) fail("fragmented");
  let movieTimescale = 0;
  const mvhd = find(kids, "mvhd");
  if (mvhd) {
    const v1 = dv.getUint8(mvhd.body) === 1;
    movieTimescale = dv.getUint32(mvhd.body + (v1 ? 20 : 12));
  }
  const tracks: Mp4Track[] = [];
  for (const k of kids) {
    if (k.type === "trak") tracks.push(parseTrack(dv, buf, k));
  }
  return { movieTimescale, tracks };
}

export function parseMp4(buf: Uint8Array): Mp4File {
  try {
    return parseInner(buf);
  } catch (e) {
    if (e instanceof RangeError) throw new Mp4ParseError("truncated data");
    throw e;
  }
}

/** Presentation time in seconds: (s.cts - track.mediaStart) / track.timescale */
export function sampleTime(track: Mp4Track, s: Mp4Sample): number {
  return (s.cts - track.mediaStart) / track.timescale;
}
