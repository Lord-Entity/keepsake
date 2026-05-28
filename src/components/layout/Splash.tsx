import { motion, useReducedMotion } from "motion/react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { MicroSplash } from "../ui/illustrations/MicroSplash";
import { Progress } from "../ui/Progress";
import { t } from "../ui/motion";

const WORD = Array.from("Keepsake");

/** Startup loader (UI_THEME_MOTION.md section 3). App controls timing and exit. */
export function Splash({
  step,
  versions,
  error,
  onRetry,
}: {
  step: string;
  versions: string | null;
  error: { title: string; body: string } | null;
  onRetry: () => void;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      key="splash"
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-6 bg-app px-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]"
      initial={{ opacity: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 1.02 }}
      transition={{ duration: 0.24 }}
      role="status"
      aria-live="polite"
    >
      <motion.div
        className="flex flex-col items-center gap-3 text-center"
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={t.slow}
      >
        {/* Kip drops in, pops his lid and cheers; sits sadly if startup failed. */}
        <MicroSplash size={120} state={error ? "error" : "boot"} />
        <div className="flex flex-col items-center gap-1">
          <p className="text-lg font-semibold text-fg">
            <span className="sr-only">Keepsake</span>
            {WORD.map((ch, i) => (
              <motion.span
                key={i}
                aria-hidden="true"
                className="inline-block"
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={
                  reduced
                    ? { duration: 0.2 }
                    : { type: "spring", stiffness: 520, damping: 14, delay: 0.3 + i * 0.04 }
                }
              >
                {ch}
              </motion.span>
            ))}
          </p>
          <motion.p
            className="text-sm text-fg-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, delay: reduced ? 0 : 0.55 }}
          >
            Downloads with a memory.
          </motion.p>
        </div>
      </motion.div>
      {error ? (
        <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
          <Badge tone="danger">{error.title}</Badge>
          <p className="text-fg-2">{error.body}</p>
          <Button variant="primary" size="lg" icon="retry" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <div className="w-48 max-w-full">
            <Progress pct={null} label="Starting Keepsake" />
          </div>
          <p className="text-[11px] leading-[14px] text-fg-2">{step}</p>
        </>
      )}
      <p className="h-4 font-mono text-[11px] text-fg-3">{versions ?? ""}</p>
    </motion.div>
  );
}
