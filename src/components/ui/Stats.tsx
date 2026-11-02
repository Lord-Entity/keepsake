import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Glyph } from "./Glyph";
import type { IconName } from "./Icon";
import { t } from "./motion";

/**
 * Stat card: organic shape, layered rim (.card), an SVG arc ornament pinned to the
 * top-right corner that turns on hover, a layered Glyph, and a big tabular value.
 */
export function StatCard({
  label,
  value,
  sub,
  icon,
  tint,
  shape = "leaf",
  className = "",
  style,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  icon: IconName;
  tint?: boolean;
  shape?: "leaf" | "drop" | "tab";
  className?: string;
  style?: CSSProperties;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      whileHover={reduced ? undefined : { y: -3 }}
      transition={t.spring}
      style={style}
      className={`card card-interactive glyph-host icon-host shape-${shape} relative flex min-w-0 flex-col justify-between gap-3 overflow-hidden p-4 ${tint ? "card-tint" : ""} ${className}`}
    >
      <svg aria-hidden="true" viewBox="0 0 80 80" className="stat-ornament pointer-events-none absolute -top-3 -right-3 size-20">
        <path d="M80 6A74 74 0 0 0 6 80" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M80 22A58 58 0 0 0 22 80" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 5" strokeLinecap="round" />
        <circle cx="64" cy="16" r="3" fill="currentColor" />
      </svg>
      <div className="flex items-center gap-2.5">
        <span className={tint ? "text-on-accent" : "text-accent"}>
          <Glyph icon={icon} size={15} box={30} />
        </span>
        <span className={`truncate text-[12px] font-medium ${tint ? "text-on-accent/85" : "text-fg-2"}`}>{label}</span>
      </div>
      <div className="min-w-0">
        <div className="tabular truncate text-[28px] leading-[32px] font-semibold tracking-[-0.02em]">{value}</div>
        {sub && <div className={`truncate text-[11px] leading-[14px] ${tint ? "text-on-accent/75" : "text-fg-3"}`}>{sub}</div>}
      </div>
    </motion.div>
  );
}

function dayLabel(day: string, style: "short" | "long"): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00` : day);
  if (Number.isNaN(d.getTime())) return day;
  return style === "short"
    ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

const GAP = 6;
const MAX_BAR = 28;

/** Top corners rounded (4px), flat on the baseline. */
function barPath(x: number, w: number, h: number, base: number): string {
  const r = Math.min(4, h / 2, w / 2);
  const y = base - h;
  return `M${x} ${base}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${base}Z`;
}

/**
 * 14-day activity: single-series SVG bar chart drawn at the container's real pixel
 * width (ResizeObserver), so bars stay crisp with true 4px rounded tops. Per-bar
 * hover tooltip with a hit target wider and taller than the bar.
 */
export function ActivityChart({ days, height = 120 }: { days: { day: string; count: number }[]; height?: number }) {
  const reduced = useReducedMotion();
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = days.length;
  const max = Math.max(1, ...days.map((d) => d.count));
  const total = days.reduce((acc, d) => acc + d.count, 0);
  const step = n ? w / n : 0;
  const bw = Math.max(2, Math.min(MAX_BAR, step - GAP));
  const base = height;
  const hd = hover === null ? null : days[hover];

  if (n === 0) return <p className="py-6 text-center text-fg-2">No activity yet</p>;

  return (
    <div className="flex flex-col gap-1.5">
      <div ref={box} className="relative" style={{ height }}>
        {w > 0 && (
          <svg
            width={w}
            height={height}
            viewBox={`0 0 ${w} ${height}`}
            className="block overflow-visible"
            role="img"
            aria-label={`Downloads per day over the last ${n} days, ${total} in total`}
            onMouseLeave={() => setHover(null)}
          >
            {[0.5, 1].map((f) => (
              <line key={f} x1={0} x2={w} y1={base - (base - 8) * f} y2={base - (base - 8) * f} stroke="var(--border)" strokeWidth={1} strokeDasharray="2 4" />
            ))}
            <line x1={0} x2={w} y1={base - 0.5} y2={base - 0.5} stroke="var(--border-strong)" strokeWidth={1} />
            {days.map((d, i) => {
              const x = i * step + (step - bw) / 2;
              const bh = d.count === 0 ? 2 : Math.max(4, (d.count / max) * (base - 8));
              const last = i === n - 1;
              const on = hover === i;
              return (
                <g key={d.day}>
                  <motion.path
                    className="chart-bar"
                    d={barPath(x, bw, bh, base)}
                    fill={d.count === 0 ? "var(--border-strong)" : on ? "var(--accent-hover)" : "var(--accent)"}
                    fillOpacity={d.count === 0 ? 1 : last || on ? 1 : 0.6}
                    style={{ originY: 1 }}
                    initial={reduced ? false : { scaleY: 0 }}
                    animate={{ scaleY: 1 }}
                    transition={{ ...t.spring, delay: reduced ? 0 : i * 0.025 }}
                  />
                  <rect x={i * step} y={0} width={step} height={base} fill="transparent" onMouseEnter={() => setHover(i)} />
                </g>
              );
            })}
          </svg>
        )}
        {hd && hover !== null && (
          <motion.div
            key={hover}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={t.fast}
            className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-[10px_10px_10px_3px] border border-line bg-card px-2 py-1 text-[11px] whitespace-nowrap shadow-pop"
            style={{
              left: Math.min(Math.max(hover * step + step / 2, 60), Math.max(60, w - 60)),
              top: Math.max(-30, base - (hd.count === 0 ? 2 : Math.max(4, (hd.count / max) * (base - 8))) - 34),
            }}
          >
            <span className="tabular font-semibold text-fg">{hd.count}</span>
            <span className="text-fg-2"> · {dayLabel(hd.day, "long")}</span>
          </motion.div>
        )}
      </div>
      <div className="flex justify-between text-[10px] text-fg-3">
        <span>{dayLabel(days[0].day, "short")}</span>
        <span>{dayLabel(days[Math.floor(n / 2)].day, "short")}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

export const CATEGORY_ORDER = ["YouTube", "Instagram", "TikTok", "Music", "Other"] as const;
export const CATEGORY_ICON: Record<string, IconName> = {
  YouTube: "play",
  Instagram: "camera",
  TikTok: "note",
  Music: "audio",
  Other: "globe",
};

/** Category breakdown: labelled horizontal bars in fixed category order (identity by label + icon, never colour). */
export function CategoryBars({
  items,
  onPick,
  active,
}: {
  items: { category: string; count: number }[];
  onPick?: (category: string) => void;
  active?: string;
}) {
  const reduced = useReducedMotion();
  const counts = new Map(items.map((i) => [i.category, i.count]));
  const rows = [
    ...CATEGORY_ORDER.map((c) => ({ category: c as string, count: counts.get(c) ?? 0 })),
    ...items.filter((i) => !(CATEGORY_ORDER as readonly string[]).includes(i.category)),
  ];
  const total = rows.reduce((n, r) => n + r.count, 0);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((r, i) => {
        const pct = total ? Math.round((r.count / total) * 100) : 0;
        const on = active === r.category;
        const body = (
          <>
            <Glyph icon={CATEGORY_ICON[r.category] ?? "globe"} size={14} box={26} on={on} sparks={false} />
            <span className="w-[72px] shrink-0 truncate text-[12px] font-medium">{r.category}</span>
            <span className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-inset">
              <motion.span
                className="absolute inset-y-0 left-0 rounded-full bg-accent"
                style={{ opacity: r.count ? 0.4 + 0.6 * (r.count / max) : 0 }}
                initial={reduced ? false : { width: 0 }}
                animate={{ width: `${(r.count / max) * 100}%` }}
                transition={{ ...t.spring, delay: reduced ? 0 : i * 0.04 }}
              />
            </span>
            <span className="tabular w-8 shrink-0 text-right text-[12px] font-semibold">{r.count}</span>
            <span className="tabular w-9 shrink-0 text-right text-[11px] text-fg-3">{pct}%</span>
          </>
        );
        return (
          <li key={r.category}>
            {onPick ? (
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onPick(r.category)}
                className={`glyph-host icon-host flex h-9 w-full items-center gap-2.5 rounded-[10px_10px_10px_4px] px-1.5 text-left transition-colors duration-150 ${
                  on ? "bg-accent-soft" : "hover:bg-card-hover"
                }`}
              >
                {body}
              </button>
            ) : (
              <div className="glyph-host icon-host flex h-9 items-center gap-2.5 px-1.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
