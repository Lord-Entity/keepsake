import { motion, useReducedMotion } from "motion/react";
import { useId, useRef, type KeyboardEvent } from "react";
import { Icon, type IconName } from "./Icon";
import { t } from "./motion";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
  icon?: IconName;
  /** Small tabular count shown after the label. */
  count?: number;
}

/**
 * Pill tab bar. The active thumb is a raised pill with a notch bitten out of its
 * lower edge (CSS mask, `.notch-thumb`) and an accent bead seated in the notch;
 * thumb and bead spring together between options (shared layoutId).
 * Arrow keys (and Home / End) move the selection like a radio group.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
  disabled,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  // Unique layoutId per instance so two segmented controls never share a thumb.
  const id = useId();
  const reduced = useReducedMotion();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: KeyboardEvent, i: number) => {
    const k = e.key;
    // Home / End jump to the ends, then walk inward past disabled options.
    const from = k === "Home" ? -1 : k === "End" ? options.length : i;
    const dir =
      k === "ArrowRight" || k === "ArrowDown" || k === "Home" ? 1 : k === "ArrowLeft" || k === "ArrowUp" || k === "End" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    for (let n = 1; n <= options.length; n++) {
      const j = (from + dir * n + options.length * 2) % options.length;
      const o = options[j];
      if (o && !o.disabled) {
        onChange(o.value);
        refs.current[j]?.focus();
        return;
      }
    }
  };

  const spring = reduced ? { duration: 0 } : t.spring;
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`inline-flex h-9 items-stretch rounded-full border border-line bg-inset p-[3px] shadow-[inset_0_1px_2px_rgba(0,0,0,0.18)] ${disabled ? "pointer-events-none opacity-45" : ""} ${className}`}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={`hit icon-host relative flex flex-1 items-center justify-center gap-1.5 rounded-full px-3.5 text-[12px] font-medium whitespace-nowrap transition-[color,transform] duration-150 active:scale-[0.96] disabled:opacity-45 ${
              selected ? "text-fg" : "text-fg-2 hover:text-fg"
            }`}
          >
            {selected && (
              <>
                <motion.span
                  layoutId={`seg-thumb-${id}`}
                  transition={spring}
                  className="notch-thumb absolute inset-0 rounded-full bg-card shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_2px_6px_rgba(0,0,0,0.25)] dark:bg-line-strong"
                />
                <motion.span
                  layoutId={`seg-bead-${id}`}
                  transition={spring}
                  className="absolute bottom-[-1px] left-1/2 size-[5px] -translate-x-1/2 rounded-full bg-accent"
                />
              </>
            )}
            {o.icon && <Icon name={o.icon} size={14} animated className={`relative ${selected ? "text-accent" : ""}`} />}
            <span className="relative">{o.label}</span>
            {o.count !== undefined && (
              <span className={`tabular relative text-[10px] ${selected ? "text-accent" : "text-fg-3"}`}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
