import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useState, type ReactNode } from "react";
import { Glyph } from "./Glyph";
import { Icon, type IconName } from "./Icon";
import { t } from "./motion";

/**
 * Collapsible section: a header button with a turning chevron and a body that
 * animates its height (auto) and fades its content. Optional persisted state is
 * the caller's job (pass `open` / `onOpenChange`).
 */
export function Collapsible({
  title,
  subtitle,
  icon,
  right,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  children,
  className = "",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: IconName;
  right?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const reduced = useReducedMotion();
  const [inner, setInner] = useState(defaultOpen);
  const open = openProp ?? inner;
  const toggle = () => {
    setInner(!open);
    onOpenChange?.(!open);
  };
  return (
    <div className={`flex min-w-0 flex-col ${className}`}>
      <div className="flex min-h-11 items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={toggle}
          className="glyph-host icon-host group -mx-1 flex min-w-0 flex-1 items-center gap-3 rounded-[12px_12px_12px_5px] px-1 py-1 text-left transition-colors duration-150 hover:bg-card-hover/60"
        >
          {icon && <Glyph icon={icon} size={16} box={32} on={open} />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold">{title}</span>
            {subtitle && <span className="block truncate text-[11px] leading-[14px] text-fg-2">{subtitle}</span>}
          </span>
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={t.spring}
            className="grid size-7 shrink-0 place-items-center rounded-full bg-inset text-fg-2 group-hover:text-fg"
          >
            <Icon name="chevronDown" size={16} />
          </motion.span>
        </button>
        {right}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`${id}-body`}
            key="body"
            initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={reduced ? t.fast : { height: t.spring, opacity: t.base }}
            className="overflow-hidden"
          >
            <motion.div
              initial={reduced ? false : { y: -6 }}
              animate={{ y: 0 }}
              exit={reduced ? undefined : { y: -6 }}
              transition={t.spring}
              className="pt-2"
            >
              {children}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
