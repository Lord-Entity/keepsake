import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useIsPhone } from "../../state/hooks";
import { dismissToast, useToasts, type Toast, type ToastTone } from "../../state/toast";
import { Icon, type IconName } from "./Icon";
import { IconButton } from "./Button";
import { t } from "./motion";

const ICON: Record<ToastTone, IconName> = {
  success: "check",
  error: "alert",
  warning: "alert",
  info: "bolt",
};

const TONE: Record<ToastTone, { chip: string; bar: string; text: string }> = {
  success: { chip: "bg-success/16 text-success", bar: "bg-success", text: "text-success" },
  error: { chip: "bg-danger/16 text-danger", bar: "bg-danger", text: "text-danger" },
  warning: { chip: "bg-warning/16 text-warning", bar: "bg-warning", text: "text-warning" },
  info: { chip: "bg-accent-soft text-accent", bar: "bg-accent", text: "text-accent" },
};

/** At most this many toasts on screen; older ones wait in the store. */
const MAX_VISIBLE = 3;

/**
 * Floating feedback stack, newest at the bottom.
 * Desktop: bottom-right. Phone: bottom, just above the TabBar and the bottom
 * safe-area inset (so it never covers the compact Titlebar or the nav).
 * The container ignores pointers; only the cards themselves are hit-testable.
 */
export function Toasts() {
  const list = useToasts().slice(-MAX_VISIBLE);
  const phone = useIsPhone();
  return (
    <div
      aria-live="polite"
      className={`pointer-events-none fixed z-[70] flex flex-col gap-2.5 ${
        phone ? "toast-stack-phone inset-x-4" : "right-5 bottom-5 w-[352px] max-w-[calc(100vw-40px)]"
      }`}
    >
      <AnimatePresence initial={false}>
        {list.map((toast) => (
          <ToastCard key={toast.id} toast={toast} phone={phone} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastCard({ toast, phone }: { toast: Toast; phone: boolean }) {
  const reduced = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const remaining = useRef(toast.duration);
  const started = useRef(0);

  // Countdown that pauses while hovered or focused; resumes with the time left.
  useEffect(() => {
    if (paused) return;
    started.current = Date.now();
    const id = window.setTimeout(() => dismissToast(toast.id), Math.max(0, remaining.current));
    return () => {
      window.clearTimeout(id);
      remaining.current -= Date.now() - started.current;
    };
  }, [paused, toast.id]);

  const tone = TONE[toast.tone];
  return (
    <motion.div
      layout={reduced ? false : "position"}
      role={toast.tone === "error" ? "alert" : "status"}
      initial={
        reduced ? { opacity: 0 } : phone ? { opacity: 0, y: 24, scale: 0.96 } : { opacity: 0, x: 48, scale: 0.94, rotate: 1.2 }
      }
      animate={{ opacity: 1, x: 0, y: 0, scale: 1, rotate: 0 }}
      exit={reduced ? { opacity: 0 } : phone ? { opacity: 0, y: 16, scale: 0.96 } : { opacity: 0, x: 56, scale: 0.96 }}
      transition={t.spring}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      className="pointer-events-auto relative overflow-hidden rounded-[18px_18px_18px_6px] border border-line bg-card p-3.5 pr-2.5 shadow-lift"
    >
      <div className="flex items-start gap-3">
        <span className={`grid size-9 shrink-0 place-items-center rounded-full ${tone.chip}`}>
          <Icon name={ICON[toast.tone]} size={18} />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="truncate text-[13px] leading-[18px] font-semibold text-fg">{toast.title}</p>
          {toast.body && <p className="mt-0.5 line-clamp-2 text-[12px] leading-[17px] text-fg-2">{toast.body}</p>}
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action?.run();
                dismissToast(toast.id);
              }}
              className={`hit mt-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium transition-colors hover:bg-accent-soft ${tone.text}`}
            >
              {toast.action.label}
            </button>
          )}
        </div>
        <IconButton icon="x" label="Dismiss" size={28} onClick={() => dismissToast(toast.id)} />
      </div>
      <span
        aria-hidden="true"
        className={`absolute inset-x-0 bottom-0 h-[3px] origin-left ${tone.bar}`}
        style={{
          animation: `toast-timer ${toast.duration}ms linear forwards`,
          animationPlayState: paused ? "paused" : "running",
        }}
      />
    </motion.div>
  );
}
