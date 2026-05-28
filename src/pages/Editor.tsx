import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Loader";
import { PAGE_BOTTOM } from "../components/layout/page";
import { editorEngine } from "../editor/engine";
import {
  EditorError,
  validateJob,
  type CropPreset,
  type CropRect,
  type EditJob,
  type EditorCapabilities,
  type EditorInput,
  type EditorOutput,
  type MediaProbe,
} from "../editor/types";
import { CropStage } from "../editor/ui/CropStage";
import { applyPreset, fullRect, isFullFrame, presetRatio, roundCrop, type Size } from "../editor/ui/crop-math";
import { EditorControls } from "../editor/ui/EditorControls";
import { TrimBar } from "../editor/ui/TrimBar";
import { openFile } from "../state/native";
import { notify } from "../state/toast";

interface Loaded {
  input: EditorInput;
  probe: MediaProbe;
  url: string;
}

type Phase = { phase: "empty" } | { phase: "loading"; name: string } | ({ phase: "ready" } & Loaded);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const revoke = (url: string | undefined) => {
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
};

const FULL_CAPS: EditorCapabilities = { crop: true, trim: true, mute: true, exactTrim: true };

const defaultOutput = (input: EditorInput): EditorOutput =>
  input.kind === "video" ? "mp4" : /\.png$/i.test(input.name) ? "png" : "jpg";

/** Editor tab: pick one photo or video, crop / trim / mute it, export a new file. */
export function EditorPage({ phone }: { phone: boolean }) {
  const [state, setState] = useState<Phase>({ phase: "empty" });
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const loadAbort = useRef<AbortController | null>(null);

  const pick = useCallback(async () => {
    let input: EditorInput | null;
    try {
      input = await editorEngine.pickMedia();
    } catch (e) {
      notify({ tone: "error", title: "Couldn't open the file", body: errorText(e) });
      return;
    }
    if (!input) return;
    const prev = stateRef.current;
    loadAbort.current?.abort();
    const ac = new AbortController();
    loadAbort.current = ac;
    setState({ phase: "loading", name: input.name });
    // A cancelled load never restores `prev`, so its preview URL is freed here (nothing else holds it any more).
    const dropPrev = () => {
      if (prev.phase === "ready") revoke(prev.url);
    };
    try {
      const [probe, url] = await Promise.all([editorEngine.probe(input, ac.signal), editorEngine.previewUrl(input)]);
      if (ac.signal.aborted) {
        revoke(url);
        dropPrev();
        return;
      }
      if (!(probe.width > 0 && probe.height > 0) || (input.kind === "video" && !(probe.duration > 0))) {
        revoke(url);
        throw new EditorError("probe_failed", "Keepsake couldn't read this file's size or length.");
      }
      dropPrev();
      setState({ phase: "ready", input, probe, url });
    } catch (e) {
      if (ac.signal.aborted) {
        dropPrev();
        return;
      }
      if (!(e instanceof EditorError && e.code === "cancelled")) {
        notify({
          tone: "error",
          title: e instanceof EditorError && e.code === "unsupported" ? "This file isn't supported" : "Couldn't open the file",
          body: errorText(e),
        });
      }
      setState(prev.phase === "loading" ? { phase: "empty" } : prev);
    } finally {
      if (loadAbort.current === ac) loadAbort.current = null;
    }
  }, []);

  // Leaving the tab: stop probing and free the preview URL. A running export finishes on its own.
  useEffect(
    () => () => {
      loadAbort.current?.abort();
      const s = stateRef.current;
      if (s.phase === "ready") revoke(s.url);
    },
    [],
  );

  if (state.phase === "empty") {
    return (
      <div className={`flex h-full min-w-0 flex-col ${PAGE_BOTTOM}`}>
        <EmptyState
          icon="image"
          title="Edit a photo or video"
          body="Crop, trim and turn sound off, then export a new copy. Your original stays untouched."
          action={
            <Button variant="primary" icon="folder" size="lg" onClick={() => void pick()}>
              Choose a photo or video
            </Button>
          }
        />
      </div>
    );
  }

  if (state.phase === "loading") {
    return (
      <div className={`flex h-full min-h-[320px] min-w-0 flex-col items-center justify-center gap-3 text-center ${PAGE_BOTTOM}`} aria-busy="true">
        <Spinner size={28} label="Opening file" />
        <div className="max-w-[320px] truncate text-[13px] text-fg-2" title={state.name}>
          Opening {state.name}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            loadAbort.current?.abort();
            setState({ phase: "empty" });
          }}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <EditorWorkspace
      key={state.url}
      loaded={state}
      phone={phone}
      onReplace={() => void pick()}
    />
  );
}

function EditorWorkspace({ loaded, phone, onReplace }: { loaded: Loaded; phone: boolean; onReplace: () => void }) {
  const { input, probe, url } = loaded;
  const video = input.kind === "video";
  const pw = probe.width;
  const ph = probe.height;
  const size = useMemo<Size>(() => ({ width: pw, height: ph }), [pw, ph]);
  const duration = video ? probe.duration : 0;

  const [preset, setPreset] = useState<CropPreset>("free");
  const [crop, setCrop] = useState<CropRect>(() => fullRect(size));
  const [audio, setAudio] = useState(probe.hasAudio);
  const [output, setOutput] = useState<EditorOutput>(() => defaultOutput(input));
  const [trim, setTrim] = useState<[number, number]>([0, duration]);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportAbort = useRef<AbortController | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trimRef = useRef(trim);
  useLayoutEffect(() => {
    trimRef.current = trim;
  }, [trim]);

  // What this platform can do with the video (null while checking; the first desktop check can take seconds).
  // Photos are always fully editable. A failed check counts as full so the export reports the real error.
  const [videoCaps, setVideoCaps] = useState<EditorCapabilities | null>(null);
  useEffect(() => {
    if (!video) return;
    let live = true;
    const check = editorEngine.capabilities?.("video") ?? Promise.resolve(FULL_CAPS);
    void check
      .catch(() => FULL_CAPS)
      .then((c) => {
        if (live) setVideoCaps(c);
      });
    return () => {
      live = false;
    };
  }, [video]);
  const checking = video && videoCaps === null;
  const caps = video ? (videoCaps ?? FULL_CAPS) : FULL_CAPS;
  const canCrop = !checking && caps.crop;
  const nothing = video && !checking && !caps.crop && !caps.trim && !caps.mute;

  const ratio = presetRatio(preset, size);
  const rounded = useMemo(() => roundCrop(crop, size, video), [crop, size, video]);
  const cropped = !isFullFrame(rounded, size, video ? 1 : 0);

  const job = useMemo<EditJob>(() => {
    const j: EditJob = { input, audio: video ? probe.hasAudio && audio : false, output: video ? "mp4" : output };
    if (cropped && canCrop) j.crop = rounded;
    if (video) {
      const [s, e] = trim;
      if (s > 0.001) j.trimStart = Math.round(s * 1000) / 1000;
      if (e < duration - 0.001) j.trimEnd = Math.round(e * 1000) / 1000;
    }
    if (j.output === "jpg") j.quality = 92;
    return j;
  }, [input, video, probe.hasAudio, audio, output, cropped, canCrop, rounded, trim, duration]);
  const invalid = validateJob(job, probe);

  // React does not reliably reflect `muted`; set the property directly.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = !audio || !probe.hasAudio;
  }, [audio, probe.hasAudio]);

  // Smooth playhead while playing; loop inside the trimmed range.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        const [s, e] = trimRef.current;
        if (v.currentTime >= e || v.currentTime < s - 0.25) v.currentTime = s;
        setCurrent(v.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (v && Number.isFinite(t)) v.currentTime = t;
    setCurrent(t);
  }, []);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (!v.paused) {
      v.pause();
      return;
    }
    const [s, e] = trim;
    if (v.currentTime < s || v.currentTime >= e - 0.05) v.currentTime = s;
    void v.play().catch(() => setPlaying(false));
  };

  const onPreset = (p: CropPreset) => {
    setPreset(p);
    setCrop((c) => applyPreset(c, p, size));
  };

  const runExport = async () => {
    if (invalid || exporting || checking || nothing) return;
    videoRef.current?.pause();
    const ac = new AbortController();
    exportAbort.current = ac;
    setExporting(true);
    setProgress(null);
    let last = -1;
    try {
      const res = await editorEngine.exportEdit(
        job,
        (f) => {
          const p = Math.round(Math.min(1, Math.max(0, Number.isFinite(f) ? f : 0)) * 100) / 100;
          if (p !== last) {
            last = p;
            setProgress(p);
          }
        },
        ac.signal,
      );
      notify({
        tone: "success",
        title: "Saved",
        body: res.path || res.name,
        duration: 8000,
        action: res.path ? { label: "Open", run: () => void openFile(res.path) } : undefined,
      });
    } catch (e) {
      if (ac.signal.aborted || (e instanceof EditorError && e.code === "cancelled")) {
        notify({ tone: "info", title: "Export cancelled" });
      } else {
        const code = e instanceof EditorError ? e.code : null;
        notify({
          tone: "error",
          title:
            code === "no_space"
              ? "Not enough free space"
              : code === "permission"
                ? "Keepsake can't save there"
                : code === "unsupported"
                  ? "This file can't be exported"
                  : "Export failed",
          body: errorText(e),
        });
      }
    } finally {
      if (exportAbort.current === ac) exportAbort.current = null;
      setExporting(false);
      setProgress(null);
    }
  };

  const media = video ? (
    <video
      ref={videoRef}
      src={url}
      playsInline
      preload="auto"
      muted={!audio || !probe.hasAudio}
      className="pointer-events-none block h-full w-full"
      style={{ objectFit: "fill" }}
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onEnded={() => setPlaying(false)}
      onSeeked={(e) => {
        if (e.currentTarget.paused) setCurrent(e.currentTarget.currentTime);
      }}
    />
  ) : (
    <img src={url} alt={input.name} draggable={false} className="pointer-events-none block h-full w-full" style={{ objectFit: "fill" }} />
  );

  const stage = (
    <CropStage
      source={size}
      crop={crop}
      ratio={ratio}
      onChange={(r) => {
        if (!exporting) setCrop(r);
      }}
      phone={phone}
      cropDisabled={!canCrop}
      className={phone ? "h-[min(56vh,520px)] min-h-[260px] w-full" : "h-[min(64vh,680px)] min-h-[320px] w-full"}
    >
      {media}
    </CropStage>
  );

  const transport = video && (
    <div className="flex min-w-0 items-center gap-3">
      <PlayButton playing={playing} onClick={togglePlay} size={phone ? 44 : 36} disabled={exporting} />
      <div className="min-w-0 flex-1">
        <TrimBar
          duration={duration}
          start={trim[0]}
          end={trim[1]}
          current={current}
          onChange={(s, e) => setTrim([s, e])}
          onSeek={seek}
          phone={phone}
          disabled={exporting || !caps.trim}
        />
      </div>
    </div>
  );

  const controls = (
    <EditorControls
      kind={input.kind}
      name={input.name}
      preset={preset}
      onPreset={onPreset}
      crop={rounded}
      cropped={cropped}
      onResetCrop={() => {
        setPreset("free");
        setCrop(fullRect(size));
      }}
      audio={audio}
      hasAudio={probe.hasAudio}
      onAudio={setAudio}
      output={output}
      onOutput={setOutput}
      exporting={exporting}
      progress={progress}
      error={invalid}
      onExport={() => void runExport()}
      onCancel={() => exportAbort.current?.abort()}
      onReplace={onReplace}
      phone={phone}
      canCrop={canCrop}
      canMute={caps.mute}
      note={checking ? "Checking video tools..." : (caps.note ?? null)}
      blocked={checking || nothing}
    />
  );

  if (phone) {
    return (
      <div className={`flex min-w-0 flex-col gap-3 pt-1 ${PAGE_BOTTOM}`}>
        {stage}
        {transport}
        <Card className="!p-4">{controls}</Card>
      </div>
    );
  }

  return (
    <div className={`grid min-w-0 grid-cols-[minmax(0,1fr)_300px] items-start gap-4 pt-1 ${PAGE_BOTTOM}`}>
      <div className="flex min-w-0 flex-col gap-3">
        {stage}
        {transport}
      </div>
      <Card>{controls}</Card>
    </div>
  );
}

function PlayButton({ playing, onClick, size, disabled }: { playing: boolean; onClick: () => void; size: number; disabled?: boolean }) {
  const label = playing ? "Pause" : "Play";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{ width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-accent text-on-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] transition-[background-color,scale] duration-150 hover:bg-accent-hover active:scale-[0.94] disabled:pointer-events-none disabled:opacity-45"
    >
      <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        {playing ? <path d="M6 4h4v16H6zM14 4h4v16h-4z" /> : <path d="M7 4.5v15l12-7.5z" />}
      </svg>
    </button>
  );
}
