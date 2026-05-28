/**
 * Pure geometry for the editor UI: crop presets, clamping, resize/move, even rounding,
 * screen <-> source mapping, zoom/pan and trim clamping. No DOM, no React: unit-testable.
 * All crop rects are in SOURCE pixels (MediaProbe width/height, display-oriented).
 */
import type { CropPreset, CropRect } from "../types";

export interface Size {
  width: number;
  height: number;
}

/** Screen = source * scale + (tx, ty), in stage CSS pixels. */
export interface View {
  scale: number;
  tx: number;
  ty: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export const CROP_PRESETS: readonly CropPreset[] = ["free", "original", "1:1", "4:5", "9:16", "16:9", "4:3", "3:4"];

/** Smallest crop side in source pixels (shrinks for tiny sources). */
export const MIN_CROP = 16;
/** Shortest trimmed clip, seconds. */
export const MIN_TRIM = 0.1;
/** Zoom range relative to the "fit" scale. */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Effective minimum side for a source size. */
export function minSide(size: Size): number {
  return Math.max(2, Math.min(MIN_CROP, size.width, size.height));
}

/** w/h ratio of a preset, or null for free crop. */
export function presetRatio(preset: CropPreset, size: Size): number | null {
  if (preset === "free") return null;
  if (preset === "original") return size.width > 0 && size.height > 0 ? size.width / size.height : null;
  const [a, b] = preset.split(":").map(Number);
  return a > 0 && b > 0 ? a / b : null;
}

export function fullRect(size: Size): CropRect {
  return { x: 0, y: 0, w: size.width, h: size.height };
}

export function isFullFrame(r: CropRect, size: Size, tolerance = 1): boolean {
  return r.x <= tolerance && r.y <= tolerance && r.x + r.w >= size.width - tolerance && r.y + r.h >= size.height - tolerance;
}

/** Keep a rect inside [0,width]x[0,height] with at least the minimum side. Size wins over position. */
export function clampRect(r: CropRect, size: Size): CropRect {
  const m = minSide(size);
  const w = clamp(Number.isFinite(r.w) ? r.w : size.width, m, size.width);
  const h = clamp(Number.isFinite(r.h) ? r.h : size.height, m, size.height);
  const x = clamp(Number.isFinite(r.x) ? r.x : 0, 0, size.width - w);
  const y = clamp(Number.isFinite(r.y) ? r.y : 0, 0, size.height - h);
  return { x, y, w, h };
}

/**
 * Integer source pixels; with `even` (video encoders need even sizes) width/height and
 * x/y are rounded down to even numbers. Result always lies inside the source.
 */
export function roundCrop(r: CropRect, size: Size, even: boolean): CropRect {
  const c = clampRect(r, size);
  const step = even ? 2 : 1;
  const down = (v: number) => Math.floor(v / step) * step;
  const maxW = down(size.width);
  const maxH = down(size.height);
  const w = clamp(down(Math.round(c.w)), step, maxW);
  const h = clamp(down(Math.round(c.h)), step, maxH);
  const x = clamp(down(Math.round(c.x)), 0, down(size.width - w));
  const y = clamp(down(Math.round(c.y)), 0, down(size.height - h));
  return { x, y, w: Math.max(2, w), h: Math.max(2, h) };
}

/** Largest rect of `ratio` that fits `size`, centred on `center` and shifted to stay inside. */
export function fitRatio(ratio: number, size: Size, center?: Point): CropRect {
  let w = size.width;
  let h = w / ratio;
  if (h > size.height) {
    h = size.height;
    w = h * ratio;
  }
  const cx = center?.x ?? size.width / 2;
  const cy = center?.y ?? size.height / 2;
  return clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }, size);
}

/** Crop to show after picking a preset: free keeps the current rect, others refit around its centre. */
export function applyPreset(current: CropRect, preset: CropPreset, size: Size): CropRect {
  const ratio = presetRatio(preset, size);
  if (ratio === null) return clampRect(current, size);
  if (preset === "original") return fullRect(size);
  return fitRatio(ratio, size, { x: current.x + current.w / 2, y: current.y + current.h / 2 });
}

/** Move by (dx, dy) source pixels, stopping at the edges. */
export function moveRect(start: CropRect, dx: number, dy: number, size: Size): CropRect {
  return {
    x: clamp(start.x + dx, 0, size.width - start.w),
    y: clamp(start.y + dy, 0, size.height - start.h),
    w: start.w,
    h: start.h,
  };
}

/**
 * Resize from a handle by (dx, dy) source pixels. The opposite edge/corner stays fixed.
 * With a ratio, corners follow the dominant drag axis and edges grow the other side
 * symmetrically; the result always fits the source and keeps the ratio.
 */
export function resizeRect(start: CropRect, handle: Handle, dx: number, dy: number, size: Size, ratio: number | null): CropRect {
  const m = minSide(size);
  const hasW = handle.includes("w");
  const hasE = handle.includes("e");
  const hasN = handle.includes("n");
  const hasS = handle.includes("s");
  let left = start.x;
  let right = start.x + start.w;
  let top = start.y;
  let bottom = start.y + start.h;

  if (ratio === null) {
    if (hasW) left = clamp(left + dx, 0, right - m);
    if (hasE) right = clamp(right + dx, left + m, size.width);
    if (hasN) top = clamp(top + dy, 0, bottom - m);
    if (hasS) bottom = clamp(bottom + dy, top + m, size.height);
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  const minW = Math.max(m, m * ratio);
  const corner = (hasW || hasE) && (hasN || hasS);
  if (corner) {
    // Anchor = opposite corner. Candidate width from x drag, or from y drag via ratio.
    const ax = hasW ? right : left;
    const ay = hasN ? bottom : top;
    const wx = hasW ? start.w - dx : start.w + dx;
    const wy = (hasN ? start.h - dy : start.h + dy) * ratio;
    let w = Math.abs(wx - start.w) >= Math.abs(wy - start.w) ? wx : wy;
    const maxW = Math.min(hasW ? ax : size.width - ax, (hasN ? ay : size.height - ay) * ratio);
    w = clamp(w, Math.min(minW, maxW), maxW);
    const h = w / ratio;
    return { x: hasW ? ax - w : ax, y: hasN ? ay - h : ay, w, h };
  }

  if (hasW || hasE) {
    // Horizontal edge drag; height follows, centred on the start's vertical middle.
    const ax = hasW ? right : left;
    const cy = start.y + start.h / 2;
    const maxW = Math.min(hasW ? ax : size.width - ax, Math.min(cy, size.height - cy) * 2 * ratio);
    const w = clamp(hasW ? start.w - dx : start.w + dx, Math.min(minW, maxW), maxW);
    const h = w / ratio;
    return { x: hasW ? ax - w : ax, y: cy - h / 2, w, h };
  }

  const ay = hasN ? bottom : top;
  const cx = start.x + start.w / 2;
  const maxH = Math.min(hasN ? ay : size.height - ay, (Math.min(cx, size.width - cx) * 2) / ratio);
  const h = clamp(hasN ? start.h - dy : start.h + dy, Math.min(minW / ratio, maxH), maxH);
  const w = h * ratio;
  return { x: cx - w / 2, y: hasN ? ay - h : ay, w, h };
}

/**
 * Draw a new crop by dragging from `anchor` to `to` (source pixels). The anchor corner stays put; the rect grows
 * toward the pointer, keeps `ratio` when set, never leaves the source and is at least the minimum side
 * (shifted inside when the anchor is too close to an edge).
 */
export function drawRect(anchor: Point, to: Point, size: Size, ratio: number | null): CropRect {
  const m = minSide(size);
  const ax = clamp(Number.isFinite(anchor.x) ? anchor.x : 0, 0, size.width);
  const ay = clamp(Number.isFinite(anchor.y) ? anchor.y : 0, 0, size.height);
  const tx = clamp(Number.isFinite(to.x) ? to.x : ax, 0, size.width);
  const ty = clamp(Number.isFinite(to.y) ? to.y : ay, 0, size.height);
  const sx = tx >= ax ? 1 : -1;
  const sy = ty >= ay ? 1 : -1;
  let w = Math.abs(tx - ax);
  let h = Math.abs(ty - ay);
  if (ratio === null || !(ratio > 0)) {
    w = Math.max(w, m);
    h = Math.max(h, m);
  } else {
    const roomX = sx > 0 ? size.width - ax : ax;
    const roomY = sy > 0 ? size.height - ay : ay;
    const minW = Math.max(m, m * ratio);
    w = Math.max(Math.min(Math.max(w, h * ratio), roomX, roomY * ratio), minW);
    h = w / ratio;
    if (w > size.width || h > size.height) {
      const f = fitRatio(ratio, size);
      w = f.w;
      h = f.h;
    }
  }
  return clampRect({ x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h }, size);
}

/** Scale and offset that fit the whole source inside the stage with `pad` CSS px around it. */
export function fitView(stage: Size, src: Size, pad = 24): View {
  const aw = Math.max(1, stage.width - pad * 2);
  const ah = Math.max(1, stage.height - pad * 2);
  const scale = src.width > 0 && src.height > 0 ? Math.min(aw / src.width, ah / src.height) : 1;
  return {
    scale,
    tx: (stage.width - src.width * scale) / 2,
    ty: (stage.height - src.height * scale) / 2,
  };
}

export function toScreen(p: Point, v: View): Point {
  return { x: p.x * v.scale + v.tx, y: p.y * v.scale + v.ty };
}

export function toSource(p: Point, v: View): Point {
  return { x: (p.x - v.tx) / v.scale, y: (p.y - v.ty) / v.scale };
}

export function rectToScreen(r: CropRect, v: View): CropRect {
  return { x: r.x * v.scale + v.tx, y: r.y * v.scale + v.ty, w: r.w * v.scale, h: r.h * v.scale };
}

/** Keep at least `keep` CSS px of the source visible inside the stage after a pan/zoom. */
export function clampView(v: View, stage: Size, src: Size, keep = 48): View {
  const w = src.width * v.scale;
  const h = src.height * v.scale;
  const kx = Math.min(keep, w, stage.width);
  const ky = Math.min(keep, h, stage.height);
  return {
    scale: v.scale,
    tx: clamp(v.tx, kx - w, stage.width - kx),
    ty: clamp(v.ty, ky - h, stage.height - ky),
  };
}

/** Zoom by `factor` around the stage point `at`, limited to [MIN_ZOOM, MAX_ZOOM] x fitScale. */
export function zoomAt(v: View, factor: number, at: Point, fitScale: number): View {
  const scale = clamp(v.scale * factor, fitScale * MIN_ZOOM, fitScale * MAX_ZOOM);
  const k = scale / v.scale;
  return { scale, tx: at.x - (at.x - v.tx) * k, ty: at.y - (at.y - v.ty) * k };
}

export function panBy(v: View, dx: number, dy: number): View {
  return { scale: v.scale, tx: v.tx + dx, ty: v.ty + dy };
}

/**
 * Clamp a trim edit. `which` is the handle that moved; the other one is pushed
 * (not past the ends) so the clip stays at least MIN_TRIM long.
 */
export function clampTrim(start: number, end: number, duration: number, which: "start" | "end"): [number, number] {
  const d = Math.max(0, duration);
  const gap = Math.min(MIN_TRIM, d);
  if (which === "start") {
    const s = clamp(start, 0, d - gap);
    return [s, clamp(Math.max(end, s + gap), s + gap, d)];
  }
  const e = clamp(end, gap, d);
  return [clamp(Math.min(start, e - gap), 0, e - gap), e];
}

/** m:ss.t (or h:mm:ss.t). */
export function formatTime(sec: number): string {
  const t = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const tenths = Math.floor(t * 10) % 10;
  const whole = Math.floor(t);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}.${tenths}` : `${m}:${ss}.${tenths}`;
}
