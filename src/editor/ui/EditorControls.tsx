import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { FieldRow } from "../../components/ui/Fields";
import { Progress } from "../../components/ui/Progress";
import { Segmented } from "../../components/ui/Segmented";
import { Switch } from "../../components/ui/Switch";
import type { CropPreset, CropRect, EditorOutput, MediaKind } from "../types";
import { CROP_PRESETS } from "./crop-math";

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
}) {
  const video = kind === "video";
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
      <div className="flex min-w-0 items-center gap-2">
        <Badge tone="neutral" className="shrink-0">
          {video ? "Video" : "Photo"}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={name}>
          {name}
        </span>
        <Button size="sm" variant="ghost" icon="folder" className={`shrink-0 ${phone ? "h-11" : ""}`} disabled={exporting} onClick={onReplace}>
          Change
        </Button>
      </div>

      <section aria-labelledby="editor-crop-h" className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 id="editor-crop-h" className="text-[13px] font-semibold">
            Crop
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

      <div className="flex min-w-0 flex-col">
        {video && (
          <FieldRow label="Sound" hint={hasAudio ? (audio ? "Keep the audio track" : "Export without sound") : "This video has no audio"}>
            <Switch label="Sound" checked={hasAudio && audio} disabled={!hasAudio || !canMute || exporting} onChange={onAudio} />
          </FieldRow>
        )}
        <FieldRow label="Format">
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
      </div>

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
