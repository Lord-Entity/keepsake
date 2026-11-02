import { motion, useReducedMotion } from "motion/react";
import { useActiveCount } from "../../state/downloads";
import { navigate, usePage } from "../../state/nav";
import { Icon } from "../ui/Icon";
import { t } from "../ui/motion";
import { TAB_ITEMS } from "./nav-items";

/**
 * Phone navigation (UI_MOBILE.md): 64px row plus the bottom safe-area inset,
 * 24px icons, 12px labels, 48px+ touch targets. The active pill is notched on its
 * lower edge with an accent bead seated in the notch; both slide (layoutId).
 * Five slots: Home, Downloads, Library, Favorites, Settings (Sources lives on Home).
 */
export function TabBar() {
  const page = usePage();
  const active = useActiveCount();
  const reduced = useReducedMotion();
  const spring = reduced ? { duration: 0 } : t.spring;
  return (
    // In flow below <main> (never overlays content). The 64px row sits above the
    // gesture/nav-bar inset; side insets keep tabs clear of landscape cutouts.
    <nav
      aria-label="Main"
      className="shrink-0 border-t border-line bg-sidebar pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
    >
      <div className="flex h-16 items-stretch px-1">
        {TAB_ITEMS.map((item) => {
          const on = page === item.page || (item.page === "home" && page === "sources");
          return (
            <motion.button
              key={item.page}
              type="button"
              whileTap={{ scale: 0.95 }}
              transition={t.press}
              onClick={() => navigate(item.page)}
              aria-current={on ? "page" : undefined}
              className={`relative flex min-h-12 min-w-12 flex-1 flex-col items-center justify-center gap-1 text-[11px] leading-4 font-medium transition-colors duration-150 ${
                on ? "text-accent" : "text-fg-2"
              }`}
            >
              <span className="relative flex h-8 w-12 items-center justify-center">
                {on && (
                  <>
                    <motion.span
                      layoutId="tabbar-active"
                      transition={spring}
                      className="notch-thumb absolute inset-0 rounded-full bg-accent-soft"
                      aria-hidden="true"
                    />
                    <motion.span
                      layoutId="tabbar-bead"
                      transition={spring}
                      className="absolute bottom-[-2px] left-1/2 size-[5px] -translate-x-1/2 rounded-full bg-accent"
                      aria-hidden="true"
                    />
                  </>
                )}
                <span className="relative">
                  <Icon name={item.icon} size={22} />
                  {item.page === "downloads" && active > 0 && (
                    <span className="absolute -top-1 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] text-on-accent">
                      {active}
                    </span>
                  )}
                </span>
              </span>
              {item.label}
            </motion.button>
          );
        })}
      </div>
    </nav>
  );
}
