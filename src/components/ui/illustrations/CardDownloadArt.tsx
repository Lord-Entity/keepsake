import { Mascot, type MascotMood } from "./Mascot";
import "./CardDownloadArt.css";

export type CardDownloadState =
  | "queued"
  | "fetching"
  | "downloading"
  | "processing"
  | "saving"
  | "done"
  | "failed"
  | "cancelled"
  | "idle";

const C = 32;
const R = 29;

function mood(state: CardDownloadState): MascotMood {
  if (state === "queued" || state === "idle") return "sleepy";
  if (state === "done") return "joy";
  if (state === "failed") return "sad";
  return "happy";
}

function Ring({ state, progress }: { state: CardDownloadState; progress?: number }) {
  const common = { cx: C, cy: C, r: R, fill: "none", strokeWidth: 3.5, strokeLinecap: "round" as const, pathLength: 100 };
  const track = <circle {...common} stroke="var(--ill-paper-2)" />;
  if (state === "idle") return track;
  if (state === "downloading" && progress !== undefined) {
    const p = Math.max(0, Math.min(100, progress));
    return (
      <>
        {track}
        <circle
          {...common}
          className="cdl-arc"
          stroke="var(--ill-body)"
          strokeDasharray="100 100"
          strokeDashoffset={100 - p}
          transform={`rotate(-90 ${C} ${C})`}
        />
      </>
    );
  }
  if (state === "done" || state === "failed" || state === "cancelled") {
    const stroke = state === "done" ? "var(--ill-teal)" : state === "failed" ? "var(--ill-body-shade)" : "var(--ill-ink-soft)";
    return (
      <>
        {track}
        <circle {...common} className="cdl-arc" stroke={stroke} strokeDasharray={state === "failed" ? "5 4" : "100 100"} />
      </>
    );
  }
  return (
    <>
      {track}
      <g transform={`rotate(-90 ${C} ${C})`}>
        <circle {...common} className="cdl-spin" stroke="var(--ill-body)" strokeDasharray="22 78" />
      </g>
    </>
  );
}

function Extras({ state }: { state: CardDownloadState }) {
  const gold = "var(--ill-gold)";
  const sparkle = "M0 -5L1.5 -1.5L5 0L1.5 1.5L0 5L-1.5 1.5L-5 0L-1.5 -1.5Z";
  switch (state) {
    case "queued":
      return (
        <g fill="var(--ill-ink-soft)">
          {[26, 32, 38].map((x, i) => (
            <circle key={x} className="cdl-dot" cx={x} cy={10} r={1.7} style={{ animationDelay: `${i * 200}ms` }} />
          ))}
        </g>
      );
    case "fetching":
    case "downloading":
      return (
        <g transform="translate(32 11)">
          <path className="cdl-arrow" d="M-2.5 -4H2.5V0H5.5L0 6.5L-5.5 0H-2.5Z" fill={gold} />
        </g>
      );
    case "processing":
    case "saving":
      return (
        <g transform="translate(50 20)">
          <path className="cdl-gear" d={sparkle} fill={gold} />
        </g>
      );
    case "done":
      return (
        <g transform="translate(50 20)">
          <path className="ill-twinkle" d={sparkle} fill={gold} />
        </g>
      );
    case "failed":
      return (
        <g transform="translate(47 21)">
          <path className="cdl-drip" d="M0 -4Q3.5 0.5 0 3.2Q-3.5 0.5 0 -4Z" fill="var(--ill-teal-soft)" />
        </g>
      );
    case "cancelled":
      return (
        <path
          transform="translate(49 20)"
          d="M-3 -3L3 3M3 -3L-3 3"
          stroke="var(--ill-ink-soft)"
          strokeWidth={2}
          strokeLinecap="round"
        />
      );
    case "idle":
      return (
        <g transform="translate(47 19)">
          <path
            className="cdl-z"
            d="M-3 -3H3L-3 3H3"
            fill="none"
            stroke="var(--ill-ink-soft)"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      );
  }
}

/** Progress ring around a mini Kip, one pose per download state. */
export function CardDownloadArt({
  state,
  progress,
  size = 48,
  className = "",
}: {
  state: CardDownloadState;
  progress?: number;
  size?: number;
  className?: string;
}) {
  const busy = state === "fetching" || state === "downloading";
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ overflow: "visible" }}
    >
      <Ring state={state} progress={progress} />
      <g className={state === "done" ? "cdl-pop" : undefined}>
        <Mascot
          x={32}
          y={46}
          scale={0.44}
          mood={mood(state)}
          pose="rest"
          lid={busy ? "tip" : "on"}
          bob={busy}
          blink={false}
        />
      </g>
      <Extras state={state} />
    </svg>
  );
}
