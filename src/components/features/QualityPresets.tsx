import type { FormatOption } from "../../lib/types";
import { CardChipGlyph } from "../ui/illustrations/CardChipGlyph";

export type PresetKey = "best" | "1080" | "720" | "audio";

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "best", label: "Best" },
  { key: "1080", label: "1080p" },
  { key: "720", label: "720p" },
  { key: "audio", label: "Audio" },
];

/** Picks an existing, enabled format option for a preset; never builds one. */
export function resolvePreset(key: PresetKey, formats: FormatOption[]): FormatOption | null {
  const usable = formats.filter((f) => !f.disabledReason);
  const video = usable.filter((f) => f.mode === "video");
  const audio = usable.filter((f) => f.mode === "audio");
  switch (key) {
    case "best":
      return (
        video.find((f) => f.id === "video:best") ??
        video.reduce<FormatOption | null>(
          (top, f) => (f.height != null && (top === null || f.height > (top.height ?? 0)) ? f : top),
          null,
        )
      );
    case "1080":
      return video.find((f) => f.height === 1080) ?? null;
    case "720":
      return video.find((f) => f.height === 720) ?? null;
    case "audio":
      return audio.find((f) => f.isDefault) ?? audio[0] ?? null;
  }
}

/** Four quick-quality buttons that map onto the available format options. */
export function QualityPresets({
  formats,
  value,
  onChange,
  disabled,
}: {
  formats: FormatOption[];
  value: PresetKey | null;
  onChange: (k: PresetKey | null) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label="Quick quality" className="grid grid-cols-4 gap-2">
      {PRESETS.map((p) => {
        const f = resolvePreset(p.key, formats);
        const off = disabled || !f;
        const on = value === p.key && !!f;
        return (
          <button
            key={p.key}
            type="button"
            aria-pressed={on}
            disabled={off}
            title={f ? f.label : "Not offered for this link"}
            onClick={() => onChange(on ? null : p.key)}
            className={`flex h-12 min-w-0 flex-col items-center justify-center rounded-[14px_14px_14px_6px] border px-1 transition-[color,background-color,border-color,box-shadow,scale] duration-150 active:scale-[0.97] motion-reduce:active:scale-100 disabled:opacity-45 ${on ? "border-accent-border bg-accent-soft text-accent shadow-sm" : "border-line bg-inset text-fg hover:border-line-strong"}`}
          >
            <span className="flex items-center gap-1 text-[13px] leading-4 font-semibold">
              <CardChipGlyph name={p.key} active={on} className="size-3.5 shrink-0" />
              {p.label}
            </span>
            <span className={`tabular truncate text-[10px] leading-3 ${on ? "text-accent" : "text-fg-3"}`}>
              {f ? f.ext.toUpperCase() : "n/a"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
