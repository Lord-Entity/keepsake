import { formatPct } from "../../state/format";
import { isActive, type Job } from "../../state/models";
import { navigate } from "../../state/nav";
import { Icon } from "../ui/Icon";
import { ProgressRing } from "../ui/Ring";

/** Always-visible entry to the Downloads page with live active/failed summary. */
export function DownloadsEntry({ jobs }: { jobs: Job[] }) {
  const active = jobs.filter((j) => isActive(j.status));
  const running =
    active.find((j) => j.status === "downloading" || j.status === "merging" || j.status === "converting") ?? active[0];
  const failed = jobs.filter((j) => j.status === "failed").length;
  const pct = !running ? 0 : running.status === "downloading" ? running.pct : running.status === "queued" ? 0 : null;

  return (
    <button
      type="button"
      onClick={() => navigate("downloads")}
      aria-label={`Open Downloads${active.length ? `, ${active.length} active` : ""}${failed ? `, ${failed} failed` : ""}`}
      className="card card-interactive icon-host flex min-h-[72px] w-full min-w-0 items-center gap-3 p-3 text-left"
    >
      <span className="shrink-0">
        <ProgressRing size={48} pct={pct}>
          {active.length > 0 ? (
            <span className="tabular text-[14px] font-semibold">{active.length}</span>
          ) : (
            <Icon name="download" size={18} className="text-fg-3" />
          )}
        </ProgressRing>
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[14px] font-semibold">Downloads</span>
        {running ? (
          <span className="truncate text-[12px] text-fg-2">
            {`${active.length} active`}
            {running.status === "downloading" && running.pct !== null ? ` · ${formatPct(running.pct)}` : ""}
            {` · ${running.title}`}
          </span>
        ) : failed > 0 ? (
          <span className="truncate text-[12px] text-danger">{`${failed} failed · tap to retry`}</span>
        ) : (
          <span className="truncate text-[12px] text-fg-2">Nothing downloading right now</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-0.5 text-[12px] font-medium text-accent">
        View all
        <Icon name="chevronRight" size={16} animated />
      </span>
    </button>
  );
}
