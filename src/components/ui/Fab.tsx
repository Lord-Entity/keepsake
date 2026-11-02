import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Glyph } from "./Glyph";
import { Icon, type IconName } from "./Icon";
import { press, t } from "./motion";

export interface FabAction {
  label: string;
  icon: IconName;
  onSelect: () => void;
}

/**
 * Floating action button. A tapered accent drop that, on click, turns its plus
 * into a cross and fans a small action group up out of itself (staggered spring).
 * Esc, a click outside or choosing an action closes it. Position it with className
 * (it renders `absolute`; the caller supplies the offsets).
 */
export function Fab({
  actions,
  label = "Quick actions",
  className = "",
  phone,
}: {
  actions: FabAction[];
  label?: string;
  className?: string;
  phone?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();
  const root = useRef<HTMLDivElement>(null);
  const size = phone ? 56 : 52;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className={`pointer-events-none absolute z-30 flex flex-col items-end gap-2.5 ${className}`}>
      <AnimatePresence>
        {open && (
          <motion.ul
            role="menu"
            aria-label={label}
            className="pointer-events-auto flex flex-col items-end gap-2"
            initial="closed"
            animate="open"
            exit="closed"
            variants={{
              open: { transition: { staggerChildren: 0.045, staggerDirection: -1 } },
              closed: { transition: { staggerChildren: 0.03 } },
            }}
          >
            {actions.map((a) => (
              <motion.li
                key={a.label}
                variants={
                  reduced
                    ? { open: { opacity: 1 }, closed: { opacity: 0 } }
                    : {
                        open: { opacity: 1, y: 0, scale: 1, transition: t.spring },
                        closed: { opacity: 0, y: 14, scale: 0.85, transition: t.fast },
                      }
                }
                style={{ transformOrigin: "100% 100%" }}
              >
                <motion.button
                  type="button"
                  role="menuitem"
                  whileTap={press}
                  transition={t.press}
                  onClick={() => {
                    setOpen(false);
                    a.onSelect();
                  }}
                  className={`glyph-host icon-host card card-interactive flex items-center gap-2.5 !rounded-[18px_6px_18px_18px] py-1.5 pr-2 pl-3.5 text-[12px] font-medium text-fg shadow-pop ${phone ? "min-h-12" : "min-h-10"}`}
                >
                  {a.label}
                  <Glyph icon={a.icon} size={16} box={30} />
                </motion.button>
              </motion.li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
      <motion.button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        whileHover={reduced ? undefined : { y: -2, scale: 1.03 }}
        whileTap={{ scale: 0.94 }}
        transition={t.press}
        style={{ width: size, height: size }}
        className="pointer-events-auto relative grid place-items-center rounded-[22px_22px_8px_22px] bg-accent text-on-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_16px_30px_-12px_var(--accent)] transition-colors duration-150 hover:bg-accent-hover active:bg-accent-active"
      >
        {/* Separate SVG parts: a soft ring that blooms while open, and the plus that turns. */}
        <motion.svg
          aria-hidden="true"
          viewBox="0 0 60 60"
          className="pointer-events-none absolute -inset-1.5"
          style={{ width: size + 12, height: size + 12 }}
          animate={{ opacity: open ? 1 : 0, scale: open ? 1 : 0.8, rotate: open ? 45 : 0 }}
          transition={t.spring}
        >
          <rect x="2" y="2" width="56" height="56" rx="22" fill="none" stroke="var(--accent-border)" strokeWidth="1.5" strokeDasharray="3 6" />
        </motion.svg>
        <motion.span animate={{ rotate: open ? 135 : 0 }} transition={t.spring} className="relative grid place-items-center">
          <Icon name="plus" size={phone ? 26 : 24} strokeWidth={2.2} />
        </motion.span>
      </motion.button>
    </div>
  );
}
