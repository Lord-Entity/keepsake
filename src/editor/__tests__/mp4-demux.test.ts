import { describe, expect, test } from "bun:test";
import {
  Mp4ParseError,
  av1Codec,
  avcCodec,
  hevcCodec,
  parseMp4,
  sampleTime,
  vp9Codec,
  type Mp4File,
  type Mp4Track,
} from "../mp4-demux";

// ---- byte builders (independent of production code) ----
const enc = new TextEncoder();
const u8 = (...n: number[]): Uint8Array => Uint8Array.from(n);
const zeros = (n: number): Uint8Array => new Uint8Array(n);
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u16 = (n: number): Uint8Array => u8((n >> 8) & 255, n & 255);
const u32 = (n: number): Uint8Array => {
  const a = new Uint8Array(4);
  new DataView(a.buffer).setUint32(0, n >>> 0);
  return a;
};
const i32 = (n: number): Uint8Array => {
  const a = new Uint8Array(4);
  new DataView(a.buffer).setInt32(0, n);
  return a;
};
const u64 = (n: number): Uint8Array => cat(u32(Math.floor(n / 2 ** 32)), u32(n % 2 ** 32));
const i64 = (n: number): Uint8Array => {
  const hi = Math.floor(n / 2 ** 32);
  const a = new Uint8Array(8);
  const dv = new DataView(a.buffer);
  dv.setInt32(0, hi);
  dv.setUint32(4, n - hi * 2 ** 32);
  return a;
};
const f64 = (n: number): Uint8Array => {
  const a = new Uint8Array(8);
  new DataView(a.buffer).setFloat64(0, n);
  return a;
};
const box = (type: string, ...parts: Uint8Array[]): Uint8Array => {
  const body = cat(...parts);
  return cat(u32(8 + body.length), enc.encode(type), body);
};
const full = (type: string, ver: number, flags: number, ...parts: Uint8Array[]): Uint8Array =>
  box(type, u32(((ver << 24) | flags) >>> 0), ...parts);

// ---- table boxes ----
const stsd = (entry: Uint8Array) => full("stsd", 0, 0, u32(1), entry);
const stts = (pairs: [number, number][]) => full("stts", 0, 0, u32(pairs.length), ...pairs.flatMap(([c, d]) => [u32(c), u32(d)]));
const ctts = (ver: number, pairs: [number, number][]) =>
  full("ctts", ver, 0, u32(pairs.length), ...pairs.flatMap(([c, o]) => [u32(c), ver === 1 ? i32(o) : u32(o)]));
const stss = (nums: number[]) => full("stss", 0, 0, u32(nums.length), ...nums.map(u32));
const stszTable = (sizes: number[]) => full("stsz", 0, 0, u32(0), u32(sizes.length), ...sizes.map(u32));
const stszUniform = (size: number, count: number) => full("stsz", 0, 0, u32(size), u32(count));
const stsc = (rows: [number, number][]) => full("stsc", 0, 0, u32(rows.length), ...rows.flatMap(([f, n]) => [u32(f), u32(n), u32(1)]));
const stco = (offs: number[]) => full("stco", 0, 0, u32(offs.length), ...offs.map(u32));
const co64 = (offs: number[]) => full("co64", 0, 0, u32(offs.length), ...offs.map(u64));

interface Tables {
  stts?: [number, number][];
  sizes?: number[];
  szBox?: Uint8Array;
  stsc?: [number, number][];
  stco?: number[];
  co64?: number[];
  ctts?: Uint8Array;
  stss?: number[];
}
/** stbl children; defaults: 4 samples of delta 100 in one chunk at offset 100. */
function tables(entry: Uint8Array, t: Tables = {}): Uint8Array {
  const parts = [stsd(entry), stts(t.stts ?? [[4, 100]])];
  parts.push(t.szBox ?? stszTable(t.sizes ?? [10, 20, 30, 40]));
  parts.push(stsc(t.stsc ?? [[1, 4]]));
  parts.push(t.co64 ? co64(t.co64) : stco(t.stco ?? [100]));
  if (t.ctts) parts.push(t.ctts);
  if (t.stss) parts.push(stss(t.stss));
  return box("stbl", ...parts);
}

const IDENT = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
interface TrakOpts {
  id?: number;
  handler?: string;
  timescale?: number;
  duration?: number;
  v1?: boolean;
  matrix?: number[];
  elst?: Uint8Array;
  stbl: Uint8Array;
}
function trak(o: TrakOpts): Uint8Array {
  const matrix = cat(...(o.matrix ?? IDENT).map(i32));
  const tail = cat(zeros(8), u16(0), u16(0), u16(0), u16(0), matrix, u32(0), u32(0));
  const tkhd = o.v1
    ? full("tkhd", 1, 3, u64(0), u64(0), u32(o.id ?? 1), u32(0), u64(0), tail)
    : full("tkhd", 0, 3, u32(0), u32(0), u32(o.id ?? 1), u32(0), u32(0), tail);
  const ts = o.timescale ?? 1000;
  const dur = o.duration ?? 4000;
  const mdhd = o.v1
    ? full("mdhd", 1, 0, u64(0), u64(0), u32(ts), u64(dur), u32(0))
    : full("mdhd", 0, 0, u32(0), u32(0), u32(ts), u32(dur), u32(0));
  const hdlr = full("hdlr", 0, 0, u32(0), enc.encode(o.handler ?? "vide"), zeros(12), u8(0));
  const mdia = box("mdia", mdhd, hdlr, box("minf", o.stbl));
  return box("trak", tkhd, ...(o.elst ? [box("edts", o.elst)] : []), mdia);
}
const mvhd = (ts: number) => full("mvhd", 0, 0, u32(0), u32(0), u32(ts), u32(0), zeros(80));
const moov = (...children: Uint8Array[]) => box("moov", mvhd(600), ...children);
const ftyp = () => box("ftyp", enc.encode("isom"), u32(0), enc.encode("isom"));
const mdat = (n: number) => box("mdat", zeros(n));
const file = (...top: Uint8Array[]) => cat(...top);

// ---- sample entries ----
const AVCC_BODY = u8(1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0, 0);
function visualEntry(fourcc: string, w: number, h: number, ...kids: Uint8Array[]): Uint8Array {
  // entry offsets: 8 hdr, 6 reserved, 2 dri, 2+2 pre/res, 12 pre = 32, w@32, h@34, 50 more bytes -> children @86
  return box(fourcc, zeros(6), u16(1), zeros(4), zeros(12), u16(w), u16(h), zeros(50), ...kids);
}
const avc1Entry = () => visualEntry("avc1", 1920, 1080, box("avcC", AVCC_BODY));

function audioHead(ver: number, ch: number, rate: number): Uint8Array {
  // 8 hdr, 6 reserved, dri@14, version@16, revision@18, vendor@20, channels@24, samplesize@26, 4 bytes, rate(16.16)@32
  return cat(zeros(6), u16(1), u16(ver), u16(0), u32(0), u16(ch), u16(16), u16(0), u16(0), u32(Math.round(rate * 65536)));
}
function audioEntry(fourcc: string, ch: number, rate: number, ver: number, ...kids: Uint8Array[]): Uint8Array {
  if (ver === 1) return box(fourcc, audioHead(1, ch, rate), zeros(16), ...kids);
  if (ver === 2) {
    // v2: @24 always3, @26 16, @28 -2, @32 0x10000, @36 struct size, @40 f64 rate, @48 u32 channels, then 24 more bytes -> children @72
    return box(
      fourcc,
      zeros(6),
      u16(1),
      u16(2),
      u16(0),
      u32(0),
      u16(3),
      u16(16),
      u16(0xfffe),
      u16(0),
      u32(0x10000),
      u32(72),
      f64(rate),
      u32(ch),
      u32(0x7f000000),
      zeros(16),
      ...kids,
    );
  }
  return box(fourcc, audioHead(0, ch, rate), ...kids);
}

function desc(tag: number, body: Uint8Array, long = false): Uint8Array {
  const len = long ? u8(0x80, 0x80, 0x80, body.length) : u8(body.length);
  return cat(u8(tag), len, body);
}
/** esds box: ES_Descriptor > DecoderConfigDescriptor(oti) > optional DecoderSpecificInfo(asc). */
function esds(oti: number, asc: Uint8Array | null, long = false): Uint8Array {
  const dsi = asc ? desc(0x05, asc, long) : zeros(0);
  const dcd = desc(0x04, cat(u8(oti, 0x15), zeros(3), u32(0), u32(0), dsi), long);
  const es = desc(0x03, cat(u16(1), u8(0), dcd, desc(0x06, u8(2), long)), long);
  return full("esds", 0, 0, es);
}

const first = (f: Mp4File): Mp4Track => {
  const t = f.tracks[0];
  if (!t) throw new Error("no track");
  return t;
};
const videoFile = (t: Tables = {}, o: Partial<TrakOpts> = {}) =>
  file(ftyp(), moov(trak({ stbl: tables(avc1Entry(), t), ...o })));

/** tkhd matrix in a,b,u,c,d,v,x,y,w order. */
const mat = (a: number, b: number, c: number, d: number) => [a, b, 0, c, d, 0, 0, 0, 0x40000000];
const rot = (matrix: number[]) => first(parseMp4(videoFile({}, { matrix }))).rotation;
const audioTrack = (entry: Uint8Array) =>
  first(parseMp4(file(ftyp(), moov(trak({ handler: "soun", timescale: 48000, stbl: tables(entry) })))));
const timeAt = (t: Mp4Track, i: number): number => {
  const s = t.samples[i];
  if (!s) throw new Error("no sample");
  return sampleTime(t, s);
};

describe("box walking", () => {
  test("moov after mdat; skips mdat and free", () => {
    const f = parseMp4(file(ftyp(), mdat(1000), box("free", zeros(5)), moov(trak({ stbl: tables(avc1Entry()) }))));
    expect(f.movieTimescale).toBe(600);
    expect(f.tracks.length).toBe(1);
  });

  test("moov before mdat", () => {
    const f = parseMp4(file(ftyp(), moov(trak({ stbl: tables(avc1Entry()) })), mdat(50)));
    expect(f.tracks.length).toBe(1);
  });

  test("64-bit largesize boxes", () => {
    const m = moov(trak({ stbl: tables(avc1Entry()) }));
    const body = m.subarray(8);
    // size field 1, type, u64 total size = 16 header + body
    const big = cat(u32(1), enc.encode("moov"), u64(16 + body.length), body);
    const bigFree = cat(u32(1), enc.encode("free"), u64(16 + 3), zeros(3));
    const f = parseMp4(file(ftyp(), bigFree, big));
    expect(f.movieTimescale).toBe(600);
    expect(first(f).samples.length).toBe(4);
  });

  test("size 0 extends to end of file", () => {
    const m = moov(trak({ stbl: tables(avc1Entry()) }));
    m.set(u32(0), 0);
    const f = parseMp4(file(ftyp(), mdat(10), m));
    expect(f.tracks.length).toBe(1);
  });

  test("no moov", () => {
    expect(() => parseMp4(file(ftyp(), mdat(10)))).toThrow("no moov");
  });
});

describe("rejections", () => {
  test("mvex is fragmented", () => {
    const m = box("moov", mvhd(600), trak({ stbl: tables(avc1Entry()) }), box("mvex", zeros(0)));
    expect(() => parseMp4(file(ftyp(), m))).toThrow("fragmented");
  });

  test("top-level moof is fragmented", () => {
    const bytes = file(ftyp(), moov(trak({ stbl: tables(avc1Entry()) })), box("moof", zeros(8)));
    expect(() => parseMp4(bytes)).toThrow("fragmented");
  });

  test("truncated file", () => {
    const bytes = videoFile();
    expect(() => parseMp4(bytes.subarray(0, bytes.length - 5))).toThrow(Mp4ParseError);
  });

  test("stts total differs from stsz count", () => {
    // 3 timed samples vs 4 sizes
    expect(() => parseMp4(videoFile({ stts: [[3, 100]] }))).toThrow(Mp4ParseError);
    // 5 timed samples vs 4 sizes
    expect(() => parseMp4(videoFile({ stts: [[5, 100]] }))).toThrow(Mp4ParseError);
  });

  test("ctts total smaller than count", () => {
    expect(() => parseMp4(videoFile({ ctts: ctts(0, [[3, 0]]) }))).toThrow(Mp4ParseError);
  });

  test("stsc/stco cover fewer samples than stsz", () => {
    // 1 chunk x 2 samples = 2 < 4
    expect(() => parseMp4(videoFile({ stsc: [[1, 2]] }))).toThrow(Mp4ParseError);
  });

  test("stz2 without stsz", () => {
    const szBox = full("stz2", 0, 0, u32(0), u32(0));
    expect(() => parseMp4(videoFile({ szBox }))).toThrow("stz2 unsupported");
  });

  test("garbage", () => {
    expect(() => parseMp4(u8(0, 0, 0))).toThrow(Mp4ParseError);
  });
});

describe("sample tables", () => {
  test("stsc runs 3,3,2 with stco", () => {
    const sizes = [10, 20, 30, 40, 50, 60, 70, 80];
    const f = parseMp4(
      videoFile({
        sizes,
        stts: [[8, 100]],
        // chunk 1-2 hold 3 samples, chunk 3 holds 2
        stsc: [
          [1, 3],
          [3, 2],
        ],
        stco: [1000, 2000, 3000],
      }),
    );
    const s = first(f).samples;
    // chunk1 @1000: 1000, 1000+10, 1000+10+20; chunk2 @2000: 2000, 2040, 2090; chunk3 @3000: 3000, 3070
    expect(s.map((x) => x.offset)).toEqual([1000, 1010, 1030, 2000, 2040, 2090, 3000, 3070]);
    expect(s.map((x) => x.size)).toEqual(sizes);
    expect(s.map((x) => x.dts)).toEqual([0, 100, 200, 300, 400, 500, 600, 700]);
    expect(s.every((x) => x.duration === 100)).toBe(true);
  });

  test("stsc run change at chunk 2 with variable stts", () => {
    // stts: 2 samples delta 50 (dts 0,50) then 2 samples delta 30 (dts 100,130)
    const f = parseMp4(
      videoFile({
        stts: [
          [2, 50],
          [2, 30],
        ],
        stsc: [
          [1, 1],
          [2, 3],
        ],
        stco: [500, 900],
      }),
    );
    const s = first(f).samples;
    // chunk1 (1 sample, size 10) @500; chunk2 (3 samples, sizes 20,30,40) @900, 920, 950
    expect(s.map((x) => x.offset)).toEqual([500, 900, 920, 950]);
    expect(s.map((x) => x.dts)).toEqual([0, 50, 100, 130]);
    expect(s.map((x) => x.duration)).toEqual([50, 50, 30, 30]);
  });

  test("co64 offsets beyond 4 GiB", () => {
    const f = parseMp4(
      videoFile({
        szBox: stszUniform(16, 4),
        stsc: [[1, 2]],
        co64: [5_000_000_000, 6_000_000_000],
      }),
    );
    // uniform size 16, 2 per chunk
    expect(first(f).samples.map((x) => x.offset)).toEqual([5_000_000_000, 5_000_000_016, 6_000_000_000, 6_000_000_016]);
    expect(first(f).samples.every((x) => x.size === 16)).toBe(true);
  });

  test("ctts v0 unsigned", () => {
    // dts 0,100,200,300; offsets 200,100,0,0 -> cts 200,200,200,300
    const f = parseMp4(
      videoFile({
        ctts: ctts(0, [
          [1, 200],
          [1, 100],
          [2, 0],
        ]),
      }),
    );
    expect(first(f).samples.map((x) => x.cts)).toEqual([200, 200, 200, 300]);
  });

  test("ctts v1 negative offsets", () => {
    // offsets -50,-50,100,100 -> cts -50, 50, 300, 400
    const f = parseMp4(
      videoFile({
        ctts: ctts(1, [
          [2, -50],
          [2, 100],
        ]),
      }),
    );
    expect(first(f).samples.map((x) => x.cts)).toEqual([-50, 50, 300, 400]);
  });

  test("without ctts cts equals dts", () => {
    const s = first(parseMp4(videoFile())).samples;
    expect(s.map((x) => x.cts)).toEqual([0, 100, 200, 300]);
  });

  test("stss marks sync samples (1-based)", () => {
    const f = parseMp4(videoFile({ stss: [1, 3] }));
    expect(first(f).samples.map((x) => x.sync)).toEqual([true, false, true, false]);
  });

  test("missing stss means all sync", () => {
    expect(first(parseMp4(videoFile())).samples.every((x) => x.sync)).toBe(true);
  });
});

describe("track metadata", () => {
  test("ids, handler types, mdhd v0", () => {
    const aud = audioEntry("mp4a", 2, 44100, 0, esds(0x40, u8(0x12, 0x10)));
    const f = parseMp4(
      file(
        ftyp(),
        moov(
          trak({ id: 1, stbl: tables(avc1Entry()), timescale: 30000, duration: 123456 }),
          trak({ id: 2, handler: "soun", stbl: tables(aud), timescale: 44100 }),
          trak({ id: 3, handler: "text", stbl: tables(box("tx3g", zeros(20))) }),
        ),
      ),
    );
    expect(f.tracks.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(f.tracks.map((t) => t.type)).toEqual(["video", "audio", "other"]);
    expect(f.tracks[0]?.timescale).toBe(30000);
    expect(f.tracks[0]?.duration).toBe(123456);
    expect(f.tracks[1]?.timescale).toBe(44100);
    expect(f.tracks[2]?.codec).toBe("");
    expect(f.tracks[2]?.width).toBe(0);
  });

  test("tkhd v1 and mdhd v1 (64-bit duration)", () => {
    const f = parseMp4(videoFile({}, { v1: true, id: 7, duration: 5_000_000_000, timescale: 90000, matrix: [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000] }));
    const t = first(f);
    expect(t.id).toBe(7);
    expect(t.duration).toBe(5_000_000_000);
    expect(t.timescale).toBe(90000);
    expect(t.rotation).toBe(90);
  });

  test("rotation from the four matrices", () => {
    const P = 0x10000;
    expect(rot(mat(P, 0, 0, P))).toBe(0);
    expect(rot(mat(0, P, -P, 0))).toBe(90);
    expect(rot(mat(-P, 0, 0, -P))).toBe(180);
    expect(rot(mat(0, -P, P, 0))).toBe(270);
    // unknown combination (mirror) falls back to 0
    expect(rot(mat(-P, 0, 0, P))).toBe(0);
  });

  test("elst: empty edit then media edit", () => {
    // v0 entries: (dur 1000, media_time -1, rate 1.0), (dur 2000, media_time 480, rate 1.0)
    const rate = cat(u16(1), u16(0));
    const elst = full("elst", 0, 0, u32(2), u32(1000), i32(-1), rate, u32(2000), i32(480), rate);
    const t = first(parseMp4(videoFile({}, { elst })));
    expect(t.mediaStart).toBe(480);
  });

  test("elst v1 with 64-bit media_time", () => {
    const rate = cat(u16(1), u16(0));
    const elst = full("elst", 1, 0, u32(2), u64(1000), i64(-1), rate, u64(2000), i64(960), rate);
    expect(first(parseMp4(videoFile({}, { elst }))).mediaStart).toBe(960);
  });

  test("no elst gives mediaStart 0", () => {
    expect(first(parseMp4(videoFile())).mediaStart).toBe(0);
  });

  test("sampleTime subtracts mediaStart", () => {
    // timescale 600, deltas 600 -> dts 0,600,1200; mediaStart 480
    const rate = cat(u16(1), u16(0));
    const elst = full("elst", 0, 0, u32(1), u32(1000), i32(480), rate);
    const t = first(parseMp4(videoFile({ stts: [[4, 600]] }, { elst, timescale: 600 })));
    // (0-480)/600 = -0.8, (600-480)/600 = 0.2, (1200-480)/600 = 1.2
    expect(timeAt(t, 0)).toBeCloseTo(-0.8, 9);
    expect(timeAt(t, 1)).toBeCloseTo(0.2, 9);
    expect(timeAt(t, 2)).toBeCloseTo(1.2, 9);
  });
});

describe("video sample entries", () => {
  test("avc1 with avcC", () => {
    const entry = avc1Entry();
    const t = first(parseMp4(videoFile()));
    expect(t.fourcc).toBe("avc1");
    expect(t.width).toBe(1920);
    expect(t.height).toBe(1080);
    // avcC[1..3] = 0x64 0x00 0x1f -> "64" "00" "1f"
    expect(t.codec).toBe("avc1.64001f");
    expect(Array.from(t.description ?? [])).toEqual(Array.from(AVCC_BODY));
    expect(Array.from(t.sampleEntry)).toEqual(Array.from(entry));
    expect(t.channels).toBe(0);
    expect(t.sampleRate).toBe(0);
  });

  test("sampleEntry is a copy", () => {
    const bytes = videoFile();
    const t = first(parseMp4(bytes));
    const before = t.sampleEntry[0];
    bytes.fill(0);
    expect(t.sampleEntry[0]).toBe(before);
  });

  test("hvc1 entry gets codec and description", () => {
    const hvcC = u8(1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 93, 0xf0);
    const e = visualEntry("hvc1", 640, 360, box("hvcC", hvcC));
    const t = first(parseMp4(file(ftyp(), moov(trak({ stbl: tables(e) })))));
    expect(t.codec).toBe("hvc1.1.6.L93.B0");
    expect(Array.from(t.description ?? [])).toEqual(Array.from(hvcC));
  });

  test("vp09 entry", () => {
    const vpcC = u8(1, 0, 0, 0, 0, 10, 0x80, 0, 0, 0, 0, 0);
    const e = visualEntry("vp09", 640, 360, box("vpcC", vpcC));
    const t = first(parseMp4(file(ftyp(), moov(trak({ stbl: tables(e) })))));
    expect(t.codec).toBe("vp09.00.10.08");
    expect(t.description).toBeUndefined();
  });

  test("av01 entry", () => {
    const av1C = u8(0x81, 0x04, 0x00, 0x00);
    const e = visualEntry("av01", 640, 360, box("av1C", av1C));
    const t = first(parseMp4(file(ftyp(), moov(trak({ stbl: tables(e) })))));
    expect(t.codec).toBe("av01.0.04M.08");
    expect(Array.from(t.description ?? [])).toEqual(Array.from(av1C));
  });

  test("unknown video fourcc has empty codec", () => {
    const e = visualEntry("mp4v", 320, 240);
    const t = first(parseMp4(file(ftyp(), moov(trak({ stbl: tables(e) })))));
    expect(t.codec).toBe("");
    expect(t.width).toBe(320);
  });
});

describe("audio sample entries", () => {
  test("mp4a AAC-LC (AOT 2)", () => {
    // asc[0] = 0x12 = 00010 010 -> aot = 0x12 >> 3 = 2
    const t = audioTrack(audioEntry("mp4a", 2, 48000, 0, esds(0x40, u8(0x12, 0x10))));
    expect(t.codec).toBe("mp4a.40.2");
    expect(t.channels).toBe(2);
    expect(t.sampleRate).toBe(48000);
    expect(t.width).toBe(0);
    expect(t.description).toBeUndefined();
  });

  test("mp4a with 4-byte descriptor lengths", () => {
    const t = audioTrack(audioEntry("mp4a", 2, 44100, 0, esds(0x40, u8(0x12, 0x10), true)));
    expect(t.codec).toBe("mp4a.40.2");
    expect(t.sampleRate).toBe(44100);
  });

  test("mp4a HE-AAC (AOT 5)", () => {
    // 0x29 = 00101 001 -> aot 5
    expect(audioTrack(audioEntry("mp4a", 2, 48000, 0, esds(0x40, u8(0x29, 0x88)))).codec).toBe("mp4a.40.5");
  });

  test("mp4a escape AOT 31", () => {
    // asc = F9 40: first 5 bits 11111 = 31 -> escape. ext = ((0xF9 & 7) << 3) | (0x40 >> 5) = (1 << 3) | 2 = 10 -> 32 + 10 = 42
    expect(audioTrack(audioEntry("mp4a", 2, 48000, 0, esds(0x40, u8(0xf9, 0x40)))).codec).toBe("mp4a.40.42");
  });

  test("mp4a with no DecoderSpecificInfo defaults to AAC-LC", () => {
    expect(audioTrack(audioEntry("mp4a", 2, 48000, 0, esds(0x40, null))).codec).toBe("mp4a.40.2");
  });

  test("mp4a OTI 0x6B and 0x69 are mp3", () => {
    expect(audioTrack(audioEntry("mp4a", 2, 44100, 0, esds(0x6b, null))).codec).toBe("mp3");
    expect(audioTrack(audioEntry("mp4a", 2, 44100, 0, esds(0x69, null))).codec).toBe("mp3");
  });

  test("mp4a with unknown OTI has empty codec", () => {
    expect(audioTrack(audioEntry("mp4a", 2, 44100, 0, esds(0x20, null))).codec).toBe("");
  });

  test("Opus and fLaC entries", () => {
    const o = audioTrack(audioEntry("Opus", 2, 48000, 0, box("dOps", zeros(11))));
    expect(o.codec).toBe("opus");
    expect(o.fourcc).toBe("Opus");
    expect(o.sampleRate).toBe(48000);
    expect(audioTrack(audioEntry("fLaC", 2, 44100, 0, box("dfLa", zeros(8)))).codec).toBe("flac");
  });

  test("entry version 1 children start 16 bytes later", () => {
    const t = audioTrack(audioEntry("mp4a", 1, 22050, 1, esds(0x40, u8(0x12, 0x10))));
    expect(t.codec).toBe("mp4a.40.2");
    expect(t.channels).toBe(1);
    expect(t.sampleRate).toBe(22050);
  });

  test("entry version 2 uses float64 rate and u32 channels, children 36 bytes later", () => {
    // header fields say 3 channels and rate 1.0; the real values are 6 and 96000
    const t = audioTrack(audioEntry("mp4a", 6, 96000, 2, esds(0x40, u8(0x12, 0x10))));
    expect(t.codec).toBe("mp4a.40.2");
    expect(t.channels).toBe(6);
    expect(t.sampleRate).toBe(96000);
  });
});

describe("codec helpers", () => {
  test("avcCodec", () => {
    expect(avcCodec("avc1", u8(1, 0x64, 0x00, 0x1f))).toBe("avc1.64001f");
    // 0x42 0xE0 0x0A -> "42e00a"; avc3 prefix
    expect(avcCodec("avc3", u8(1, 0x42, 0xe0, 0x0a, 0xff))).toBe("avc3.42e00a");
    expect(avcCodec("avc1", u8(1, 0x64, 0))).toBe("");
  });

  test("hevcCodec Main example", () => {
    // space 0, tier 0, profile 1; compat 0x60000000 = bits 30,29 set; reversed (bit i -> 31-i) = bits 1,2 = 0x6
    // constraints B0 then zeros -> ".B0"; level 93 -> "L93"
    const b = u8(1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 93);
    expect(hevcCodec("hvc1", b)).toBe("hvc1.1.6.L93.B0");
  });

  test("hevcCodec Main10", () => {
    // profile_idc 2 (b[1] = 0x02, space 0, tier 0); compat 0x20000000 = bit 29 only; reversed -> bit 2 = 0x4
    // constraints 90 00 00 00 00 00 -> ".90"; level 120 -> "L120"
    const b = u8(1, 0x02, 0x20, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 120);
    expect(hevcCodec("hev1", b)).toBe("hev1.2.4.L120.90");
  });

  test("hevcCodec space, tier and no constraints", () => {
    // b[1] = 0x61 = 01 1 00001: space 1 -> "A", tier 1 -> "H", profile 1; compat 0x60000000 -> 6; no constraint bytes
    const b = u8(1, 0x61, 0x60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 93);
    expect(hevcCodec("hvc1", b)).toBe("hvc1.A1.6.H93");
  });

  test("hevcCodec multiple constraint bytes and short input", () => {
    // constraints 90 00 40 ... would need a padded zero; use 90 B0: last non-zero index 1 -> ".90.B0"
    const b = u8(1, 0x01, 0x60, 0, 0, 0, 0x90, 0xb0, 0, 0, 0, 0, 93);
    expect(hevcCodec("hvc1", b)).toBe("hvc1.1.6.L93.90.B0");
    expect(hevcCodec("hvc1", u8(1, 1, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0))).toBe("");
  });

  test("hevcCodec compat flags with a low bit", () => {
    // compat 0x00000001 = bit 0; reversed -> bit 31 = 0x80000000 -> "80000000"
    const b = u8(1, 0x01, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 90);
    expect(hevcCodec("hvc1", b)).toBe("hvc1.1.80000000.L90");
  });

  test("vp9Codec", () => {
    // [ver/flags x4][profile 0][level 10][bitDepth byte 0x80 -> 8]
    expect(vp9Codec(u8(1, 0, 0, 0, 0, 10, 0x80))).toBe("vp09.00.10.08");
    // profile 2, level 41, 0xA0 >> 4 = 10 bits
    expect(vp9Codec(u8(1, 0, 0, 0, 2, 41, 0xa0))).toBe("vp09.02.41.10");
  });

  test("av1Codec", () => {
    // b[1] = 0x04: profile 0, level 4; b[2] = 0: tier 0 (M), 8 bit
    expect(av1Codec(u8(0x81, 0x04, 0x00, 0x00))).toBe("av01.0.04M.08");
    // b[1] = 0x28 = 001 01000: profile 1, level 8; b[2] = 0xC0: tier 1 (H), high_bitdepth 1 -> 10 bit
    expect(av1Codec(u8(0x81, 0x28, 0xc0, 0x00))).toBe("av01.1.08H.10");
    // b[2] = 0xA0 = 1 0 1 ...: tier H, high 0, twelve 1 -> 12 bit
    expect(av1Codec(u8(0x81, 0x28, 0xa0, 0x00))).toBe("av01.1.08H.12");
  });
});
