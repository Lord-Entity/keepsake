import { AnimatePresence, motion, useReducedMotion, type PanInfo } from "motion/react";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { useIsPhone } from "../../state/hooks";
import { dismissToast, useToasts, type Toast, type ToastTone } from "../../state/toast";
import { IconButton } from "./Button";
import { MicroError } from "./illustrations/MicroError";
import { MicroInfo } from "./illustrations/MicroInfo";
import { MicroSuccess } from "./illustrations/MicroSuccess";
import { MicroWarning } from "./illustrations/MicroWarning";

/** A small animated Kip moment per tone: stamp, tipped box, bright idea, warning sign. */
const ART: Record<ToastTone, ComponentType<{ size?: number; className?: string }>> = {
  success: MicroSuccess,
  error: MicroError,
  warning: MicroWarning,
  info: MicroInfo,
};

const TONE: Record<ToastTone, { chip: string; bar: string; text: string }> = {
  success: { chip: "bg-success/16 text-success", bar: "bg-success", text: "text-success" },
  error: { chip: "bg-danger/16 text-danger", bar: "bg-danger", text: "text-danger" },
  warning: { chip: "bg-warning/16 text-warning", bar: "bg-warning", text: "text-warning" },
  info: { chip: "bg-accent-soft text-accent", bar: "bg-accent", text: "text-accent" },
};

/** At most this many toasts on screen; older ones beyond the newest 3 are dropped, not queued. */
const MAX_VISIBLE = 3;

/** Slide in on a lively spring that lands with a small bounce; leave on a quick ease. */
const SLIDE_IN = { type: "spring", stiffness: 460, damping: 24, mass: 0.9 } as const;
const LEAVE = { duration: 0.2, ease: [0.4, 0, 1, 1] as const };

/** Phone swipe-to-dismiss: past this distance (px) or fling speed (px/s) the toast goes. */
const SWIPE_DISTANCE = 90;
const SWIPE_SPEED = 500;

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
  const [dragging, setDragging] = useState(false);
  // Direction of a dismissing swipe (-1 left, 1 right); 0 while not swiped away.
  const [swiped, setSwiped] = useState<-1 | 0 | 1>(0);
  const paused = hovered || focused || dragging;
  const remaining = useRef(toast.duration);
  const started = useRef(0);

  // Dismiss one render after the swipe so the exit animation already knows its direction.
  useEffect(() => {
    if (swiped !== 0) dismissToast(toast.id);
  }, [swiped, toast.id]);

  const onDragEnd = (_e: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    setDragging(false);
    const { x } = info.offset;
    const v = info.velocity.x;
    if (Math.abs(x) > SWIPE_DISTANCE || Math.abs(v) > SWIPE_SPEED) setSwiped(x + v * 0.1 < 0 ? -1 : 1);
  };

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
  const Art = ART[toast.tone];
  const exit = reduced
    ? { opacity: 0, transition: { duration: 0.12, ease: "linear" as const } }
    : swiped !== 0
      ? { opacity: 0, x: swiped * 420, transition: LEAVE }
      : phone
        ? { opacity: 0, y: 16, scale: 0.96, transition: LEAVE }
        : { opacity: 0, x: 48, scale: 0.96, transition: LEAVE };
  return (
    <motion.div
      layout={reduced ? false : "position"}
      role={toast.tone === "error" ? "alert" : "status"}
      initial={reduced ? { opacity: 0 } : phone ? { opacity: 0, y: 28, scale: 0.94 } : { opacity: 0, x: 40, scale: 0.94 }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      exit={exit}
      transition={reduced ? { duration: 0.12, ease: "linear" } : SLIDE_IN}
      // Phone: swipe sideways to dismiss (the card snaps back if the swipe is short).
      drag={phone ? "x" : false}
      dragDirectionLock
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.7}
      dragSnapToOrigin
      onDragStart={() => setDragging(true)}
      onDragEnd={onDragEnd}
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
      <span aria-hidden="true" className={`absolute inset-y-3 left-0 w-[3px] rounded-r-full ${tone.bar}`} />
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`ks-toast-in motion-safe-only grid size-9 shrink-0 place-items-center overflow-visible rounded-full ${tone.chip}`}
          style={{ animationDelay: reduced ? undefined : "80ms" }}
        >
          <Art size={36} />
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
      {/* Reduced motion: no countdown bar (the global rule would snap it to empty at once). */}
      {!reduced && <span
        aria-hidden="true"
        className={`absolute inset-x-0 bottom-0 h-[3px] origin-left ${tone.bar}`}
        style={{
          animation: `toast-timer ${toast.duration}ms linear forwards`,
          animationPlayState: paused ? "paused" : "running",
        }}
      />}
    </motion.div>
  );
}
