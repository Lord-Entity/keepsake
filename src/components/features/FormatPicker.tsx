import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AudioBitrate, DownloadMode, FormatOption, VideoInfo } from "../../lib/types";
import { formatBytes, MOD } from "../../state/format";
import { useCommand, type Command } from "../../state/nav";
import { updateSettings, useSettings } from "../../state/settings";
import { Button } from "../ui/Button";
import { Select } from "../ui/Fields";
import { Icon } from "../ui/Icon";
import { Segmented } from "../ui/Segmented";
import { Switch } from "../ui/Switch";
import { t } from "../ui/motion";

const BITRATES: AudioBitrate[] = [128, 192, 256, 320];
/** Bitrate applies to lossy re-encodes only (MP3, and AAC if added); M4A/OPUS/WAV/FLAC hide it. */
const HAS_BITRATE = new Set(["mp3", "aac"]);
const DOWNLOAD_LABEL: Record<DownloadMode, string> = {
  video: "Download video",
  audio: "Download audio",
  thumbnail: "Save thumbnail",
};

export interface PickerChoice {
  format: FormatOption;
  audioBitrate?: AudioBitrate;
  streamId?: string;
}

/** Picks the default option per mode (engine marks isDefault; fall back to the first enabled). */
function defaultFor(options: FormatOption[]): string {
  const usable = options.filter((o) => !o.disabledReason);
  return (usable.find((o) => o.isDefault) ?? usable[0] ?? options[0])?.id ?? "";
}

export function FormatPicker({
  info,
  formats,
  disabled,
  downloadDisabledReason,
  onDownload,
  fill,
}: {
  info: VideoInfo | null;
  formats: FormatOption[];
  disabled?: boolean;
  downloadDisabledReason?: string;
  onDownload: (choice: PickerChoice) => void;
  /** Phone modal: 48px rows and Download button, button pinned below the scroll area. */
  fill?: boolean;
}) {
  const savedMode = useSettings((s) => s.lastMode);
  const preferH264 = useSettings((s) => s.preferH264);
  const noVideo = info !== null && !info.hasVideo;
  // "No video in link": switch to Audio but keep the saved preference.
  const mode: DownloadMode = noVideo && savedMode === "video" ? "audio" : savedMode;

  const byMode = useMemo(() => {
    const m: Record<DownloadMode, FormatOption[]> = { video: [], audio: [], thumbnail: [] };
    for (const f of formats) m[f.mode].push(f);
    return m;
  }, [formats]);

  // Selections are keyed per info so a new fetch resets to defaults.
  const key = info?.url ?? "";
  const [sel, setSel] = useState<{ key: string; ids: Partial<Record<DownloadMode, string>> }>({ key, ids: {} });
  const ids = sel.key === key ? sel.ids : {};
  const [bitrate, setBitrate] = useState<AudioBitrate>(192);
  const [advanced, setAdvanced] = useState(false);
  const [stream, setStream] = useState<{ key: string; id?: string }>({ key });
  const streamId = stream.key === key ? stream.id : undefined;

  const options = byMode[mode];
  const selectedId = ids[mode] && options.some((o) => o.id === ids[mode]) ? ids[mode]! : defaultFor(options);
  const selected = options.find((o) => o.id === selectedId);
  const off = disabled || !info;
  const canDownload = !off && selected && !selected.disabledReason && !downloadDisabledReason;

  const choose = (id: string) => setSel({ key, ids: { ...ids, [mode]: id } });

  const visibleStreams = useMemo(() => {
    if (!info) return [];
    const max = selected?.height;
    return info.streams.filter((s) => s.kind !== "audio-only" && (!max || !s.height || s.height <= max));
  }, [info, selected?.height]);

  const download = () => {
    if (!canDownload || !selected) return;
    onDownload({
      format: selected,
      audioBitrate: mode === "audio" && HAS_BITRATE.has(selected.audioFormat ?? "") ? bitrate : undefined,
      streamId: mode === "video" ? streamId : undefined,
    });
  };

  // Mod+Enter raises "download"; a ref keeps the listener stable across renders.
  const downloadRef = useRef(download);
  useEffect(() => {
    downloadRef.current = download;
  });
  const onCommand = useCallback((c: Command) => {
    if (c === "download") downloadRef.current();
  }, []);
  useCommand(onCommand);

  return (
    <div className={`flex min-h-0 flex-1 flex-col gap-3 ${off ? "opacity-50" : ""}`} data-format-picker>
      <Segmented<DownloadMode>
        label="Download type"
        value={mode}
        disabled={off}
        className="w-full"
        onChange={(m) => updateSettings({ lastMode: m })}
        options={[
          {
            value: "video",
            label: "Video",
            disabled: noVideo,
            title: noVideo ? "This link has no video, only audio" : undefined,
          },
          { value: "audio", label: "Audio" },
          { value: "thumbnail", label: "Thumbnail" },
        ]}
      />

      <div className="scroll-y flex min-h-0 flex-1 flex-col gap-3">
        {!info ? (
          <p className="text-fg-2">Fetch a video first</p>
        ) : mode === "video" ? (
          <>
            <Row fill={fill} label="Quality">
              <Select
                label="Quality"
                className="w-[200px] max-w-full"
                value={selectedId}
                disabled={off}
                onChange={choose}
                options={options.map((o) => ({
                  value: o.id,
                  label: o.disabledReason ? `${o.label} (unavailable)` : o.label,
                }))}
              />
            </Row>
            <Row fill={fill} label="Prefer H.264" title="Best compatibility. YouTube offers H.264 up to 1080p only">
              <Switch
                label="Prefer H.264"
                checked={preferH264}
                disabled={off}
                onChange={(v) => updateSettings({ preferH264: v })}
              />
            </Row>
            {info.streams.length > 0 && (
              <div>
                <button
                  type="button"
                  className={`flex items-center gap-1 text-[12px] font-medium text-fg-2 hover:text-fg ${fill ? "min-h-12" : ""}`}
                  aria-expanded={advanced}
                  onClick={() => setAdvanced((a) => !a)}
                >
                  <motion.span animate={{ rotate: advanced ? 0 : -90 }} transition={t.fast} className="inline-flex">
                    <Icon name="chevronDown" size={14} />
                  </motion.span>
                  Advanced
                </button>
                <AnimatePresence initial={false}>
                  {advanced && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={t.fast}
                      className="mt-2"
                    >
                      <StreamsTable
                        streams={visibleStreams}
                        selected={streamId}
                        onSelect={(id) => setStream({ key, id: id === streamId ? undefined : id })}
                      />
                      <p className="mt-1 truncate text-[11px] text-fg-2">
                        Selected: {streamId ? streamId : "Automatic"}
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </>
        ) : mode === "audio" ? (
          <>
            <Row fill={fill} label="Format">
              <Select
                label="Audio format"
                className="w-[200px] max-w-full"
                value={selectedId}
                onChange={choose}
                options={options.map((o) => ({ value: o.id, label: o.label }))}
              />
            </Row>
            {HAS_BITRATE.has(selected?.audioFormat ?? "") && (
              <Row fill={fill} label="Bitrate">
                <Select
                  label="Bitrate"
                  className="w-[200px] max-w-full"
                  value={String(bitrate)}
                  onChange={(v) => setBitrate(Number(v) as AudioBitrate)}
                  options={BITRATES.map((b) => ({ value: String(b), label: `${b} kbps` }))}
                />
              </Row>
            )}
          </>
        ) : (
          <Row fill={fill} label="Save as">
            <Select
              label="Thumbnail format"
              className="w-[200px] max-w-full"
              value={selectedId}
              onChange={choose}
              options={options.map((o) => ({ value: o.id, label: o.label }))}
            />
          </Row>
        )}
        {(selected?.disabledReason || downloadDisabledReason) && info && (
          <p className="text-[11px] leading-[14px] text-warning [overflow-wrap:anywhere]">
            {downloadDisabledReason ?? selected?.disabledReason}
          </p>
        )}
      </div>

      <Button
        variant="primary"
        size={fill ? "lg" : "md"}
        icon="download"
        className="w-full shrink-0"
        disabled={!canDownload}
        title={`${DOWNLOAD_LABEL[mode]} (${MOD}+Enter)`}
        onClick={download}
      >
        {DOWNLOAD_LABEL[mode]}
      </Button>
    </div>
  );
}

function Row({
  label,
  title,
  fill,
  children,
}: {
  label: string;
  title?: string;
  fill?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`flex min-w-0 items-center justify-between gap-3 ${fill ? "min-h-12" : ""}`} title={title}>
      <span className="min-w-0 truncate text-[12px] font-medium text-fg-2">{label}</span>
      {children}
    </div>
  );
}

function StreamsTable({
  streams,
  selected,
  onSelect,
}: {
  streams: VideoInfo["streams"];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  if (streams.length === 0) return <p className="text-fg-2">Streams appear here after fetching</p>;
  return (
    <div className="scroll-y max-h-40 overflow-x-auto rounded-md border border-line">
      <table className="tabular w-full text-left text-[11px]">
        <thead className="sticky top-0 bg-inset text-fg-2">
          <tr>
            {["Resolution", "FPS", "Video codec", "Audio codec", "Size", "Type", "ID"].map((h) => (
              <th key={h} className="px-2 py-1 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {streams.map((s) => (
            <tr
              key={s.id}
              onClick={() => onSelect(s.id)}
              aria-selected={selected === s.id}
              className={`cursor-pointer border-t border-line ${selected === s.id ? "bg-accent-soft text-accent" : "hover:bg-card-hover"}`}
            >
              <td className="px-2 py-1">{s.height ? `${s.height}p` : "--"}</td>
              <td className="px-2 py-1">{s.fps ?? "--"}</td>
              <td className="px-2 py-1">{s.vcodec ?? "--"}</td>
              <td className="px-2 py-1">{s.acodec ?? "--"}</td>
              <td className="px-2 py-1">{formatBytes(s.sizeBytes)}</td>
              <td className="px-2 py-1">{s.ext}</td>
              <td className="px-2 py-1 font-mono">{s.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
