/**
 * Editor contract (FROZEN). Every editor module imports from here; do not change existing fields.
 * New optional fields may be added only by the file's owner and must be reported.
 * Scope is deliberately small: crop, trim, resize via presets, mute, export. No filters, text or effects.
 */

export type MediaKind = "video" | "photo";
export type EditorOutput = "mp4" | "jpg" | "png";

/** Source-pixel rectangle, top-left origin. Always inside [0,width]x[0,height], even width/height for video. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the user's file lives. Desktop uses `path`; Android uses `uri` (content:// from a picker). */
export interface EditorInput {
  kind: MediaKind;
  name: string;
  path?: string;
  uri?: string;
}

/** What the file is, read before editing so the UI can size the crop box and trim bar. */
export interface MediaProbe {
  width: number;
  height: number;
  /** Seconds. 0 for photos. */
  duration: number;
  hasAudio: boolean;
  /** Clockwise degrees (0, 90, 180, 270) the player applies. width/height are already display-oriented. */
  rotation: number;
}

/** Free crop or a locked ratio. `free` lets the user drag any edge; the others fix w:h. */
export type CropPreset = "free" | "original" | "1:1" | "4:5" | "9:16" | "16:9" | "4:3" | "3:4";

export interface EditJob {
  input: EditorInput;
  /** Omitted = no crop. */
  crop?: CropRect;
  /** Video only, seconds. Omitted = start 0 / end duration. Invariant: 0 <= trimStart < trimEnd <= duration. */
  trimStart?: number;
  trimEnd?: number;
  /** Video only. false strips the audio track. */
  audio: boolean;
  output: EditorOutput;
  /** jpg only, 1..100. Default 92. */
  quality?: number;
}

export interface EditResult {
  /** Final saved location (desktop path, or Android content:// / display name). */
  path: string;
  name: string;
}

/** What the current platform can do for a media kind. `note` is a short user-facing explanation of any limit. */
export interface EditorCapabilities {
  crop: boolean;
  trim: boolean;
  mute: boolean;
  /** false: a trim start snaps to the keyframe at or before it. */
  exactTrim: boolean;
  note?: string;
}

/** The only functions the UI calls. Implemented in src/editor/engine.ts; platform work is behind them. */
export interface EditorEngine {
  /** Optional. Never rejects in the shipped engine: unknown means the full set (the export reports any error). */
  capabilities?(kind: MediaKind): Promise<EditorCapabilities>;
  /**
   * Opens the system picker. `kind` (optional, added later) limits the picker to photos or videos where the platform
   * can; omitted means both, exactly as before. The returned `kind` is always the file's real kind, which can differ
   * from the request when a picker ignores the filter.
   */
  pickMedia(kind?: MediaKind): Promise<EditorInput | null>;
  probe(input: EditorInput, signal?: AbortSignal): Promise<MediaProbe>;
  /** Object/data URL the webview can show (<video>/<img>) for the source. */
  previewUrl(input: EditorInput): Promise<string>;
  exportEdit(job: EditJob, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<EditResult>;
}

export type EditorErrorCode = "unsupported" | "cancelled" | "probe_failed" | "export_failed" | "no_space" | "permission" | "invalid_job";

export class EditorError extends Error {
  code: EditorErrorCode;
  constructor(code: EditorErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Pure helper shared by UI and tests: reject a job the engines must not run. Returns an error message or null. */
export function validateJob(job: EditJob, probe: MediaProbe): string | null {
  const c = job.crop;
  if (c) {
    if (![c.x, c.y, c.w, c.h].every(Number.isFinite)) return "Crop is not a number";
    if (c.w < 2 || c.h < 2) return "Crop is too small";
    if (c.x < 0 || c.y < 0 || c.x + c.w > probe.width + 0.5 || c.y + c.h > probe.height + 0.5) return "Crop is outside the picture";
  }
  if (job.input.kind === "video") {
    const s = job.trimStart ?? 0;
    const e = job.trimEnd ?? probe.duration;
    if (!(s >= 0) || !(e > s) || e > probe.duration + 0.05) return "Trim range is invalid";
  }
  if (job.input.kind === "photo" && job.output === "mp4") return "A photo cannot export as MP4";
  if (job.input.kind === "video" && job.output !== "mp4") return "A video exports as MP4";
  return null;
}
