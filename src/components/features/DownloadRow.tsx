import { useState } from "react";
import type { AppErrorCode } from "../../lib/types";
import { cancelJob, removeJob, retryJob } from "../../state/downloads";
import { formatBytes, formatEta, formatPct, formatSpeed } from "../../state/format";
import type { Job } from "../../state/models";
import { copyText, openFile, revealFile } from "../../state/native";
import { navigate } from "../../state/nav";
import { IconButton } from "../ui/Button";
import type { IconName } from "../ui/Icon";
import { Progress, type ProgressTone } from "../ui/Progress";
import { ActionSheet, type SheetAction } from "../ui/Sheet";
import { Thumb } from "./PreviewCard";

/** Friendly message only: the raw "(Details: ...)" tail stays behind "Copy error". */
function friendly(j: Job): string {
  return (j.error?.message ?? "Unknown error").split(" (Details:")[0];
}

const FOLDER_CODES: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>(["no_space", "permission"]);
const needsFolder = (j: Job) => (j.error ? FOLDER_CODES.has(j.error.code) : false);

function statusText(j: Job): string {
  const stage = j.stage || undefined;
  switch (j.status) {
    case "queued":
      return "Queued";
    case "downloading":
      return `${stage ?? "Downloading"} · ${j.formatLabel}`;
    case "merging":
      return stage ?? "Merging";
    case "converting":
      return stage ?? "Converting";
    case "done":
      if (j.summary) return `Completed · ${j.summary}`;
      return `Completed · ${j.ext.toUpperCase()}${j.totalBytes ? ` · ${formatBytes(j.totalBytes)}` : ""}`;
    case "failed":
      return `Failed: ${friendly(j)}`;
    case "cancelled":
      return "Cancelled";
  }
}

/** Bar value: null = indeterminate shimmer, number = filled bar. */
function barPct(j: Job): number | null {
  switch (j.status) {
    case "done":
      return 100;
    case "queued":
      return 0;
    case "merging":
    case "converting":
      return null;
    case "downloading":
      return j.pct;
    case "failed":
    case "cancelled":
      return j.pct ?? 0;
  }
}

function tone(j: Job): ProgressTone {
  if (j.status === "done") return "success";
  if (j.status === "failed") return "danger";
  if (j.status === "cancelled" || j.status === "queued") return "muted";
  return "accent";
}

interface Action {
  icon: IconName;
  label: string;
  run: () => void;
  disabled?: boolean;
}

function actionsFor(j: Job, canReveal: boolean): Action[] {
  switch (j.status) {
    case "queued":
    case "downloading":
    case "merging":
    case "converting":
      return [{ icon: "x", label: "Cancel", run: () => cancelJob(j.id) }];
    case "done": {
      const list: Action[] = [
        { icon: "open", label: "Open", run: () => j.filePath && void openFile(j.filePath), disabled: !j.filePath },
      ];
      if (canReveal) {
        list.push({
          icon: "folder",
          label: "Show in folder",
          run: () => j.filePath && void revealFile(j.filePath),
          disabled: !j.filePath,
        });
      }
      list.push({ icon: "trash", label: "Remove from list", run: () => removeJob(j.id) });
      return list;
    }
    case "failed":
      return [
        { icon: "retry", label: "Retry", run: () => retryJob(j.id) },
        ...(needsFolder(j)
          ? [{ icon: "folder" as IconName, label: "Choose another folder", run: () => navigate("settings") }]
          : []),
        {
          icon: "copy",
          label: "Copy error",
          run: () => void copyText(j.error?.detail ?? j.error?.message ?? ""),
        },
        { icon: "trash", label: "Remove from list", run: () => removeJob(j.id) },
      ];
    case "cancelled":
      return [
        { icon: "retry", label: "Retry", run: () => retryJob(j.id) },
        { icon: "trash", label: "Remove from list", run: () => removeJob(j.id) },
      ];
  }
}

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
  const [menu, setMenu] = useState(false);
  const pct = barPct(job);
  const actions = actionsFor(job, canReveal);
  const active = job.status === "downloading" || job.status === "merging" || job.status === "converting";

  return (
    <div
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Delete" && (active || job.status === "queued")) {
          e.preventDefault();
          cancelJob(job.id);
        }
      }}
      className={`group flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-lg px-1.5 outline-offset-[-2px] transition-[background-color,transform] duration-200 hover:bg-card-hover active:scale-[0.98] ${compact ? "h-14" : "h-[72px]"}`}
    >
      <Thumb
        src={job.thumbnailUrl}
        icon={job.mode === "audio" ? "audio" : job.mode === "thumbnail" ? "image" : "video"}
        className={`shrink-0 rounded-[10px] ${compact ? "size-10" : "size-12"}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-[13px] font-medium" title={job.title}>
            {job.title}
          </span>
          {!compact && job.channel && !phone && (
            <span className="max-w-[40%] min-w-0 shrink-0 truncate text-[11px] text-fg-2" title={job.channel}>
              {job.channel}
            </span>
          )}
        </div>
        <Progress pct={pct} tone={tone(job)} label={job.title} />
        <div className="flex min-w-0 items-center gap-2 text-[11px] leading-[14px]">
          <span
            role={job.status === "done" ? "status" : undefined}
            className={`min-w-0 truncate ${job.status === "failed" ? "text-danger" : job.status === "done" ? "text-success" : "text-fg-2"}`}
            title={job.status === "failed" ? friendly(job) : undefined}
          >
            {statusText(job)}
          </span>
          {!phone && !compact && job.status === "failed" && (
            <>
              <button type="button" className="shrink-0 font-medium text-accent hover:underline" onClick={() => retryJob(job.id)}>
                Retry
              </button>
              {needsFolder(job) && (
                <button
                  type="button"
                  className="shrink-0 font-medium text-accent hover:underline"
                  onClick={() => navigate("settings")}
                >
                  Choose another folder
                </button>
              )}
            </>
          )}
          {!phone && !compact && job.status === "done" && job.filePath && (
            <>
              <button
                type="button"
                className="shrink-0 font-medium text-accent hover:underline"
                onClick={() => void openFile(job.filePath!)}
              >
                Open
              </button>
              {canReveal && (
                <button
                  type="button"
                  className="shrink-0 font-medium text-accent hover:underline"
                  onClick={() => void revealFile(job.filePath!)}
                >
                  Show in folder
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {!phone && !compact && (
        <div className="tabular flex w-40 min-w-0 shrink-0 flex-col items-end overflow-hidden text-[11px] leading-[14px] whitespace-nowrap text-fg-2">
          <span className="max-w-full truncate text-[13px] font-medium text-fg">
            {job.status === "done" ? "100%" : formatPct(job.pct)}
          </span>
          {active && (
            <span className="max-w-full truncate" title={`${formatSpeed(job.speedBps)} · ${formatEta(job.etaSec)}`}>
              {formatSpeed(job.speedBps)} · {formatEta(job.etaSec)}
            </span>
          )}
          <span className="max-w-full truncate">{formatBytes(job.totalBytes)}</span>
        </div>
      )}
      {compact && !phone && (
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
          {(compact ? actions.slice(0, 1) : actions).map((a) => (
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
