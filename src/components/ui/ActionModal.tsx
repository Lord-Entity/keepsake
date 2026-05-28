import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { CookingScene } from "./illustrations/CookingScene";
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
 * `scene="cooking"` (opt-in, used by the link fetch dialogs) swaps the ring for CookingBody below.
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
  scene,
}: {
  open: boolean;
  phase: ActionPhase;
  title: string;
  pct?: number | null;
  messages: string[];
  detail?: string;
  successLabel?: string;
  onCancel?: () => void;
  /**
   * Opt-in art. "cooking": Kip cooks while a link is read (staged titles, a Link -> Formats
   * -> Ready trail, slow-network hints). `pct` is ignored; `title` is used on success only.
   */
  scene?: "cooking";
}) {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  useModal(open, panel, phase === "working" ? onCancel : undefined);
  // Counts opens so a reopen during the exit animation still restarts the cooking clock.
  const [prevOpen, setPrevOpen] = useState(open);
  const [runs, setRuns] = useState(0);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setRuns((n) => n + 1);
  }

  useEffect(() => {
    if (scene || phase !== "working" || messages.length < 2) return;
    const id = setInterval(() => setStep((n) => n + 1), 1800);
    return () => clearInterval(id);
  }, [scene, phase, messages.length]);

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
            // The cooking body announces through its own status region, not on every tick.
            aria-live={scene ? undefined : "polite"}
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

            {scene === "cooking" ? (
              <CookingBody
                key={runs}
                done={done}
                title={title}
                messages={messages}
                detail={detail}
                successLabel={successLabel}
                onCancel={onCancel}
                reduced={!!reduced}
              />
            ) : (
            <>
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
            </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return typeof document === "undefined" ? tree : createPortal(tree, document.body);
}

const COOKING_TITLES = ["Reading your link", "Finding the good stuff", "Plating up…"] as const;
const TRAIL = ["Link", "Formats", "Ready"] as const;
const TICK_MS = 2200;
const SLOW_HINT = "Simmering a bit longer than usual…";
const STALL_HINT = "Still cooking. Feel free to cancel and retry.";

/**
 * Body of the "cooking" ActionModal. Mounted once per open, so its clock restarts with every
 * fetch. Everything shown is derived from elapsed time and the `messages` index, never from
 * the engine: stage 0 until ~2.2 s, stage 1 until ~6.6 s, then stage 2; a hint after ~8.8 s
 * and a calmer, stopped state after ~19.8 s. "Ready" is only checked on success.
 */
function CookingBody({
  done,
  title,
  messages,
  detail,
  successLabel,
  onCancel,
  reduced,
}: {
  done: boolean;
  title: string;
  messages: string[];
  detail?: string;
  successLabel: string;
  onCancel?: () => void;
  reduced: boolean;
}) {
  const [tick, setTick] = useState(0);
  const stalled = tick >= 9;

  useEffect(() => {
    // Stops on success and once stalled: the stalled state is deliberately still.
    if (done || stalled) return;
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, [done, stalled]);

  const stage: 0 | 1 | 2 = tick < 1 ? 0 : tick < 3 ? 1 : 2;
  const active = stage === 0 ? 0 : 1;
  const heading = done ? title : COOKING_TITLES[stage];
  const line = done ? successLabel : (messages[tick % Math.max(messages.length, 1)] ?? "");
  const hint = done ? "" : stalled ? STALL_HINT : tick >= 4 ? SLOW_HINT : "";
  // One polite announcement per stage, hint or result; the rotating line is not announced.
  const status = done ? `${title}. ${successLabel}` : hint ? `${heading}. ${hint}` : heading;

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {status}
      </span>

      <div className="-mt-2 -mb-1 flex w-full justify-center">
        <CookingScene
          stage={stage}
          phase={done ? "success" : "working"}
          className="h-auto w-full max-w-[240px]"
        />
      </div>

      <div className="flex w-full flex-col gap-1">
        <h2 className="relative h-[22px] overflow-hidden text-[16px] leading-[22px] font-semibold">
          <Swap text={heading} reduced={reduced} />
        </h2>
        <p className={`relative h-5 overflow-hidden text-[13px] leading-5 ${done ? "text-success" : "text-fg-2"}`}>
          <Swap text={line} reduced={reduced} />
        </p>
      </div>

      <ol className="flex w-full flex-wrap items-center justify-center gap-1.5">
        {TRAIL.map((label, i) => {
          const state = done || i < active ? "done" : i === active ? "active" : "todo";
          return (
            <li key={label} className="flex items-center gap-1.5">
              {i > 0 && (
                <span
                  aria-hidden="true"
                  className={`h-px w-3 min-[400px]:w-5 ${state === "todo" ? "bg-line" : "bg-accent-border"}`}
                />
              )}
              <span
                className={`relative grid size-5 shrink-0 place-items-center rounded-full ${
                  state === "done"
                    ? "bg-success/16 text-success"
                    : state === "active"
                      ? "bg-accent-soft text-accent"
                      : "bg-inset text-fg-3"
                }`}
                aria-hidden="true"
              >
                {state === "done" ? (
                  <Icon name="check" size={12} />
                ) : (
                  <span className="size-1.5 rounded-full bg-current" />
                )}
                {state === "active" && !reduced && (
                  <motion.span
                    className="absolute inset-0 rounded-full border border-accent"
                    initial={{ scale: 1, opacity: 0.7 }}
                    animate={{ scale: 1.7, opacity: 0 }}
                    transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
                  />
                )}
              </span>
              <span
                className={`text-[11px] font-medium ${
                  state === "todo" ? "text-fg-3" : state === "active" ? "text-fg" : "text-fg-2"
                }`}
              >
                {label}
                <span className="sr-only">{state === "done" ? ", done" : state === "active" ? ", in progress" : ", to do"}</span>
              </span>
            </li>
          );
        })}
      </ol>

      {detail &&
        (done ? (
          <p className="max-w-full truncate text-[11px] text-fg-3">{detail}</p>
        ) : (
          <span className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-line bg-inset px-2.5 text-[11px] text-fg-2">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent" />
            <span className="truncate">{detail}</span>
          </span>
        ))}

      {!done && (
        <>
          {/* Reserved line so the hint appearing never shifts the Cancel button under a finger. */}
          <p className="min-h-4 text-[12px] leading-4 text-fg-3">{hint}</p>
          {onCancel && (
            // Stalled: same size and element (no jump under a finger, focus kept), just louder.
            <Button variant={stalled ? "primary" : "secondary"} onClick={onCancel}>
              Cancel
            </Button>
          )}
        </>
      )}
    </>
  );
}

/** Cross-fades a line of text in a fixed-height parent; an instant swap under reduced motion. */
function Swap({ text, reduced }: { text: string; reduced: boolean }) {
  if (reduced) return <span className="block truncate">{text}</span>;
  return (
    <AnimatePresence initial={false}>
      <motion.span
        key={text}
        className="absolute inset-x-0 top-0 block truncate"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={t.base}
      >
        {text}
      </motion.span>
    </AnimatePresence>
  );
}
