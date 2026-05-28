import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { VideoInfo } from "../../lib/types";
import { formatClock, formatCount, formatDate } from "../../state/format";
import { Badge } from "../ui/Badge";
import { Icon } from "../ui/Icon";
import { CardBow } from "../ui/illustrations/CardBow";
import { CardKindBadge } from "../ui/illustrations/CardKindBadge";
import { CardReadyStamp } from "../ui/illustrations/CardReadyStamp";
import "../ui/illustrations/CardSurface.css";
import { Mascot } from "../ui/illustrations/Mascot";
import { Scene, Sparkle } from "../ui/illustrations/Scene";
import { Pulse } from "../ui/Loader";
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
          <div
            aria-hidden="true"
            className={`ks-shimmer motion-safe-only rounded-[var(--radius-sm)] ${
              phone ? "aspect-video w-full" : "aspect-video h-full max-h-full shrink-0 rounded-md"
            }`}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1">
            <div className="text-[11px] font-medium tracking-wider text-fg-3">FETCHING</div>
            <div className="text-[15px] font-semibold">{phone ? "Looking up your link…" : "Reading link info..."}</div>
            <Pulse lines={3} />
          </div>
        </motion.div>
      ) : info ? (
        <motion.div key={info.url} {...fade} transition={t.base} className={`flex min-h-0 flex-1 gap-4 ${phone ? "flex-col" : ""}`}>
          {phone ? (
            // Phone: full-width hero thumb with the duration pinned on it and a "ready" stamp.
            <div className="relative w-full shrink-0">
              <div className="phero-frame relative overflow-hidden">
                <Thumb
                  src={info.thumbnails[0]?.url}
                  icon={info.hasVideo ? "video" : "audio"}
                  contain={!info.hasVideo}
                  className="aspect-video w-full shrink-0"
                />
                <span aria-hidden="true" className="absolute bottom-2 left-2 block size-8 drop-shadow-sm">
                  <CardKindBadge kind={info.hasVideo ? "video" : "audio"} className="size-full" />
                </span>
                {info.durationSec ? (
                  <span className="tabular absolute right-2 bottom-2 rounded-md bg-black/75 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                    {formatClock(info.durationSec)}
                  </span>
                ) : null}
              </div>
              <span aria-hidden="true" className="pointer-events-none absolute -top-2.5 -left-2 block w-10">
                <CardBow className="w-full" />
              </span>
              <CardReadyStamp label="Ready" className="phero-stamp absolute -top-3 -right-2 size-[68px]" />
            </div>
          ) : (
            // Desktop keeps the original sizing (height-driven 16:9, capped at 220px) on the wrapper.
            <div className="relative aspect-video h-full max-h-[220px] shrink-0 self-start">
              <div className="phero-frame absolute inset-0 overflow-hidden">
                <Thumb
                  src={info.thumbnails[0]?.url}
                  icon={info.hasVideo ? "video" : "audio"}
                  contain={!info.hasVideo}
                  className="size-full"
                />
                <span aria-hidden="true" className="absolute bottom-2 left-2 block size-8 drop-shadow-sm">
                  <CardKindBadge kind={info.hasVideo ? "video" : "audio"} className="size-full" />
                </span>
              </div>
              <span aria-hidden="true" className="pointer-events-none absolute -top-2.5 -left-2 block w-10">
                <CardBow className="w-full" />
              </span>
              <CardReadyStamp label="Ready" className="phero-stamp absolute -top-4 -right-4 size-[64px]" />
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="truncate text-[11px] font-medium tracking-wider text-accent">{kicker(info)}</div>
            <h3
              className={`selectable line-clamp-2 min-w-0 font-semibold [overflow-wrap:anywhere] ${phone ? "text-[17px] leading-6" : "text-[15px] leading-[22px]"}`}
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
          <div className="w-28 shrink-0">
            <Scene>
              <Mascot x={120} y={150} scale={1.25} mood="curious" pose="wave" lid="tip" />
              <Sparkle x={70} y={60} size={7} />
              <Sparkle x={176} y={48} size={5} delay={0.9} />
            </Scene>
          </div>
          <div className="text-[11px] font-medium tracking-wider text-fg-3">NO VIDEO</div>
          <div className="text-[15px] font-semibold">Paste a link to get started</div>
          <div className="text-fg-2">YouTube and 1,000+ other sites. Press Enter or Fetch.</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
