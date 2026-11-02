import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo, useState } from "react";
import { TagBadge } from "../components/ui/Badge";
import { Button, IconButton } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Select } from "../components/ui/Fields";
import { Glyph } from "../components/ui/Glyph";
import { Segmented } from "../components/ui/Segmented";
import { CATEGORY_ICON } from "../components/ui/Stats";
import { listItem, t } from "../components/ui/motion";
import { categoryOf, siteLabel, CATEGORIES } from "../lib/categories";
import { hostOf, relativeTime } from "../state/format";
import { openAddLink } from "../state/nav";
import { addSource, markSourceDownloaded, removeSource, useSources, type Source, type SourceKind } from "../state/sources";
import { notify } from "../state/toast";
import { useQuickDownload } from "./QuickDownload";
import { PAGE_STACK } from "../components/layout/page";

type Sort = "newest" | "name" | "recent";

const KIND_LABEL: Record<SourceKind, string> = {
  channel: "Channel",
  profile: "Profile",
  playlist: "Playlist",
  other: "Link",
};

export function SourcesPage({ phone }: { phone: boolean }) {
  const sources = useSources();
  const reduced = useReducedMotion();
  const [cat, setCat] = useState<string>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const quick = useQuickDownload(phone);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sources) m.set(categoryOf(s.site), (m.get(categoryOf(s.site)) ?? 0) + 1);
    return m;
  }, [sources]);

  const shown = useMemo(() => {
    const list = sources.filter((s) => cat === "all" || categoryOf(s.site) === cat);
    if (sort === "name") list.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === "recent") list.sort((a, b) => (b.lastDownloadedAt ?? 0) - (a.lastDownloadedAt ?? 0));
    else list.sort((a, b) => b.addedAt - a.addedAt);
    return list;
  }, [sources, cat, sort]);

  if (sources.length === 0) {
    return (
      <>
        <EmptyState
          icon="sources"
          title="No sources yet"
          body="Add a YouTube channel, an Instagram or TikTok profile, or any playlist. Download from it any time."
          action={
            <Button variant="primary" size={phone ? "lg" : "md"} icon="plus" onClick={() => openAddLink("sources")}>
              Add a source
            </Button>
          }
        />
        {quick.element}
      </>
    );
  }

  return (
    <div className={PAGE_STACK}>
      <div className={`flex gap-2 ${phone ? "flex-col" : "flex-wrap items-center justify-between"}`}>
        <div className={phone ? "no-scrollbar -mx-4 overflow-x-auto px-4" : ""}>
          <Segmented
            label="Category"
            value={cat}
            onChange={setCat}
            options={[
              { value: "all", label: "All", count: sources.length },
              ...CATEGORIES.filter((c) => counts.get(c)).map((c) => ({ value: c as string, label: c, count: counts.get(c) })),
            ]}
          />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <Select<Sort>
            label="Sort sources"
            value={sort}
            onChange={setSort}
            className={phone ? "min-w-0 flex-1" : "w-[170px]"}
            options={[
              { value: "newest", label: "Newest first", icon: "clock" },
              { value: "name", label: "Name", icon: "list" },
              { value: "recent", label: "Last downloaded", icon: "download" },
            ]}
          />
          <Button variant="primary" icon="plus" size={phone ? "lg" : "md"} onClick={() => openAddLink("sources")}>
            {phone ? "Add" : "Add source"}
          </Button>
        </div>
      </div>

      <div className={`grid gap-3 ${phone ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4"}`}>
        <AnimatePresence initial={false}>
          {shown.map((s, i) => (
            <motion.div key={s.id} layout={!reduced} {...listItem(reduced, i)} className="min-w-0">
              <SourceTile
                source={s}
                phone={phone}
                onDownload={() => quick.start(s.url, () => markSourceDownloaded(s.id))}
                onRemove={() => remove(s)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      {quick.element}
    </div>
  );
}

function remove(s: Source) {
  removeSource(s.id);
  notify({
    tone: "info",
    title: "Source removed",
    body: s.title,
    action: { label: "Undo", run: () => addSource(s) },
  });
}

function SourceTile({
  source: s,
  phone,
  onDownload,
  onRemove,
}: {
  source: Source;
  phone: boolean;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const reduced = useReducedMotion();
  const category = categoryOf(s.site);
  const [copied, setCopied] = useState(false);
  return (
    <motion.article
      whileHover={reduced ? undefined : { y: -4 }}
      transition={t.spring}
      className="card card-interactive glyph-host icon-host shape-tab flex min-w-0 flex-col gap-3 p-4"
    >
      <div className="flex min-w-0 items-center gap-3">
        <Avatar src={s.thumbnailUrl} name={s.title} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold" title={s.title}>
            {s.title}
          </div>
          <div className="selectable truncate font-mono text-[11px] text-fg-3" title={s.url}>
            {hostOf(s.url)}
            {safePath(s.url)}
          </div>
        </div>
        <span className="shrink-0 text-accent">
          <Glyph icon={CATEGORY_ICON[category] ?? "globe"} size={15} box={30} />
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <TagBadge>{KIND_LABEL[s.kind]}</TagBadge>
        <TagBadge tone="neutral">{siteLabel(s.site)}</TagBadge>
        <span className="ml-auto text-[11px] text-fg-3">
          {s.lastDownloadedAt ? `Downloaded ${relativeTime(s.lastDownloadedAt)}` : `Added ${relativeTime(s.addedAt)}`}
        </span>
      </div>
      {/* At 320px the tile body is ~256px: the label truncates instead of pushing the icons out. */}
      <div className="flex min-w-0 items-center gap-1.5">
        <Button
          size={phone ? "md" : "sm"}
          variant="primary"
          icon="download"
          className={`min-w-0 flex-1 ${phone ? "h-11" : ""}`}
          title="Download from source"
          onClick={onDownload}
        >
          <span className="min-w-0 truncate">Download from source</span>
        </Button>
        <IconButton
          icon={copied ? "check" : "copy"}
          label="Copy link"
          size={phone ? 44 : 32}
          onClick={() => {
            void navigator.clipboard?.writeText(s.url).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        />
        <IconButton icon="trash" label="Remove source" size={phone ? 44 : 32} onClick={onRemove} />
      </div>
    </motion.article>
  );
}

function safePath(url: string): string {
  try {
    const p = new URL(url).pathname;
    return p === "/" ? "" : p;
  } catch {
    return "";
  }
}

/** Thumbnail in a pebble shape, or a monogram when there is none (or it fails to load). */
function Avatar({ src, name }: { src: string | null; name: string }) {
  const [broken, setBroken] = useState(false);
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span className="shape-pebble relative grid size-12 shrink-0 place-items-center overflow-hidden bg-accent-soft text-[18px] font-semibold text-accent shadow-[inset_0_0_0_1px_var(--accent-border)]">
      {src && !broken ? (
        <img
          src={src}
          alt=""
          draggable={false}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="absolute inset-0 size-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        letter
      )}
    </span>
  );
}
