import { describe, expect, test } from "bun:test";
import {
  audioRange,
  avcCandidates,
  decodeEnd,
  decodeStart,
  encodeProgress,
  frameMatrix,
  trackFps,
  transcodeWebCodecs,
  videoBitrate,
  webCodecsCanEncode,
  webCodecsPresent,
} from "../engine-webcodecs";

const apply = (m, u, v) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];

/** Track with samples at the given (dts, cts, sync) in a 1000 Hz timescale, each 100 ticks long. */
const track = (rows, mediaStart = 0, type = "video") => ({
  id: 1,
  type,
  timescale: 1000,
  duration: rows.length * 100,
  fourcc: "avc1",
  sampleEntry: new Uint8Array(8),
  codec: "avc1.64001f",
  width: 1920,
  height: 1080,
  channels: 0,
  sampleRate: 0,
  rotation: 0,
  mediaStart,
  samples: rows.map(([dts, cts, sync], i) => ({ offset: i * 10, size: 10, dts, cts, duration: 100, sync })),
});

describe("avcCandidates (H.264 level table A-1)", () => {
  test("1080p30: 8160 MBs <= 8192 and 244800 MB/s <= 245760 -> level 4.0 (0x28), then 4.2 (0x2a)", () => {
    expect(avcCandidates(1920, 1080, 30)).toEqual(["avc1.640028", "avc1.64002a", "avc1.4d0028", "avc1.4d002a", "avc1.42e028", "avc1.42e02a"]);
  });
  test("720p30: exactly 3600 MBs and 108000 MB/s -> level 3.1 (0x1f), then 3.2", () => {
    expect(avcCandidates(1280, 720, 30).slice(0, 2)).toEqual(["avc1.64001f", "avc1.640020"]);
  });
  test("1080p60: 489600 MB/s needs level 4.2 (0x2a), then 5.0", () => {
    expect(avcCandidates(1920, 1080, 60).slice(0, 2)).toEqual(["avc1.64002a", "avc1.640032"]);
  });
  test("2160p30: 32400 MBs, 972000 MB/s -> level 5.1 (0x33), then 5.2", () => {
    expect(avcCandidates(3840, 2160, 30).slice(0, 2)).toEqual(["avc1.640033", "avc1.640034"]);
  });
  test("larger than every level falls back to 6.2 only", () => {
    expect(avcCandidates(16384, 16384, 60)).toEqual(["avc1.64003e", "avc1.4d003e", "avc1.42e03e"]);
  });
});

const crop = (x, y, w, h) => ({ x, y, w, h });

describe("frameMatrix maps raw decoded pixels to the cropped display", () => {
  test("rotation 0, same size: a plain offset", () => {
    const m = frameMatrix(crop(100, 50, 200, 100), 1920, 1080, 0, 1920, 1080);
    expect(apply(m, 100, 50)).toEqual([0, 0]);
    expect(apply(m, 300, 150)).toEqual([200, 100]);
  });
  test("rotation 0 with a different decoded size scales", () => {
    const m = frameMatrix(crop(0, 0, 1920, 1080), 1920, 1080, 0, 960, 540);
    expect(apply(m, 960, 540)).toEqual([1920, 1080]);
  });
  test("rotation 90 (phone portrait): raw 1920x1080 shown as 1080x1920", () => {
    const m = frameMatrix(crop(0, 0, 1080, 1920), 1080, 1920, 90, 1920, 1080);
    // Rotating 90 cw: raw top-left -> display top-right; raw bottom-left -> display top-left.
    expect(apply(m, 0, 0)).toEqual([1080, 0]);
    expect(apply(m, 0, 1080)).toEqual([0, 0]);
    expect(apply(m, 1920, 0)).toEqual([1080, 1920]);
  });
  test("rotation 90 with a crop offset", () => {
    const m = frameMatrix(crop(80, 400, 1000, 1000), 1080, 1920, 90, 1920, 1080);
    // raw (400, 1000) -> display (1080 - 1000, 400) = (80, 400) -> crop origin
    expect(apply(m, 400, 1000)).toEqual([0, 0]);
  });
  test("rotation 180: raw top-left -> display bottom-right", () => {
    const m = frameMatrix(crop(0, 0, 1920, 1080), 1920, 1080, 180, 1920, 1080);
    expect(apply(m, 0, 0)).toEqual([1920, 1080]);
    expect(apply(m, 1920, 1080)).toEqual([0, 0]);
  });
  test("rotation 270: raw top-left -> display bottom-left", () => {
    const m = frameMatrix(crop(0, 0, 1080, 1920), 1080, 1920, 270, 1920, 1080);
    expect(apply(m, 0, 0)).toEqual([0, 1920]);
    expect(apply(m, 1920, 0)).toEqual([0, 0]);
    expect(apply(m, 1920, 1080)).toEqual([1080, 0]);
  });
});

describe("timestamp mapping and ranges", () => {
  // Decode order I0 P3 B1 B2 I4 P5 (cts in units of 100 ticks = 0.1 s), with an edit list skipping 100 ticks.
  const t = track(
    [
      [0, 100, true],
      [100, 400, false],
      [200, 200, false],
      [300, 300, false],
      [400, 500, true],
      [500, 600, false],
    ],
    100,
  );
  // Presentation times (cts - 100) / 1000: 0, 0.3, 0.1, 0.2, 0.4, 0.5
  test("decodeStart: last sync sample presented at or before the start", () => {
    expect(decodeStart(t, 0)).toBe(0);
    expect(decodeStart(t, 0.35)).toBe(0);
    expect(decodeStart(t, 0.4)).toBe(4);
    expect(decodeStart(t, 9)).toBe(4);
  });
  test("decodeEnd: stop once every later sample is presented at or after the end", () => {
    expect(decodeEnd(t, 0.25)).toBe(4); // samples 0..3 include B2 at 0.2 (decoded after P3 at 0.3)
    expect(decodeEnd(t, 0.45)).toBe(5);
    expect(decodeEnd(t, 10)).toBe(6);
    expect(decodeEnd(t, 0)).toBe(0);
  });
  test("audioRange keeps samples overlapping [t0, end)", () => {
    const a = track(
      [0, 1, 2, 3, 4].map((i) => [i * 100, i * 100, true]),
      0,
      "audio",
    );
    // sample i covers [0.1 i, 0.1 i + 0.1)
    expect(audioRange(a, 0.15, 0.35).map((s) => s.dts)).toEqual([100, 200, 300]);
    expect(audioRange(a, 0.2, 0.3).map((s) => s.dts)).toEqual([200]);
  });
  test("trackFps from sample count over span", () => {
    expect(trackFps(t)).toBeCloseTo(6 / 0.6, 6);
  });
  test("encodeProgress clamps to 0..1", () => {
    expect(encodeProgress(1_500_000, 1_000_000, 2_000_000)).toBe(0.5);
    expect(encodeProgress(5_000_000, 1_000_000, 2_000_000)).toBe(1);
    expect(encodeProgress(0, 1_000_000, 2_000_000)).toBe(0);
    expect(encodeProgress(Number.NaN, 0, 1)).toBe(0);
    expect(encodeProgress(1, 5, 5)).toBe(0);
  });
  test("videoBitrate: 4 bits per pixel at 30 fps, clamped 1..40 Mb/s", () => {
    expect(videoBitrate(1920, 1080, 30)).toBe(8_294_400);
    expect(videoBitrate(1920, 1080, 60)).toBe(16_588_800);
    expect(videoBitrate(100, 100, 30)).toBe(1_000_000);
    expect(videoBitrate(7680, 4320, 60)).toBe(40_000_000);
  });
});

describe("detection without WebCodecs (bun has none)", () => {
  test("not present, cannot encode, transcode rejects unsupported", async () => {
    expect(webCodecsPresent()).toBe(false);
    expect(await webCodecsCanEncode()).toBe(false);
    const err = await transcodeWebCodecs({
      bytes: new Uint8Array(0),
      probe: { width: 2, height: 2, duration: 1, hasAudio: false, rotation: 0 },
      start: 0,
      end: 1,
      audio: false,
      onProgress: () => {},
      write: async () => {},
    }).catch((e) => e);
    expect(err.code).toBe("unsupported");
  });
});
