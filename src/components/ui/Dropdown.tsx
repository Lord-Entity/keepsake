import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";
import { press, t } from "./motion";

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  hint?: string;
}

const ROW = 36;
/** Phone rows grow to the 44px touch minimum (`.touch-row` in theme.css). */
const ROW_PHONE = 44;
const PHONE_QUERY = "(max-width: 759.98px), (pointer: coarse)";
const GAP = 6;
const EDGE = 8;

/**
 * Custom select. The trigger is a combobox button; the list is a floating panel in
 * a portal (so scrolling filter rows and dialogs never clip it) with a spring
 * open/close, arrow/Home/End/type-ahead keyboard navigation, click-outside close,
 * and a drawn check on the selected row. Focus stays on the trigger
 * (aria-activedescendant), so Esc and Tab behave like a native select.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
  disabled,
  title,
  icon,
}: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
  disabled?: boolean;
  title?: string;
  icon?: IconName;
}) {
  const reduced = useReducedMotion();
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean; maxH: number } | null>(
    null,
  );
  const typed = useRef({ text: "", at: 0 });
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const current = options[selectedIndex];
  const lead = icon ?? current?.icon;

  // Fit the list in the visible viewport (the visual viewport shrinks when the
  // Android keyboard is up): open below, flip up when there is more room above,
  // and cap the height to the room on the chosen side.
  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const vv = window.visualViewport;
    const vh = vv ? vv.height + vv.offsetTop : window.innerHeight;
    const vw = vv ? vv.width + vv.offsetLeft : window.innerWidth;
    const row = window.matchMedia(PHONE_QUERY).matches ? ROW_PHONE : ROW;
    const want = Math.min(options.length * row + 12, 320);
    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const up = want > below && above > below;
    const maxH = Math.max(row + 12, Math.min(want, up ? above : below));
    const width = Math.min(Math.max(r.width, 160), vw - EDGE * 2);
    const left = Math.min(Math.max(EDGE, r.left), vw - width - EDGE);
    setPos({ top: up ? r.top - GAP - maxH : r.bottom + GAP, left, width, up, maxH });
  }, [options.length]);

  const openList = () => {
    if (disabled) return;
    setActive(selectedIndex);
    place();
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };
  const choose = (i: number) => {
    const o = options[i];
    if (o) onChange(o.value);
    close();
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (btn.current?.contains(n) || panel.current?.contains(n)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (panel.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // Keep the highlighted row in view.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const k = e.key;
    if (!open) {
      if (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " ") {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (k === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (k === "Tab") {
      close(false);
    } else if (k === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (k === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (k === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (k === "End") {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (k === "Enter" || k === " ") {
      e.preventDefault();
      choose(active);
    } else if (k.length === 1 && /\S/.test(k)) {
      const now = e.timeStamp;
      typed.current.text = now - typed.current.at > 600 ? k.toLowerCase() : typed.current.text + k.toLowerCase();
      typed.current.at = now;
      const hit = options.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.text));
      if (hit >= 0) setActive(hit);
    }
  };

  const list = (
    <AnimatePresence>
      {open && pos && (
        <motion.div
          ref={panel}
          data-popover
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: pos.up ? 6 : -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: pos.up ? 4 : -4, transition: t.fast }}
          transition={t.spring}
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxH,
            transformOrigin: pos.up ? "50% 100%" : "50% 0%",
          }}
          className="card z-[70] flex flex-col overflow-hidden !rounded-[16px_16px_16px_6px] p-1.5 shadow-pop"
        >
          <ul id={`${id}-list`} role="listbox" aria-label={label} className="scroll-y min-h-0 flex-1 overscroll-contain">
            {options.map((o, i) => {
              const sel = o.value === value;
              const hi = i === active;
              return (
                <li
                  key={o.value}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={sel}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                  className={`touch-row relative flex h-9 shrink-0 cursor-default items-center gap-2 rounded-[10px] px-2.5 text-[12px] font-medium transition-colors duration-100 ${
                    sel ? "text-fg" : hi ? "text-fg" : "text-fg-2"
                  }`}
                >
                  {hi && (
                    <motion.span
                      layoutId={`${id}-hi`}
                      transition={t.press}
                      className="absolute inset-0 rounded-[10px] bg-card-hover shadow-[inset_0_0_0_1px_var(--border)]"
                    />
                  )}
                  {o.icon && <Icon name={o.icon} size={15} className={`relative ${sel ? "text-accent" : ""}`} />}
                  <span className="relative min-w-0 flex-1 truncate">{o.label}</span>
                  {o.hint && <span className="relative text-[11px] text-fg-3">{o.hint}</span>}
                  <span className="relative grid size-4 place-items-center text-accent">
                    {sel && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <motion.path
                          d="M5 12.5l4.5 4.5L19 7"
                          stroke="currentColor"
                          strokeWidth={2.4}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          initial={reduced ? false : { pathLength: 0 }}
                          animate={{ pathLength: 1 }}
                          transition={{ duration: 0.26, delay: 0.06 }}
                        />
                      </svg>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div className={`relative ${className}`}>
      <motion.button
        ref={btn}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open ? `${id}-opt-${active}` : undefined}
        title={title}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKey}
        whileTap={disabled ? undefined : press}
        transition={t.press}
        className={`hit icon-host group flex h-9 w-full items-center gap-2 rounded-[12px_12px_12px_5px] border bg-inset pr-2 pl-3 text-left text-[12px] font-medium text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-[border-color,background-color,box-shadow] duration-150 hover:border-line-strong hover:bg-card-hover disabled:pointer-events-none disabled:opacity-45 ${
          open ? "border-accent-border shadow-[0_0_0_3px_var(--accent-soft)]" : "border-line"
        }`}
      >
        {lead && <Icon name={lead} size={15} className="shrink-0 text-fg-2" />}
        <span className="min-w-0 flex-1 truncate">{current?.label ?? ""}</span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={t.spring}
          className="grid shrink-0 place-items-center text-fg-2"
        >
          <Icon name="chevronDown" size={16} />
        </motion.span>
      </motion.button>
      {typeof document === "undefined" ? list : createPortal(list, document.body)}
    </div>
  );
}
