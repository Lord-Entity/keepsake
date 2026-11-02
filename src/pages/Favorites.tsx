import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Thumb } from "../components/features/PreviewCard";
import { TagBadge } from "../components/ui/Badge";
import { Button, IconButton } from "../components/ui/Button";
import { Select } from "../components/ui/Fields";
import { EmptyState } from "../components/ui/EmptyState";
import { Icon } from "../components/ui/Icon";
import { listItem, t } from "../components/ui/motion";
import { categoryOf, siteLabel, CATEGORIES } from "../lib/categories";
import { removeFavorite, useFavorites, type FavoriteItem, type FavoriteKind } from "../state/favorites";
import { isMac, relativeTime } from "../state/format";
import { useMediaQuery } from "../state/hooks";
import { navigate, openAddLink } from "../state/nav";
import { addSource } from "../state/sources";
import { notify } from "../state/toast";
import { guessSourceKind } from "./AddLink";
import { useQuickDownload } from "./QuickDownload";
import { PAGE_STACK } from "../components/layout/page";

type KindFilter = "all" | FavoriteKind;

const KIND_ICON: Record<FavoriteKind, "video" | "audio" | "sources" | "user"> = {
  video: "video",
  audio: "audio",
  channel: "sources",
  profile: "user",
};

export function FavoritesPage({ phone }: { phone: boolean }) {
  const favorites = useFavorites();
  const reduced = useReducedMotion();
  const tiny = useMediaQuery("(max-width: 359.98px)");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [cat, setCat] = useState<string>("all");
  const quick = useQuickDownload(phone);
  const searchRef = useRef<HTMLInputElement>(null);

  // Mod+F focuses this page's own search (the shell skips Mod+F on Favorites).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey || e.key.toLowerCase() !== "f") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return favorites.filter(
      (f) =>
        (kind === "all" || f.kind === kind) &&
        (cat === "all" || categoryOf(f.site) === cat) &&
        (!n || f.title.toLowerCase().includes(n) || f.site.toLowerCase().includes(n)),
    );
  }, [favorites, q, kind, cat]);

  if (favorites.length === 0) {
    return (
      <EmptyState
        icon="heart"
        title="No favorites yet"
        body="Save videos, songs, channels and profiles you want to come back to."
        action={
          <Button variant="primary" size={phone ? "lg" : "md"} icon="plus" onClick={() => openAddLink("favorites")}>
            Add a link
          </Button>
        }
      />
    );
  }

  return (
    <div className={PAGE_STACK}>
      <div className={`flex gap-2 ${phone ? "flex-col" : "flex-wrap items-center"}`}>
        <label className={`icon-host group relative min-w-0 flex-1 ${phone ? "" : "basis-[220px]"}`}>
          <Icon name="search" size={16} animated className="absolute top-1/2 left-3 -translate-y-1/2 text-fg-3 group-focus-within:text-accent" />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search favorites"
            aria-label="Search favorites"
            className={`w-full rounded-[12px_12px_12px_5px] border border-line bg-inset pr-3 pl-9 text-[13px] text-fg transition-colors duration-150 placeholder:text-fg-3 hover:border-line-strong focus-visible:border-accent ${phone ? "h-12" : "h-9"}`}
          />
        </label>
        <div className={`flex min-w-0 items-center gap-2 ${phone ? "" : "flex-wrap"}`}>
          <Select<KindFilter>
            label="Kind"
            value={kind}
            onChange={setKind}
            className={phone ? "min-w-0 flex-1" : "w-[140px]"}
            options={[
              { value: "all", label: "All kinds", icon: "layers" },
              { value: "video", label: "Videos", icon: "video" },
              { value: "audio", label: "Audio", icon: "audio" },
              { value: "channel", label: "Channels", icon: "sources" },
              { value: "profile", label: "Profiles", icon: "user" },
            ]}
          />
          <Select
            label="Category"
            value={cat}
            onChange={setCat}
            className={phone ? "min-w-0 flex-1" : "w-[150px]"}
            options={[{ value: "all", label: "All categories" }, ...CATEGORIES.map((c) => ({ value: c as string, label: c }))]}
          />
          {!phone && (
            <Button variant="primary" icon="plus" onClick={() => openAddLink("favorites")}>
              Add
            </Button>
          )}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="flex min-w-0 flex-col items-center gap-3 py-16 text-center">
          <div className="text-[15px] font-semibold">Nothing matches</div>
          <Button
            size={phone ? "lg" : "md"}
            onClick={() => {
              setQ("");
              setKind("all");
              setCat("all");
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        // minmax(0,1fr) tracks: a long title or button row can never widen a column past the screen.
        <div
          className={`grid gap-3 ${phone ? (tiny ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[repeat(2,minmax(0,1fr))]") : "grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4"}`}
        >
          <AnimatePresence initial={false}>
            {shown.map((f, i) => (
              <motion.div key={f.id} layout={!reduced} {...listItem(reduced, i)} className="min-w-0">
                <FavoriteTile
                  item={f}
                  phone={phone}
                  onDownload={() => quick.start(f.url)}
                  onRemove={() => {
                    removeFavorite(f.id);
                    notify({ tone: "info", title: "Removed from Favorites", body: f.title });
                  }}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
      {quick.element}
    </div>
  );
}

function FavoriteTile({
  item,
  phone,
  onDownload,
  onRemove,
}: {
  item: FavoriteItem;
  phone: boolean;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const reduced = useReducedMotion();
  const isSource = item.kind === "channel" || item.kind === "profile";
  return (
    <motion.article
      whileHover={reduced ? undefined : { y: -4 }}
      transition={t.spring}
      className="card card-interactive glyph-host icon-host shape-leaf flex h-full min-w-0 flex-col overflow-hidden"
    >
      <div className="relative">
        <Thumb
          src={item.thumbnailUrl}
          icon={item.kind === "audio" ? "audio" : "video"}
          className="aspect-video w-full rounded-[25px_9px_0_0]"
        />
        <span className="absolute top-2 left-2">
          <TagBadge className="!bg-card/85 backdrop-blur">{categoryOf(item.site)}</TagBadge>
        </span>
        <HeartToggle onRemove={onRemove} phone={phone} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <div className="line-clamp-2 text-[13px] leading-[18px] font-semibold" title={item.title}>
          {item.title}
        </div>
        <div className="mt-auto flex items-center gap-1.5 text-[11px] text-fg-2">
          <Icon name={KIND_ICON[item.kind]} size={13} />
          <span className="truncate">{siteLabel(item.site)}</span>
          <span className="text-fg-3">·</span>
          <span className="shrink-0 text-fg-3">{relativeTime(item.addedAt)}</span>
        </div>
        {/* Wraps in a two-column phone grid (~140px tiles) rather than overflowing. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size={phone ? "md" : "sm"}
            variant="secondary"
            icon="download"
            className={`min-w-0 flex-1 basis-[7rem] ${phone ? "h-11" : ""}`}
            onClick={onDownload}
          >
            Download
          </Button>
          {isSource && (
            <IconButton
              icon="sources"
              label="Add to Sources"
              size={phone ? 44 : 32}
              onClick={() => {
                addSource({ url: item.url, title: item.title, site: item.site, kind: guessSourceKind(item.url), thumbnailUrl: item.thumbnailUrl });
                notify({ tone: "success", title: "Added to Sources", body: item.title, action: { label: "View", run: () => navigate("sources") } });
              }}
            />
          )}
        </div>
      </div>
    </motion.article>
  );
}

/** Filled heart with a separate burst ring layer; clicking un-favorites. */
function HeartToggle({ onRemove, phone }: { onRemove: () => void; phone: boolean }) {
  return (
    <motion.button
      type="button"
      aria-label="Remove from Favorites"
      title="Remove from Favorites"
      whileTap={{ scale: 0.82 }}
      transition={t.press}
      onClick={onRemove}
      className={`group/heart absolute top-2 right-2 grid place-items-center rounded-full bg-card/85 text-accent shadow-card backdrop-blur ${phone ? "size-11" : "size-9"}`}
    >
      <svg aria-hidden="true" viewBox="0 0 36 36" className="absolute inset-0 size-full scale-75 opacity-0 transition-[scale,opacity] duration-300 group-hover/heart:scale-100 group-hover/heart:opacity-60">
        <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.5 4" strokeLinecap="round" />
      </svg>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" className="relative transition-[scale] duration-200 group-hover/heart:scale-110">
        <path
          fill="currentColor"
          d="M12 20s-7.5-4.6-9.2-9.3C1.7 7.6 3.8 4.5 7 4.5c2.1 0 3.6 1.2 5 3 1.4-1.8 2.9-3 5-3 3.2 0 5.3 3.1 4.2 6.2C19.5 15.4 12 20 12 20z"
        />
      </svg>
    </motion.button>
  );
}
