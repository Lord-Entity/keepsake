import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** Eases the displayed number toward `target`; null passes through. Instant under reduced motion or from null. */
export function useTweenedNumber(target: number | null, duration = 450): number | null {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState<number | null>(target);
  const current = useRef<number | null>(target);

  useEffect(() => {
    const prev = current.current;
    let raf = 0;
    if (target === null || prev === null || reduced || prev === target) {
      raf = requestAnimationFrame(() => {
        current.current = target;
        setShown(target);
      });
      return () => cancelAnimationFrame(raf);
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const v = prev + (target - prev) * easeOutCubic(t);
      current.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, reduced]);

  return target === null ? null : shown;
}
