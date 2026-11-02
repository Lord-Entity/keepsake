import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { ProgressRing } from "./Ring";
import { t } from "./motion";
import { useModal } from "./useModal";

export type ActionPhase = "working" | "success";

/**
 * Immersive progress modal for async work (fetching, preparing, finishing).
 * Working: ring fills from `pct` (null = spinning) and the micro-copy rotates through `messages`.
 * Success: the ring closes, a check draws itself, and `successLabel` replaces the copy.
 * Esc cancels while working (when `onCancel` is given); Tab is trapped, body scroll is
 * locked, and focus returns to the opener on close (useModal). Portalled like Dialog.
 */
export function ActionModal({
  open,
  phase,
  title,
  pct = null,
  messages,
  detail,
  successLabel = "Complete!",
  onCancel,
}: {
  open: boolean;
  phase: ActionPhase;
  title: string;
  pct?: number | null;
  messages: string[];
  detail?: string;
  successLabel?: string;
  onCancel?: () => void;
}) {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  useModal(open, panel, phase === "working" ? onCancel : undefined);

  useEffect(() => {
    if (phase !== "working" || messages.length < 2) return;
    const id = setInterval(() => setStep((n) => n + 1), 1800);
    return () => clearInterval(id);
  }, [phase, messages.length]);

  const line = phase === "success" ? successLabel : (messages[step % Math.max(messages.length, 1)] ?? "");
  const done = phase === "success";

  const tree = (
    <AnimatePresence>
      {open && (
        <motion.div
          key="action-scrim"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          style={{
            backgroundImage:
              "radial-gradient(55% 45% at 50% 42%, color-mix(in srgb, var(--accent) 12%, transparent), transparent)",
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={t.fast}
          // Keys pressed inside the modal must not reach page shortcuts.
          onKeyDown={(e) => e.stopPropagation()}
        >
          <motion.div
            ref={panel}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            aria-live="polite"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 28, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97 }}
            transition={t.spring}
            className="modal-panel scroll-y relative flex w-full max-w-[340px] flex-col items-center gap-4 overflow-x-hidden rounded-[26px_26px_26px_10px] outline-none border border-line bg-card px-6 pt-7 pb-6 text-center shadow-pop"
          >
            <span
              aria-hidden="true"
              className="absolute inset-x-8 top-0 h-px"
              style={{ background: "linear-gradient(90deg, transparent, var(--accent), transparent)" }}
            />

            <Badge tone={done ? "success" : "accent"}>
              <span className="mr-1.5 inline-block size-1.5 rounded-full bg-current" aria-hidden="true" />
              {done ? "Finished" : "In progress"}
            </Badge>

            <ProgressRing pct={done ? 100 : pct} done={done} size={128}>
              {!done && pct !== null && <span className="tabular text-[22px] leading-6 font-semibold">{Math.round(pct)}%</span>}
            </ProgressRing>

            <div className="flex flex-col gap-1">
              <h2 className="text-[16px] leading-[22px] font-semibold">{title}</h2>
              <div className="relative h-5 overflow-hidden">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.p
                    key={line}
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
                    transition={t.fast}
                    className={`text-[13px] ${done ? "text-success" : "text-fg-2"}`}
                  >
                    {line}
                  </motion.p>
                </AnimatePresence>
              </div>
            </div>

            {detail && <p className="max-w-full truncate text-[11px] text-fg-3">{detail}</p>}

            {!done && onCancel && (
              <Button variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return typeof document === "undefined" ? tree : createPortal(tree, document.body);
}
