import "./download-card.css";

export type TrackTone = "accent" | "success" | "danger" | "muted";

const FILL: Record<TrackTone, string> = {
  accent: "bg-accent",
  success: "bg-success",
  danger: "bg-danger",
  muted: "bg-fg-3",
};

const TEXT: Record<TrackTone, string> = {
  accent: "text-accent",
  success: "text-success",
  danger: "text-danger",
  muted: "text-fg-3",
};

export function ProgressTrack({
  pct,
  tone,
  label,
  active,
  className = "",
}: {
  pct: number | null;
  tone: TrackTone;
  label: string;
  active?: boolean;
  className?: string;
}) {
  const num = typeof pct === "number" && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={num === null ? undefined : Math.round(num)}
      aria-valuetext={num === null ? "Working" : `${Math.round(num)} percent`}
      className={`relative h-2 w-full overflow-hidden rounded-full bg-inset ${className}`}
    >
      {num === null ? (
        <>
          <div className="dlc-indet-static" />
          <div className={`dlc-indet-sweep ${FILL[tone]}`} />
        </>
      ) : (
        <>
          <div
            className={`dlc-fill absolute inset-0 rounded-full ${FILL[tone]}`}
            style={{ transform: `scaleX(${num / 100})` }}
          />
          {active && num > 0 && num < 100 && (
            <>
              {/* Transform-only (no width/left transitions): the window slides in from the left and
                  its content counter-slides, so the sheen stays aligned with the fill. */}
              <div className="dlc-sheen-wrap" style={{ transform: `translateX(${num - 100}%)` }}>
                <div className="dlc-sheen-counter" style={{ transform: `translateX(${100 - num}%)` }}>
                  <div className="dlc-sheen" />
                </div>
              </div>
              <div className="dlc-head-rail" style={{ transform: `translateX(${num}%)` }}>
                <div className={`dlc-head ${TEXT[tone]}`} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
