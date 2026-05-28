import "./download-card.css";
import type { TrackTone } from "./ProgressTrack";
import { useTweenedNumber } from "./useTween";

const STROKE: Record<TrackTone, string> = {
  accent: "var(--accent)",
  success: "var(--success)",
  danger: "var(--danger)",
  muted: "var(--text-muted)",
};

export function ProgressRing({
  pct,
  tone,
  size = 44,
  className = "",
}: {
  pct: number | null;
  tone: TrackTone;
  size?: number;
  className?: string;
}) {
  const num = typeof pct === "number" && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
  const shown = useTweenedNumber(num);
  const sw = 4;
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const indeterminate = num === null;
  const offset = indeterminate ? 0 : c * (1 - (num ?? 0) / 100);
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" className="absolute inset-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--border)" strokeWidth={sw} />
        <circle
          className={`dlc-ring-arc ${indeterminate ? "dlc-ring-spin" : ""}`}
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={STROKE[tone]}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={indeterminate ? `${c * 0.25} ${c}` : c}
          strokeDashoffset={offset}
        />
      </svg>
      {tone === "success" ? (
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" className="relative" stroke="var(--success)">
          <path className="dlc-check" d="M5 12l5 5L20 7" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <span className="tabular relative inline-block w-[3ch] text-center text-[11px] font-semibold text-fg-2">
          {shown === null ? "--" : Math.round(shown)}
        </span>
      )}
    </span>
  );
}
