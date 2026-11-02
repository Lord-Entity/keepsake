/**
 * UI-side records. Engine shapes (VideoInfo, FormatOption, DownloadProgress,
 * BinaryStatus, AppError) come from src/lib/types.ts and are used directly.
 */
import type { AppError, AudioBitrate, DownloadMode, DownloadStatus } from "../lib/types";

export interface Job {
  id: string;
  url: string;
  title: string;
  channel: string | null;
  thumbnailUrl: string | null;
  site: string;
  mode: DownloadMode;
  formatId: string;
  formatLabel: string;
  ext: string;
  audioBitrate?: AudioBitrate;
  streamId?: string;
  status: DownloadStatus;
  /** 0-100, null when unknown. */
  pct: number | null;
  speedBps: number | null;
  etaSec: number | null;
  totalBytes: number | null;
  filePath: string | null;
  error: AppError | null;
  /** Playlist result line on success, e.g. "12 videos, 2 failed". */
  summary?: string;
  createdAt: number;
  finishedAt: number | null;
}

export interface LibraryItem {
  id: string;
  url: string;
  title: string;
  channel: string | null;
  site: string;
  mode: DownloadMode;
  formatId: string;
  format: string;
  status: "done" | "failed" | "cancelled";
  sizeBytes: number | null;
  filePath: string | null;
  thumbnailUrl: string | null;
  date: number;
}

export function isActive(s: DownloadStatus): boolean {
  return s === "queued" || s === "downloading" || s === "merging" || s === "converting";
}
