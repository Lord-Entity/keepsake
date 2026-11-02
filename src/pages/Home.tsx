import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DownloadRow } from "../components/features/DownloadRow";
import { FormatPicker, type PickerChoice } from "../components/features/FormatPicker";
import { PreviewCard, Thumb } from "../components/features/PreviewCard";
import { ActionModal } from "../components/ui/ActionModal";
import { Button, IconButton } from "../components/ui/Button";
import { Card, spanStyle, type Span } from "../components/ui/Card";
import { Glyph } from "../components/ui/Glyph";
import { Icon, type IconName } from "../components/ui/Icon";
import { ActivityChart, CategoryBars, StatCard } from "../components/ui/Stats";
import { Sheet } from "../components/ui/Sheet";
import { listItem, t } from "../components/ui/motion";
import type { AppError, FormatOption, VideoInfo } from "../lib/types";
import { enqueue, useDownloads } from "../state/downloads";
import { asAppError, fetchInfo, getPlatform, listFormats } from "../state/engine";
import { formatBytes, hostOf, isHttpUrl, MOD, relativeTime } from "../state/format";
import { useWidth } from "../state/hooks";
import { computeStats, useLibrary } from "../state/library";
import { isActive } from "../state/models";
import { pickFolder, readClipboard } from "../state/native";
import { toggleFavorite, useIsFavorite } from "../state/favorites";
import { navigate, openAddLink, useCommand, type Command } from "../state/nav";
import { useSources } from "../state/sources";
import { useStats } from "../state/stats";
import { favoriteFromInfo, favoriteIdOf } from "./AddLink";
import { PAGE_BOTTOM, PAGE_STACK } from "../components/layout/page";
import { settingsStore, updateSettings, useSettings } from "../state/settings";
import { createStore, useStore } from "../state/store";
import { notify } from "../state/toast";

interface HomeState {
  input: string;
  info: VideoInfo | null;
  formats: FormatOption[];
  loading: boolean;
  error: AppError | null;
  /** True for ~1s after a successful fetch, so the modal can show its "Found it" state. */
  ready: boolean;
}

/** Module-level so the preview survives page switches. */
const home = createStore<HomeState>({
  input: "",
  info: null,
  formats: [],
  loading: false,
  error: null,
  ready: false,
});
const setHome = (p: Partial<HomeState>) => home.set((s) => ({ ...s, ...p }));
let fetchToken = 0;
let fetchAbort: AbortController | null = null;
let readyTimer: number | undefined;

const FETCH_MESSAGES = ["Reading the link…", "Checking available formats…", "Almost there…"];

async function runFetch(raw: string) {
  const url = raw.trim();
  if (!url) {
    setHome({ error: { code: "empty_url", message: "Paste a link first.", cookiesHint: false } });
    return;
  }
  const token = ++fetchToken;
  fetchAbort?.abort();
  const ctrl = new AbortController();
  fetchAbort = ctrl;
  setHome({ loading: true, error: null, ready: false });
  try {
    const info = await fetchInfo(url, {
      signal: ctrl.signal,
      cookiesBrowser: settingsStore.get().cookiesBrowser,
    });
    if (token !== fetchToken) return;
    let formats: FormatOption[] = [];
    try {
      formats = listFormats(info);
    } catch (e) {
      setHome({ loading: false, error: asAppError(e) });
      return;
    }
    setHome({ info, formats, loading: false, ready: true });
    window.clearTimeout(readyTimer);
    readyTimer = window.setTimeout(() => setHome({ ready: false }), 1100);
  } catch (e) {
    if (token !== fetchToken) return;
    setHome({ loading: false, error: asAppError(e) });
  }
}

/** Esc while fetching: ignore the pending result. */
function cancelFetch() {
  fetchToken++;
  fetchAbort?.abort();
  fetchAbort = null;
  window.clearTimeout(readyTimer);
  setHome({ loading: false, ready: false });
}

function splitDetails(message: string): { body: string; details: string | null } {
  const m = message.match(/^(.*?)\s*\(Details: ([\s\S]*)\)\s*$/);
  return m ? { body: m[1], details: m[2] } : { body: message, details: null };
}

const SPANS: Record<string, Span> = {
  preview: { wide: [7, 4], narrow: [12, 3] },
  picker: { wide: [5, 4], narrow: [12, 4] },
  empty: { wide: [12, 4], narrow: [12, 4] },
  active: { wide: [8, 3], narrow: [12, 3] },
  stats: { wide: [4, 3], narrow: [12, 3] },
  stat: { wide: [6, 2], narrow: [6, 2] },
  activity: { wide: [8, 3], narrow: [12, 3] },
  categories: { wide: [4, 3], narrow: [12, 3] },
  recent: { wide: [8, 4], narrow: [12, 3] },
  sources: { wide: [4, 2], narrow: [12, 1] },
  folder: { wide: [4, 2], narrow: [12, 1] },
};

export function HomePage({ phone }: { phone: boolean }) {
  const state = useStore(home, (s) => s);
  const { info, formats, loading, error, input, ready } = state;
  const jobs = useDownloads();
  const library = useLibrary();
  const saveDir = useSettings((s) => s.saveDir);
  const clipboardDetect = useSettings((s) => s.clipboardDetect);
  const reduced = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const width = useWidth(gridRef);
  const narrow = phone || (width > 0 && width < 760);
  const [sheet, setSheet] = useState(false);
  const [clipLink, setClipLink] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const platform = getPlatform();

  const activeJobs = useMemo(() => jobs.filter((j) => isActive(j.status)).slice(0, 3), [jobs]);
  const today = useMemo(() => computeStats(library), [library]);
  const stats = useStats();
  const sum14 = stats.last14Days.reduce((n, d) => n + d.count, 0);
  const recent = library.slice(0, 5);

  const fetchNow = useCallback((url?: string) => {
    const u = url ?? home.get().input;
    if (url !== undefined) setHome({ input: url });
    setShowDetails(false);
    void runFetch(u);
  }, []);

  const onCommand = useCallback(
    (c: Command) => {
      if (c === "focus-paste") {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (c === "paste-and-fetch") {
        void readClipboard().then((text) => {
          const v = text.trim();
          if (v) fetchNow(v);
          inputRef.current?.focus();
        });
      }
    },
    [fetchNow],
  );
  useCommand(onCommand, "home");

  // Clipboard detect (Settings, default off): on window focus, offer a new link. Never auto-fetches.
  useEffect(() => {
    if (!clipboardDetect) return;
    let last = "";
    const onFocus = () => {
      void readClipboard().then((text) => {
        const v = text.trim();
        if (v && v !== last && isHttpUrl(v) && v !== home.get().input) {
          last = v;
          setClipLink(v);
        }
      });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [clipboardDetect]);

  const onDownload = (choice: PickerChoice) => {
    if (!info) return;
    enqueue(info, choice);
    setHome({ input: "" });
    notify({
      tone: "success",
      title: "Added to downloads",
      body: info.title,
      action: { label: "View", run: () => navigate("downloads") },
    });
    setSheet(false);
    inputRef.current?.focus();
  };

  const err = error ? splitDetails(error.message) : null;
  const showEmpty = !info && !loading;

  const pasteBar = (
    // Wraps at very narrow widths (320px): the field keeps a 9rem basis and the
    // Fetch button drops to its own full-width row instead of overflowing.
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        fetchNow();
      }}
    >
      <label className={`relative min-w-0 flex-1 ${phone ? "basis-[9rem]" : "basis-[12rem]"}`}>
        <Icon name="link" size={18} className="absolute top-1/2 left-3 -translate-y-1/2 text-fg-3" />
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setHome({ input: e.target.value, error: null })}
          onKeyDown={(e) => {
            if (e.key === "Escape" && home.get().loading) {
              e.preventDefault();
              cancelFetch();
            }
          }}
          placeholder="Paste a video, playlist or audio link"
          aria-label="Link"
          spellCheck={false}
          autoComplete="off"
          className={`w-full min-w-0 truncate rounded-md border border-line bg-inset pl-10 text-[13px] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-[border-color,box-shadow] duration-200 placeholder:text-fg-3 hover:border-line-strong focus:border-accent-border focus:shadow-[0_0_0_3px_var(--accent-soft)] ${phone ? "h-12 pr-12" : "h-10 pr-10"}`}
        />
        {input && (
          <IconButton
            icon="x"
            label="Clear"
            size={phone ? 44 : 28}
            className={`absolute top-1/2 -translate-y-1/2 ${phone ? "right-0.5" : "right-1.5"}`}
            onClick={() => {
              setHome({ input: "", error: null });
              inputRef.current?.focus();
            }}
          />
        )}
      </label>
      <IconButton
        icon="clipboard"
        label={`Paste from clipboard (${MOD}+V)`}
        size={phone ? 48 : 40}
        onClick={() => onCommand("paste-and-fetch")}
      />
      <Button
        type="submit"
        variant="primary"
        size={phone ? "lg" : "md"}
        // Fixed min width so "Fetch" -> "Fetching" never changes where the row wraps.
        // Under 360px viewport the row wraps and Fetch takes the full second line.
        className={phone ? "min-w-[7.25rem] max-[359.98px]:grow" : "h-10 min-w-[6.5rem]"}
        loading={loading}
        disabled={!input.trim() && !loading}
        title="Fetch (Enter)"
      >
        {loading ? "Fetching" : "Fetch"}
      </Button>
    </form>
  );

  const notices = (
    <AnimatePresence initial={false}>
      {clipLink && (
        <motion.div
          key="clip"
          initial={{ opacity: 0, y: -8, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.97 }}
          transition={t.spring}
          className="max-w-full self-start"
        >
          {/* Sticky note: tinted, tilted slightly, one tapered corner. */}
          <div className="sticky-note flex max-w-full items-center gap-2 py-1.5 pr-1.5 pl-3 text-[12px]">
            <Icon name="link" size={14} className="shrink-0 text-accent" />
            <span className="min-w-0 truncate font-medium">Link found: {hostOf(clipLink)}</span>
            <Button
              size="sm"
              variant="primary"
              className={phone ? "h-11 shrink-0" : "shrink-0"}
              onClick={() => {
                const v = clipLink;
                setClipLink(null);
                fetchNow(v);
              }}
            >
              Use link
            </Button>
            <IconButton icon="x" label="Dismiss" size={phone ? 48 : 28} onClick={() => setClipLink(null)} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  const errorBlock = err && (
    <motion.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={t.spring}
      role="alert"
      className="rounded-[14px_14px_14px_4px] border border-danger/40 bg-danger/10 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
    >
      <div className="flex items-start gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-danger/16 text-danger">
          <Icon name="alert" size={17} />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="font-semibold">
            {error?.code === "empty_url" ? "Paste a link first." : "Couldn't read this link"}
          </div>
          {error?.code !== "empty_url" && <p className="selectable text-fg-2">{err.body}</p>}
          {(err.details || error?.detail) && (
            <button
              type="button"
              className={`mt-1 text-[11px] text-fg-2 underline-offset-2 hover:underline ${phone ? "min-h-11 pr-3" : ""}`}
              onClick={() => setShowDetails((v) => !v)}
            >
              {showDetails ? "Hide details" : "Show details"}
            </button>
          )}
          {showDetails && (
            <pre className="selectable mt-1 font-mono text-[11px] whitespace-pre-wrap text-fg-2">
              {err.details ?? error?.detail}
            </pre>
          )}
          {error?.code !== "empty_url" && (
            <div className={`flex flex-wrap gap-2 ${phone ? "mt-3" : "mt-2"}`}>
              <Button size={phone ? "lg" : "sm"} variant="secondary" icon="retry" onClick={() => fetchNow()}>
                Try again
              </Button>
              {error?.cookiesHint && (
                <Button size={phone ? "lg" : "sm"} variant="ghost" onClick={() => navigate("settings")}>
                  Open Settings
                </Button>
              )}
            </div>
          )}
        </div>
        <IconButton
          icon="x"
          label="Dismiss"
          size={phone ? 48 : 28}
          className={phone ? "-mt-2 -mr-2" : ""}
          onClick={() => setHome({ error: null })}
        />
      </div>
    </motion.div>
  );

  const fetchModal = (
    <ActionModal
      open={loading || ready}
      phase={loading ? "working" : "success"}
      title={loading ? "Reading your link" : "Found it"}
      messages={FETCH_MESSAGES}
      detail={loading ? hostOf(input) || undefined : info?.title}
      successLabel="Pick a format to continue"
      onCancel={cancelFetch}
    />
  );

  const statCards: { label: string; value: string; sub?: string; icon: IconName; tint?: boolean; shape: "leaf" | "drop" | "tab" }[] = [
    { label: "Today", value: String(today.today), sub: `${today.items} completed in total`, icon: "bolt", tint: true, shape: "drop" },
    { label: "Total downloads", value: String(stats.total), sub: "All library entries", icon: "download", shape: "leaf" },
    {
      label: "Success rate",
      value: stats.successRate === null ? "-" : `${stats.successRate}%`,
      sub: "Completed vs failed",
      icon: "check",
      shape: "tab",
    },
    { label: "Total size", value: formatBytes(stats.totalBytes), sub: "Completed files", icon: "database", shape: "leaf" },
  ];

  const heart = info && !loading && <FavoriteHeart info={info} className="absolute top-3 right-3 z-10" size={phone ? 44 : 36} />;

  const enter = (i: number) => listItem(reduced, i);

  // ---- Phone: single column (16px gutter from <main>, 12px gaps), sticky paste bar,
  // format picker in a centered modal ----
  if (phone) {
    return (
      <div className={`flex min-w-0 flex-col gap-3 ${PAGE_BOTTOM}`}>
        {/* -mb-3 cancels the column gap so the bar's own 12px bottom padding is the gap. */}
        <div className="sticky top-0 z-10 -mx-4 -mb-3 flex flex-col gap-3 bg-app px-4 pt-3 pb-3">
          {pasteBar}
          {notices}
        </div>
        {errorBlock}
        <Card className="relative !p-4">
          {heart}
          <PreviewCard info={info} loading={loading} phone onOpenFormats={() => setSheet(true)} />
        </Card>
        <SourcesCard phone />
        <Card
          className="!p-4"
          title="Active downloads"
          action={<Link onClick={() => navigate("downloads")}>View all</Link>}
        >
          {activeJobs.length === 0 ? (
            <p className="py-3 text-center text-fg-2">Nothing downloading</p>
          ) : (
            <div className="-mx-1.5 flex flex-col gap-1">
              {activeJobs.map((j) => (
                <DownloadRow key={j.id} job={j} compact phone />
              ))}
            </div>
          )}
        </Card>
        <div className="grid grid-cols-2 gap-3">
          {statCards.map((s) => (
            <StatCard key={s.label} {...s} className="min-h-[124px]" />
          ))}
        </div>
        <Card className="!p-4" title="Last 14 days" action={<span className="tabular text-[12px] text-fg-2">{sum14} downloads</span>}>
          <ActivityChart days={stats.last14Days} height={110} />
        </Card>
        <Card className="!p-4" title="Categories">
          <CategoryBars items={stats.byCategory} />
        </Card>
        <RecentCard recent={recent} reduced={reduced} className="!p-4" />
        <SaveFolderCard saveDir={saveDir} platform={platform} phone />
        <Sheet open={sheet} onClose={() => setSheet(false)} title="Format">
          <div className="flex min-h-[300px] min-w-0 flex-1 flex-col">
            <FormatPicker info={info} formats={formats} disabled={loading} onDownload={onDownload} fill />
          </div>
        </Sheet>
        {fetchModal}
      </div>
    );
  }

  // ---- Desktop bento ----
  return (
    <div className={PAGE_STACK}>
      <Card className="h-[88px] justify-center !py-0" bodyClassName="justify-center">
        {pasteBar}
      </Card>
      {notices}
      {errorBlock}
      <div ref={gridRef} className="bento">
        {showEmpty ? (
          <Card span={SPANS.empty} narrow={narrow}>
            <PreviewCard info={null} loading={false} />
            <p className="text-center text-[11px] text-fg-3">Press {MOD}+V anywhere on this page to paste and fetch</p>
          </Card>
        ) : (
          <>
            <Card span={SPANS.preview} narrow={narrow} className="relative">
              {heart}
              <PreviewCard info={info} loading={loading} />
            </Card>
            <Card span={SPANS.picker} narrow={narrow} title="Format">
              <FormatPicker info={info} formats={formats} disabled={loading} onDownload={onDownload} />
            </Card>
          </>
        )}

        <Card
          span={SPANS.active}
          narrow={narrow}
          title="Active downloads"
          action={<Link onClick={() => navigate("downloads")}>View all</Link>}
        >
          {activeJobs.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-fg-2">Nothing downloading</div>
          ) : (
            <div className="flex flex-col">
              <AnimatePresence initial={false}>
                {activeJobs.map((j, i) => (
                  <motion.div key={j.id} layout={!reduced} {...enter(i)}>
                    <DownloadRow job={j} compact canReveal={platform !== "android"} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </Card>

        {narrow ? (
          statCards.map((s) => <StatCard key={s.label} {...s} style={spanStyle(SPANS.stat, true)} />)
        ) : (
          <div className="grid grid-cols-2 gap-4" style={{ ...spanStyle(SPANS.stats, false), gridAutoRows: "1fr" }}>
            {statCards.map((s) => (
              <StatCard key={s.label} {...s} />
            ))}
          </div>
        )}

        <Card
          span={SPANS.activity}
          narrow={narrow}
          title="Last 14 days"
          action={<span className="tabular text-[12px] text-fg-2">{sum14} downloads</span>}
          bodyClassName="justify-end"
        >
          <ActivityChart days={stats.last14Days} height={150} />
        </Card>
        <Card span={SPANS.categories} narrow={narrow} title="Categories">
          <CategoryBars items={stats.byCategory} />
        </Card>

        <RecentCard recent={recent} reduced={reduced} span={SPANS.recent} narrow={narrow} />
        <SourcesCard span={SPANS.sources} narrow={narrow} />
        <SaveFolderCard saveDir={saveDir} platform={platform} span={SPANS.folder} narrow={narrow} />
      </div>
      {fetchModal}
    </div>
  );
}

function Link({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      // The ::before extends the hit area to 48px tall without changing the header layout.
      className="relative rounded-sm text-[12px] font-medium text-accent transition-[opacity,transform] duration-150 before:absolute before:-inset-x-2 before:-inset-y-[16px] before:content-[''] hover:underline active:scale-[0.97]"
    >
      {children}
    </button>
  );
}

const HEART =
  "M12 20s-7.5-4.6-9.2-9.3C1.7 7.6 3.8 4.5 7 4.5c2.1 0 3.6 1.2 5 3 1.4-1.8 2.9-3 5-3 3.2 0 5.3 3.1 4.2 6.2C19.5 15.4 12 20 12 20z";
const BURST = [0, 60, 120, 180, 240, 300].map((a) => ({
  a,
  x: 20 + 15 * Math.cos((a * Math.PI) / 180),
  y: 20 + 15 * Math.sin((a * Math.PI) / 180),
}));

/** Heart toggle on the preview: separate SVG layers (outline, fill, burst ring) animate independently. */
function FavoriteHeart({ info, className = "", size = 36 }: { info: VideoInfo; className?: string; size?: number }) {
  const on = useIsFavorite(favoriteIdOf(info));
  const reduced = useReducedMotion();
  return (
    <motion.button
      type="button"
      aria-pressed={on}
      aria-label={on ? "Remove from Favorites" : "Save to Favorites"}
      title={on ? "Remove from Favorites" : "Save to Favorites"}
      whileTap={{ scale: 0.84 }}
      transition={t.press}
      onClick={() => {
        const added = toggleFavorite(favoriteFromInfo(info));
        notify({
          tone: added ? "success" : "info",
          title: added ? "Saved to Favorites" : "Removed from Favorites",
          body: info.title,
          action: added ? { label: "View", run: () => navigate("favorites") } : undefined,
        });
      }}
      style={{ width: size, height: size }}
      className={`group/heart grid place-items-center rounded-full border border-line bg-card/90 text-accent shadow-card backdrop-blur transition-colors duration-150 hover:border-accent-border ${className}`}
    >
      <AnimatePresence>
        {on && !reduced && (
          <motion.svg
            key="burst"
            aria-hidden="true"
            viewBox="0 0 40 40"
            className="pointer-events-none absolute"
            style={{ width: size + 16, height: size + 16 }}
            initial={{ scale: 0.4, opacity: 0.9 }}
            animate={{ scale: 1.15, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.55, ease: "easeOut" }}
          >
            {BURST.map((p) => (
              <circle key={p.a} cx={p.x} cy={p.y} r="1.6" fill="currentColor" />
            ))}
          </motion.svg>
        )}
      </AnimatePresence>
      <svg
        aria-hidden="true"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        className="absolute transition-[scale] duration-200 group-hover/heart:scale-110"
      >
        <path d={HEART} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" />
      </svg>
      <motion.svg
        aria-hidden="true"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        className="absolute"
        initial={false}
        animate={{ scale: on ? 1 : 0, opacity: on ? 1 : 0 }}
        transition={{ type: "spring", stiffness: 520, damping: 16 }}
      >
        <path d={HEART} fill="currentColor" />
      </motion.svg>
    </motion.button>
  );
}

/** Sources shortcut: stacked avatars of saved creators and a way in (the only entry on phones). */
function SourcesCard({ span, narrow, phone }: { span?: Span; narrow?: boolean; phone?: boolean }) {
  const sources = useSources();
  // Three avatars on phones so the label keeps room at 320px; four elsewhere.
  const top = sources.slice(0, phone ? 3 : 4);
  const count = sources.length;
  return (
    <Card
      span={span}
      narrow={narrow}
      interactive
      className={`glyph-host icon-host cursor-pointer ${phone ? "!p-4" : ""}`}
      onClick={() => navigate("sources")}
      bodyClassName="justify-center"
      role="link"
      tabIndex={0}
      aria-label="Open Sources"
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) navigate("sources");
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="shrink-0 text-accent">
          <Glyph icon="sources" size={18} box={40} on />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">Sources</div>
          <div className="truncate text-[11px] text-fg-2">
            {count === 0 ? "Save channels and profiles" : `${count} saved creator${count === 1 ? "" : "s"}`}
          </div>
        </div>
        {top.length > 0 ? (
          <div className="flex shrink-0 -space-x-2">
            {top.map((s) => (
              <span
                key={s.id}
                className="shape-pebble relative grid size-8 place-items-center overflow-hidden border-2 border-card bg-accent-soft text-[12px] font-semibold text-accent"
                title={s.title}
              >
                {s.thumbnailUrl ? (
                  <img src={s.thumbnailUrl} alt="" referrerPolicy="no-referrer" className="absolute inset-0 size-full object-cover" />
                ) : (
                  (s.title.trim()[0] ?? "?").toUpperCase()
                )}
              </span>
            ))}
          </div>
        ) : (
          <Button
            size="sm"
            icon="plus"
            className={phone ? "h-11 shrink-0" : "shrink-0"}
            onClick={(e) => {
              e.stopPropagation();
              openAddLink("sources");
            }}
          >
            Add
          </Button>
        )}
        <Icon name="chevronRight" size={18} animated className="shrink-0 text-fg-3" />
      </div>
    </Card>
  );
}

function RecentCard({
  recent,
  reduced,
  span,
  narrow,
  className,
}: {
  recent: ReturnType<typeof useLibrary>;
  reduced: boolean | null;
  span?: Span;
  narrow?: boolean;
  className?: string;
}) {
  return (
    <Card
      span={span}
      narrow={narrow}
      className={className}
      title="Recent activity"
      action={<Link onClick={() => navigate("library")}>View all</Link>}
    >
      {recent.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-4 text-fg-2">Your downloads appear here</div>
      ) : (
        <div className="scroll-y flex min-h-0 flex-col">
          <AnimatePresence initial={false}>
            {recent.map((r, i) => (
              <motion.div
                key={r.id}
                layout={!reduced}
                {...listItem(reduced, i)}
                className="flex h-11 shrink-0 items-center gap-3 rounded-md px-1 transition-colors duration-150 hover:bg-card-hover"
              >
                <Thumb src={r.thumbnailUrl} className="h-8 w-12 shrink-0 rounded-sm" icon={r.mode === "audio" ? "audio" : "video"} />
                <span className="min-w-0 flex-1 truncate text-[13px]">{r.title}</span>
                <span
                  className={`shrink-0 text-[11px] ${r.status === "done" ? "text-fg-2" : r.status === "failed" ? "text-danger" : "text-fg-3"}`}
                >
                  {r.status === "done" ? r.format : r.status}
                </span>
                <span className="tabular w-20 shrink-0 text-right text-[11px] text-fg-2 max-[479.98px]:w-auto">
                  {relativeTime(r.date)}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </Card>
  );
}

function SaveFolderCard({
  saveDir,
  platform,
  span,
  narrow,
  phone,
}: {
  saveDir: string;
  platform: string;
  span?: Span;
  narrow?: boolean;
  phone?: boolean;
}) {
  const oneRow = narrow && !!span;
  return (
    <Card
      span={span}
      narrow={narrow}
      className={phone ? "!p-4" : ""}
      title={oneRow ? undefined : "Save folder"}
      bodyClassName="justify-center"
    >
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-[12px_12px_12px_4px] bg-accent-soft text-accent">
          <Icon name="folder" size={18} />
        </span>
        <span className="selectable min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2" title={saveDir || "System Downloads folder"}>
          {saveDir || (platform === "android" ? "App files folder" : "System Downloads folder")}
        </span>
        <Button
          size={phone ? "lg" : "sm"}
          className={phone ? "!px-4" : ""}
          onClick={async () => {
            const dir = await pickFolder(saveDir);
            if (dir) updateSettings({ saveDir: dir });
          }}
        >
          Change...
        </Button>
      </div>
    </Card>
  );
}
