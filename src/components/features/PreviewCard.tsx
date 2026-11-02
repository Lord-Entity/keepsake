import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { VideoInfo } from "../../lib/types";
import { formatClock, formatCount, formatDate } from "../../state/format";
import { Badge } from "../ui/Badge";
import { Icon } from "../ui/Icon";
import { Skeleton } from "../ui/Fields";
import { press, t } from "../ui/motion";

function kicker(info: VideoInfo): string {
  const site = info.site.toUpperCase();
  if (info.kind === "playlist") {
    return `PLAYLIST · ${site}${info.playlistCount ? ` · ${info.playlistCount} ITEMS` : ""}`;
  }
  return `${info.kind === "audio" || !info.hasVideo ? "AUDIO" : "VIDEO"} · ${site}`;
}

export function Thumb({
  src,
  icon = "video",
  className = "",
  contain,
}: {
  src: string | null | undefined;
  icon?: "video" | "audio" | "image";
  className?: string;
  contain?: boolean;
}) {
  return (
    <div className={`relative overflow-hidden bg-line ${className}`}>
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          loading="lazy"
          referrerPolicy="no-referrer"
          className={`absolute inset-0 size-full ${contain ? "object-contain" : "object-cover"}`}
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      ) : null}
      <div className="absolute inset-0 -z-0 flex items-center justify-center text-fg-3">
        {!src && <Icon name={icon} size={24} />}
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] leading-[14px] text-fg-3">{label}</div>
      <div className="tabular truncate text-[13px] font-medium">{value}</div>
    </div>
  );
}

export function PreviewCard({
  info,
  loading,
  phone,
  onOpenFormats,
}: {
  info: VideoInfo | null;
  loading: boolean;
  phone?: boolean;
  onOpenFormats?: () => void;
}) {
  const reduced = useReducedMotion();
  const fade = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -4 } };

  return (
    <AnimatePresence mode="wait" initial={false}>
      {loading ? (
        <motion.div key="loading" {...fade} transition={t.base} className={`flex min-h-0 flex-1 gap-4 ${phone ? "flex-col" : ""}`}>
          <Skeleton className={phone ? "aspect-video w-full" : "aspect-video h-full max-h-full shrink-0 rounded-md"} />
          <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1">
            <div className="text-[11px] font-medium tracking-wider text-fg-3">FETCHING</div>
            <div className="text-[15px] font-semibold">Reading link info...</div>
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </motion.div>
      ) : info ? (
        <motion.div key={info.url} {...fade} transition={t.base} className={`flex min-h-0 flex-1 gap-4 ${phone ? "flex-col" : ""}`}>
          <Thumb
            src={info.thumbnails[0]?.url}
            icon={info.hasVideo ? "video" : "audio"}
            contain={!info.hasVideo}
            className={`aspect-video shrink-0 rounded-md ${phone ? "w-full" : "h-full max-h-[220px] self-start"}`}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="truncate text-[11px] font-medium tracking-wider text-accent">{kicker(info)}</div>
            <h3
              className="selectable line-clamp-2 min-w-0 text-[15px] leading-[22px] font-semibold [overflow-wrap:anywhere]"
              title={info.title}
            >
              {info.title.length > 140 ? `${info.title.slice(0, 139)}…` : info.title}
            </h3>
            {info.channel && (
              <div className="min-w-0 truncate text-fg-2" title={info.channel}>
                {info.channel}
              </div>
            )}
            <div className="mt-1 grid grid-cols-3 gap-2 sm:gap-3">
              <Meta label="Duration" value={info.durationSec ? formatClock(info.durationSec) : "--"} />
              <Meta label="Views" value={formatCount(info.viewCount)} />
              <Meta label="Uploaded" value={formatDate(info.uploadDate)} />
            </div>
            {info.description && (
              <p className="truncate text-[11px] leading-[14px] text-fg-2">{info.description}</p>
            )}
            {info.previewOnly && (
              <Badge tone="warning" className="self-start" title="Preview only">
                Preview only: the full track may need a sign-in (Settings &gt; Cookies)
              </Badge>
            )}
            {phone && onOpenFormats && (
              <motion.button
                type="button"
                onClick={onOpenFormats}
                whileTap={press}
                transition={t.press}
                className="icon-host mt-2 inline-flex h-12 items-center justify-center gap-2 rounded-md bg-accent text-[14px] font-semibold text-on-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_10px_22px_-12px_var(--accent)] transition-colors duration-150 active:bg-accent-active"
              >
                <Icon name="download" size={18} animated />
                Choose format
              </motion.button>
            )}
          </div>
        </motion.div>
      ) : (
        <motion.div
          key="empty"
          {...fade}
          transition={t.base}
          className="flex flex-1 flex-col items-center justify-center gap-2 text-center"
        >
          <span className="breathe icon-host flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
            <Icon name="link" size={22} animated />
          </span>
          <div className="text-[11px] font-medium tracking-wider text-fg-3">NO VIDEO</div>
          <div className="text-[15px] font-semibold">Paste a link to get started</div>
          <div className="text-fg-2">YouTube and 1,000+ other sites. Press Enter or Fetch.</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
