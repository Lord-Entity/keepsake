import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Thumb } from "../components/features/PreviewCard";
import { TagBadge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Dialog } from "../components/ui/Dialog";
import { Icon } from "../components/ui/Icon";
import { RadioGroup } from "../components/ui/RadioGroup";
import { t } from "../components/ui/motion";
import { categoryOf, siteLabel } from "../lib/categories";
import type { VideoInfo } from "../lib/types";
import { asAppError, fetchInfo } from "../state/engine";
import { isFavorite, toggleFavorite, type FavoriteKind } from "../state/favorites";
import { hostOf, isHttpUrl } from "../state/format";
import { readClipboard } from "../state/native";
import { closeAddLink, navigate, useAddLink, type AddLinkTarget } from "../state/nav";
import { settingsStore } from "../state/settings";
import { addSource, type SourceKind } from "../state/sources";
import { notify } from "../state/toast";

/** Guess what a link points at from its shape (no network). */
export function guessSourceKind(url: string): SourceKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "other";
  }
  const host = u.hostname.replace(/^(www|m)\./, "");
  const path = u.pathname;
  if (u.searchParams.has("list") || /\/playlist|\/sets\//.test(path)) return "playlist";
  if (host.endsWith("youtube.com") && /^\/(@|channel\/|c\/|user\/)/.test(path)) return "channel";
  if (host.endsWith("twitch.tv")) return "channel";
  if (/(instagram\.com|tiktok\.com|x\.com|twitter\.com|soundcloud\.com)$/.test(host)) {
    const segs = path.split("/").filter(Boolean);
    if (segs.length === 1 && !/^(p|reel|reels|video|explore)$/.test(segs[0])) return "profile";
    if (host.endsWith("tiktok.com") && segs.length === 1 && segs[0].startsWith("@")) return "profile";
  }
  return "other";
}

function favoriteKind(url: string, info: VideoInfo | null): FavoriteKind {
  if (info && info.kind !== "playlist") return info.kind === "audio" || !info.hasVideo ? "audio" : "video";
  const k = guessSourceKind(url);
  return k === "profile" ? "profile" : k === "channel" || k === "playlist" ? "channel" : "video";
}

/** Stable favorite id for a fetched item (shared by Home's heart and the Add link flow). */
export function favoriteIdOf(info: VideoInfo): string {
  return `${info.site}:${info.id}`;
}

export function favoriteFromInfo(info: VideoInfo) {
  return {
    id: favoriteIdOf(info),
    url: info.url,
    title: info.title,
    thumbnailUrl: info.thumbnails[0]?.url ?? null,
    site: info.site,
    kind: favoriteKind(info.url, info),
  };
}

/**
 * "Add link" flow: paste a link, optionally look it up (title + thumbnail), then
 * save it to Sources or Favorites. Opened from the FAB, the sidebar, Sources and Favorites.
 */
export function AddLinkDialog({ phone }: { phone: boolean }) {
  const { open, target, url, seq } = useAddLink();
  return (
    <Dialog
      open={open}
      onClose={closeAddLink}
      title="Add link"
      description="Save a creator, channel, profile or video to come back to."
      phone={phone}
      width={480}
    >
      <AddLinkForm key={seq} phone={phone} initialTarget={target} initialUrl={url} />
    </Dialog>
  );
}

function AddLinkForm({
  phone,
  initialTarget,
  initialUrl,
}: {
  phone: boolean;
  initialTarget: AddLinkTarget;
  initialUrl: string;
}) {
  const reduced = useReducedMotion();
  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState<AddLinkTarget>(initialTarget);
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const clean = url.trim();
  const valid = isHttpUrl(clean);

  const lookUp = () => {
    if (!valid) {
      setError("Paste a full link that starts with http.");
      return;
    }
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setLooking(true);
    setError(null);
    void fetchInfo(clean, { signal: ctrl.signal, cookiesBrowser: settingsStore.get().cookiesBrowser })
      .then((i) => {
        if (ctrl.signal.aborted) return;
        setInfo(i);
        setTitle((tt) => tt || i.channel || i.title);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(`${asAppError(e).message.split(" (Details:")[0]} You can still save the link.`);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLooking(false);
      });
  };

  const save = () => {
    if (!valid) {
      setError("Paste a full link that starts with http.");
      return;
    }
    const site = info?.site || hostOf(clean);
    const name = title.trim() || info?.title || hostOf(clean) || clean;
    const thumb = info?.thumbnails[0]?.url ?? null;
    if (target === "sources") {
      addSource({ url: clean, title: name, site, kind: info?.kind === "playlist" ? "playlist" : guessSourceKind(clean), thumbnailUrl: thumb });
      notify({ tone: "success", title: "Added to Sources", body: name, action: { label: "View", run: () => navigate("sources") } });
    } else {
      const id = info ? favoriteIdOf(info) : clean;
      if (!isFavorite(id)) {
        toggleFavorite({ id, url: info?.url ?? clean, title: name, thumbnailUrl: thumb, site, kind: favoriteKind(clean, info) });
      }
      notify({ tone: "success", title: "Saved to Favorites", body: name, action: { label: "View", run: () => navigate("favorites") } });
    }
    closeAddLink();
  };

  const site = info?.site || hostOf(clean);
  return (
    <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (info) save();
          else lookUp();
        }}
      >
        <div className="flex items-center gap-2">
          <label className="relative min-w-0 flex-1">
            <Icon name="link" size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-fg-3" />
            <input
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setInfo(null);
                setError(null);
              }}
              placeholder="https://www.youtube.com/@channel"
              aria-label="Link"
              spellCheck={false}
              autoComplete="off"
              className={`w-full rounded-[12px_12px_12px_5px] border border-line bg-inset pr-3 pl-9 text-[13px] text-fg transition-[border-color,box-shadow] duration-200 placeholder:text-fg-3 hover:border-line-strong focus:border-accent-border focus:shadow-[0_0_0_3px_var(--accent-soft)] ${phone ? "h-12" : "h-10"}`}
            />
          </label>
          <Button
            icon="clipboard"
            size={phone ? "lg" : "md"}
            className={phone ? "" : "h-10"}
            aria-label="Paste"
            title="Paste"
            onClick={() =>
              void readClipboard().then((txt) => {
                const v = txt.trim();
                if (v) {
                  setUrl(v);
                  setInfo(null);
                  setError(null);
                }
              })
            }
          >
            {phone ? "" : "Paste"}
          </Button>
        </div>

        <RadioGroup<AddLinkTarget>
          label="Save to"
          value={target}
          onChange={setTarget}
          compact={phone}
          options={[
            { value: "sources", label: "Sources", description: "Creators, channels, profiles", icon: "sources" },
            { value: "favorites", label: "Favorites", description: "Anything worth keeping", icon: "heart" },
          ]}
        />

        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-fg-2">Name (optional)</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={hostOf(clean) || "Shown on the card"}
            className={`w-full rounded-[12px_12px_12px_5px] border border-line bg-inset px-3 text-[13px] text-fg transition-[border-color,box-shadow] duration-200 placeholder:text-fg-3 hover:border-line-strong focus:border-accent-border focus:shadow-[0_0_0_3px_var(--accent-soft)] ${phone ? "h-12" : "h-9"}`}
          />
        </label>

        <AnimatePresence mode="wait" initial={false}>
          {info ? (
            <motion.div
              key="info"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={t.spring}
              className="card shape-drop flex items-center gap-3 p-2.5"
            >
              <Thumb src={info.thumbnails[0]?.url} className="aspect-video w-24 shrink-0 rounded-[10px_10px_10px_4px]" />
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-[13px] font-semibold [overflow-wrap:anywhere]">{info.title}</div>
                <div className="mt-1 flex min-w-0 items-center gap-1.5">
                  <TagBadge>{categoryOf(site)}</TagBadge>
                  <span className="truncate text-[11px] text-fg-2">{info.channel ?? siteLabel(site)}</span>
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div key="lookup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={t.fast}>
              <Button
                type="submit"
                variant="secondary"
                icon="search"
                size={phone ? "lg" : "md"}
                className={phone ? "w-full" : ""}
                loading={looking}
                disabled={!valid}
              >
                {looking ? "Looking up" : "Look up title and thumbnail"}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
        <div className={`flex justify-end gap-2 pt-1 ${phone ? "flex-col-reverse" : ""}`}>
          <Button variant="ghost" size={phone ? "lg" : "md"} onClick={closeAddLink}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size={phone ? "lg" : "md"}
            icon={target === "sources" ? "sources" : "heart"}
            disabled={!valid}
            onClick={save}
          >
            {target === "sources" ? "Add to Sources" : "Save to Favorites"}
          </Button>
        </div>
      </form>
  );
}
