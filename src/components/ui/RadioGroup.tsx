import { motion, useReducedMotion } from "motion/react";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Glyph } from "./Glyph";
import type { IconName } from "./Icon";
import { t } from "./motion";

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: IconName;
  /** Optional custom art shown above the label (e.g. a theme preview). */
  art?: ReactNode;
  disabled?: boolean;
}

/**
 * Custom radio group: tactile tiles with a hand-made radio dial. The accent bead
 * is one shared element (layoutId) that springs from tile to tile and squashes as
 * it lands. Roving tabindex with arrow keys, like a native radio group.
 */
export function RadioGroup<T extends string>({
  value,
  options,
  onChange,
  label,
  columns,
  className = "",
  compact,
}: {
  value: T;
  options: RadioOption<T>[];
  onChange: (v: T) => void;
  label: string;
  columns?: number;
  className?: string;
  compact?: boolean;
}) {
  const id = useId();
  const reduced = useReducedMotion();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);

  const move = (from: number, dir: 1 | -1) => {
    const pos = enabled.indexOf(from);
    const next = enabled[(pos + dir + enabled.length) % enabled.length];
    const o = options[next];
    if (!o) return;
    onChange(o.value);
    refs.current[next]?.focus();
  };

  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(i, 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(i, -1);
    } else if ((e.key === "Home" || e.key === "End") && enabled.length) {
      e.preventDefault();
      const j = e.key === "Home" ? enabled[0] : enabled[enabled.length - 1];
      const o = options[j];
      if (!o) return;
      onChange(o.value);
      refs.current[j]?.focus();
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`grid gap-2 ${className}`}
      style={{ gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <motion.button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            whileHover={reduced || on ? undefined : { y: -2 }}
            whileTap={{ scale: 0.96 }}
            transition={t.press}
            className={`hit glyph-host icon-host group relative flex min-w-0 flex-col items-start gap-2 border text-left transition-[border-color,background-color,box-shadow] duration-200 disabled:opacity-45 ${
              compact ? "rounded-[14px_14px_14px_6px] p-2.5" : "rounded-[18px_18px_18px_7px] p-3"
            } ${
              on
                ? "border-accent-border bg-accent-soft/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                : "border-line bg-inset hover:border-line-strong hover:bg-card-hover"
            }`}
          >
            {o.art}
            <span className="flex w-full min-w-0 items-center gap-2">
              {o.icon && <Glyph icon={o.icon} size={15} box={28} on={on} />}
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-[12px] font-semibold ${on ? "text-fg" : "text-fg-2 group-hover:text-fg"}`}>
                  {o.label}
                </span>
                {o.description && <span className="block truncate text-[11px] leading-[14px] text-fg-3">{o.description}</span>}
              </span>
              {/* The dial: a fixed ring with the shared bead springing between tiles. */}
              <span
                className={`relative grid size-[18px] shrink-0 place-items-center rounded-full border-[1.5px] transition-colors duration-200 ${
                  on ? "border-accent" : "border-line-strong group-hover:border-fg-3"
                }`}
              >
                {on && (
                  <motion.span
                    layoutId={`radio-bead-${id}`}
                    transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 22 }}
                    initial={reduced ? false : { scaleX: 1.5, scaleY: 0.6 }}
                    animate={{ scaleX: 1, scaleY: 1 }}
                    className="size-2 rounded-full bg-accent shadow-[0_0_0_3px_var(--accent-soft)]"
                  />
                )}
              </span>
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}
