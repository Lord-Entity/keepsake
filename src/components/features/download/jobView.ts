/**
 * Presentation helpers shared by DownloadRow (compact list row) and DownloadCard.
 * Pure functions over a Job: the actions call the same store/native functions the
 * row always called, so behaviour stays identical wherever a download is shown.
 */
import type { AppErrorCode } from "../../../lib/types";
import { cancelJob, removeJob, retryJob } from "../../../state/downloads";
import { formatBytes } from "../../../state/format";
import type { Job } from "../../../state/models";
import { copyText, openFile, revealFile } from "../../../state/native";
import { navigate } from "../../../state/nav";
import type { IconName } from "../../ui/Icon";
import type { DownloadArtState } from "../../ui/illustrations/DownloadStateArt";
import type { ProgressTone } from "../../ui/Progress";

/** Friendly message only: the raw "(Details: ...)" tail stays behind "Copy error". */
export function friendly(j: Job): string {
  return (j.error?.message ?? "Unknown error").split(" (Details:")[0];
}

const FOLDER_CODES: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>(["no_space", "permission"]);
export const needsFolder = (j: Job) => (j.error ? FOLDER_CODES.has(j.error.code) : false);

export function statusText(j: Job): string {
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
export function barPct(j: Job): number | null {
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

export function tone(j: Job): ProgressTone {
  if (j.status === "done") return "success";
  if (j.status === "failed") return "danger";
  if (j.status === "cancelled" || j.status === "queued") return "muted";
  return "accent";
}

export const isWorking = (j: Job) => j.status === "downloading" || j.status === "merging" || j.status === "converting";

/**
 * Which illustration a job shows. Purely visual: "fetching" is a download that has not
 * reported any bytes yet, "saving" is the last sliver before the engine finishes.
 */
export function artState(j: Job): DownloadArtState {
  switch (j.status) {
    case "queued":
      return "queued";
    case "merging":
    case "converting":
      return "processing";
    case "downloading":
      if (j.pct === null && j.speedBps === null) return "fetching";
      if (j.pct !== null && j.pct >= 99.5) return "saving";
      return "downloading";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

export interface JobAction {
  icon: IconName;
  label: string;
  run: () => void;
  disabled?: boolean;
}

export function actionsFor(j: Job, canReveal: boolean): JobAction[] {
  switch (j.status) {
    case "queued":
    case "downloading":
    case "merging":
    case "converting":
      return [{ icon: "x", label: "Cancel", run: () => cancelJob(j.id) }];
    case "done": {
      const list: JobAction[] = [
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

/** Delete key cancels a queued or running job (same rule the row always had). */
export function cancelOnDelete(j: Job, e: { key: string; preventDefault: () => void }) {
  if (e.key === "Delete" && (isWorking(j) || j.status === "queued")) {
    e.preventDefault();
    cancelJob(j.id);
  }
}
