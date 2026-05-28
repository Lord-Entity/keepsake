import { useId } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { FieldRow } from "../../components/ui/Fields";
import { Progress } from "../../components/ui/Progress";
import { Segmented } from "../../components/ui/Segmented";
import { Switch } from "../../components/ui/Switch";
import type { CropPreset, CropRect, EditorOutput, MediaKind } from "../types";
import { Icon } from "../../components/ui/Icon";
import { CROP_PRESETS } from "./crop-math";

/** m:ss.s */
function fmtTime(sec: number): string {
  // Whole tenths, so floating-point never prints "0:010.0".
  const tenths = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * 10));
  const m = Math.floor(tenths / 600);
  const r = tenths - m * 600;
  return `${m}:${String(Math.floor(r / 10)).padStart(2, "0")}.${r % 10}`;
}

const PRESET_LABEL: Record<CropPreset, string> = {
  free: "Free",
  original: "Original",
  "1:1": "1:1",
  "4:5": "4:5",
  "9:16": "9:16",
  "16:9": "16:9",
  "4:3": "4:3",
  "3:4": "3:4",
};

const PRESET_TITLE: Record<CropPreset, string> = {
  free: "Drag any edge or corner freely",
  original: "Keep the original shape",
  "1:1": "Square",
  "4:5": "Portrait post",
  "9:16": "Story / Reel",
  "16:9": "Widescreen",
  "4:3": "Classic landscape",
  "3:4": "Classic portrait",
};

/** Side panel (desktop) / bottom section (phone): presets, sound, format, export. */
export function EditorControls({
  kind,
  name,
  preset,
  onPreset,
  crop,
  cropped,
  onResetCrop,
  audio,
  hasAudio,
  onAudio,
  output,
  onOutput,
  exporting,
  progress,
  error,
  onExport,
  onCancel,
  onReplace,
  phone,
  canCrop = true,
  canMute = true,
  note = null,
  blocked = false,
  onPickKind,
  quality,
  onQuality,
  trim,
  duration,
  canTrim = true,
  saved = null,
  onOpenSaved,
  onEditAnother,
}: {
  kind: MediaKind;
  name: string;
  preset: CropPreset;
  onPreset: (p: CropPreset) => void;
  /** Export-rounded crop in source pixels. */
  crop: CropRect;
  /** True when the crop differs from the full frame. */
  cropped: boolean;
  onResetCrop: () => void;
  audio: boolean;
  hasAudio: boolean;
  onAudio: (v: boolean) => void;
  output: EditorOutput;
  onOutput: (o: EditorOutput) => void;
  exporting: boolean;
  /** 0..1, or null while the engine has not reported yet. */
  progress: number | null;
  /** Reason the job cannot export (validateJob), shown under the button. */
  error: string | null;
  onExport: () => void;
  onCancel: () => void;
  onReplace: () => void;
  phone: boolean;
  /** false: crop presets and reset are disabled (the platform cannot crop this kind). */
  canCrop?: boolean;
  /** false: the Sound switch is disabled. */
  canMute?: boolean;
  /** Short non-blocking info about platform limits, shown above Export. */
  note?: string | null;
  /** true: Export is disabled (nothing can be exported, or capabilities are still being checked). */
  blocked?: boolean;
  /** Open the picker for a specific kind. Falls back to onReplace. */
  onPickKind?: (kind: MediaKind) => void;
  /** JPG quality 1..100 (default 92). The slider shows only with onQuality. */
  quality?: number;
  onQuality?: (q: number) => void;
  /** Trim range in seconds (video). */
  trim?: [number, number];
  duration?: number;
  /** false: trimming is unavailable on this platform. */
  canTrim?: boolean;
  /** Result of the last successful export. */
  saved?: { name: string; path: string } | null;
  onOpenSaved?: () => void;
  onEditAnother?: () => void;
}) {
  const video = kind === "video";
  const qualityId = useId();
  const q = quality ?? 92;
  const showQuality = !video && output === "jpg" && !!onQuality;
  const showTrim = video && typeof duration === "number" && duration > 0 && !!trim;
  const editAnother = () => (onEditAnother ?? onReplace)();
  const chip = (p: CropPreset) => {
    const on = p === preset;
    return (
      <button
        key={p}
        type="button"
        aria-pressed={on}
        title={PRESET_TITLE[p]}
        disabled={exporting || !canCrop}
        onClick={() => onPreset(p)}
        className={`hit tabular inline-flex items-center justify-center rounded-full border px-3 text-[12px] font-medium whitespace-nowrap transition-[background-color,border-color,color,scale] duration-150 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-45 ${
          phone ? "h-10 min-w-12" : "h-8 min-w-11"
        } ${on ? "border-accent-border bg-accent-soft text-accent" : "border-line bg-inset text-fg-2 hover:border-line-strong hover:text-fg"}`}
      >
        {PRESET_LABEL[p]}
      </button>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <Segmented<MediaKind>
          label="What you are editing"
          className={phone ? "!h-11" : ""}
          value={kind}
          disabled={exporting}
          onChange={(k) => {
            if (k !== kind) (onPickKind ?? (() => onReplace()))(k);
          }}
          options={[
            { value: "photo", label: "Photo", icon: "image", title: "Edit a photo" },
            { value: "video", label: "Video", icon: "video", title: "Edit a video" },
          ]}
        />
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={name}>
            {name}
          </span>
          <Button
            size="sm"
            variant="ghost"
            icon="folder"
            className={`shrink-0 ${phone ? "h-11" : ""}`}
            disabled={exporting}
            onClick={() => (onPickKind ? onPickKind(kind) : onReplace())}
          >
            Choose another
          </Button>
        </div>
        <p className="text-[11px] text-fg-2">
          {video ? "Drag the box to crop, the handles under the video to trim." : "Drag the box on the picture to crop, then pick a format."}
        </p>
      </div>

      <section aria-labelledby="editor-crop-h" className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 id="editor-crop-h" className="text-[13px] font-semibold">
            1. Crop
          </h3>
          <span className="tabular truncate font-mono text-[11px] text-fg-2" aria-live="polite">
            {crop.w} x {crop.h}
          </span>
        </div>
        <div role="group" aria-label="Crop shape" className="flex flex-wrap gap-1.5">
          {CROP_PRESETS.map(chip)}
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon="retry"
          className={`self-start ${phone ? "h-11" : ""}`}
          disabled={exporting || !canCrop || (!cropped && preset === "free")}
          onClick={onResetCrop}
        >
          Reset crop
        </Button>
      </section>

      <section aria-labelledby="editor-step2-h" className="flex min-w-0 flex-col">
        <h3 id="editor-step2-h" className="text-[13px] font-semibold">
          {video ? "2. Trim & sound" : "2. Format"}
        </h3>
        {showTrim && trim && (
          <FieldRow label="Trim" hint={canTrim ? "Drag the handles under the video" : "Trimming isn't available here"}>
            <span className="tabular font-mono text-[12px]">
              {fmtTime(trim[0])} – {fmtTime(trim[1])}{" "}
              <span className="text-fg-2">({Math.max(0, trim[1] - trim[0]).toFixed(1)} s)</span>
            </span>
          </FieldRow>
        )}
        {video && (
          <FieldRow label="Sound" hint={hasAudio ? (audio ? "Keep the audio track" : "Export without sound") : "This video has no audio"}>
            <Switch label="Sound" checked={hasAudio && audio} disabled={!hasAudio || !canMute || exporting} onChange={onAudio} />
          </FieldRow>
        )}
        <FieldRow label="Format" hint={video ? "H.264 video" : undefined}>
          {video ? (
            <Badge tone="neutral">MP4</Badge>
          ) : (
            <Segmented<EditorOutput>
              label="Output format"
              value={output}
              onChange={onOutput}
              disabled={exporting}
              options={[
                { value: "jpg", label: "JPG", title: "Smaller file" },
                { value: "png", label: "PNG", title: "Lossless, keeps transparency" },
              ]}
            />
          )}
        </FieldRow>
        {showQuality && (
          <FieldRow label="Quality" hint="Higher = sharper, bigger file">
            <input
              id={qualityId}
              type="range"
              min={40}
              max={100}
              step={1}
              value={q}
              aria-label="JPG quality"
              disabled={exporting}
              onChange={(e) => onQuality?.(Number(e.target.value))}
              className={`w-28 accent-[var(--accent)] ${phone ? "h-11" : ""}`}
            />
            <span className="tabular w-7 text-right text-[12px] font-medium">{q}</span>
          </FieldRow>
        )}
      </section>

      {exporting ? (
        <div className="flex flex-col gap-2" aria-live="polite">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-medium">Exporting...</span>
            <span className="tabular text-fg-2">{progress === null ? "" : `${Math.round(progress * 100)}%`}</span>
          </div>
          <Progress pct={progress === null ? null : Math.round(progress * 100)} label="Export progress" />
          <Button variant="ghost" icon="x" size={phone ? "lg" : "md"} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {saved && (
            <div role="status" className="flex min-w-0 flex-col gap-2 rounded-lg border border-success/40 bg-success/10 p-2.5">
              <div className="flex min-w-0 items-center gap-2 text-[12px]">
                <Icon name="check" size={16} className="shrink-0 text-success" />
                <span className="font-medium">Saved</span>
                <span className="min-w-0 flex-1 truncate text-fg-2" title={saved.path}>
                  {saved.name}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {onOpenSaved && (
                  <Button size="sm" variant="secondary" icon="open" className={phone ? "h-11" : ""} onClick={onOpenSaved}>
                    Open
                  </Button>
                )}
                <Button size="sm" variant="ghost" icon="folder" className={phone ? "h-11" : ""} onClick={editAnother}>
                  Edit another
                </Button>
              </div>
            </div>
          )}
          {note && (
            <p className="text-[11px] text-fg-2" aria-live="polite">
              {note}
            </p>
          )}
          <Button variant="primary" icon="download" size="lg" className="w-full" disabled={!!error || blocked} onClick={onExport}>
            Export {video ? "MP4" : output.toUpperCase()}
          </Button>
          {error && (
            <p className="text-[11px] text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
