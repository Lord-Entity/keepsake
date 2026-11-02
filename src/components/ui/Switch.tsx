import { motion } from "motion/react";
import { t } from "./motion";

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <motion.button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      whileTap={disabled ? undefined : { scale: 0.94 }}
      transition={t.press}
      className={`hit group relative h-5 w-10 shrink-0 rounded-full shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)] transition-colors duration-150 disabled:pointer-events-none disabled:opacity-45 ${
        checked ? "bg-accent hover:bg-accent-hover" : "bg-line-strong hover:bg-fg-3"
      }`}
    >
      {/* Track glint: a separate layer that slides in with the "on" state. */}
      <motion.span
        aria-hidden="true"
        className="absolute inset-y-[5px] left-[7px] w-[2px] rounded-full bg-white/70"
        initial={false}
        animate={{ opacity: checked ? 1 : 0, scaleY: checked ? 1 : 0.2 }}
        transition={t.spring}
      />
      {/* Thumb stretches while pressed, then springs across. */}
      <motion.span
        className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.35)] transition-[scale] duration-150 group-hover:scale-110 group-active:scale-x-125"
        initial={false}
        animate={{ x: checked ? 20 : 0 }}
        transition={t.spring}
        style={{ originX: checked ? 1 : 0 }}
      />
    </motion.button>
  );
}
