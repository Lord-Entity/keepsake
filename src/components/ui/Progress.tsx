import { motion, useReducedMotion } from "motion/react";
import { t } from "./motion";

export type ProgressTone = "accent" | "success" | "danger" | "muted";

const FILL: Record<ProgressTone, string> = {
  accent: "bg-accent",
  success: "bg-success",
  danger: "bg-danger",
  muted: "bg-fg-3",
};

/** pct: 0-100, or null for indeterminate. */
export function Progress({
  pct,
  tone = "accent",
  className = "",
  label,
}: {
  pct: number | null;
  tone?: ProgressTone;
  className?: string;
  label?: string;
}) {
  const reduced = useReducedMotion();
  const value = pct === null ? undefined : Math.max(0, Math.min(100, pct));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === undefined ? undefined : Math.round(value)}
      className={`relative h-1.5 w-full overflow-hidden rounded-full bg-inset ${className}`}
    >
      {value === undefined ? (
        reduced ? (
          <motion.div
            className={`absolute inset-y-0 left-0 w-[40%] rounded-full ${FILL[tone]}`}
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "linear" }}
          />
        ) : (
          <motion.div
            className={`absolute inset-y-0 left-0 w-[30%] rounded-full ${FILL[tone]}`}
            animate={{ x: ["-100%", "330%"] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
          />
        )
      ) : (
        <motion.div
          className={`absolute inset-0 rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] transition-colors duration-300 ${FILL[tone]}`}
          style={{ transformOrigin: "0% 50%" }}
          initial={false}
          animate={{ scaleX: value / 100 }}
          transition={reduced ? t.fast : t.progress}
        />
      )}
    </div>
  );
}
