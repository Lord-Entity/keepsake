import { relativeTime } from "../../state/format";
import type { LibraryItem } from "../../state/models";
import { navigate } from "../../state/nav";
import { openFile } from "../../state/native";
import { CardDownloadArt } from "../ui/illustrations/CardDownloadArt";
import { CardKindBadge } from "../ui/illustrations/CardKindBadge";
import { Thumb } from "./PreviewCard";

/** Horizontal strip of recently finished downloads, tappable to open the file. */
export function RecentStrip({ items }: { items: LibraryItem[] }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label="Recent downloads">
      <div className="flex h-7 items-center justify-between gap-2">
        <h2 className="text-[15px] leading-[22px] font-semibold">Recent downloads</h2>
        <button
          type="button"
          onClick={() => navigate("library")}
          className="relative rounded-sm text-[12px] font-medium text-accent transition-[opacity,transform] duration-150 before:absolute before:-inset-x-2 before:-inset-y-[16px] before:content-[''] hover:underline active:scale-[0.97]"
        >
          View all
        </button>
      </div>
      {items.length === 0 ? (
        <div className="rounded-md border border-dashed border-line px-4 py-5 text-center text-[13px] text-fg-2">
          Finished downloads show up here.
        </div>
      ) : (
        <ul className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-1 [scrollbar-width:none]">
          {items.map((r, i) => (
            <li
              key={r.id}
              className="cdl-rise w-[148px] shrink-0 snap-start"
              style={{ animationDelay: `${Math.min(i, 8) * 50}ms` }}
            >
              <button
                type="button"
                onClick={() => {
                  if (r.status === "done" && r.filePath) void openFile(r.filePath);
                  else navigate("library");
                }}
                aria-label={`${r.title}, ${r.status === "done" ? "open file" : r.status}`}
                className="card card-interactive flex min-h-12 w-full min-w-0 flex-col overflow-hidden rounded-[18px_18px_18px_8px] p-0 text-left transition-transform duration-150 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
              >
                <span className="relative block">
                  <Thumb
                    src={r.thumbnailUrl}
                    icon={r.mode === "audio" ? "audio" : r.mode === "thumbnail" ? "image" : "video"}
                    className="aspect-video w-full rounded-none"
                  />
                  <CardKindBadge
                    kind={r.mode === "audio" ? "audio" : r.mode === "thumbnail" ? "image" : "video"}
                    className="absolute top-1.5 left-1.5 size-6 drop-shadow-sm"
                  />
                  {(r.status === "done" || r.status === "failed" || r.status === "cancelled") && (
                    <CardDownloadArt state={r.status} size={22} className="absolute top-1.5 right-1.5 drop-shadow-sm" />
                  )}
                  {r.status === "failed" && (
                    <span className="absolute bottom-1.5 left-1.5 rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      Failed
                    </span>
                  )}
                  {r.status === "cancelled" && (
                    <span className="absolute bottom-1.5 left-1.5 rounded-full bg-card/90 px-1.5 py-0.5 text-[10px] font-semibold text-fg-2">
                      Cancelled
                    </span>
                  )}
                </span>
                <span className="flex min-w-0 flex-col gap-1 px-2.5 pt-2 pb-2.5">
                  <span className="line-clamp-2 text-[12px] leading-4 font-medium [overflow-wrap:anywhere]">{r.title}</span>
                  <span className="tabular truncate text-[11px] text-fg-2">
                    {r.status === "done" ? r.format : r.status} · {relativeTime(r.date)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
