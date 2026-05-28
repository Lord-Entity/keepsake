import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo, useState } from "react";
import { DownloadCard } from "../components/features/DownloadCard";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Segmented } from "../components/ui/Segmented";
import { listItem, t } from "../components/ui/motion";
import { useDownloads } from "../state/downloads";
import { getPlatform } from "../state/engine";
import { isActive } from "../state/models";
import { navigate } from "../state/nav";
import { PAGE_STACK } from "../components/layout/page";

type Filter = "all" | "active" | "done" | "failed";

/** Only the first N cards animate; long lists render plainly to stay cheap. */
const ANIMATE_LIMIT = 200;

export function DownloadsPage({ phone }: { phone: boolean }) {
  const jobs = useDownloads();
  const reduced = useReducedMotion();
  const [filter, setFilter] = useState<Filter>("all");
  const canReveal = getPlatform() !== "android";

  const shown = useMemo(() => {
    switch (filter) {
      case "active":
        return jobs.filter((j) => isActive(j.status));
      case "done":
        return jobs.filter((j) => j.status === "done");
      case "failed":
        return jobs.filter((j) => j.status === "failed" || j.status === "cancelled");
      default:
        return jobs;
    }
  }, [jobs, filter]);

  if (jobs.length === 0) {
    return (
      <EmptyState
        illustration="downloads"
        title="No downloads yet"
        body="Paste a link on Home, pick a format and press Download. Progress shows up here."
        action={
          <Button variant="primary" size={phone ? "lg" : "md"} icon="home" onClick={() => navigate("home")}>
            Go to Home
          </Button>
        }
      />
    );
  }

  const count = {
    all: jobs.length,
    active: jobs.filter((j) => isActive(j.status)).length,
    done: jobs.filter((j) => j.status === "done").length,
    failed: jobs.filter((j) => j.status === "failed" || j.status === "cancelled").length,
  };

  return (
    <div className={PAGE_STACK}>
      <div className={phone ? "no-scrollbar -mx-4 overflow-x-auto px-4" : ""}>
        <Segmented<Filter>
          label="Filter downloads"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: count.all },
            { value: "active", label: "Active", icon: "bolt", count: count.active },
            { value: "done", label: "Done", icon: "check", count: count.done },
            { value: "failed", label: "Failed", icon: "alert", count: count.failed },
          ]}
        />
      </div>
      {/* Every download is its own animated card; cards enter, leave and reorder with the shared list motion. */}
      <section aria-label="Downloads" className={`grid min-w-0 grid-cols-1 ${phone ? "gap-3" : "gap-4 2xl:grid-cols-2"}`}>
        {shown.length === 0 ? (
          <motion.p
            key={filter}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={t.base}
            className="card shape-drop py-8 text-center text-fg-2"
          >
            Nothing here
          </motion.p>
        ) : shown.length > ANIMATE_LIMIT ? (
          shown.map((j) => (
            <div key={j.id} className="min-w-0">
              <DownloadCard job={j} phone={phone} canReveal={canReveal} />
            </div>
          ))
        ) : (
          <AnimatePresence>
            {shown.map((j, i) => (
              <motion.div key={j.id} layout={!reduced} {...listItem(reduced, i)} className="min-w-0">
                <DownloadCard job={j} phone={phone} canReveal={canReveal} />
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </section>
    </div>
  );
}
