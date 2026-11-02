import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { useActiveCount } from "../../state/downloads";
import { MOD } from "../../state/format";
import { navigate, PAGE_TITLES, usePage } from "../../state/nav";
import { cycleTheme, useSettings, type ThemePref } from "../../state/settings";
import { IconButton } from "../ui/Button";
import { Logo, type IconName } from "../ui/Icon";
import { press, t } from "../ui/motion";
import { WindowControls } from "./WindowControls";

const THEME_ICON: Record<ThemePref, IconName> = { system: "monitor", light: "sun", dark: "moon" };
const NEXT_LABEL: Record<ThemePref, string> = {
  system: "Switch to light",
  light: "Switch to dark",
  dark: "Use system theme",
};

/**
 * In-app header (56px). Native decorations stay on (UI_LAYOUT.md), so the
 * header is also a drag region on desktop via data-tauri-drag-region.
 *
 * Compact (phone): the 56px row sits below the status bar. `box-content` keeps the
 * row 56px tall and adds the top safe-area inset on top of it (with border-box the
 * inset would eat into the row). Side insets cover landscape cutouts. The active
 * downloads pill is omitted because the tab bar's Downloads tab already shows the count.
 */
export function Titlebar({ action, compact }: { action?: ReactNode; compact?: boolean }) {
  const page = usePage();
  const theme = useSettings((s) => s.theme);
  const active = useActiveCount();
  return (
    <header
      data-tauri-drag-region
      className={`flex h-14 shrink-0 items-center justify-between gap-3 ${
        compact
          ? "box-content pt-[env(safe-area-inset-top)] pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]"
          : "px-6"
      }`}
    >
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2.5">
        {compact && (
          <span className="hidden shrink-0 min-[360px]:block" aria-hidden="true">
            <Logo size={28} />
          </span>
        )}
        <h1 data-tauri-drag-region className="truncate text-[20px] leading-7 font-semibold tracking-[-0.01em]">
          {PAGE_TITLES[page]}
        </h1>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {action}
        <IconButton
          icon={THEME_ICON[theme]}
          label={`${NEXT_LABEL[theme]} (${MOD}+Shift+L)`}
          size={compact ? 44 : 36}
          onClick={cycleTheme}
        />
        <AnimatePresence initial={false}>
          {!compact && active > 0 && (
            <motion.button
              type="button"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              whileTap={press}
              transition={t.fast}
              onClick={() => navigate("downloads")}
              className="tabular flex h-8 items-center gap-1.5 rounded-full bg-accent-soft px-3 text-[12px] font-medium text-accent transition-[box-shadow] duration-150 hover:shadow-[inset_0_0_0_1px_var(--accent-border)]"
              title="Active downloads"
            >
              <span className="spinner size-3" aria-hidden="true" />
              {active} active
            </motion.button>
          )}
        </AnimatePresence>
        {!compact && <WindowControls />}
      </div>
    </header>
  );
}
