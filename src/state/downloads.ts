import type { AudioBitrate, DownloadHandle, DownloadProgress, FormatOption, VideoInfo } from "../lib/types";
import { asAppError, startDownload } from "./engine";
import { addLibraryItem } from "./library";
import { navigate } from "./nav";
import { notify } from "./toast";
import { isActive, type Job } from "./models";
import { settingsStore } from "./settings";
import { createStore, useStore } from "./store";

export const downloadsStore = createStore<Job[]>([]);

const handles = new Map<string, DownloadHandle>();
/** Requests kept for Retry; holds the fetched info so Android/web skip a re-fetch. */
const infos = new Map<string, VideoInfo | undefined>();

function patch(id: string, p: Partial<Job>) {
  downloadsStore.set((jobs) => {
    const i = jobs.findIndex((j) => j.id === id);
    if (i < 0) return jobs;
    const cur = jobs[i];
    // Progress lines often repeat the same values; skip them so subscribers do not re-render for nothing.
    if ((Object.keys(p) as (keyof Job)[]).every((k) => Object.is(cur[k], p[k]))) return jobs;
    const next = jobs.slice();
    next[i] = { ...cur, ...p };
    return next;
  });
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

export function enqueue(
  info: VideoInfo,
  choice: { format: FormatOption; audioBitrate?: AudioBitrate; streamId?: string },
): string {
  const { format, audioBitrate, streamId } = choice;
  const id = newId();
  infos.set(id, info);
  const job: Job = {
    id,
    url: info.url,
    title: info.title,
    channel: info.channel ?? null,
    thumbnailUrl: info.thumbnails[0]?.url ?? null,
    site: info.site,
    mode: format.mode,
    formatId: format.id,
    formatLabel: audioBitrate ? `${format.label} ${audioBitrate} kbps` : format.label,
    ext: format.ext,
    audioBitrate,
    streamId,
    status: "queued",
    pct: null,
    speedBps: null,
    etaSec: null,
    totalBytes: null,
    filePath: null,
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
  };
  downloadsStore.set((jobs) => [job, ...jobs]);
  pump();
  return id;
}

/** Counter-based dispatcher: the limit is read on every pump, so it can change at runtime. */
function pump() {
  const limit = settingsStore.get().parallelDownloads;
  const jobs = downloadsStore.get();
  let running = jobs.filter((j) => handles.has(j.id)).length;
  // Oldest queued first.
  for (let i = jobs.length - 1; i >= 0; i--) {
    const job = jobs[i];
    if (running >= limit) break;
    if (job.status !== "queued" || handles.has(job.id)) continue;
    run(job);
    running++;
  }
}

settingsStore.subscribe(pump);

function run(job: Job) {
  const s = settingsStore.get();
  let handle: DownloadHandle;
  try {
    handle = startDownload(
      {
        id: job.id,
        url: job.url,
        info: infos.get(job.id),
        mode: job.mode,
        formatId: job.formatId,
        audioBitrate: job.audioBitrate,
        streamId: job.streamId,
        preferH264: s.preferH264,
        embedThumbnail: s.embedThumbnail,
        embedVideoMeta: s.embedVideoMeta,
        outputDir: s.saveDir || undefined,
        cookiesBrowser: s.cookiesBrowser,
      },
      (p) => onProgress(job.id, p),
    );
  } catch (e) {
    finish(job.id, { id: job.id, status: "failed", downloadedBytes: 0, error: asAppError(e) });
    return;
  }
  handles.set(job.id, handle);
  patch(job.id, { status: "downloading" });
  void handle.done.then((last) => finish(job.id, last));
}

function onProgress(id: string, p: DownloadProgress) {
  const job = downloadsStore.get().find((j) => j.id === id);
  if (!job || !isActive(job.status)) return;
  patch(id, {
    status: p.status,
    pct: p.percent ?? (p.totalBytes ? (p.downloadedBytes / p.totalBytes) * 100 : null),
    speedBps: p.speedBps ?? null,
    etaSec: p.etaSec ?? null,
    totalBytes: p.totalBytes ?? job.totalBytes,
    filePath: p.filePath ?? job.filePath,
  });
}

function finish(id: string, last: DownloadProgress) {
  handles.delete(id);
  const job = downloadsStore.get().find((j) => j.id === id);
  if (!job) {
    pump();
    return;
  }
  const status = last.status === "done" || last.status === "cancelled" ? last.status : "failed";
  const done: Job = {
    ...job,
    status,
    pct: status === "done" ? 100 : job.pct,
    speedBps: null,
    etaSec: null,
    totalBytes: last.totalBytes ?? job.totalBytes ?? (last.downloadedBytes || null),
    filePath: last.filePath ?? job.filePath,
    error: status === "failed" ? (last.error ?? asAppError("Download failed")) : null,
    // Desktop playlists: the engine puts "N videos, M failed" in error.message on a done result.
    // last.note: e.g. "Retried with cookies from Edge" after the automatic cookie fallback.
    summary:
      status !== "done"
        ? undefined
        : [
            last.playlistCount && last.playlistCount > 1 ? (last.error?.message ?? `${last.playlistCount} videos`) : "",
            last.note ?? "",
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
    finishedAt: Date.now(),
  };
  patch(id, done);
  if (status === "done") {
    notify({
      tone: "success",
      title: "Saved to your library",
      body: done.summary ? `${done.title} · ${done.summary}` : done.title,
      action: { label: "Open downloads", run: () => navigate("downloads") },
    });
  } else if (status === "failed") {
    notify({
      tone: "error",
      title: "Download failed",
      body: `${done.title}: ${done.error?.message ?? "Unknown error"}`,
      duration: 6000,
    });
  }
  if (status !== "cancelled") {
    addLibraryItem({
      id: done.id,
      url: done.url,
      title: done.title,
      channel: done.channel,
      site: done.site,
      mode: done.mode,
      formatId: done.formatId,
      format: done.ext.toUpperCase(),
      status,
      sizeBytes: done.totalBytes,
      filePath: done.filePath,
      thumbnailUrl: done.thumbnailUrl,
      date: done.finishedAt ?? Date.now(),
    });
  }
  pump();
}

export function cancelJob(id: string) {
  const h = handles.get(id);
  if (h) {
    h.cancel(); // handle.done resolves with "cancelled" and calls finish()
    return;
  }
  const job = downloadsStore.get().find((j) => j.id === id);
  if (job?.status === "queued") patch(id, { status: "cancelled", finishedAt: Date.now() });
}

export function retryJob(id: string) {
  patch(id, {
    status: "queued",
    pct: null,
    error: null,
    summary: undefined,
    speedBps: null,
    etaSec: null,
    finishedAt: null,
    createdAt: Date.now(),
  });
  pump();
}

export function removeJob(id: string) {
  if (handles.has(id)) return;
  infos.delete(id);
  downloadsStore.set((jobs) => jobs.filter((j) => j.id !== id));
}

export function clearFinished() {
  downloadsStore.set((jobs) => {
    for (const j of jobs) if (!isActive(j.status)) infos.delete(j.id);
    return jobs.filter((j) => isActive(j.status));
  });
}

/** Library "Download again": queue from the stored URL with the stored format id. */
export function redownload(item: {
  url: string;
  title: string;
  channel: string | null;
  site: string;
  thumbnailUrl: string | null;
  mode: Job["mode"];
  formatId: string;
  format: string;
}) {
  const id = newId();
  infos.set(id, undefined);
  downloadsStore.set((jobs) => [
    {
      id,
      url: item.url,
      title: item.title,
      channel: item.channel,
      thumbnailUrl: item.thumbnailUrl,
      site: item.site,
      mode: item.mode,
      formatId: item.formatId,
      formatLabel: item.format,
      ext: item.format.toLowerCase(),
      status: "queued",
      pct: null,
      speedBps: null,
      etaSec: null,
      totalBytes: null,
      filePath: null,
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
    },
    ...jobs,
  ]);
  pump();
}

export function cancelAll() {
  for (const h of handles.values()) h.cancel();
}

export function useDownloads(): Job[] {
  return useStore(downloadsStore, (s) => s);
}

export function useActiveCount(): number {
  return useStore(downloadsStore, (s) => s.filter((j) => isActive(j.status)).length);
}

/** True when any job is done, failed or cancelled ("Clear finished"). Re-renders only when that flips. */
export function useHasFinished(): boolean {
  return useStore(downloadsStore, (s) => s.some((j) => !isActive(j.status)));
}
