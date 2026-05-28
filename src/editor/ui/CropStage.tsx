import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../../components/ui/Icon";
import type { CropRect } from "../types";
import {
  clampView,
  fitView,
  HANDLES,
  moveRect,
  panBy,
  drawRect,
  isFullFrame,
  rectToScreen,
  resizeRect,
  toSource,
  zoomAt,
  type Handle,
  type Point,
  type Size,
  type View,
} from "./crop-math";

const HANDLE_LABEL: Record<Handle, string> = {
  n: "top edge",
  s: "bottom edge",
  e: "right edge",
  w: "left edge",
  ne: "top-right corner",
  nw: "top-left corner",
  se: "bottom-right corner",
  sw: "bottom-left corner",
};

const HANDLE_CURSOR: Record<Handle, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

const ZOOM_STEP = 1.25;

type Drag =
  | { kind: "move" | "resize"; handle: Handle | null; id: number; rect: CropRect; sx: number; sy: number }
  | { kind: "pan"; id: number; view: View; sx: number; sy: number }
  | { kind: "draw"; id: number; anchor: Point; sx: number; sy: number }
  | { kind: "pinch"; view: View; dist: number; mid: Point };

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Crop canvas. `children` is the media element sized to the source (it fills a box of
 * source.width x source.height CSS px that is scaled/panned here). The crop box, its
 * eight handles, pan (drag the backdrop), zoom (wheel, pinch, buttons) all map pointer
 * positions back to SOURCE pixels; `onChange` receives unrounded source-pixel rects.
 * Remount (key) per file so the view refits.
 */
export function CropStage({
  source,
  crop,
  ratio,
  onChange,
  children,
  phone,
  className = "",
  cropDisabled = false,
  readout,
}: {
  source: Size;
  crop: CropRect;
  ratio: number | null;
  onChange: (r: CropRect) => void;
  children: ReactNode;
  phone?: boolean;
  className?: string;
  /** Hide the crop frame and handles (cropping unavailable); pan and zoom still work. */
  cropDisabled?: boolean;
  /** Numeric size of the crop, e.g. "1280 × 720", shown as a chip. */
  readout?: string;
}) {
  const [coarse] = useState(() => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
  const ref = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const [dragging, setDragging] = useState<{ kind: Drag["kind"]; handle: Handle | null } | null>(null);
  const fitted = useRef(true);
  const pointers = useRef(new Map<number, Point>());
  const drag = useRef<Drag | null>(null);

  const sw = source.width;
  const sh = source.height;
  const src = useMemo<Size>(() => ({ width: sw, height: sh }), [sw, sh]);
  const fit = useMemo(() => fitView(stage, src, phone ? 12 : 24), [stage, src, phone]);
  const ready = stage.width > 0 && stage.height > 0 && sw > 0 && sh > 0;

  // Latest values for pointer handlers (they run between renders).
  const live = useRef({ view, crop, fit, stage, src, ratio, onChange });
  useLayoutEffect(() => {
    live.current = { view, crop, fit, stage, src, ratio, onChange };
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setStage((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Refit while the user has not zoomed or panned (first layout, window resizes).
  useEffect(() => {
    if (fitted.current) setView(fit);
  }, [fit]);

  const applyView = (next: View) => {
    fitted.current = false;
    setView(clampView(next, live.current.stage, live.current.src));
  };

  const zoomBy = (factor: number, at?: Point) => {
    const { view: v, stage: s, fit: f } = live.current;
    applyView(zoomAt(v, factor, at ?? { x: s.width / 2, y: s.height / 2 }, f.scale));
  };

  const resetView = () => {
    fitted.current = true;
    setView(live.current.fit);
  };

  // Wheel zoom needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015));
      const b = el.getBoundingClientRect();
      const { view: v, fit: f, stage: s, src: so } = live.current;
      fitted.current = false;
      setView(clampView(zoomAt(v, factor, { x: e.clientX - b.left, y: e.clientY - b.top }, f.scale), s, so));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const local = (e: PointerEvent): Point => {
    const b = ref.current?.getBoundingClientRect();
    return { x: e.clientX - (b?.left ?? 0), y: e.clientY - (b?.top ?? 0) };
  };

  const startDrag = (d: Drag | null) => {
    drag.current = d;
    setDragging(d ? { kind: d.kind, handle: d.kind === "resize" ? d.handle : null } : null);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!ready) return;
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    e.currentTarget.setPointerCapture(e.pointerId);
    const pts = [...pointers.current.values()];
    if (pts.length === 2) {
      startDrag({ kind: "pinch", view: live.current.view, dist: Math.max(1, dist(pts[0], pts[1])), mid: mid(pts[0], pts[1]) });
      return;
    }
    if (pts.length > 2) return;
    e.preventDefault();
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-handle]");
    const h = target?.dataset.handle;
    if (h === "move" && e.button !== 1 && isFullFrame(live.current.crop, live.current.src, 1)) {
      // The frame covers the whole picture, so a move is impossible: draw a new crop instead.
      const { view: v, src: so } = live.current;
      const a = toSource(p, v);
      const anchor = { x: Math.min(so.width, Math.max(0, a.x)), y: Math.min(so.height, Math.max(0, a.y)) };
      target?.focus({ preventScroll: true });
      startDrag({ kind: "draw", id: e.pointerId, anchor, sx: p.x, sy: p.y });
    } else if (h && e.button !== 1) {
      target?.focus({ preventScroll: true });
      startDrag({
        kind: h === "move" ? "move" : "resize",
        handle: h === "move" ? null : (h as Handle),
        id: e.pointerId,
        rect: live.current.crop,
        sx: p.x,
        sy: p.y,
      });
    } else {
      startDrag({ kind: "pan", id: e.pointerId, view: live.current.view, sx: p.x, sy: p.y });
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const d = drag.current;
    if (!d) return;
    const { view: v, fit: f, src: so, ratio: r, onChange: change } = live.current;
    if (d.kind === "pinch") {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const m = mid(pts[0], pts[1]);
      const z = zoomAt(d.view, dist(pts[0], pts[1]) / d.dist, d.mid, f.scale);
      applyView(panBy(z, m.x - d.mid.x, m.y - d.mid.y));
      return;
    }
    if (d.id !== e.pointerId) return;
    if (d.kind === "pan") {
      applyView(panBy(d.view, p.x - d.sx, p.y - d.sy));
      return;
    }
    if (d.kind === "draw") {
      if (Math.hypot(p.x - d.sx, p.y - d.sy) >= 4) change(drawRect(d.anchor, toSource(p, v), so, r));
      return;
    }
    const dx = (p.x - d.sx) / v.scale;
    const dy = (p.y - d.sy) / v.scale;
    change(d.kind === "move" || !d.handle ? moveRect(d.rect, dx, dy, so) : resizeRect(d.rect, d.handle, dx, dy, so, r));
  };

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const d = drag.current;
    const rest = [...pointers.current.entries()];
    // Lifting one finger of a pinch continues as a pan with the other, without a jump.
    if (d?.kind === "pinch" && rest.length === 1) {
      const [id, q] = rest[0];
      startDrag({ kind: "pan", id, view: live.current.view, sx: q.x, sy: q.y });
    } else if (rest.length === 0 || (d && d.kind !== "pinch" && d.id === e.pointerId)) {
      startDrag(null);
    }
  };

  const step = Math.max(1, Math.round(Math.max(sw, sh) / 200));
  const onKey = (e: KeyboardEvent<HTMLElement>, handle: Handle | null) => {
    const a = ARROWS[e.key];
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const k = e.shiftKey ? step * 10 : step;
    onChange(handle ? resizeRect(crop, handle, a[0] * k, a[1] * k, src, ratio) : moveRect(crop, a[0] * k, a[1] * k, src));
  };

  const box = rectToScreen(crop, view);
  const hit = phone || coarse ? 44 : 32;
  const fullCrop = isFullFrame(crop, src, 1);
  const showEdgesX = box.w > hit * 2.5; // n / s handles
  const showEdgesY = box.h > hit * 2.5; // e / w handles
  const zoomPct = Math.round(view.scale * 100);
  const dk = dragging?.kind ?? null;
  const cursor =
    dk === "pan" || dk === "pinch" ? "grabbing" : dk === "draw" ? "crosshair" : dk === "move" ? "move" : dragging?.handle ? HANDLE_CURSOR[dragging.handle] : "grab";

  return (
    <div
      ref={ref}
      role="application"
      aria-label={
        cropDisabled
          ? "Preview. Drag to pan; scroll or pinch to zoom."
          : "Crop area. Drag across the picture to draw a crop, drag the frame or its handles to adjust; drag the background to pan; scroll or pinch to zoom."
      }
      className={`relative touch-none overflow-hidden rounded-[14px] border border-line bg-[#0b0908] select-none ${className}`}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest("[data-handle],[data-toolbar]")) resetView();
      }}
    >
      {/* Checkerboard behind transparent photos. */}
      <div
        className="pointer-events-none absolute top-0 left-0 origin-top-left"
        style={{
          width: sw,
          height: sh,
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
          visibility: ready ? "visible" : "hidden",
          backgroundColor: "#2a2624",
          backgroundImage:
            "linear-gradient(45deg,#3a3532 25%,transparent 25%,transparent 75%,#3a3532 75%),linear-gradient(45deg,#3a3532 25%,transparent 25%,transparent 75%,#3a3532 75%)",
          backgroundSize: `${16 / view.scale}px ${16 / view.scale}px`,
          backgroundPosition: `0 0, ${8 / view.scale}px ${8 / view.scale}px`,
        }}
      >
        {children}
      </div>

      {ready && !cropDisabled && (
        <div
          data-handle="move"
          tabIndex={0}
          role="group"
          aria-label={`Crop frame, ${Math.round(crop.w)} by ${Math.round(crop.h)} pixels. Arrow keys move it, Shift for bigger steps.`}
          onKeyDown={(e) => onKey(e, null)}
          className="absolute outline-none focus-visible:ring-2 focus-visible:ring-accent"
          style={{
            left: box.x,
            top: box.y,
            width: box.w,
            height: box.h,
            cursor: dragging ? undefined : fullCrop ? "crosshair" : "move",
            boxShadow: "0 0 0 1px rgba(255,255,255,0.9), 0 0 0 100vmax rgba(0,0,0,0.55)",
          }}
        >
          {/* Rule-of-thirds guides. */}
          <div
            className={`pointer-events-none absolute inset-0 transition-opacity duration-150 ${dk === "move" || dk === "resize" || dk === "draw" ? "opacity-100" : "opacity-0"}`}
            aria-hidden="true"
          >
            <div className="absolute inset-y-0 left-1/3 w-px bg-white/45" />
            <div className="absolute inset-y-0 left-2/3 w-px bg-white/45" />
            <div className="absolute inset-x-0 top-1/3 h-px bg-white/45" />
            <div className="absolute inset-x-0 top-2/3 h-px bg-white/45" />
          </div>
          {HANDLES.map((h) => {
            const edge = h.length === 1;
            if (edge && (h === "n" || h === "s") && !showEdgesX) return null;
            if (edge && (h === "e" || h === "w") && !showEdgesY) return null;
            const left = h.includes("w") ? "0%" : h.includes("e") ? "100%" : "50%";
            const top = h.includes("n") ? "0%" : h.includes("s") ? "100%" : "50%";
            return (
              <div
                key={h}
                data-handle={h}
                tabIndex={0}
                role="button"
                aria-label={`Resize crop from the ${HANDLE_LABEL[h]}`}
                title={`Resize from the ${HANDLE_LABEL[h]}`}
                onKeyDown={(e) => onKey(e, h)}
                className="group absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent"
                style={{ left, top, width: hit, height: hit, cursor: HANDLE_CURSOR[h] }}
              >
                <HandleMark handle={h} big={hit >= 44} />
              </div>
            );
          })}
        </div>
      )}

      {ready && !cropDisabled && readout && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-2 left-2 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white tabular backdrop-blur-md"
        >
          {readout}
        </div>
      )}
      {ready && !cropDisabled && fullCrop && !dragging && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white tabular backdrop-blur-md"
        >
          Drag across the picture to crop
        </div>
      )}

      {ready && (
        <div
          data-toolbar
          className="absolute right-2 bottom-2 flex items-center gap-0.5 rounded-full bg-black/60 p-1 text-white shadow-[0_6px_18px_-8px_rgba(0,0,0,0.6)] backdrop-blur-md"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <ToolButton icon="minus" label="Zoom out" size={phone ? 40 : 30} onClick={() => zoomBy(1 / ZOOM_STEP)} />
          <span className="tabular min-w-[44px] text-center text-[11px] font-medium" aria-live="polite" aria-label={`Zoom ${zoomPct} percent`}>
            {zoomPct}%
          </span>
          <ToolButton icon="plus" label="Zoom in" size={phone ? 40 : 30} onClick={() => zoomBy(ZOOM_STEP)} />
          <button
            type="button"
            onClick={resetView}
            title="Fit to view"
            className={`rounded-full px-2.5 text-[11px] font-medium hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${phone ? "h-10" : "h-[30px]"}`}
          >
            Fit
          </button>
        </div>
      )}
    </div>
  );
}

function ToolButton({ icon, label, size, onClick }: { icon: IconName; label: string; size: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{ width: size, height: size }}
      className="inline-flex items-center justify-center rounded-full hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
    >
      <Icon name={icon} size={16} />
    </button>
  );
}

/** Visible part of a handle: an L for corners, a short bar for edges. */
function HandleMark({ handle, big = false }: { handle: Handle; big?: boolean }) {
  const bar = "absolute rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)] transition-transform duration-150 group-hover:scale-110";
  if (handle.length === 1) {
    const horizontal = handle === "n" || handle === "s";
    return <span aria-hidden="true" className={bar} style={horizontal ? { width: 22, height: 4 } : { width: 4, height: 22 }} />;
  }
  const L = big ? 20 : 16;
  const T = 4;
  // Corner arms run inward from the corner point (the centre of the hit box).
  const sx = handle.includes("w") ? 1 : -1;
  const sy = handle.includes("n") ? 1 : -1;
  return (
    <span aria-hidden="true" className="absolute top-1/2 left-1/2 h-0 w-0">
      <span className={bar} style={{ width: L, height: T, left: sx > 0 ? -T / 2 : -L + T / 2, top: -T / 2 }} />
      <span className={bar} style={{ width: T, height: L, left: -T / 2, top: sy > 0 ? -T / 2 : -L + T / 2 }} />
    </span>
  );
}
