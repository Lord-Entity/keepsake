import { formatPct } from "../../state/format";
import { isActive, type Job } from "../../state/models";
import { navigate } from "../../state/nav";
import { Icon } from "../ui/Icon";
import { CardDownloadArt } from "../ui/illustrations/CardDownloadArt";
import { DownloadStateArt } from "../ui/illustrations/DownloadStateArt";

/** Always-visible entry to the Downloads page with live active/failed summary. */
export function DownloadsEntry({ jobs }: { jobs: Job[] }) {
  const active = jobs.filter((j) => isActive(j.status));
  const running =
    active.find((j) => j.status === "downloading" || j.status === "merging" || j.status === "converting") ?? active[0];
  const failed = jobs.filter((j) => j.status === "failed").length;
  const pct = !running ? 0 : running.status === "downloading" ? running.pct : running.status === "queued" ? 0 : null;

  const state: "queued" | "downloading" | "processing" | "failed" | "idle" = running
    ? running.status === "downloading"
      ? "downloading"
      : running.status === "queued"
        ? "queued"
        : "processing"
    : failed > 0
      ? "failed"
      : "idle";
  const progress = running?.status === "downloading" && running.pct !== null ? running.pct : undefined;

  return (
    <button
      type="button"
      onClick={() => navigate("downloads")}
      aria-label={`Open Downloads${active.length ? `, ${active.length} active` : ""}${failed ? `, ${failed} failed` : ""}`}
      className="card card-interactive icon-host relative flex min-h-[76px] w-full min-w-0 items-center gap-3 overflow-hidden p-3 text-left"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-8 -right-8 size-36 rounded-full bg-[radial-gradient(circle,var(--color-accent-soft),transparent_70%)]"
      />
      {/* Fixed slot so swapping between the wide story scene and the idle ring never shifts the text. */}
      <span className="relative grid h-14 w-[84px] shrink-0 place-items-center">
        {state === "idle" ? (
          <CardDownloadArt state="idle" size={52} />
        ) : (
          <DownloadStateArt state={state} progress={progress} size={84} />
        )}
        {active.length > 0 && (
          <span className="tabular absolute -right-1 -bottom-1 grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[11px] leading-none font-semibold text-on-accent">
            {active.length}
          </span>
        )}
      </span>
      <span className="relative flex min-w-0 flex-1 flex-col">
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
      <span className="relative flex shrink-0 items-center gap-0.5 text-[12px] font-medium text-accent">
        View all
        <Icon name="chevronRight" size={16} animated />
      </span>
      {running && pct !== null && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-0 h-[3px] bg-accent transition-[width] duration-300"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      )}
    </button>
  );
}
