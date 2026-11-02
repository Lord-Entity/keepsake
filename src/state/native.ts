/**
 * Thin wrappers over Tauri APIs used by the UI (window, dialog, opener).
 * Every call is guarded so the UI also runs in a plain browser (`bun run dev:web`).
 * Required capabilities: core:window:allow-show, -set-focus, -minimize, -maximize,
 * -unmaximize, -close, -start-dragging (default set covers is-decorated / is-maximized),
 * dialog:allow-open, opener:allow-open-path, opener:allow-reveal-item-in-dir.
 */
import { isTauri } from "@tauri-apps/api/core";
import { platform } from "../engine/platform";
import { notify } from "./toast";

export const inTauri = (() => {
  try {
    return isTauri();
  } catch {
    return false;
  }
})();

async function win() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/** Window starts hidden (visible:false) to avoid a white flash; show it after first paint. */
export async function showWindow(): Promise<void> {
  if (!inTauri) return;
  try {
    const w = await win();
    await w.show();
    await w.setFocus();
  } catch {
    // ignore: window may already be visible or permission missing
  }
}

export async function isDecorated(): Promise<boolean> {
  if (!inTauri) return true;
  try {
    return await (await win()).isDecorated();
  } catch {
    return true;
  }
}

export async function windowAction(action: "minimize" | "maximize" | "close"): Promise<void> {
  if (!inTauri) return;
  try {
    const w = await win();
    if (action === "minimize") await w.minimize();
    else if (action === "close") await w.close();
    else if (await w.isMaximized()) await w.unmaximize();
    else await w.maximize();
  } catch {
    // ignore
  }
}

export async function pickFolder(current?: string): Promise<string | null> {
  if (!inTauri) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const res = await open({ directory: true, multiple: false, defaultPath: current || undefined });
    return typeof res === "string" ? res : null;
  } catch {
    return null;
  }
}

export interface AndroidFolder {
  key: "downloads" | "music" | "movies";
  label: string;
  path: string;
}

/**
 * Folders Keepsake may save to on Android. The system folder picker returns a content://
 * tree URI that the file APIs cannot write to, so Android users choose from these instead.
 * Each path sits inside the fs scope in capabilities/mobile.json.
 */
export async function androidFolders(): Promise<AndroidFolder[]> {
  if (!inTauri) return [];
  try {
    const { downloadDir, audioDir, videoDir } = await import("@tauri-apps/api/path");
    const [dl, music, movies] = await Promise.all([downloadDir(), audioDir(), videoDir()]);
    return [
      { key: "downloads", label: "Downloads", path: dl },
      { key: "music", label: "Music", path: music },
      { key: "movies", label: "Movies", path: movies },
    ];
  } catch {
    return [];
  }
}

export async function openFile(path: string): Promise<boolean> {
  if (!inTauri) return false;
  try {
    if (platform() === "android") {
      // Android needs a content:// URI; the keepsake-media plugin shares the file through FileProvider.
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("plugin:keepsake-media|open_file", { path });
    } else {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(path);
    }
    return true;
  } catch (e) {
    notify({
      tone: "error",
      title: "Couldn't open the file",
      body: e instanceof Error ? e.message : typeof e === "string" ? e : undefined,
    });
    return false;
  }
}

export async function revealFile(path: string): Promise<boolean> {
  if (!inTauri) return false;
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
    return true;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // ignore
  }
}

export async function readClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}
