import { useCallback, useMemo, useRef, useState } from "react";
import { LibraryList } from "../components/features/LibraryList";
import { Button } from "../components/ui/Button";
import { Collapsible } from "../components/ui/Collapsible";
import { EmptyState } from "../components/ui/EmptyState";
import { Select } from "../components/ui/Fields";
import { Icon } from "../components/ui/Icon";
import { Segmented } from "../components/ui/Segmented";
import { ActivityChart, CategoryBars, StatCard } from "../components/ui/Stats";
import { categoryOf, siteLabel, CATEGORIES } from "../lib/categories";
import type { DownloadMode } from "../lib/types";
import { getPlatform } from "../state/engine";
import { formatBytes, MOD } from "../state/format";
import { useMediaQuery, useWidth } from "../state/hooks";
import { useLibrary } from "../state/library";
import type { LibraryItem } from "../state/models";
import { navigate, useCommand, type Command } from "../state/nav";
import { loadUiPref, saveUiPref } from "../state/persist";
import { useStats } from "../state/stats";
import { PAGE_STACK } from "../components/layout/page";

type Kind = "all" | DownloadMode;
type Status = "all" | LibraryItem["status"];
type Sort = "newest" | "oldest" | "title";
type View = "list" | "grid";

const PAGE = 60;

export function LibraryPage({ phone }: { phone: boolean }) {
  const items = useLibrary();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [status, setStatus] = useState<Status>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [cat, setCat] = useState<string>("all");
  const [insights, setInsightsState] = useState<boolean>(() => loadUiPref<boolean>("libraryInsights", !phone));
  const stats = useStats();
  const [view, setViewState] = useState<View>(() => loadUiPref<View>("libraryView", "grid"));
  const [limit, setLimit] = useState(PAGE);
  const searchRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useWidth(wrapRef);
  const tiny = useMediaQuery("(max-width: 359.98px)");

  const setView = (v: View) => {
    setViewState(v);
    saveUiPref("libraryView", v);
  };

  const onCommand = useCallback((c: Command) => {
    if (c === "focus-library-search") searchRef.current?.focus();
  }, []);
  useCommand(onCommand, "library");

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    const list = items.filter(
      (i) =>
        (kind === "all" || i.mode === kind) &&
        (status === "all" || i.status === status) &&
        (cat === "all" || categoryOf(i.site) === cat) &&
        (!n ||
          i.title.toLowerCase().includes(n) ||
          (i.channel ?? "").toLowerCase().includes(n) ||
          i.site.toLowerCase().includes(n)),
    );
    if (sort === "oldest") list.sort((a, b) => a.date - b.date);
    else if (sort === "title") list.sort((a, b) => a.title.localeCompare(b.title));
    else list.sort((a, b) => b.date - a.date);
    return list;
  }, [items, q, kind, status, sort, cat]);

  // Three stat tiles share a ~256px row at 320px: shrink the value so it is not clipped.
  const statCls = phone ? "min-w-0 !p-2.5 [&_.tabular]:!text-[18px]" : "!p-3 [&_.tabular]:!text-[22px]";
  const columns = phone ? (tiny ? 1 : 2) : width > 0 && width < 760 ? 3 : 4;
  const clear = () => {
    setQ("");
    setKind("all");
    setStatus("all");
    setCat("all");
  };
  const setInsights = (v: boolean) => {
    setInsightsState(v);
    saveUiPref("libraryInsights", v);
  };

  if (items.length === 0) {
    return (
      <EmptyState
        icon="library"
        title="Your library is empty"
        body="Finished downloads appear here with their snapshots."
        action={
          <Button variant="primary" size={phone ? "lg" : "md"} icon="home" onClick={() => navigate("home")}>
            Go to Home
          </Button>
        }
      />
    );
  }

  const kindOptions = [
    { value: "all" as Kind, label: "All kinds", icon: "layers" as const },
    { value: "video" as Kind, label: "Video", icon: "video" as const },
    { value: "audio" as Kind, label: "Audio", icon: "audio" as const },
    { value: "thumbnail" as Kind, label: "Thumbnail", icon: "image" as const },
  ];
  const statusOptions = [
    { value: "all" as Status, label: "All statuses" },
    { value: "done" as Status, label: "Completed" },
    { value: "failed" as Status, label: "Failed" },
    { value: "cancelled" as Status, label: "Cancelled" },
  ];
  const sortOptions = [
    { value: "newest" as Sort, label: "Newest" },
    { value: "oldest" as Sort, label: "Oldest" },
    { value: "title" as Sort, label: "Title" },
  ];

  return (
    <div ref={wrapRef} className={PAGE_STACK}>
      <section className="card shape-drop px-4 py-2">
        <Collapsible
          title="Insights"
          subtitle={`${stats.total} items · ${formatBytes(stats.totalBytes)} · ${stats.successRate === null ? "no rate yet" : `${stats.successRate}% success`}`}
          icon="chart"
          open={insights}
          onOpenChange={setInsights}
        >
          <div
            className={`grid gap-4 pb-3 ${phone || (width > 0 && width < 760) ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.9fr)]"}`}
          >
            <div className="grid min-w-0 grid-cols-3 gap-2 self-start">
              <StatCard label="Total" value={String(stats.total)} icon="layers" shape="leaf" className={statCls} />
              <StatCard
                label="Success"
                value={stats.successRate === null ? "-" : `${stats.successRate}%`}
                icon="check"
                shape="tab"
                className={statCls}
              />
              <StatCard label="Size" value={formatBytes(stats.totalBytes)} icon="database" shape="drop" tint className={statCls} />
              <div className="col-span-3 pt-1">
                <div className="mb-1 text-[11px] font-medium text-fg-2">Last 14 days</div>
                <ActivityChart days={stats.last14Days} height={72} />
              </div>
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-[11px] font-medium text-fg-2">Categories · tap to filter</div>
              <CategoryBars items={stats.byCategory} active={cat} onPick={(c) => setCat((v) => (v === c ? "all" : c))} />
            </div>
            <div className="min-w-0">
              <div className="mb-1 text-[11px] font-medium text-fg-2">Top sites</div>
              <ul className="flex flex-col">
                {stats.bySite.slice(0, 6).map((s, i) => (
                  <li key={s.site} className="flex h-8 items-center gap-2 border-b border-line/60 text-[12px] last:border-b-0">
                    <span className="tabular w-4 shrink-0 text-fg-3">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{siteLabel(s.site)}</span>
                    <span className="tabular shrink-0 text-fg-2">{s.count}</span>
                  </li>
                ))}
                {stats.bySite.length === 0 && <li className="py-2 text-fg-3">No sites yet</li>}
              </ul>
            </div>
          </div>
        </Collapsible>
      </section>
      <div className={`flex gap-2 ${phone ? "flex-col" : "min-h-11 flex-wrap items-center"}`}>
        <label className={`icon-host group relative min-w-0 flex-1 ${phone ? "" : "basis-[220px]"}`}>
          <Icon
            name="search"
            size={16}
            animated
            className="absolute top-1/2 left-3 -translate-y-1/2 text-fg-3 group-focus-within:text-accent"
          />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setLimit(PAGE);
            }}
            placeholder="Search title, channel or site"
            aria-label={`Search library (${MOD}+F)`}
            className={`w-full rounded-[12px_12px_12px_5px] border border-line bg-inset pr-3 pl-9 text-[13px] text-fg transition-colors duration-150 placeholder:text-fg-3 hover:border-line-strong focus-visible:border-accent ${phone ? "h-12" : "h-9"}`}
          />
        </label>
        <div className={`flex items-center gap-2 ${phone ? "no-scrollbar -mx-4 overflow-x-auto px-4" : "flex-wrap"}`}>
          <Select label="Kind" value={kind} onChange={setKind} options={kindOptions} className="w-[140px] shrink-0" />
          <Select label="Status" value={status} onChange={setStatus} options={statusOptions} className="w-[140px] shrink-0" />
          <Select
            label="Category"
            value={cat}
            onChange={setCat}
            options={[{ value: "all", label: "All sources" }, ...CATEGORIES.map((c) => ({ value: c as string, label: c }))]}
            className="w-[140px] shrink-0"
          />
          <Select label="Sort" value={sort} onChange={setSort} options={sortOptions} className="w-[120px] shrink-0" />
          <Segmented<View>
            label="View"
            value={view}
            onChange={setView}
            className="shrink-0"
            options={[
              { value: "list", label: "List", icon: "list" },
              { value: "grid", label: "Grid", icon: "grid" },
            ]}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="flex min-w-0 flex-col items-center gap-3 py-16 text-center">
          <div className="max-w-full text-[15px] font-semibold [overflow-wrap:anywhere]">
            {q ? `No matches for "${q}"` : "No matches"}
          </div>
          <Button size={phone ? "lg" : "md"} onClick={clear}>
            Clear filters
          </Button>
        </div>
      ) : (
        <>
          <LibraryList
            items={filtered.slice(0, limit)}
            view={view}
            phone={phone}
            columns={columns}
            canReveal={getPlatform() !== "android"}
          />
          {filtered.length > limit && (
            <Button className="self-center" size={phone ? "lg" : "md"} onClick={() => setLimit((l) => l + PAGE)}>
              Show more
            </Button>
          )}
        </>
      )}
    </div>
  );
}
