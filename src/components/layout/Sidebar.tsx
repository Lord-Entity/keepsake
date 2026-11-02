import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { useActiveCount } from "../../state/downloads";
import { healthOf, useBinaries, type Health } from "../../state/engine";
import { MOD } from "../../state/format";
import { navigate, openAddLink, usePage } from "../../state/nav";
import { Badge, Dot, type BadgeTone } from "../ui/Badge";
import { Glyph } from "../ui/Glyph";
import { Icon, Logo } from "../ui/Icon";
import { press, t } from "../ui/motion";
import { NAV_ITEMS } from "./nav-items";

const HEALTH: Record<Health, { tone: BadgeTone; label: string }> = {
  ready: { tone: "success", label: "Ready" },
  ffmpeg: { tone: "warning", label: "ffmpeg missing" },
  ytdlp: { tone: "danger", label: "yt-dlp missing" },
  unsupported: { tone: "success", label: "Built-in engine" },
  loading: { tone: "neutral", label: "Checking tools" },
};

/**
 * collapsed: visual rail state. overlay: the narrow-window expanded overlay.
 * onToggle flips the stored preference (or the overlay on narrow windows).
 */
export function Sidebar({
  collapsed,
  overlay,
  onToggle,
  onCloseOverlay,
  onSupportedSites,
}: {
  collapsed: boolean;
  overlay: boolean;
  onToggle: () => void;
  onCloseOverlay: () => void;
  onSupportedSites: () => void;
}) {
  const page = usePage();
  const active = useActiveCount();
  const health = HEALTH[healthOf(useBinaries())];
  const rail = collapsed && !overlay;

  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseOverlay();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, onCloseOverlay]);

  const aside = (
    <motion.aside
      layout
      transition={t.spring}
      style={{ width: rail ? 64 : 232 }}
      className={`flex h-full shrink-0 flex-col overflow-hidden border-r border-line bg-sidebar ${
        overlay ? "absolute inset-y-0 left-0 z-40 shadow-pop" : "relative"
      }`}
      aria-label="Sidebar"
    >
      <div className={`flex h-16 shrink-0 items-center gap-3 ${rail ? "justify-center" : "px-4"}`}>
        <Logo size={32} />
        <AnimatePresence initial={false}>
          {!rail && (
            <motion.span
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -4 }}
              transition={t.fast}
              className="text-[15px] font-semibold tracking-tight"
            >
              Keepsake
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <nav className="flex flex-col gap-1 px-3 pt-2">
        {NAV_ITEMS.map((item) => {
          const isActive = page === item.page;
          return (
            <motion.button
              key={item.page}
              type="button"
              onClick={() => {
                navigate(item.page);
                if (overlay) onCloseOverlay();
              }}
              whileTap={press}
              transition={t.press}
              title={rail ? `${item.label} (${MOD}+${item.key})` : undefined}
              aria-current={isActive ? "page" : undefined}
              className={`glyph-host icon-host group relative flex h-11 items-center gap-2.5 rounded-[14px_14px_14px_5px] text-[12px] font-medium transition-colors duration-150 ${
                rail ? "justify-center" : "pr-3 pl-1.5"
              } ${isActive ? "text-fg" : "text-fg-2 hover:bg-card-hover/50 hover:text-fg"}`}
            >
              {isActive && (
                <motion.span
                  layoutId="nav-pill"
                  transition={t.spring}
                  className="absolute inset-0 rounded-[14px_14px_14px_5px] border border-line bg-card-hover shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                >
                  <span className="absolute top-3 bottom-3 -left-[1px] w-[3px] rounded-r-full bg-accent" />
                </motion.span>
              )}
              <span className={`relative transition-colors duration-150 ${isActive ? "text-accent" : ""}`}>
                <Glyph icon={item.icon} size={19} box={34} on={isActive} />
                {rail && item.page === "downloads" && active > 0 && (
                  <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-accent shadow-[0_0_0_2px_var(--bg-sidebar)]" />
                )}
              </span>
              <AnimatePresence initial={false}>
                {!rail && (
                  <motion.span
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -4 }}
                    transition={t.fast}
                    className="relative flex flex-1 items-center justify-between whitespace-nowrap"
                  >
                    {item.label}
                    {item.page === "downloads" && active > 0 && <Badge tone="accent">{active}</Badge>}
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-1 px-3 pb-3">
        <motion.button
          type="button"
          onClick={() => {
            openAddLink("sources");
            if (overlay) onCloseOverlay();
          }}
          whileTap={press}
          transition={t.press}
          title={`Add a link to Sources or Favorites`}
          aria-label="Add link"
          className={`glyph-host icon-host mb-1 flex h-10 items-center gap-2 rounded-[14px_14px_5px_14px] border border-dashed border-accent-border text-[12px] font-medium text-accent transition-colors duration-150 hover:bg-accent-soft ${
            rail ? "justify-center" : "px-2"
          }`}
        >
          <Glyph icon="plus" size={16} box={28} />
          {!rail && <span className="whitespace-nowrap">Add link</span>}
        </motion.button>
        <div
          className={`flex h-9 items-center gap-2 text-[11px] text-fg-2 ${rail ? "justify-center" : "px-3"}`}
          title={`yt-dlp / ffmpeg: ${health.label}`}
        >
          <Dot tone={health.tone} />
          {!rail && <span className="truncate">{health.label}</span>}
        </div>
        {!rail && (
          <button
            type="button"
            onClick={onSupportedSites}
            className="icon-host group flex h-9 items-center gap-2 rounded-sm px-3 text-[12px] text-fg-2 transition-colors hover:bg-accent-soft hover:text-fg"
          >
            <Icon name="globe" size={16} animated />
            Supported sites
          </button>
        )}
        <button
          type="button"
          onClick={onToggle}
          title={`${rail ? "Expand sidebar" : "Collapse sidebar"} (${MOD}+B)`}
          aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
          className={`icon-host group flex h-9 items-center rounded-sm text-fg-2 transition-colors hover:bg-accent-soft hover:text-fg ${
            rail ? "justify-center" : "px-3"
          }`}
        >
          <Icon name={rail ? "chevronRight" : "chevronLeft"} size={18} animated />
        </button>
      </div>
    </motion.aside>
  );

  if (!overlay) return aside;
  return (
    <>
      {/* Rail placeholder keeps the content from jumping while the overlay is open. */}
      <div className="w-16 shrink-0 border-r border-line bg-sidebar" />
      <div className="absolute inset-0 z-30 bg-black/40" onMouseDown={onCloseOverlay} />
      {aside}
    </>
  );
}
