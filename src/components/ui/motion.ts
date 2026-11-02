import type { Transition } from "motion/react";

export const ease = [0.22, 1, 0.36, 1] as const;

/** The one spring every interactive surface uses: lists, cards, tabs, modals, toasts. */
const SPRING: Transition = { type: "spring", stiffness: 350, damping: 28 };

export const t = {
  fast: { duration: 0.12, ease },
  base: { duration: 0.18, ease },
  slow: { duration: 0.28, ease },
  spring: SPRING,
  /** Press and release: a little quicker so taps feel instant. */
  press: { type: "spring", stiffness: 520, damping: 30 },
  progress: { type: "spring", stiffness: 120, damping: 24, mass: 0.6 },
  sheet: SPRING,
} satisfies Record<string, Transition>;

/** Shared press feedback for every tappable surface (keeps taps weighty, never jumpy). */
export const press = { scale: 0.98 } as const;

/** List item enter/exit; pass reduced=true to keep only an opacity fade. */
export function listItem(reduced: boolean | null, index = 0) {
  const delay = Math.min(index, 8) * 0.03;
  if (reduced) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: { ...t.fast, delay } },
      exit: { opacity: 0, transition: t.fast },
    };
  }
  return {
    initial: { opacity: 0, y: 10, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1, transition: { ...t.spring, delay } },
    exit: { opacity: 0, scale: 0.96, transition: t.fast },
  };
}
