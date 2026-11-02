import { loadJsonArray, saveJson } from "./persist";
import { createStore, useStore } from "./store";

export type SourceKind = "channel" | "profile" | "playlist" | "other";

export interface Source {
  id: string;
  url: string;
  title: string;
  thumbnailUrl: string | null;
  site: string;
  kind: SourceKind;
  /** ms epoch */
  addedAt: number;
  lastDownloadedAt: number | null;
}

export type SourceInput = Omit<Source, "id" | "addedAt" | "lastDownloadedAt"> &
  Partial<Pick<Source, "id" | "addedAt" | "lastDownloadedAt">>;

const KEY = "keepsake.sources.v1";

/** Normalised URL for dedupe: lower-case host without www, no hash, no trailing slash. */
export function normaliseUrl(url: string): string {
  const raw = url.trim();
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}${u.search}`;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, "");
  }
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export const sourcesStore = createStore<Source[]>(
  loadJsonArray<Source>(KEY).filter((s) => s && typeof s.id === "string" && typeof s.url === "string"),
);
sourcesStore.subscribe(() => saveJson(KEY, sourcesStore.get()));

/** All sources, newest first. */
export function useSources(): Source[] {
  return useStore(sourcesStore, (s) => s);
}

/** Adds a source, or returns the existing one with the same normalised url. */
export function addSource(input: SourceInput): Source {
  const key = normaliseUrl(input.url);
  const existing = sourcesStore.get().find((s) => normaliseUrl(s.url) === key);
  if (existing) return existing;
  const source: Source = {
    ...input,
    id: input.id ?? newId(),
    addedAt: input.addedAt ?? Date.now(),
    lastDownloadedAt: input.lastDownloadedAt ?? null,
  };
  sourcesStore.set((prev) => [source, ...prev]);
  return source;
}

export function removeSource(id: string): void {
  sourcesStore.set((prev) => prev.filter((s) => s.id !== id));
}

export function markSourceDownloaded(id: string, at: number = Date.now()): void {
  sourcesStore.set((prev) => prev.map((s) => (s.id === id ? { ...s, lastDownloadedAt: at } : s)));
}
