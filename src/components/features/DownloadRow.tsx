import { useState } from "react";
import { formatPct } from "../../state/format";
import type { Job } from "../../state/models";
import { IconButton } from "../ui/Button";
import { Progress } from "../ui/Progress";
import { ActionSheet, type SheetAction } from "../ui/Sheet";
import { DownloadCard } from "./DownloadCard";
import { actionsFor, barPct, cancelOnDelete, friendly, statusText, tone } from "./download/jobView";
import { Thumb } from "./PreviewCard";

/**
 * One download in a list. `compact` is the slim row (Home's queue strip); without it the
 * job renders as the full animated DownloadCard, so every caller keeps working unchanged.
 */
export function DownloadRow({
  job,
  compact,
  phone,
  canReveal = true,
}: {
  job: Job;
  compact?: boolean;
  phone?: boolean;
  canReveal?: boolean;
}) {
  if (!compact) return <DownloadCard job={job} phone={phone} canReveal={canReveal} />;
  return <CompactRow job={job} phone={phone} canReveal={canReveal} />;
}

/** The slim 56px row: thumbnail, title, bar, status and the first action (or the phone menu). */
function CompactRow({ job, phone, canReveal }: { job: Job; phone?: boolean; canReveal: boolean }) {
  const [menu, setMenu] = useState(false);
  const actions = actionsFor(job, canReveal);

  return (
    <div
      tabIndex={0}
      onKeyDown={(e) => cancelOnDelete(job, e)}
      className="group flex h-14 w-full min-w-0 items-center gap-3 overflow-hidden rounded-lg px-1.5 outline-offset-[-2px] transition-[background-color,transform] duration-200 hover:bg-card-hover active:scale-[0.98]"
    >
      <Thumb
        src={job.thumbnailUrl}
        icon={job.mode === "audio" ? "audio" : job.mode === "thumbnail" ? "image" : "video"}
        className="size-10 shrink-0 rounded-[10px]"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="min-w-0 truncate text-[13px] font-medium" title={job.title}>
          {job.title}
        </span>
        <Progress pct={barPct(job)} tone={tone(job)} label={job.title} />
        <span
          role={job.status === "done" ? "status" : undefined}
          className={`min-w-0 truncate text-[11px] leading-[14px] ${job.status === "failed" ? "text-danger" : job.status === "done" ? "text-success" : "text-fg-2"}`}
          title={job.status === "failed" ? friendly(job) : undefined}
        >
          {statusText(job)}
        </span>
      </div>
      {!phone && (
        <span className="tabular w-12 shrink-0 text-right text-[12px] font-medium whitespace-nowrap">
          {job.pct !== null ? formatPct(job.pct) : ""}
        </span>
      )}
      {phone ? (
        <>
          <IconButton icon="more" label="Actions" size={48} className="-mr-1.5 shrink-0" onClick={() => setMenu(true)} />
          {/* Centered action modal (portaled), not a bottom sheet. */}
          <ActionSheet
            open={menu}
            onClose={() => setMenu(false)}
            title={job.title}
            actions={actions.map<SheetAction>((a) => ({
              label: a.label,
              icon: a.icon,
              onSelect: a.run,
              disabled: a.disabled,
              danger: a.icon === "trash",
            }))}
          />
        </>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          {actions.slice(0, 1).map((a) => (
            <IconButton
              key={a.label}
              icon={a.icon}
              label={a.label === "Cancel" ? "Cancel (Delete)" : a.label}
              size={32}
              disabled={a.disabled}
              onClick={a.run}
            />
          ))}
        </div>
      )}
    </div>
  );
}
