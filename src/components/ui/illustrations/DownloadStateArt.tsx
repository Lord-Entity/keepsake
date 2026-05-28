import type { CSSProperties } from "react";
import { DownloadingLayer, SavingLayer } from "./DownloadArtJourney";
import { DoneLayer, FailedLayer, ProcessingLayer } from "./DownloadArtFinale";
import { CancelledLayer, FetchingLayer, QueuedLayer } from "./DownloadArtWaiting";
import "./illustrations.css";
import "./download.css";

export type DownloadArtState =
  | "queued"
  | "fetching"
  | "downloading"
  | "processing"
  | "saving"
  | "done"
  | "failed"
  | "cancelled";

/**
 * Kip's little story for one download, one scene per state, in a 240 x 120 viewBox:
 * queued (waiting in line with a ticket), fetching (magnifying the link while bits orbit
 * a globe), downloading (carrying the parcel along a trail; `progress` moves Kip and
 * fills the ribbon), processing (taping and stitching the parcel), saving (sliding it
 * onto a shelf), done (check stamp and confetti), failed (tipped parcel and a friendly
 * retry badge), cancelled (a folded box).
 *
 * The svg root carries `--dsa-p` (progress 0..1) so CSS can glide Kip and the ribbon
 * without re-rendering the scene. Each state's layer is keyed, so a state change plays a
 * soft enter. All motion lives in download.css under prefers-reduced-motion:
 * no-preference; otherwise each state is a calm static pose that still shows progress.
 * Decorative: always aria-hidden, the card next to it carries the text and progressbar.
 *
 * `progress`: 0-100 (only "downloading" and "saving" use it). `size`: rendered width in px
 * (height follows the 2:1 viewBox); omit it to fill the container width.
 */
export function DownloadStateArt(props: {
  state: "queued" | "fetching" | "downloading" | "processing" | "saving" | "done" | "failed" | "cancelled";
  progress?: number;
  size?: number;
  className?: string;
}) {
  const { state, size, className = "" } = props;
  const raw = props.progress;
  const pct =
    state === "saving" || state === "done"
      ? 100
      : typeof raw === "number" && Number.isFinite(raw)
        ? Math.max(0, Math.min(100, raw))
        : 0;
  const style = { "--dsa-p": pct / 100, ...(size ? { width: size } : {}) } as CSSProperties;
  return (
    <svg
      viewBox="0 0 240 120"
      className={`ill dsa dsa-${state} ${className}`}
      style={style}
      focusable="false"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Backdrop: a low sky hill and the ground shadow Kip stands on (feet at y = 106). */}
      <path
        className="dsa-hill"
        d="M8 108C20 78 52 62 92 62C124 62 140 50 172 50C208 50 230 74 234 108Z"
        fill="var(--ill-sky)"
      />
      <ellipse cx={120} cy={107.5} rx={108} ry={5} fill="var(--ill-ground)" />
      <g key={state} className="dsa-layer">
        <Layer state={state} pct={pct} />
      </g>
    </svg>
  );
}

function Layer({ state, pct }: { state: DownloadArtState; pct: number }) {
  switch (state) {
    case "queued":
      return <QueuedLayer />;
    case "fetching":
      return <FetchingLayer />;
    case "downloading":
      return <DownloadingLayer progress={pct} />;
    case "processing":
      return <ProcessingLayer />;
    case "saving":
      return <SavingLayer />;
    case "done":
      return <DoneLayer />;
    case "failed":
      return <FailedLayer />;
    case "cancelled":
      return <CancelledLayer />;
  }
}
