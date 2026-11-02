import { useMemo } from "react";
import { categoryOf, CATEGORIES, type Category } from "../lib/categories";
import { useLibrary } from "./library";
import type { LibraryItem } from "./models";

export interface DayCount {
  /** Local date, "YYYY-MM-DD". */
  day: string;
  count: number;
}

export interface Stats {
  /** Number of library items (any status). */
  total: number;
  /** 0-100, done / (done + failed); null when there is nothing to rate. */
  successRate: number | null;
  /** Sum of sizeBytes of completed items. */
  totalBytes: number;
  /** 14 entries, oldest first, ending today. Counts completed items. */
  last14Days: DayCount[];
  /** One entry per category (fixed order), counts all items. */
  byCategory: { category: Category; count: number }[];
  /** Top 8 sites by item count, descending. */
  bySite: { site: string; count: number }[];
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function computeLibraryStats(items: LibraryItem[], now: number = Date.now()): Stats {
  let done = 0;
  let failed = 0;
  let totalBytes = 0;
  const perDay = new Map<string, number>();
  const perCat = new Map<Category, number>();
  const perSite = new Map<string, number>();

  for (const i of items) {
    if (i.status === "done") {
      done++;
      totalBytes += i.sizeBytes ?? 0;
      const k = dayKey(i.date);
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    } else if (i.status === "failed") {
      failed++;
    }
    const cat = categoryOf(i.site);
    perCat.set(cat, (perCat.get(cat) ?? 0) + 1);
    const site = i.site || "generic";
    perSite.set(site, (perSite.get(site) ?? 0) + 1);
  }

  const last14Days: DayCount[] = [];
  const start = new Date(now);
  start.setHours(12, 0, 0, 0); // midday avoids DST edge cases when stepping days
  for (let back = 13; back >= 0; back--) {
    const d = new Date(start);
    d.setDate(start.getDate() - back);
    const day = dayKey(d.getTime());
    last14Days.push({ day, count: perDay.get(day) ?? 0 });
  }

  const bySite = [...perSite.entries()].map(([site, count]) => ({ site, count }));
  bySite.sort((a, b) => b.count - a.count || a.site.localeCompare(b.site));

  const rated = done + failed;
  return {
    total: items.length,
    successRate: items.length && rated ? Math.round((done / rated) * 100) : null,
    totalBytes,
    last14Days,
    byCategory: CATEGORIES.map((category) => ({ category, count: perCat.get(category) ?? 0 })),
    bySite: bySite.slice(0, 8),
  };
}

export function useStats(): Stats {
  const items = useLibrary();
  return useMemo(() => computeLibraryStats(items), [items]);
}
