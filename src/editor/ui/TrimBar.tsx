import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { clampTrim, formatTime, MIN_TRIM } from "./crop-math";

type Grab = "start" | "end" | "seek";

/**
 * Video trim timeline: two handles (start / end, at least MIN_TRIM apart), the kept range
 * highlighted, and a playhead. Press anywhere else on the track to seek. Handles are
 * sliders: arrows step 0.1 s (Shift: 1 s), Home / End jump to the limits.
 */
export function TrimBar({
  duration,
  start,
  end,
  current,
  onChange,
  onSeek,
  phone,
  disabled,
}: {
  duration: number;
  start: number;
  end: number;
  current: number;
  onChange: (start: number, end: number) => void;
  onSeek: (t: number) => void;
  phone?: boolean;
  disabled?: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const grab = useRef<Grab | null>(null);
  const [active, setActive] = useState<Grab | null>(null);
  const d = duration > 0 ? duration : 0;
  const pct = (t: number) => (d > 0 ? `${(Math.min(Math.max(t, 0), d) / d) * 100}%` : "0%");

  const timeAt = (clientX: number) => {
    const b = track.current?.getBoundingClientRect();
    if (!b || b.width <= 0) return 0;
    return (Math.min(Math.max(clientX - b.left, 0), b.width) / b.width) * d;
  };

  const set = (which: "start" | "end", t: number) => {
    const [s, e] = clampTrim(which === "start" ? t : start, which === "end" ? t : end, d, which);
    onChange(s, e);
    onSeek(which === "start" ? s : e);
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || d <= 0) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-trim]");
    const which = (target?.dataset.trim as "start" | "end" | undefined) ?? "seek";
    target?.focus({ preventScroll: true });
    grab.current = which;
    setActive(which);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (which === "seek") onSeek(Math.min(Math.max(timeAt(e.clientX), start), end));
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (!g) return;
    const t = timeAt(e.clientX);
    if (g === "seek") onSeek(Math.min(Math.max(t, start), end));
    else set(g, t);
  };

  const onUp = () => {
    grab.current = null;
    setActive(null);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>, which: "start" | "end") => {
    const v = which === "start" ? start : end;
    const stepSize = e.shiftKey ? 1 : MIN_TRIM;
    let next: number | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = v - stepSize;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = v + stepSize;
    else if (e.key === "PageDown") next = v - 5;
    else if (e.key === "PageUp") next = v + 5;
    else if (e.key === "Home") next = which === "start" ? 0 : start + MIN_TRIM;
    else if (e.key === "End") next = which === "start" ? end - MIN_TRIM : d;
    if (next === null) return;
    e.preventDefault();
    set(which, next);
  };

  const h = phone ? 44 : 36;
  const handle = (which: "start" | "end") => {
    const v = which === "start" ? start : end;
    const label = which === "start" ? "Trim start" : "Trim end";
    return (
      <div
        data-trim={which}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={which === "start" ? 0 : Math.min(d, start + MIN_TRIM)}
        aria-valuemax={which === "start" ? Math.max(0, end - MIN_TRIM) : d}
        aria-valuenow={Math.round(v * 10) / 10}
        aria-valuetext={formatTime(v)}
        aria-disabled={disabled || undefined}
        title={`${label}: ${formatTime(v)}`}
        onKeyDown={(e) => onKey(e, which)}
        className="group absolute top-0 z-[2] flex h-full -translate-x-1/2 cursor-ew-resize items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent"
        style={{ left: pct(v), width: phone ? 32 : 22 }}
      >
        <span
          aria-hidden="true"
          className={`flex h-full w-3 items-center justify-center bg-accent shadow-[0_2px_8px_-2px_rgba(0,0,0,0.5)] transition-transform duration-150 group-hover:scale-x-125 ${
            which === "start" ? "rounded-l-md" : "rounded-r-md"
          } ${active === which ? "scale-x-125" : ""}`}
        >
          <span className="h-3.5 w-0.5 rounded-full bg-on-accent/80" />
        </span>
      </div>
    );
  };

  const kept = Math.max(0, end - start);
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${disabled ? "opacity-60" : ""}`}>
      <div
        ref={track}
        className={`relative touch-none select-none ${disabled ? "pointer-events-none" : "cursor-pointer"}`}
        style={{ height: h }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {/* Full track, then the kept range on top. */}
        <div className="absolute inset-x-0 top-1/2 h-[60%] -translate-y-1/2 rounded-md border border-line bg-inset" />
        <div
          className="absolute top-1/2 h-[60%] -translate-y-1/2 border-y-2 border-accent bg-accent-soft"
          style={{ left: pct(start), width: d > 0 ? `${(kept / d) * 100}%` : "0%" }}
        />
        {/* Playhead. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 z-[1] h-full w-0.5 -translate-x-1/2 rounded-full bg-fg shadow-[0_0_0_1px_rgba(0,0,0,0.25)]"
          style={{ left: pct(current) }}
        />
        {handle("start")}
        {handle("end")}
      </div>
      <div className="tabular flex items-center justify-between gap-2 text-[11px] text-fg-2">
        <span title="Start">{formatTime(start)}</span>
        <span className="text-fg-3">
          <span className="text-fg">{formatTime(kept)}</span> of {formatTime(d)}
        </span>
        <span title="End">{formatTime(end)}</span>
      </div>
    </div>
  );
}
