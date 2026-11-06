/**
 * Loaders: SVG spinner, determinate/indeterminate bar, and skeleton lines.
 * Animations are CSS keyframes from theme.css (keepsake-spin / -sweep / -shimmer);
 * `.motion-safe-only` turns them off under prefers-reduced-motion.
 */

export type LoaderTone = "accent" | "success" | "danger" | "muted";

const FILL: Record<LoaderTone, string> = {
  accent: "bg-accent",
  success: "bg-success",
  danger: "bg-danger",
  muted: "bg-fg-3",
};

/**
 * Rotating arc in currentColor (text-accent by default). Under reduced motion it
 * stays still as a dashed ring. `decorative` drops the status role for use inside
 * a button or an element that already announces itself.
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
  const r = 9;
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
      className={`shrink-0 ${className}`}
    >
      <circle cx="12" cy="12" r={r} stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <circle
        className="ks-spin ks-spinner-arc motion-safe-only"
        cx="12"
        cy="12"
        r={r}
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${c * 0.3} ${c}`}
      />
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
          className={`absolute inset-0 origin-left rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] transition-[transform,background-color] duration-300 ease-out ${FILL[tone]}`}
          style={{ transform: `scaleX(${pct / 100})` }}
        />
      ) : (
        <div className={`ks-sweep motion-safe-only absolute inset-y-0 left-0 w-[30%] rounded-full ${FILL[tone]}`} />
      )}
    </div>
  );
}

const WIDTHS = ["100%", "86%", "92%", "64%", "78%"];

/** Skeleton shimmer lines for preview loading. */
export function Pulse({ lines = 3 }: { lines?: number }) {
  const n = Math.max(1, Math.floor(lines));
  return (
    <div aria-hidden="true" className="flex w-full flex-col gap-2">
      {Array.from({ length: n }, (_, i) => (
        <span
          key={i}
          className="ks-shimmer motion-safe-only block h-3 rounded-[var(--radius-sm)]"
          style={{ width: i === n - 1 && n > 1 ? "56%" : WIDTHS[i % WIDTHS.length] }}
        />
      ))}
    </div>
  );
}
