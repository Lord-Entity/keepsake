import "./illustrations/illustrations.css";
import "./illustrations/Micro.css";
import type { CSSProperties } from "react";
import { MicroKipLoader } from "./illustrations/MicroKipLoader";

/**
 * Loaders, drawn in Kip's world: a little keepsake box that rolls around its track
 * (Spinner), a ribbon of tape that fills with a travelling shine (Bar), a heartbeat
 * dot cluster under skeleton lines (Pulse) and Kip himself hopping (KipLoader).
 * Motion lives in illustrations/Micro.css under prefers-reduced-motion: no-preference,
 * so reduced motion shows a calm static frame of each.
 */

export type LoaderTone = "accent" | "success" | "danger" | "muted";

const FILL: Record<LoaderTone, string> = {
  accent: "bg-accent",
  success: "bg-success",
  danger: "bg-danger",
  muted: "bg-fg-3",
};

/**
 * A tiny lidded box tumbling around a faint track, in currentColor (text-accent by
 * default), with a short trail behind it. Reduced motion: the box rests on top of
 * the track. `decorative` drops the status role for use inside a button or an
 * element that already announces itself.
 */
export function Spinner({
  size = 16,
  label = "Loading",
  className = "text-accent",
  decorative = false,
}: {
  size?: number;
  label?: string;
  className?: string;
  decorative?: boolean;
}) {
  const r = 8.5;
  const c = 2 * Math.PI * r;
  return (
    <svg
      role={decorative ? undefined : "status"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      focusable="false"
      className={`shrink-0 overflow-visible ${className}`}
    >
      <circle cx="12" cy="12" r={r} stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <g className="mc-spin-orbit">
        {/* Trail: the 65 degrees of track just behind the box (box sits at 12 o'clock). */}
        <circle
          cx="12"
          cy="12"
          r={r}
          stroke="currentColor"
          strokeOpacity="0.55"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${c * 0.18} ${c}`}
          strokeDashoffset={-c * (200 / 360)}
        />
        <g className="mc-spin-box">
          <rect x="8.7" y="3.3" width="6.6" height="4.4" rx="1.6" fill="currentColor" />
          <rect x="8.1" y="0" width="7.8" height="2.5" rx="1.15" fill="currentColor" />
        </g>
      </g>
    </svg>
  );
}

/** value: 0-100 for determinate, null/undefined for an indeterminate sweep. */
export function Bar({
  value = null,
  label,
  tone = "accent",
  className = "",
}: {
  value?: number | null;
  label?: string;
  tone?: LoaderTone;
  className?: string;
}) {
  const num = typeof value === "number" && Number.isFinite(value) ? value : null;
  const determinate = num !== null;
  const pct = num === null ? 0 : Math.max(0, Math.min(100, num));
  // Tape stripes and the shine only travel while work is under way; done/failed/queued sit still.
  const live = pct < 100 && (tone === "accent" || tone === "success");
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(pct) : undefined}
      className={`relative h-1.5 w-full overflow-hidden rounded-full bg-inset ${className}`}
    >
      {determinate ? (
        <div
          className={`mc-bar-fill absolute inset-0 overflow-hidden rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] ${FILL[tone]}`}
          style={{ "--mc-p": pct / 100 } as CSSProperties}
        >
          <span aria-hidden="true" className={`mc-tape absolute inset-0 ${live ? "mc-tape-live" : ""}`} />
          {live && <span aria-hidden="true" className="mc-shine mc-shine-live absolute inset-y-0 left-0 w-1/3" />}
        </div>
      ) : (
        <div className={`mc-sweep absolute inset-y-0 left-0 w-[30%] overflow-hidden rounded-full ${FILL[tone]}`}>
          <span aria-hidden="true" className="mc-tape mc-tape-live absolute inset-0" />
          <span aria-hidden="true" className="mc-knot absolute inset-y-[1px] right-[1px] aspect-square rounded-full" />
        </div>
      )}
    </div>
  );
}

const WIDTHS = ["100%", "86%", "92%", "64%", "78%"];

/**
 * Skeleton lines for preview loading, with a three-dot heartbeat trailing the last
 * line (same row, so the block keeps its height).
 */
export function Pulse({ lines = 3 }: { lines?: number }) {
  const n = Math.max(1, Math.floor(lines));
  return (
    <div aria-hidden="true" className="flex w-full flex-col gap-2">
      {Array.from({ length: n }, (_, i) => {
        const last = i === n - 1;
        const line = (key?: number) => (
          <span
            key={key}
            className="mc-shimmer block h-3 min-w-0 rounded-[var(--radius-sm)]"
            style={{
              width: last && n > 1 ? "56%" : WIDTHS[i % WIDTHS.length],
              animationDelay: `${i * 0.12}s`,
            }}
          />
        );
        if (!last) return line(i);
        return (
          <span key={i} className="flex h-3 w-full items-center gap-2.5">
            {n > 1 ? line() : <span className="min-w-0 flex-1">{line()}</span>}
            <span className="flex shrink-0 items-center gap-1">
              {[0, 1, 2].map((d) => (
                <span
                  key={d}
                  className={`mc-beat block size-1.5 rounded-full ${d === 1 ? "bg-[var(--ill-gold)]" : "bg-accent"}`}
                  style={{ animationDelay: `${d * 0.14}s` }}
                />
              ))}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export type KipLoaderSize = "sm" | "md" | "lg";

const KIP_PX: Record<KipLoaderSize, number> = { sm: 20, md: 40, lg: 72 };

/**
 * Kip hopping on the spot while a sparkle circles him: the friendly inline loader.
 * sm (20px) sits in a line of text, md (40px) in a card, lg (72px) in an empty pane.
 * Announces itself as a status unless `decorative`.
 */
export function KipLoader({
  size = "md",
  label = "Loading",
  className = "",
  decorative = false,
}: {
  size?: KipLoaderSize;
  label?: string;
  className?: string;
  decorative?: boolean;
}) {
  const px = KIP_PX[size];
  return (
    <span
      role={decorative ? undefined : "status"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: px, height: px }}
    >
      <MicroKipLoader size={px} />
    </span>
  );
}
