import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { siteLabel } from "../../lib/categories";
import { formatBytes, formatDate } from "../../state/format";
import type { LibraryItem } from "../../state/models";
import { Badge, type BadgeTone } from "../ui/Badge";
import { IconButton } from "../ui/Button";
import type { IconName } from "../ui/Icon";
import { CardBow } from "../ui/illustrations/CardBow";
import { CardKindBadge } from "../ui/illustrations/CardKindBadge";
import "../ui/illustrations/CardSurface.css";
import { Thumb } from "./PreviewCard";

/** One library action; the same list feeds the desktop tray and the phone action sheet. */
export interface CardAction {
  icon: IconName;
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export const KIND_ART: Record<LibraryItem["mode"], "video" | "audio" | "image"> = {
  video: "video",
  audio: "audio",
  thumbnail: "image",
};
export const KIND_LABEL: Record<LibraryItem["mode"], string> = {
  video: "Video",
  audio: "Audio",
  thumbnail: "Thumbnail",
};
export const STATUS_TONE: Record<LibraryItem["status"], BadgeTone> = {
  done: "success",
  failed: "danger",
  cancelled: "neutral",
};

const LONG_PRESS_MS = 480;
const MOVE_TOLERANCE = 10;

/**
 * Touch long-press: fires `onLong` after a still ~0.5s hold (not for mouse), cancels on
 * scroll-sized movement, and swallows the native context menu so the sheet wins.
 * Returns no handlers when disabled, so desktop markup is untouched.
 */
export function useLongPress(onLong: () => void, enabled: boolean) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const cb = useRef(onLong);
  useEffect(() => {
    cb.current = onLong;
  });
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  if (!enabled) return {};
  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType === "mouse") return;
      cancel();
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        origin.current = null;
        if ("vibrate" in navigator) navigator.vibrate(12);
        cb.current();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const o = origin.current;
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > MOVE_TOLERANCE) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  };
}

/**
 * An illustrated library card: framed thumbnail with a gold Kip bow, an animated kind
 * badge, platform tag, quality/size chips, a hover tray of actions on desktop and a
 * "more" button plus long-press sheet on phones.
 */
export function LibraryCard({
  item,
  index,
  phone,
  actions,
  onMenu,
}: {
  item: LibraryItem;
  index: number;
  phone?: boolean;
  actions: CardAction[];
  onMenu: () => void;
}) {
  const hold = useLongPress(onMenu, !!phone);
  const size = item.sizeBytes != null && item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : null;
  const delay = { "--lcard-delay": `${Math.min(index, 8) * 30 + 180}ms` } as CSSProperties;

  return (
    <article
      {...hold}
      style={delay}
      className={`lcard card card-interactive card-lift shape-leaf group relative flex h-full min-w-0 flex-col overflow-hidden ${phone ? "lcard-press select-none" : ""}`}
    >
      <div className="lcard-frame relative overflow-hidden">
        <Thumb
          src={item.thumbnailUrl}
          icon={KIND_ART[item.mode]}
          className="aspect-video w-full transition-[scale] duration-500 ease-out group-hover:scale-[1.04]"
        />
        <span aria-hidden="true" className="lcard-stitch" />
        <span aria-hidden="true" className="lcard-kind absolute bottom-1.5 left-1.5 block size-7 drop-shadow-sm">
          <CardKindBadge kind={KIND_ART[item.mode]} className="size-full" />
        </span>
        <span className="sr-only">{KIND_LABEL[item.mode]}</span>
        <span className="lcard-tag absolute right-1.5 bottom-1.5 truncate" title={item.site}>
          {siteLabel(item.site)}
        </span>
      </div>
      <span aria-hidden="true" className="lcard-bow pointer-events-none absolute top-0 left-0 block w-9">
        <CardBow className="w-full" />
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3 pt-2.5">
        <div className="line-clamp-2 min-h-10 text-[13px] leading-5 font-semibold [overflow-wrap:anywhere]" title={item.title}>
          {item.title}
        </div>
        <div className="min-w-0 truncate text-[11px] text-fg-2" title={item.channel ?? item.site}>
          {item.channel ?? item.site}
        </div>
        <div className="mt-auto flex min-w-0 flex-wrap items-center gap-1 pt-1">
          <span className="lcard-chip" title={item.format}>
            <span className="lcard-chip-dot" aria-hidden="true" />
            {item.format}
          </span>
          {size && <span className="lcard-chip lcard-chip-size tabular">{size}</span>}
          {item.status !== "done" && <Badge tone={STATUS_TONE[item.status]}>{item.status}</Badge>}
        </div>
        <div className="tabular truncate text-[10.5px] text-fg-3">{formatDate(item.date)}</div>
      </div>

      {phone ? (
        <IconButton
          icon="more"
          label="Actions"
          size={48}
          className="absolute top-1 right-1 bg-black/40 text-white"
          onClick={onMenu}
        />
      ) : (
        <div className="lcard-tray absolute top-2.5 right-2.5 flex translate-y-1 gap-1 rounded-md bg-card/90 p-1 opacity-0 shadow-card transition-[opacity,translate] duration-200 ease-out group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100">
          {actions.map((a) => (
            <IconButton key={a.label} icon={a.icon} label={a.label} size={32} disabled={a.disabled} onClick={a.run} />
          ))}
        </div>
      )}
    </article>
  );
}
