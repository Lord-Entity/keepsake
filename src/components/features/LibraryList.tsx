import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { redownload } from "../../state/downloads";
import { formatBytes, formatDate } from "../../state/format";
import { removeLibraryItem } from "../../state/library";
import type { LibraryItem } from "../../state/models";
import { openFile, revealFile } from "../../state/native";
import { Badge, type BadgeTone } from "../ui/Badge";
import { IconButton } from "../ui/Button";
import type { IconName } from "../ui/Icon";
import { listItem } from "../ui/motion";
import { ActionSheet } from "../ui/Sheet";
import { Thumb } from "./PreviewCard";

const KIND_ICON: Record<LibraryItem["mode"], "video" | "audio" | "image"> = {
  video: "video",
  audio: "audio",
  thumbnail: "image",
};
const KIND_LABEL: Record<LibraryItem["mode"], string> = {
  video: "Video",
  audio: "Audio",
  thumbnail: "Thumbnail",
};
const STATUS_TONE: Record<LibraryItem["status"], BadgeTone> = {
  done: "success",
  failed: "danger",
  cancelled: "neutral",
};

interface ItemAction {
  icon: IconName;
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
}

function actionsFor(item: LibraryItem, canReveal: boolean): ItemAction[] {
  const hasFile = item.status === "done" && !!item.filePath;
  const list: ItemAction[] = [
    { icon: "open", label: "Open", run: () => item.filePath && void openFile(item.filePath), disabled: !hasFile },
  ];
  if (canReveal) {
    list.push({
      icon: "folder",
      label: "Show in folder",
      run: () => item.filePath && void revealFile(item.filePath),
      disabled: !hasFile,
    });
  }
  list.push(
    { icon: "retry", label: "Download again", run: () => redownload(item) },
    { icon: "trash", label: "Remove from library", run: () => removeLibraryItem(item.id), danger: true },
  );
  return list;
}

export function LibraryList({
  items,
  view,
  phone,
  canReveal = true,
  columns,
}: {
  items: LibraryItem[];
  view: "list" | "grid";
  phone?: boolean;
  canReveal?: boolean;
  columns: number;
}) {
  const reduced = useReducedMotion();
  const [sheetFor, setSheetFor] = useState<LibraryItem | null>(null);

  return (
    <>
      {view === "grid" ? (
        <div className="grid gap-3 sm:gap-4" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          <AnimatePresence>
            {items.map((item, i) => (
              <motion.div
                key={item.id}
                layout={!reduced}
                {...listItem(reduced, i)}
                className="card card-interactive card-lift group relative flex min-w-0 flex-col overflow-hidden"
              >
                <div className="overflow-hidden">
                  <Thumb
                    src={item.thumbnailUrl}
                    icon={KIND_ICON[item.mode]}
                    className="aspect-video w-full transition-[scale] duration-500 ease-out group-hover:scale-[1.03]"
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1 p-3">
                  <div className="line-clamp-2 min-h-10 text-[13px] font-medium [overflow-wrap:anywhere]" title={item.title}>
                    {item.title}
                  </div>
                  <div className="min-w-0 truncate text-[11px] text-fg-2" title={item.channel ?? item.site}>
                    {item.channel ?? item.site}
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-2">
                    <span>{formatDate(item.date)}</span>
                    <Badge>{item.format}</Badge>
                    {item.status !== "done" && <Badge tone={STATUS_TONE[item.status]}>{item.status}</Badge>}
                  </div>
                </div>
                {phone ? (
                  <IconButton
                    icon="more"
                    label="Actions"
                    size={48}
                    className="absolute top-1 right-1 bg-black/40 text-white"
                    onClick={() => setSheetFor(item)}
                  />
                ) : (
                  <div className="absolute top-2 right-2 flex translate-y-1 gap-1 rounded-md bg-card/90 p-1 opacity-0 shadow-card transition-[opacity,translate] duration-200 ease-out group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100">
                    {actionsFor(item, canReveal).map((a) => (
                      <IconButton key={a.label} icon={a.icon} label={a.label} size={32} disabled={a.disabled} onClick={a.run} />
                    ))}
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      ) : (
        <div className="card flex min-w-0 flex-col px-4 py-1">
          <AnimatePresence>
            {items.map((item, i) => (
              <motion.div
                key={item.id}
                layout={!reduced}
                {...listItem(reduced, i)}
                className="group flex h-14 min-w-0 items-center gap-3 border-b border-line last:border-b-0"
              >
                <Thumb src={item.thumbnailUrl} icon={KIND_ICON[item.mode]} className="h-9 w-16 shrink-0 rounded-sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium" title={item.title}>
                    {item.title}
                  </div>
                  <div className="truncate text-[11px] text-fg-2" title={item.channel ?? item.site}>
                    {item.channel ?? item.site}
                  </div>
                </div>
                {!phone && (
                  <>
                    <span className="shrink-0">
                      <Badge tone={item.status === "done" ? "neutral" : STATUS_TONE[item.status]}>
                        {item.status === "done" ? KIND_LABEL[item.mode] : item.status}
                      </Badge>
                    </span>
                    <span className="w-14 shrink-0 truncate text-[11px] text-fg-2" title={item.format}>
                      {item.format}
                    </span>
                    <span className="tabular w-24 shrink-0 truncate text-[11px] text-fg-2">{formatDate(item.date)}</span>
                    <span className="tabular w-16 shrink-0 truncate text-right text-[11px] text-fg-2">
                      {formatBytes(item.sizeBytes)}
                    </span>
                  </>
                )}
                {phone ? (
                  <IconButton icon="more" label="Actions" size={48} className="shrink-0" onClick={() => setSheetFor(item)} />
                ) : (
                  <div className="flex shrink-0 translate-x-1 gap-1 opacity-0 transition-[opacity,translate] duration-200 ease-out group-focus-within:translate-x-0 group-focus-within:opacity-100 group-hover:translate-x-0 group-hover:opacity-100">
                    {actionsFor(item, canReveal).map((a) => (
                      <IconButton key={a.label} icon={a.icon} label={a.label} size={32} disabled={a.disabled} onClick={a.run} />
                    ))}
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
      <ActionSheet
        open={sheetFor !== null}
        onClose={() => setSheetFor(null)}
        title={sheetFor?.title}
        actions={
          sheetFor
            ? actionsFor(sheetFor, canReveal).map((a) => ({
                label: a.label,
                icon: a.icon,
                onSelect: a.run,
                disabled: a.disabled,
                danger: a.danger,
              }))
            : []
        }
      />
    </>
  );
}
