import { createStore, useStore } from "./store";
import { loadSettings, saveSettings } from "./persist";

export type ThemePref = "system" | "dark" | "light";
export type CookiesBrowser =
  | "off"
  | "firefox"
  | "chrome"
  | "edge"
  | "brave"
  | "opera"
  | "vivaldi"
  | "chromium";
export type PickerMode = "video" | "audio" | "thumbnail";

export interface Settings {
  theme: ThemePref;
  parallelDownloads: number;
  /** Empty string means "system Downloads folder" (resolved by the engine). */
  saveDir: string;
  cookiesBrowser: CookiesBrowser;
  /** Audio: embed cover art (MP3/M4A). Default on. */
  embedThumbnail: boolean;
  /** Video: embed thumbnail and metadata. Default off (each pass rewrites the whole file). */
  embedVideoMeta: boolean;
  preferH264: boolean;
  clipboardDetect: boolean;
  sidebarCollapsed: boolean;
  lastMode: PickerMode;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  parallelDownloads: 3,
  saveDir: "",
  cookiesBrowser: "off",
  embedThumbnail: true,
  embedVideoMeta: false,
  preferH264: false,
  clipboardDetect: false,
  sidebarCollapsed: false,
  lastMode: "video",
};

export const COOKIE_BROWSERS: { value: CookiesBrowser; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "firefox", label: "Firefox" },
  { value: "chrome", label: "Chrome" },
  { value: "edge", label: "Edge" },
  { value: "brave", label: "Brave" },
  { value: "opera", label: "Opera" },
  { value: "vivaldi", label: "Vivaldi" },
  { value: "chromium", label: "Chromium" },
];

export function clampParallel(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.parallelDownloads;
  return Math.min(10, Math.max(1, Math.round(n)));
}

/** Coerce anything loaded from storage into a valid Settings object. */
export function sanitizeSettings(raw: Partial<Settings> | null): Settings {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  return {
    theme: ["system", "dark", "light"].includes(s.theme) ? s.theme : "system",
    parallelDownloads: clampParallel(Number(s.parallelDownloads)),
    saveDir: typeof s.saveDir === "string" ? s.saveDir : "",
    cookiesBrowser: COOKIE_BROWSERS.some((b) => b.value === s.cookiesBrowser)
      ? s.cookiesBrowser
      : "off",
    embedThumbnail: Boolean(s.embedThumbnail),
    embedVideoMeta: Boolean(s.embedVideoMeta),
    preferH264: Boolean(s.preferH264),
    clipboardDetect: Boolean(s.clipboardDetect),
    sidebarCollapsed: Boolean(s.sidebarCollapsed),
    lastMode: ["video", "audio", "thumbnail"].includes(s.lastMode) ? s.lastMode : "video",
  };
}

export const settingsStore = createStore<Settings>(DEFAULT_SETTINGS);

let saveTimer: ReturnType<typeof setTimeout> | undefined;
settingsStore.subscribe(() => {
  applyTheme(settingsStore.get().theme);
  // Debounced 300ms per UI_LAYOUT.md; no Save button.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveSettings(settingsStore.get()), 300);
});

export async function initSettings(): Promise<Settings> {
  const loaded = sanitizeSettings(await loadSettings());
  settingsStore.set(loaded);
  applyTheme(loaded.theme);
  return loaded;
}

export function updateSettings(patch: Partial<Settings>) {
  settingsStore.set((prev) => sanitizeSettings({ ...prev, ...patch }));
}

export function resetSettings() {
  settingsStore.set({ ...DEFAULT_SETTINGS });
}

export function useSettings<S>(select: (s: Settings) => S): S {
  return useStore(settingsStore, select);
}

// ---- Theme ----

const media =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export function resolveTheme(pref: ThemePref): "dark" | "light" {
  if (pref !== "system") return pref;
  return media && !media.matches ? "light" : "dark";
}

function applyTheme(pref: ThemePref) {
  document.documentElement.dataset.theme = resolveTheme(pref);
}

media?.addEventListener("change", () => {
  if (settingsStore.get().theme === "system") applyTheme("system");
});

/** Mod+Shift+L and the titlebar button: cycle system -> light -> dark. */
export function cycleTheme() {
  const order: ThemePref[] = ["system", "light", "dark"];
  const cur = settingsStore.get().theme;
  updateSettings({ theme: order[(order.indexOf(cur) + 1) % order.length] });
}

/** Flip between dark and light based on what is showing now. */
export function toggleDarkLight() {
  const shown = resolveTheme(settingsStore.get().theme);
  updateSettings({ theme: shown === "dark" ? "light" : "dark" });
}
