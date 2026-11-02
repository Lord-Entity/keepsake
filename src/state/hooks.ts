import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Phone layout (UI_MOBILE.md): viewport < 760px. */
export function useIsPhone(): boolean {
  return useMediaQuery("(max-width: 759.98px)");
}

/** Window < 1080px forces the sidebar rail (UI_LAYOUT.md narrow rule). */
export function useIsNarrowWindow(): boolean {
  return useMediaQuery("(max-width: 1079.98px)");
}

/** Element width via ResizeObserver; bento uses content width < 760 for its narrow spans. */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
