// @ts-nocheck -- bun:test types are not in tsconfig ("types": ["vite/client"]); bun runs this file, tsc does not need to.
/**
 * Unit tests for src/editor/mp4-mux.ts against ISO/IEC 14496-12 / 14496-14. Expected bytes are derived by hand
 * (comments), never computed with the code under test. A tiny box reader below checks layouts; the round trip goes
 * through parseMp4. Pure; no Tauri, no DOM.
 */
import { describe, expect, test } from "bun:test";
import {
  Mp4Muxer,
  avc1Entry,
  box,
  concat,
  descriptorLength,
  esds,
  fullBox,
  ftyp,
  i32,
  mdatHeader,
  moov,
  mp4aEntry,
  runs,
  timing,
  u16,
  u24,
  u32,
  u64,
} from "../mp4-mux";
import { parseMp4 } from "../mp4-demux";

// ---------------- helpers ----------------

const arr = (b) => Array.from(b);
const fill = (n, v) => new Uint8Array(n).fill(v);
const bytes = (...v) => Uint8Array.from(v);
const dvOf = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Size/type walk of the boxes directly inside [start, end). */
function boxes(buf, start = 0, end = buf.length) {
  const dv = dvOf(buf);
  const out = [];
  let p = start;
  while (p < end) {
    const size = dv.getUint32(p);
    const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    if (size < 8 || p + size > end) throw new Error(`bad box ${type} size ${size} at ${p}`);
    out.push({ type, start: p, body: p + 8, end: p + size, size });
    p += size;
  }
  return out;
}
/** First child of `parent` with `type`; `skip` = payload bytes before the children (e.g. 8 for stsd). */
function kid(buf, parent, type, skip = 0) {
  const k = boxes(buf, parent.body + skip, parent.end).find((b) => b.type === type);
  if (!k) throw new Error(`missing ${type}`);
  return k;
}
const kinds = (buf, parent) => boxes(buf, parent.body, parent.end).map((b) => b.type);
const u32at = (buf, p) => dvOf(buf).getUint32(p);
const i32at = (buf, p) => dvOf(buf).getInt32(p);
const u16at = (buf, p) => dvOf(buf).getUint16(p);
const u64at = (buf, p) => u32at(buf, p) * 4294967296 + u32at(buf, p + 4);

/** moov > trak[] helpers. */
function traksOf(file) {
  const top = boxes(file);
  const m = top.find((b) => b.type === "moov");
  return { m, traks: boxes(file, m.body, m.end).filter((b) => b.type === "trak") };
}
function stblOf(file, trak) {
  const mdia = kid(file, trak, "mdia");
  const minf = kid(file, mdia, "minf");
  return { mdia, minf, stbl: kid(file, minf, "stbl") };
}

// A realistic avcC: version 1, profile 0x64, compat 0x00, level 0x1f, lengthSize 4, 1 SPS (4 bytes), 1 PPS (4 bytes).
const AVCC = bytes(0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80);
const ASC = bytes(0x12, 0x10); // AAC-LC (aot 2), 44.1 kHz index 4, stereo

// ---------------- 1. primitive encoders ----------------

describe("primitive encoders", () => {
  test("u16 is big-endian", () => {
    expect(arr(u16(0))).toEqual([0, 0]);
    expect(arr(u16(0x1234))).toEqual([0x12, 0x34]);
    expect(arr(u16(0xffff))).toEqual([0xff, 0xff]);
  });
  test("u24 is big-endian", () => {
    expect(arr(u24(0x010203))).toEqual([1, 2, 3]);
    expect(arr(u24(0xffffff))).toEqual([0xff, 0xff, 0xff]);
  });
  test("u32 is big-endian", () => {
    expect(arr(u32(0x01020304))).toEqual([1, 2, 3, 4]);
    expect(arr(u32(0xffffffff))).toEqual([0xff, 0xff, 0xff, 0xff]);
  });
  test("i32 is two's complement", () => {
    expect(arr(i32(1))).toEqual([0, 0, 0, 1]);
    expect(arr(i32(-1))).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect(arr(i32(-1000))).toEqual([0xff, 0xff, 0xfc, 0x18]); // 2^32 - 1000 = 0xFFFFFC18
    expect(arr(i32(-0x80000000))).toEqual([0x80, 0, 0, 0]);
    expect(arr(i32(0x7fffffff))).toEqual([0x7f, 0xff, 0xff, 0xff]);
  });
  test("u64 above 2^32", () => {
    expect(arr(u64(5))).toEqual([0, 0, 0, 0, 0, 0, 0, 5]);
    expect(arr(u64(2 ** 32 + 5))).toEqual([0, 0, 0, 1, 0, 0, 0, 5]);
    expect(arr(u64(0xffffffff))).toEqual([0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
    // 2^40 = 0x100_0000_0000 -> high word 0x00000100; low word 0x01020304 added
    expect(arr(u64(2 ** 40 + 0x01020304))).toEqual([0, 0, 1, 0, 1, 2, 3, 4]);
    // 2^53 - 1 = 0x1F_FFFF_FFFF_FFFF
    expect(arr(u64(Number.MAX_SAFE_INTEGER))).toEqual([0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  });
  test("range errors", () => {
    expect(() => u16(0x10000)).toThrow(RangeError);
    expect(() => u16(-1)).toThrow(RangeError);
    expect(() => u16(1.5)).toThrow(RangeError);
    expect(() => u24(0x1000000)).toThrow(RangeError);
    expect(() => u24(-1)).toThrow(RangeError);
    expect(() => u32(2 ** 32)).toThrow(RangeError);
    expect(() => u32(-1)).toThrow(RangeError);
    expect(() => u32(Number.NaN)).toThrow(RangeError);
    expect(() => i32(2 ** 31)).toThrow(RangeError);
    expect(() => i32(-(2 ** 31) - 1)).toThrow(RangeError);
    expect(() => i32(0.5)).toThrow(RangeError);
    expect(() => u64(-1)).toThrow(RangeError);
    expect(() => u64(2 ** 53)).toThrow(RangeError);
    expect(() => u64(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
  test("descriptorLength expandable form", () => {
    expect(arr(descriptorLength(0))).toEqual([0x00]);
    expect(arr(descriptorLength(127))).toEqual([0x7f]);
    expect(arr(descriptorLength(128))).toEqual([0x81, 0x00]); // 1<<7 | 0
    expect(arr(descriptorLength(16383))).toEqual([0xff, 0x7f]); // 127<<7 | 127
    expect(arr(descriptorLength(16384))).toEqual([0x81, 0x80, 0x00]); // 1<<14
    expect(arr(descriptorLength(0x0fffffff))).toEqual([0xff, 0xff, 0xff, 0x7f]);
    expect(() => descriptorLength(0x10000000)).toThrow(RangeError);
    expect(() => descriptorLength(-1)).toThrow(RangeError);
  });
});

// ---------------- 2. box / fullBox / ftyp / mdat ----------------

describe("box headers", () => {
  test("box size includes the 8-byte header", () => {
    expect(arr(box("abcd"))).toEqual([0, 0, 0, 8, 0x61, 0x62, 0x63, 0x64]);
    expect(arr(box("free", bytes(1, 2), bytes(3)))).toEqual([0, 0, 0, 11, 0x66, 0x72, 0x65, 0x65, 1, 2, 3]);
  });
  test("fullBox adds version + 24-bit flags (12 bytes minimum)", () => {
    // size 12, 'url ' = 75 72 6c 20, version 0, flags 000001
    expect(arr(fullBox("url ", 0, 1))).toEqual([0, 0, 0, 12, 0x75, 0x72, 0x6c, 0x20, 0, 0, 0, 1]);
    expect(arr(fullBox("ctts", 1, 0x010203, bytes(9)))).toEqual([0, 0, 0, 13, 0x63, 0x74, 0x74, 0x73, 1, 1, 2, 3, 9]);
  });
  test("bad box types are rejected", () => {
    expect(() => box("abc")).toThrow(RangeError);
    expect(() => box("abcde")).toThrow(RangeError);
    expect(() => box("abéd")).toThrow(RangeError);
  });
  test("ftyp exact bytes", () => {
    // size 8 + 4 (major) + 4 (minor) + 4 compatible brands * 4 = 32 = 0x20
    expect(arr(ftyp())).toEqual([
      0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, // size, 'ftyp'
      0x69, 0x73, 0x6f, 0x6d, // major 'isom'
      0, 0, 0x02, 0x00, // minor version 512
      0x69, 0x73, 0x6f, 0x6d, // 'isom'
      0x69, 0x73, 0x6f, 0x32, // 'iso2'
      0x61, 0x76, 0x63, 0x31, // 'avc1'
      0x6d, 0x70, 0x34, 0x31, // 'mp41'
    ]);
  });
  test("mdatHeader(100)", () => {
    // size 108 = 0x6c, 'mdat' = 6d 64 61 74
    expect(arr(mdatHeader(100))).toEqual([0, 0, 0, 0x6c, 0x6d, 0x64, 0x61, 0x74]);
    expect(arr(mdatHeader(0))).toEqual([0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74]);
  });
  test("mdatHeader rejects a payload that overflows the 32-bit size", () => {
    expect(() => mdatHeader(0xffffffff)).toThrow(RangeError);
  });
});

// ---------------- 3. avc1 ----------------

describe("avc1Entry", () => {
  const e = avc1Entry(1920, 1080, AVCC);
  test("length = 86 + 8 + avcC.length", () => {
    expect(e.length).toBe(86 + 8 + AVCC.length);
    expect(u32at(e, 0)).toBe(e.length);
    expect(String.fromCharCode(...e.subarray(4, 8))).toBe("avc1");
  });
  test("fixed fields at their spec offsets (14496-12 VisualSampleEntry)", () => {
    expect(u16at(e, 14)).toBe(1); // data_reference_index
    expect(u16at(e, 32)).toBe(1920); // width
    expect(u16at(e, 34)).toBe(1080); // height
    expect(u32at(e, 36)).toBe(0x00480000); // horizresolution 72 dpi
    expect(u32at(e, 40)).toBe(0x00480000);
    expect(u16at(e, 48)).toBe(1); // frame_count
    expect(e[50]).toBe(0); // compressorname length byte
    expect(u16at(e, 82)).toBe(0x0018); // depth
    expect(u16at(e, 84)).toBe(0xffff); // pre_defined -1
  });
  test("avcC child at byte 86 carries the record unchanged", () => {
    expect(u32at(e, 86)).toBe(8 + AVCC.length);
    expect(String.fromCharCode(...e.subarray(90, 94))).toBe("avcC");
    expect(arr(e.subarray(94))).toEqual(arr(AVCC));
  });
  test("dimensions beyond 16 bits throw", () => {
    expect(() => avc1Entry(65536, 10, AVCC)).toThrow(RangeError);
  });
});

// ---------------- 4. esds / mp4a ----------------

describe("esds", () => {
  test("descriptor chain by hand (ASC 12 10, bitrates 0)", () => {
    const e = esds(ASC);
    // DecoderConfigDescriptor body: OTI 1 + streamType 1 + bufferSizeDB 3 + max 4 + avg 4 + DSI (1 tag + 1 len + 2) = 17 = 0x11
    // ES_Descriptor body: ES_ID 2 + flags 1 + DCD (1 tag + 1 len + 17 = 19) + SLConfig (06 01 02 = 3) = 25 = 0x19
    // esds box: 8 header + 4 version/flags + (1 tag + 1 len + 25) = 39
    expect(arr(e)).toEqual([
      0, 0, 0, 39, 0x65, 0x73, 0x64, 0x73, // size, 'esds'
      0, 0, 0, 0, // version/flags
      0x03, 0x19, // ES_Descriptor tag 3, length 25
      0, 0, // ES_ID
      0, // flags
      0x04, 0x11, // DecoderConfigDescriptor tag 4, length 17
      0x40, // objectTypeIndication: MPEG-4 audio
      0x15, // streamType 5 << 2 | upStream 0 << 1 | reserved 1
      0, 0, 0, // bufferSizeDB
      0, 0, 0, 0, // maxBitrate
      0, 0, 0, 0, // avgBitrate
      0x05, 0x02, 0x12, 0x10, // DecoderSpecificInfo tag 5, length 2, ASC
      0x06, 0x01, 0x02, // SLConfigDescriptor tag 6, length 1, predefined 2
    ]);
  });
  test("bitrates land in max (first) then avg", () => {
    const e = esds(ASC, 128000, 192000);
    // body offsets: 12 hdr, 03 19 (14), es_id+flags (17), 04 11 (19), oti (19) streamType (20), buf 21..23, max 24..27, avg 28..31
    expect(u32at(e, 24)).toBe(192000);
    expect(u32at(e, 28)).toBe(128000);
  });
  test("a 200-byte ASC expands the descriptor lengths to two bytes", () => {
    const e = esds(new Uint8Array(200).fill(7));
    // DSI: 05 81 48 (200 = 1<<7 | 72) then 200 bytes; walk to it: DCD header is 04 + 2-byte length (body 17-4+3+200 = 216 -> 81 58)
    // 216 = 1*128 + 88 = 0x81 0x58. DCD body = 1+1+3+4+4 + (1+2+200) = 216.
    // ES body = 3 + (1 + 2 + 216) + 3 = 225 = 1*128 + 97 = 0x81 0x61.
    expect(arr(e.subarray(12, 15))).toEqual([0x03, 0x81, 0x61]);
    expect(arr(e.subarray(15, 18))).toEqual([0, 0, 0]);
    expect(arr(e.subarray(18, 21))).toEqual([0x04, 0x81, 0x58]);
    expect(u32at(e, 0)).toBe(e.length);
    expect(e.length).toBe(8 + 4 + 1 + 2 + 225);
  });
});

describe("mp4aEntry", () => {
  const e = mp4aEntry(2, 44100, ASC, 128000);
  test("layout", () => {
    expect(String.fromCharCode(...e.subarray(4, 8))).toBe("mp4a");
    expect(u16at(e, 14)).toBe(1); // data_reference_index
    expect(u16at(e, 24)).toBe(2); // channelcount
    expect(u16at(e, 26)).toBe(16); // samplesize
    expect(u32at(e, 0)).toBe(e.length);
    expect(e.length).toBe(36 + 39);
  });
  test("children start at byte 36 (esds)", () => {
    expect(u32at(e, 36)).toBe(39);
    expect(String.fromCharCode(...e.subarray(40, 44))).toBe("esds");
    expect(arr(e.subarray(36))).toEqual(arr(esds(ASC, 128000, 128000)));
  });
  test("samplerate is 16.16: 44100 << 16", () => {
    expect(u32at(e, 32)).toBe(0xac440000); // 44100 = 0xAC44
    expect(u16at(e, 32)).toBe(44100);
    expect(u16at(e, 34)).toBe(0);
  });
  test("96000 does not fit 16 bits and is stored as 0", () => {
    expect(u32at(mp4aEntry(2, 96000, ASC), 32)).toBe(0);
    expect(u32at(mp4aEntry(2, 65535, ASC), 32)).toBe(0xffff0000);
    expect(u32at(mp4aEntry(2, 65536, ASC), 32)).toBe(0);
  });
});

// ---------------- 5. timing / runs ----------------

describe("timing", () => {
  test("in-order pts", () => {
    expect(timing([0, 3000, 6000])).toEqual({ deltas: [3000, 3000, 3000], offsets: [0, 0, 0] });
  });
  test("in-order pts with explicit lastDuration", () => {
    expect(timing([0, 3000, 6000], 2500).deltas).toEqual([3000, 3000, 2500]);
  });
  test("B-frame order", () => {
    // dts = sorted pts = [0,1000,2000,3000]; offsets = pts - dts = [0-0, 3000-1000, 1000-2000, 2000-3000]
    expect(timing([0, 3000, 1000, 2000], 1000)).toEqual({ deltas: [1000, 1000, 1000, 1000], offsets: [0, 2000, -1000, -1000] });
  });
  test("duplicate pts get +1 tick", () => {
    // sorted [0,0,0] -> dts [0,1,2]; last delta repeats the previous (1)
    expect(timing([0, 0, 0])).toEqual({ deltas: [1, 1, 1], offsets: [0, -1, -2] });
    // sorted [0,1000,1000] -> dts [0,1000,1001]
    expect(timing([0, 1000, 1000])).toEqual({ deltas: [1000, 1, 1], offsets: [0, 0, -1] });
  });
  test("single sample defaults to delta 1, honours lastDuration", () => {
    expect(timing([5])).toEqual({ deltas: [1], offsets: [0] });
    expect(timing([5], 40)).toEqual({ deltas: [40], offsets: [0] });
  });
  test("invalid lastDuration falls back to the previous delta", () => {
    expect(timing([0, 10], 0).deltas).toEqual([10, 10]);
    expect(timing([0, 10], Number.NaN).deltas).toEqual([10, 10]);
    expect(timing([0, 10], -3).deltas).toEqual([10, 10]);
    expect(timing([0, 10], 2.6).deltas).toEqual([10, 3]); // rounded
  });
  test("empty input", () => {
    expect(timing([])).toEqual({ deltas: [], offsets: [] });
  });
  test("a first pts that is not 0 is shifted to dts 0 by the implicit stts start (offsets stay 0)", () => {
    // dts = sorted pts = [500,3500] in the maths; stts starts at 0, so the demuxed cts is pts - 500
    expect(timing([500, 3500])).toEqual({ deltas: [3000, 3000], offsets: [0, 0] });
  });
});

describe("runs", () => {
  test("run-length encodes", () => {
    expect(runs([5, 5, 5, 7, 5])).toEqual([
      [3, 5],
      [1, 7],
      [1, 5],
    ]);
    expect(runs([])).toEqual([]);
    expect(runs([4])).toEqual([[1, 4]]);
    expect(runs([-1, -1])).toEqual([[2, -1]]);
  });
});

// ---------------- 6. Mp4Muxer end to end ----------------

const VIDEO_ENTRY = avc1Entry(640, 480, AVCC);
const AUDIO_ENTRY = mp4aEntry(2, 48000, ASC, 128000);

function buildMuxer() {
  return new Mp4Muxer([
    { kind: "video", timescale: 90000, width: 640, height: 480, sampleEntry: VIDEO_ENTRY },
    { kind: "audio", timescale: 48000, sampleEntry: AUDIO_ENTRY },
  ]);
}

const V = [fill(10, 0xa1), fill(20, 0xa2), fill(30, 0xa3)];
const A = [fill(8, 0xb1), fill(6, 0xb2), fill(8, 0xb3)];

/** Runs the whole scenario; returns pieces and the full file. */
function runScenario() {
  const m = buildMuxer();
  const parts = [];
  parts.push(m.start());
  m.add(0, V[0], 0, true);
  m.add(1, A[0], 0, true);
  m.add(0, V[1], 3000, false);
  m.add(1, A[1], 1024, true);
  const pendingBefore = m.pendingBytes;
  const flushed = m.flush();
  parts.push(flushed);
  const writtenMid = m.written;
  const nothing = m.flush();
  m.add(0, V[2], 6000, false);
  m.add(1, A[2], 2048, true);
  parts.push(m.finish());
  const file = concat(parts);
  return { m, parts, file, flushed, pendingBefore, writtenMid, nothing };
}

describe("Mp4Muxer end to end", () => {
  const s = runScenario();

  test("start() returns the ftyp", () => {
    expect(arr(s.parts[0])).toEqual(arr(ftyp()));
  });
  test("pendingBytes / flush / written bookkeeping", () => {
    // v0 10 + a0 8 + v1 20 + a1 6 = 44
    expect(s.pendingBefore).toBe(44);
    expect(s.flushed.length).toBe(8 + 44);
    expect(s.writtenMid).toBe(32 + 52); // ftyp + first mdat
    expect(s.nothing).toBeNull();
    expect(s.m.pendingBytes).toBe(0);
  });
  test("recorded offsets are absolute and hand-derivable", () => {
    // ftyp 32; mdat#1 header 32..39, payload from 40: v0@40(10) a0@50(8) v1@58(20) a1@78(6) -> ends 84
    // mdat#2 header 84..91, payload from 92: v2@92(30) a2@122(8) -> ends 130
    expect(s.m.tracks[0].samples.map((x) => x.offset)).toEqual([40, 58, 92]);
    expect(s.m.tracks[1].samples.map((x) => x.offset)).toEqual([50, 78, 122]);
    expect(s.m.tracks[0].samples.map((x) => x.size)).toEqual([10, 20, 30]);
    expect(s.m.tracks[1].samples.map((x) => x.size)).toEqual([8, 6, 8]);
    expect(s.m.tracks[0].samples.map((x) => x.sync)).toEqual([true, false, false]);
  });
  test("bytes at each recorded offset equal the data added", () => {
    for (const [track, datas] of [[0, V], [1, A]]) {
      s.m.tracks[track].samples.forEach((x, i) => {
        expect(arr(s.file.subarray(x.offset, x.offset + x.size))).toEqual(arr(datas[i]));
      });
    }
  });
  test("top level: ftyp, mdat, mdat, moov (moov last) with exact mdat sizes", () => {
    const top = boxes(s.file);
    expect(top.map((b) => b.type)).toEqual(["ftyp", "mdat", "mdat", "moov"]);
    expect(top[1].size).toBe(52); // 8 + 44
    expect(top[2].size).toBe(8 + 38); // 30 + 8
    expect(top[1].start).toBe(32);
    expect(top[2].start).toBe(84);
    expect(top[3].start).toBe(130);
  });
  test("written equals the total length", () => {
    expect(s.m.written).toBe(s.file.length);
  });
  test("finish() with nothing pending returns just the moov", () => {
    const m = buildMuxer();
    const head = m.start();
    m.add(0, V[0], 0, true);
    const mdat = m.flush();
    const tail = m.finish();
    expect(String.fromCharCode(...tail.subarray(4, 8))).toBe("moov");
    expect(m.written).toBe(head.length + mdat.length + tail.length);
  });
  test("state errors", () => {
    const m = buildMuxer();
    expect(() => m.add(0, V[0], 0, true)).toThrow(/not open/);
    expect(() => m.flush()).toThrow(/not open/);
    m.start();
    expect(() => m.start()).toThrow(/already started/);
    expect(() => m.add(5, V[0], 0, true)).toThrow(RangeError);
    expect(() => m.add(0, V[0], Number.NaN, true)).toThrow(RangeError);
    expect(() => m.setSampleEntry(9, VIDEO_ENTRY)).toThrow(RangeError);
  });
  test("finish() with no samples throws", () => {
    const m = buildMuxer();
    m.start();
    expect(() => m.finish()).toThrow(/nothing to write/);
  });
  test("pts is rounded to whole ticks", () => {
    const m = buildMuxer();
    m.start();
    m.add(0, V[0], 10.6, true);
    expect(m.tracks[0].samples[0].pts).toBe(11);
  });
  test("setSampleEntry / setLastDuration after construction", () => {
    const m = new Mp4Muxer([{ kind: "video", timescale: 1000 }]);
    m.start();
    m.add(0, V[0], 0, true);
    m.add(0, V[1], 40, true);
    m.setSampleEntry(0, VIDEO_ENTRY, 320, 240);
    m.setLastDuration(0, 60);
    const f = concat([ftyp(), m.finish()]);
    const { traks } = traksOf(f);
    const mdhd = kid(f, kid(f, traks[0], "mdia"), "mdhd");
    expect(u32at(f, mdhd.body + 16)).toBe(100); // 40 + 60
    const tkhd = kid(f, traks[0], "tkhd");
    expect(u32at(f, tkhd.body + 76)).toBe(320 * 65536);
    expect(u32at(f, tkhd.body + 80)).toBe(240 * 65536);
  });
});

// ---------------- 7. moov contents ----------------

describe("moov from the muxer scenario", () => {
  const { file } = runScenario();
  const { m: moovBox, traks } = traksOf(file);

  test("moov children: mvhd then two traks", () => {
    expect(kinds(file, moovBox)).toEqual(["mvhd", "trak", "trak"]);
  });
  test("mvhd (v0): timescale 1000, duration = longest track in ms, next_track_ID 3", () => {
    const mvhd = kid(file, moovBox, "mvhd");
    expect(mvhd.size).toBe(108);
    expect(file[mvhd.body]).toBe(0); // version
    expect(u32at(file, mvhd.body + 12)).toBe(1000);
    // video 9000 ticks @90000 = 100 ms; audio 3072 @48000 = 64 ms
    expect(u32at(file, mvhd.body + 16)).toBe(100);
    expect(u32at(file, mvhd.body + 20)).toBe(0x00010000); // rate
    expect(u16at(file, mvhd.body + 24)).toBe(0x0100); // volume
    expect(u32at(file, mvhd.body + 36)).toBe(0x00010000); // matrix a
    expect(u32at(file, mvhd.body + 36 + 32)).toBe(0x40000000); // matrix w
    expect(u32at(file, mvhd.body + 96)).toBe(3);
  });
  test("tkhd: ids 1/2, flags 3, durations, volume, 16.16 dimensions", () => {
    const tv = kid(file, traks[0], "tkhd");
    const ta = kid(file, traks[1], "tkhd");
    expect(tv.size).toBe(92);
    expect(u32at(file, tv.body)).toBe(3); // version 0, flags 3
    expect(u32at(file, ta.body)).toBe(3);
    expect(u32at(file, tv.body + 12)).toBe(1);
    expect(u32at(file, ta.body + 12)).toBe(2);
    expect(u32at(file, tv.body + 20)).toBe(100);
    expect(u32at(file, ta.body + 20)).toBe(64);
    expect(u16at(file, tv.body + 36)).toBe(0); // video volume
    expect(u16at(file, ta.body + 36)).toBe(0x0100);
    expect(u32at(file, tv.body + 76)).toBe(640 * 65536);
    expect(u32at(file, tv.body + 80)).toBe(480 * 65536);
    expect(u32at(file, ta.body + 76)).toBe(0);
    expect(u32at(file, ta.body + 80)).toBe(0);
    expect(u32at(file, tv.body + 40)).toBe(0x00010000); // matrix
  });
  test("mdhd: timescale, duration = sum of deltas, language und (0x55C4)", () => {
    const mv = kid(file, kid(file, traks[0], "mdia"), "mdhd");
    const ma = kid(file, kid(file, traks[1], "mdia"), "mdhd");
    expect(u32at(file, mv.body + 12)).toBe(90000);
    expect(u32at(file, mv.body + 16)).toBe(9000); // 3 x 3000
    expect(u16at(file, mv.body + 20)).toBe(0x55c4);
    expect(u32at(file, ma.body + 12)).toBe(48000);
    expect(u32at(file, ma.body + 16)).toBe(3072); // 3 x 1024
    expect(u16at(file, ma.body + 20)).toBe(0x55c4);
  });
  test("hdlr vide / soun", () => {
    const hv = kid(file, kid(file, traks[0], "mdia"), "hdlr");
    const ha = kid(file, kid(file, traks[1], "mdia"), "hdlr");
    const t = (h) => String.fromCharCode(...file.subarray(h.body + 8, h.body + 12));
    expect(t(hv)).toBe("vide");
    expect(t(ha)).toBe("soun");
    // name is NUL terminated and the box ends right after it
    expect(file[hv.end - 1]).toBe(0);
    expect(file[ha.end - 1]).toBe(0);
  });
  test("media headers: vmhd flags 1 (8 byte body), smhd flags 0", () => {
    const minfV = kid(file, kid(file, traks[0], "mdia"), "minf");
    const minfA = kid(file, kid(file, traks[1], "mdia"), "minf");
    expect(kinds(file, minfV)).toEqual(["vmhd", "dinf", "stbl"]);
    expect(kinds(file, minfA)).toEqual(["smhd", "dinf", "stbl"]);
    const vmhd = kid(file, minfV, "vmhd");
    expect(u32at(file, vmhd.body)).toBe(1);
    expect(vmhd.size).toBe(8 + 4 + 8);
    const smhd = kid(file, minfA, "smhd");
    expect(u32at(file, smhd.body)).toBe(0);
    expect(smhd.size).toBe(8 + 4 + 4);
  });
  test("dinf/dref has one url with flags 1 (self-contained)", () => {
    const minf = kid(file, kid(file, traks[0], "mdia"), "minf");
    const dref = kid(file, kid(file, minf, "dinf"), "dref");
    expect(u32at(file, dref.body + 4)).toBe(1);
    const url = kid(file, dref, "url ", 8);
    expect(url.size).toBe(12);
    expect(u32at(file, url.body)).toBe(1);
  });
  test("stbl children order; stss only on the track with non-sync samples", () => {
    expect(kinds(file, stblOf(file, traks[0]).stbl)).toEqual(["stsd", "stts", "stss", "stsz", "stsc", "stco"]);
    expect(kinds(file, stblOf(file, traks[1]).stbl)).toEqual(["stsd", "stts", "stsz", "stsc", "stco"]);
  });
  test("stsd holds the given sample entry verbatim", () => {
    const sv = kid(file, stblOf(file, traks[0]).stbl, "stsd");
    expect(u32at(file, sv.body + 4)).toBe(1);
    expect(arr(file.subarray(sv.body + 8, sv.end))).toEqual(arr(VIDEO_ENTRY));
    const sa = kid(file, stblOf(file, traks[1]).stbl, "stsd");
    expect(arr(file.subarray(sa.body + 8, sa.end))).toEqual(arr(AUDIO_ENTRY));
  });
  test("stts runs", () => {
    const sv = kid(file, stblOf(file, traks[0]).stbl, "stts");
    expect(u32at(file, sv.body + 4)).toBe(1);
    expect(u32at(file, sv.body + 8)).toBe(3); // count
    expect(u32at(file, sv.body + 12)).toBe(3000); // delta
    const sa = kid(file, stblOf(file, traks[1]).stbl, "stts");
    expect(u32at(file, sa.body + 8)).toBe(3);
    expect(u32at(file, sa.body + 12)).toBe(1024);
  });
  test("stss lists 1-based sync sample numbers", () => {
    const ss = kid(file, stblOf(file, traks[0]).stbl, "stss");
    expect(u32at(file, ss.body + 4)).toBe(1);
    expect(u32at(file, ss.body + 8)).toBe(1);
    expect(ss.size).toBe(8 + 4 + 4 + 4);
  });
  test("stsz table when sizes differ (both tracks)", () => {
    const zv = kid(file, stblOf(file, traks[0]).stbl, "stsz");
    expect(u32at(file, zv.body + 4)).toBe(0); // sample_size 0 => table
    expect(u32at(file, zv.body + 8)).toBe(3);
    expect([12, 16, 20].map((o) => u32at(file, zv.body + o))).toEqual([10, 20, 30]);
    const za = kid(file, stblOf(file, traks[1]).stbl, "stsz");
    expect([12, 16, 20].map((o) => u32at(file, za.body + o))).toEqual([8, 6, 8]);
  });
  test("stsc single entry (1,1,1)", () => {
    for (const t of traks) {
      const sc = kid(file, stblOf(file, t).stbl, "stsc");
      expect(sc.size).toBe(8 + 4 + 4 + 12);
      expect([4, 8, 12, 16].map((o) => u32at(file, sc.body + o))).toEqual([1, 1, 1, 1]);
    }
  });
  test("stco offsets", () => {
    const cv = kid(file, stblOf(file, traks[0]).stbl, "stco");
    expect(u32at(file, cv.body + 4)).toBe(3);
    expect([8, 12, 16].map((o) => u32at(file, cv.body + o))).toEqual([40, 58, 92]);
    const ca = kid(file, stblOf(file, traks[1]).stbl, "stco");
    expect([8, 12, 16].map((o) => u32at(file, ca.body + o))).toEqual([50, 78, 122]);
  });
});

function videoTrack(samples, extra = {}) {
  return { kind: "video", timescale: 1000, width: 64, height: 48, sampleEntry: VIDEO_ENTRY, samples, ...extra };
}
const smp = (offset, size, pts, sync = true) => ({ offset, size, pts, sync });

describe("moov() direct", () => {
  test("uniform sizes use stsz sample_size with no table; in-order means no ctts, all sync means no stss", () => {
    const f = moov([videoTrack([smp(100, 7, 0), smp(107, 7, 40), smp(114, 7, 80)])]);
    const { stbl } = stblOf(f, boxes(f, 8, f.length).find((b) => b.type === "trak"));
    expect(kinds(f, stbl)).toEqual(["stsd", "stts", "stsz", "stsc", "stco"]);
    const sz = kid(f, stbl, "stsz");
    expect(sz.size).toBe(8 + 4 + 4 + 4);
    expect(u32at(f, sz.body + 4)).toBe(7);
    expect(u32at(f, sz.body + 8)).toBe(3);
  });

  test("B-frame order -> ctts version 1 with negative offsets, runs merged", () => {
    const f = moov([videoTrack([smp(0, 1, 0), smp(1, 1, 3000), smp(2, 1, 1000, false), smp(3, 1, 2000, false)], { lastDuration: 1000 })]);
    const trak = boxes(f, 8, f.length).find((b) => b.type === "trak");
    const { stbl } = stblOf(f, trak);
    expect(kinds(f, stbl)).toEqual(["stsd", "stts", "ctts", "stss", "stsz", "stsc", "stco"]);
    const stts = kid(f, stbl, "stts");
    expect(u32at(f, stts.body + 4)).toBe(1);
    expect([u32at(f, stts.body + 8), u32at(f, stts.body + 12)]).toEqual([4, 1000]);
    const ctts = kid(f, stbl, "ctts");
    expect(f[ctts.body]).toBe(1); // version 1 (signed offsets)
    expect(u32at(f, ctts.body + 4)).toBe(3);
    // runs of [0, 2000, -1000, -1000]
    expect([0, 1, 2].map((i) => [u32at(f, ctts.body + 8 + i * 8), i32at(f, ctts.body + 12 + i * 8)])).toEqual([
      [1, 0],
      [1, 2000],
      [2, -1000],
    ]);
    const stss = kid(f, stbl, "stss");
    expect(u32at(f, stss.body + 4)).toBe(2);
    expect([8, 12].map((o) => u32at(f, stss.body + o))).toEqual([1, 2]);
  });

  test("duplicate pts give a negative ctts offset (version 1)", () => {
    // pts [0, 1000, 1000] -> dts [0, 1000, 1001] -> offsets [0, 0, -1]; runs [[2,0],[1,-1]]
    const f = moov([videoTrack([smp(0, 1, 0), smp(1, 1, 1000), smp(2, 1, 1000)])]);
    const trak = boxes(f, 8, f.length).find((b) => b.type === "trak");
    const ctts = kid(f, stblOf(f, trak).stbl, "ctts");
    expect(f[ctts.body]).toBe(1);
    expect(i32at(f, ctts.body + 8 + 8 + 4)).toBe(-1);
  });

  test("co64 when any offset exceeds 0xFFFFFFFF (all entries 8 bytes), stco at exactly 0xFFFFFFFF", () => {
    const big = moov([videoTrack([smp(2 ** 32 + 16, 5, 0), smp(100, 5, 1000)])]);
    const trakB = boxes(big, 8, big.length).find((b) => b.type === "trak");
    const sb = stblOf(big, trakB).stbl;
    expect(kinds(big, sb)).toEqual(["stsd", "stts", "stsz", "stsc", "co64"]);
    const co = kid(big, sb, "co64");
    expect(u32at(big, co.body + 4)).toBe(2);
    expect(arr(big.subarray(co.body + 8, co.body + 24))).toEqual([0, 0, 0, 1, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 100]);

    const edge = moov([videoTrack([smp(0xffffffff, 5, 0)])]);
    const trakE = boxes(edge, 8, edge.length).find((b) => b.type === "trak");
    const se = stblOf(edge, trakE).stbl;
    expect(kinds(edge, se)).toContain("stco");
    expect(u32at(edge, kid(edge, se, "stco").body + 8)).toBe(0xffffffff);
  });

  test("durations past 32 bits switch mvhd/tkhd/mdhd to version 1", () => {
    // stts deltas are 32-bit, so two 3e9 steps: pts [0, 3e9, 6e9] @1000, lastDuration 1 -> 6_000_000_001 ticks = same in ms
    const f = moov([videoTrack([smp(0, 1, 0), smp(1, 1, 3_000_000_000), smp(2, 1, 6_000_000_000)], { lastDuration: 1 })]);
    const { m, traks } = traksOf(f);
    const mvhd = kid(f, m, "mvhd");
    expect(f[mvhd.body]).toBe(1);
    expect(u32at(f, mvhd.body + 20)).toBe(1000); // timescale after 8+8 byte times
    expect(u64at(f, mvhd.body + 24)).toBe(6_000_000_001);
    expect(u32at(f, mvhd.body + 24 + 8 + 4 + 2 + 10 + 36 + 24)).toBe(2); // next_track_ID
    const tkhd = kid(f, traks[0], "tkhd");
    expect(f[tkhd.body]).toBe(1);
    expect(u32at(f, tkhd.body + 20)).toBe(1); // track_ID
    expect(u64at(f, tkhd.body + 28)).toBe(6_000_000_001);
    const mdhd = kid(f, kid(f, traks[0], "mdia"), "mdhd");
    expect(f[mdhd.body]).toBe(1);
    expect(u32at(f, mdhd.body + 20)).toBe(1000);
    expect(u64at(f, mdhd.body + 24)).toBe(6_000_000_001);
    expect(u16at(f, mdhd.body + 32)).toBe(0x55c4);
  });

  test("tracks with zero samples are omitted and ids renumbered", () => {
    const audio = { kind: "audio", timescale: 48000, width: 0, height: 0, sampleEntry: AUDIO_ENTRY, samples: [smp(40, 4, 0), smp(44, 4, 1024)] };
    const f = moov([videoTrack([]), audio]);
    const { m, traks } = traksOf(f);
    expect(traks.length).toBe(1);
    expect(u32at(f, kid(f, traks[0], "tkhd").body + 12)).toBe(1);
    expect(u16at(f, kid(f, traks[0], "tkhd").body + 36)).toBe(0x0100);
    expect(u32at(f, kid(f, m, "mvhd").body + 96)).toBe(2);
    expect(kinds(f, kid(f, kid(f, traks[0], "mdia"), "minf"))[0]).toBe("smhd");
    // an empty track needs no sample entry
    expect(() => moov([{ kind: "video", timescale: 1, width: 0, height: 0, samples: [] }, audio])).not.toThrow();
  });

  test("errors", () => {
    expect(() => moov([])).toThrow(/nothing to write/);
    expect(() => moov([videoTrack([])])).toThrow(/nothing to write/);
    expect(() => moov([videoTrack([smp(0, 1, 0)], { sampleEntry: undefined })])).toThrow(/no sample entry/);
    expect(() => moov([videoTrack([smp(0, 1, 0)], { sampleEntry: new Uint8Array(4) })])).toThrow(/no sample entry/);
    expect(() => moov([videoTrack([smp(0, 1, 0)], { timescale: 0 })])).toThrow(RangeError);
    expect(() => moov([videoTrack([smp(0, 1, 0)], { timescale: 2 ** 32 })])).toThrow(RangeError);
  });
});

// ---------------- 8. round trip through the demuxer ----------------

describe("round trip with parseMp4", () => {
  const { file, m } = runScenario();
  const parsed = parseMp4(file);

  test("tracks and timescales", () => {
    expect(parsed.movieTimescale).toBe(1000);
    expect(parsed.tracks.length).toBe(2);
    const [v, a] = parsed.tracks;
    expect([v.id, v.type, v.timescale, v.duration, v.fourcc]).toEqual([1, "video", 90000, 9000, "avc1"]);
    expect([a.id, a.type, a.timescale, a.duration, a.fourcc]).toEqual([2, "audio", 48000, 3072, "mp4a"]);
  });
  test("video: codec string, description, dimensions, sample entry bytes", () => {
    const v = parsed.tracks[0];
    expect(v.codec).toBe("avc1.64001f"); // profile 0x64, constraints 0x00, level 0x1f
    expect(arr(v.description)).toEqual(arr(AVCC));
    expect([v.width, v.height]).toEqual([640, 480]);
    expect(arr(v.sampleEntry)).toEqual(arr(VIDEO_ENTRY));
    expect(v.rotation).toBe(0);
    expect(v.mediaStart).toBe(0);
  });
  test("audio: codec mp4a.40.2, channels, rate, sample entry bytes", () => {
    const a = parsed.tracks[1];
    expect(a.codec).toBe("mp4a.40.2"); // ASC 0x12 >> 3 = 2
    expect(a.channels).toBe(2);
    expect(a.sampleRate).toBe(48000);
    expect(arr(a.sampleEntry)).toEqual(arr(AUDIO_ENTRY));
  });
  test("video samples: offsets, sizes, sync, dts, cts, durations", () => {
    const v = parsed.tracks[0].samples;
    expect(v.map((x) => x.offset)).toEqual([40, 58, 92]);
    expect(v.map((x) => x.size)).toEqual([10, 20, 30]);
    expect(v.map((x) => x.sync)).toEqual([true, false, false]);
    expect(v.map((x) => x.dts)).toEqual([0, 3000, 6000]);
    expect(v.map((x) => x.cts)).toEqual([0, 3000, 6000]);
    expect(v.map((x) => x.duration)).toEqual([3000, 3000, 3000]);
  });
  test("audio samples: offsets, sizes, sync, times", () => {
    const a = parsed.tracks[1].samples;
    expect(a.map((x) => x.offset)).toEqual([50, 78, 122]);
    expect(a.map((x) => x.size)).toEqual([8, 6, 8]);
    expect(a.every((x) => x.sync)).toBe(true);
    expect(a.map((x) => x.dts)).toEqual([0, 1024, 2048]);
    expect(a.map((x) => x.cts)).toEqual([0, 1024, 2048]);
  });
  test("demuxed offsets point at the original payloads", () => {
    parsed.tracks[0].samples.forEach((s, i) => {
      expect(arr(file.subarray(s.offset, s.offset + s.size))).toEqual(arr(V[i]));
    });
    parsed.tracks[1].samples.forEach((s, i) => {
      expect(arr(file.subarray(s.offset, s.offset + s.size))).toEqual(arr(A[i]));
    });
    expect(m.written).toBe(file.length);
  });

  test("B-frame order: dts sorted, cts = dts + offset equals the input pts", () => {
    const mx = new Mp4Muxer([{ kind: "video", timescale: 90000, width: 640, height: 480, sampleEntry: VIDEO_ENTRY }]);
    mx.setLastDuration(0, 1000);
    const parts = [mx.start()];
    const pts = [0, 3000, 1000, 2000];
    pts.forEach((p, i) => mx.add(0, fill(3 + i, i + 1), p, i === 0));
    parts.push(mx.finish());
    const f = concat(parts);
    const t = parseMp4(f).tracks[0];
    expect(t.duration).toBe(4000);
    expect(t.samples.map((s) => s.dts)).toEqual([0, 1000, 2000, 3000]);
    expect(t.samples.map((s) => s.cts)).toEqual(pts);
    expect(t.samples.map((s) => s.cts - s.dts)).toEqual([0, 2000, -1000, -1000]);
    expect(t.samples.map((s) => s.sync)).toEqual([true, false, false, false]);
    // offsets: ftyp 32 + mdat header 8 = 40; sizes 3,4,5,6
    expect(t.samples.map((s) => s.offset)).toEqual([40, 43, 47, 52]);
    expect(t.samples.map((s) => s.size)).toEqual([3, 4, 5, 6]);
  });
});
