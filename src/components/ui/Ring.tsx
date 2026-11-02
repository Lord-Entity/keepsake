import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { t } from "./motion";

export type RingTone = "accent" | "success" | "danger";

const STROKE: Record<RingTone, string> = {
  accent: "stroke-accent",
  success: "stroke-success",
  danger: "stroke-danger",
};

/**
 * Circular progress with a drawn-in check on success.
 * pct 0-100 fills the ring; null spins a short arc (indeterminate).
 */
export function ProgressRing({
  pct,
  done = false,
  tone = "accent",
  size = 124,
  children,
}: {
  pct: number | null;
  done?: boolean;
  tone?: RingTone;
  size?: number;
  children?: ReactNode;
}) {
  const reduced = useReducedMotion();
  const indeterminate = pct === null && !done;
  const value = done ? 100 : Math.max(0, Math.min(100, pct ?? 0));
  const color = done ? STROKE.success : STROKE[tone];

  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <motion.div
        className="absolute inset-0"
        animate={indeterminate && !reduced ? { rotate: 360 } : { rotate: 0 }}
        transition={indeterminate && !reduced ? { duration: 1.4, repeat: Infinity, ease: "linear" } : t.fast}
      >
        <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden="true">
          <circle cx="50" cy="50" r="44" fill="none" strokeWidth={5} className="stroke-inset" />
          <motion.circle
            cx="50"
            cy="50"
            r="44"
            fill="none"
            strokeWidth={5}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={100}
            className={color}
            initial={false}
            animate={{ strokeDashoffset: indeterminate ? 75 : 100 - value }}
            transition={reduced ? t.fast : t.progress}
          />
        </svg>
      </motion.div>

      {done ? (
        <motion.svg
          viewBox="0 0 24 24"
          className="size-9 stroke-success"
          fill="none"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          initial={reduced ? false : { scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={t.spring}
        >
          <motion.path
            d="M5 12.5l4.5 4.5L19 7.5"
            pathLength={1}
            initial={reduced ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.4, delay: 0.1 }}
          />
        </motion.svg>
      ) : (
        <div className="relative z-10 flex flex-col items-center">{children}</div>
      )}
    </div>
  );
}
