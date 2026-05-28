import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { redownload } from "../../state/downloads";
import { formatBytes, formatDate } from "../../state/format";
import { removeLibraryItem } from "../../state/library";
import type { LibraryItem } from "../../state/models";
import { openFile, revealFile } from "../../state/native";
import { Badge } from "../ui/Badge";
import { IconButton } from "../ui/Button";
import { CardKindBadge } from "../ui/illustrations/CardKindBadge";
import { listItem } from "../ui/motion";
import { ActionSheet } from "../ui/Sheet";
import { KIND_ART, KIND_LABEL, LibraryCard, STATUS_TONE, useLongPress, type CardAction } from "./LibraryCard";
import { Thumb } from "./PreviewCard";

function actionsFor(item: LibraryItem, canReveal: boolean): CardAction[] {
  const hasFile = item.status === "done" && !!item.filePath;
  const list: CardAction[] = [
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
              <motion.div key={item.id} layout={!reduced} {...listItem(reduced, i)} className="min-w-0">
                <LibraryCard
                  item={item}
                  index={i}
                  phone={phone}
                  actions={actionsFor(item, canReveal)}
                  onMenu={() => setSheetFor(item)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      ) : (
        <div className="card shape-drop flex min-w-0 flex-col px-3 py-1 sm:px-4">
          <AnimatePresence>
            {items.map((item, i) => (
              <motion.div
                key={item.id}
                layout={!reduced}
                {...listItem(reduced, i)}
                className="border-b border-line last:border-b-0"
              >
                <ListRow item={item} phone={phone} canReveal={canReveal} onMenu={() => setSheetFor(item)} />
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

/** Compact list row: framed thumb with the animated kind badge; long-press opens the sheet on phones. */
function ListRow({
  item,
  phone,
  canReveal,
  onMenu,
}: {
  item: LibraryItem;
  phone?: boolean;
  canReveal: boolean;
  onMenu: () => void;
}) {
  const hold = useLongPress(onMenu, !!phone);
  return (
    <div
      {...hold}
      className={`group flex h-14 min-w-0 items-center gap-3 ${phone ? "select-none" : ""}`}
    >
      <span className="relative shrink-0">
        <Thumb src={item.thumbnailUrl} icon={KIND_ART[item.mode]} className="h-9 w-16 rounded-[10px_4px_8px_4px]" />
        <span aria-hidden="true" className="absolute -right-1.5 -bottom-1.5 block size-5 drop-shadow-sm">
          <CardKindBadge kind={KIND_ART[item.mode]} className="size-full" />
        </span>
      </span>
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
        <IconButton icon="more" label="Actions" size={48} className="shrink-0" onClick={onMenu} />
      ) : (
        <div className="flex shrink-0 translate-x-1 gap-1 opacity-0 transition-[opacity,translate] duration-200 ease-out group-focus-within:translate-x-0 group-focus-within:opacity-100 group-hover:translate-x-0 group-hover:opacity-100">
          {actionsFor(item, canReveal).map((a) => (
            <IconButton key={a.label} icon={a.icon} label={a.label} size={32} disabled={a.disabled} onClick={a.run} />
          ))}
        </div>
      )}
    </div>
  );
}
