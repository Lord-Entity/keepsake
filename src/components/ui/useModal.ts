import { useEffect, useRef, type RefObject } from "react";

/**
 * Shared modal behaviour for Dialog, Sheet and ActionModal:
 * - Esc calls `onEscape` (only the top-most modal reacts; an open dropdown takes Esc first)
 * - Tab / Shift+Tab are trapped inside the panel
 * - body scroll is locked while any modal is open (ref-counted, no scrollbar jump)
 * - focus moves into the panel on open and returns to the opener on close
 */
const stack: symbol[] = [];
let locks = 0;
let savedOverflow = "";

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0 && !el.closest("[inert]"),
  );
}

export function useModal(
  open: boolean,
  panel: RefObject<HTMLElement | null>,
  onEscape?: () => void,
  /** Selector for the first control to focus; the panel itself is the fallback. */
  initialFocus = 'input, button:not([data-close]):not(:disabled), select, [tabindex]:not([tabindex="-1"])',
) {
  // Callers often pass an inline handler; keep the effect tied to `open` only so
  // re-renders (progress ticks) never steal focus back to the first control.
  const escRef = useRef(onEscape);
  useEffect(() => {
    escRef.current = onEscape;
  });

  useEffect(() => {
    if (!open) return;
    const id = Symbol("modal");
    stack.push(id);
    const prev = document.activeElement as HTMLElement | null;

    if (locks++ === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      const root = panel.current;
      if (e.key === "Escape") {
        // An open dropdown inside the modal takes Esc first.
        if (document.querySelector("[data-popover]")) return;
        if (!escRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        escRef.current();
      } else if (e.key === "Tab" && root) {
        const items = focusables(root);
        const active = document.activeElement as HTMLElement | null;
        if (items.length === 0) {
          e.preventDefault();
          root.focus({ preventScroll: true });
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const inside = !!active && root.contains(active);
        if (!inside) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus({ preventScroll: true });
        } else if (e.shiftKey && (active === first || active === root)) {
          e.preventDefault();
          last.focus({ preventScroll: true });
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus({ preventScroll: true });
        }
      }
    };
    window.addEventListener("keydown", onKey, true);

    const raf = requestAnimationFrame(() => {
      const root = panel.current;
      if (!root) return;
      const first = root.querySelector<HTMLElement>(initialFocus);
      (first ?? root).focus({ preventScroll: true });
    });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      if (--locks === 0) document.body.style.overflow = savedOverflow;
      if (prev?.isConnected) prev.focus?.({ preventScroll: true });
    };
    // panel is a stable ref object and initialFocus a string, so the effect still re-runs only on `open`.
  }, [open, panel, initialFocus]);
}
