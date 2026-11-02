/**
 * Settings persistence. This is the ONLY module that knows where settings live.
 * Today it uses localStorage; a Tauri-backed implementation can replace these
 * two functions without touching the store or any component.
 */
import type { LibraryItem } from "./models";
import type { Settings } from "./settings";

const KEY = "keepsake.settings.v1";

export async function loadSettings(): Promise<Partial<Settings> | null> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Partial<Settings>) : null;
  } catch {
    return null;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage blocked or full: settings stay in memory for this session.
  }
}

const LIBRARY_KEY = "keepsake.library.v1";

/** Library history. Same swap rule as settings: replace these two for Tauri/SQLite storage. */
export async function loadLibrary(): Promise<LibraryItem[]> {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as LibraryItem[]) : [];
  } catch {
    return [];
  }
}

export async function saveLibrary(items: LibraryItem[]): Promise<void> {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(items.slice(0, 2000)));
  } catch {
    // ignore: library stays in memory
  }
}

/** Small per-device UI conveniences (library view mode etc). Never throws. */
export function loadUiPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`keepsake.ui.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** Synchronous JSON array load under a full key (e.g. "keepsake.favorites.v1"). Never throws. */
export function loadJsonArray<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked or full: data stays in memory for this session.
  }
}

export function saveUiPref<T>(key: string, value: T): void {
  try {
    localStorage.setItem(`keepsake.ui.${key}`, JSON.stringify(value));
  } catch {
    // ignore
  }
}
