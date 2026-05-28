import { useState } from "react";
import { formatBytes, formatEta, formatSpeed, hostOf } from "../../state/format";
import { isActive, type Job } from "../../state/models";
import { Button, IconButton } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { DownloadStateArt, type DownloadArtState } from "../ui/illustrations/DownloadStateArt";
import { ProgressRing } from "./download/ProgressRing";
import { ProgressTrack } from "./download/ProgressTrack";
import { StatChip } from "./download/StatChip";
import { useTweenedNumber } from "./download/useTween";
import { actionsFor, artState, barPct, cancelOnDelete, friendly, isWorking, statusText, tone } from "./download/jobView";
import "./download/download-card.css";

const STATE_LABEL: Record<DownloadArtState, string> = {
  queued: "In line",
  fetching: "Fetching info",
  downloading: "Downloading",
  processing: "Finishing up",
  saving: "Saving",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const PILL_TONE: Record<ReturnType<typeof tone>, string> = {
  accent: "text-accent",
  success: "text-success",
  danger: "text-danger",
  muted: "text-fg-2",
};

/**
 * One download as an animated card: Kip's state scene over the thumbnail, title and host,
 * a shimmering progress track (+ ring on desktop), smoothly ticking speed / ETA / size
 * chips and the job's actions. Desktop is a horizontal card; `phone` stacks the scene on
 * top and gives every action a 48px target. Actions come from jobView.actionsFor, the
 * same list the compact row and the phone action sheet use.
 */
export function DownloadCard({ job, phone, canReveal = true }: { job: Job; phone?: boolean; canReveal?: boolean }) {
  const art = artState(job);
  const t = tone(job);
  const pct = barPct(job);
  const working = isWorking(job);
  const actions = actionsFor(job, canReveal);
  const [primary, ...rest] = actions;

  // "Retrying": a failed/cancelled job that was sent back to the queue, until it settles again.
  const [prevStatus, setPrevStatus] = useState(job.status);
  const [retrying, setRetrying] = useState(false);
  if (prevStatus !== job.status) {
    setPrevStatus(job.status);
    setRetrying(
      (job.status === "queued" && (prevStatus === "failed" || prevStatus === "cancelled")) ||
        (retrying && isActive(job.status)),
    );
  }

  const speed = useTweenedNumber(working ? job.speedBps : null);
  const eta = useTweenedNumber(working ? job.etaSec : null);
  const size = useTweenedNumber(job.totalBytes);
  const label = retrying && art === "queued" ? "Retrying" : job.status === "converting" ? "Converting" : job.status === "merging" ? "Merging" : STATE_LABEL[art];
  const host = hostOf(job.url) || job.site;
  const sub = [job.channel, host].filter(Boolean).join(" · ");

  return (
    <article
      tabIndex={0}
      aria-label={job.title}
      data-state={art}
      onKeyDown={(e) => cancelOnDelete(job, e)}
      className={`dlc-card card shape-drop card-lift flex min-w-0 overflow-hidden outline-offset-2 ${phone ? "flex-col" : "flex-row"} ${
        art === "failed" ? "dlc-card-danger" : art === "done" ? "dlc-card-success" : ""
      }`}
    >
      {/* Scene: thumbnail washed by the card colour, Kip's state art on top. */}
      <div
        className={`dlc-stage relative shrink-0 overflow-hidden ${phone ? "aspect-[2/1] w-full" : "min-h-[124px] w-[248px] self-stretch"}`}
      >
        {job.thumbnailUrl && (
          <img
            src={job.thumbnailUrl}
            alt=""
            draggable={false}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="dlc-thumb absolute inset-0 size-full object-cover"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        )}
        <div className="dlc-scrim absolute inset-0" />
        <DownloadStateArt state={art} progress={pct ?? 0} className="absolute inset-x-0 bottom-0" />
        <span className="dlc-glass absolute top-2 left-2 inline-flex h-6 max-w-[60%] items-center gap-1 rounded-full px-2 text-[10px] font-semibold tracking-[0.06em] text-fg uppercase">
          <Icon name={job.mode === "audio" ? "audio" : job.mode === "thumbnail" ? "image" : "video"} size={12} className="shrink-0" />
          <span className="truncate">{job.site}</span>
        </span>
        <span
          className={`dlc-glass absolute top-2 right-2 inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-[11px] font-semibold ${PILL_TONE[t]}`}
        >
          <span className={`dlc-dot ${working || art === "queued" ? "dlc-dot-live" : ""}`} />
          {label}
        </span>
      </div>

      <div className={`flex min-w-0 flex-1 flex-col gap-2 ${phone ? "p-4 pt-3" : "py-3 pr-3 pl-4"}`}>
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className={`text-[14px] leading-5 font-semibold ${phone ? "line-clamp-2" : "truncate"}`} title={job.title}>
              {job.title}
            </h3>
            <p className="truncate text-[12px] leading-4 text-fg-2" title={sub}>
              {sub || job.formatLabel}
            </p>
          </div>
          {!phone && <ProgressRing pct={pct} tone={t} size={44} />}
        </div>

        <div className="flex min-w-0 items-center gap-3">
          <ProgressTrack pct={pct} tone={t} label={job.title} active={working} className="flex-1" />
          {phone && (
            <span className="tabular w-10 shrink-0 text-right text-[12px] font-semibold">
              <RoundedPct pct={pct} />
            </span>
          )}
        </div>

        <p
          className={`min-w-0 truncate text-[12px] leading-4 ${t === "danger" ? "text-danger" : t === "success" ? "text-success" : "text-fg-2"}`}
          title={job.status === "failed" ? friendly(job) : statusText(job)}
        >
          {statusText(job)}
        </p>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {working && (
            <>
              <StatChip icon="bolt" minWidth="6.5rem" title="Speed">
                {formatSpeed(speed)}
              </StatChip>
              <StatChip icon="clock" minWidth="6.75rem" title="Time left">
                {formatEta(eta)}
              </StatChip>
            </>
          )}
          <StatChip icon="database" minWidth="5rem" title="Size">
            {formatBytes(size)}
          </StatChip>
          <StatChip icon="layers" title="Format" className="max-w-[12rem]">
            {job.formatLabel || job.ext.toUpperCase()}
          </StatChip>
        </div>

        {/* Live region: announces state changes only (never the ticking numbers). */}
        <span className="sr-only" aria-live="polite">
          {`${label}${art === "failed" ? `: ${friendly(job)}` : ""}`}
        </span>

        {primary && (
          <div className={`mt-auto flex min-w-0 items-center gap-1 ${phone ? "pt-1" : ""}`}>
            <Button
              variant={primary.icon === "retry" || primary.icon === "open" ? "primary" : "secondary"}
              size={phone ? "lg" : "md"}
              icon={primary.icon}
              disabled={primary.disabled}
              onClick={primary.run}
              title={primary.label === "Cancel" ? "Cancel (Delete)" : primary.label}
              className={phone ? "min-w-0 flex-1" : ""}
            >
              {primary.label}
            </Button>
            <div className={`flex shrink-0 items-center gap-0.5 ${phone ? "" : "ml-auto"}`}>
              {rest.map((a) => (
                <IconButton
                  key={a.label}
                  icon={a.icon}
                  label={a.label}
                  size={phone ? 48 : 36}
                  disabled={a.disabled}
                  onClick={a.run}
                  className={a.icon === "trash" ? "hover:text-danger" : ""}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

/** Tweened whole percent for the phone readout; fixed width so it never nudges the bar. */
function RoundedPct({ pct }: { pct: number | null }) {
  const shown = useTweenedNumber(pct);
  return <>{shown === null ? "--" : `${Math.round(shown)}%`}</>;
}
