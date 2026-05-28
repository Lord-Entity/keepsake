import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { useActiveCount } from "../../state/downloads";
import { navigate, usePage } from "../../state/nav";
import { Icon } from "../ui/Icon";
import { t } from "../ui/motion";
import { TAB_CENTER, TAB_ITEMS, tabForPage } from "./nav-items";

/**
 * Phone navigation: a floating, rounded bar that still sits in flow below <main>, so
 * page content never hides behind it. Five tabs: Home, Library, Editor (raised accent
 * circle in the centre), Favorites, Settings. Downloads and Sources are reached from
 * Home, and the bar keeps Home highlighted while they are open. Home shows a dot while
 * downloads run. Every target is at least 48dp (min-w-12 / min-h-12) and labels
 * truncate rather than wrap on narrow phones. Reduced motion is honoured (no tap
 * scale, no pill/circle spring). Arrow/Home/End keys rove focus between tabs.
 */
export function TabBar() {
  const page = usePage();
  const active = useActiveCount();
  const reduced = useReducedMotion();
  const spring = reduced ? { duration: 0 } : t.spring;
  const listRef = useRef<HTMLDivElement>(null);
  const current = tabForPage(page);

  // The phone toast stack offsets itself by this var: 88 = 16 top pad + 64 bar + 8 bottom pad.
  useEffect(() => {
    document.documentElement.style.setProperty("--tabbar-h", "88px");
    return () => {
      document.documentElement.style.removeProperty("--tabbar-h");
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = TAB_ITEMS.length - 1;
    let next: number;
    if (e.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (e.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else return;
    e.preventDefault();
    navigate(TAB_ITEMS[next].page);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <nav
      aria-label="Main"
      className="shrink-0 bg-app pt-4 pr-[max(0.75rem,env(safe-area-inset-right))] pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pl-[max(0.75rem,env(safe-area-inset-left))]"
    >
      <div
        ref={listRef}
        role="tablist"
        aria-label="Main sections"
        aria-orientation="horizontal"
        className="relative flex h-16 items-stretch rounded-[24px] border border-line bg-card px-1.5 shadow-lift"
      >
        {TAB_ITEMS.map((item, index) => {
          const on = item.page === current;
          const center = item.page === TAB_CENTER;
          const running = item.page === "home" && active > 0;
          return (
            <motion.button
              key={item.key}
              type="button"
              role="tab"
              id={`tab-${item.page}`}
              aria-selected={on}
              aria-label={
                running ? `Home, ${active} download${active === 1 ? "" : "s"} running` : undefined
              }
              tabIndex={on ? 0 : -1}
              whileTap={reduced ? undefined : { scale: 0.94 }}
              transition={t.press}
              onClick={() => navigate(item.page)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={`relative flex min-h-12 min-w-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-[18px] text-[11px] leading-4 font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring ${
                on ? "text-accent" : "text-fg-2"
              }`}
            >
              {center ? (
                <motion.span
                  aria-hidden="true"
                  className="relative -mt-4 flex size-14 items-center justify-center rounded-full bg-accent text-on-accent shadow-lift ring-4 ring-app"
                  animate={{ scale: on && !reduced ? 1.06 : 1 }}
                  transition={spring}
                >
                  <Icon name={item.icon} size={24} strokeWidth={2} />
                </motion.span>
              ) : (
                <>
                  {on && (
                    <motion.span
                      layoutId="tabbar-pill"
                      transition={spring}
                      aria-hidden="true"
                      className="absolute inset-x-0.5 inset-y-1.5 rounded-[18px] bg-accent-soft"
                    />
                  )}
                  <span className="relative">
                    <Icon name={item.icon} size={22} strokeWidth={on ? 2.1 : 1.75} />
                    {running && (
                      <span
                        aria-hidden="true"
                        className="absolute -top-0.5 -right-1 size-2 rounded-full bg-accent ring-2 ring-card"
                      />
                    )}
                  </span>
                </>
              )}
              <span
                className={`relative max-w-full truncate px-0.5 ${
                  center ? `font-semibold ${on ? "text-accent" : "text-fg"}` : ""
                }`}
              >
                {item.label}
              </span>
            </motion.button>
          );
        })}
      </div>
    </nav>
  );
}
