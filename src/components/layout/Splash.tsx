import { motion, useReducedMotion } from "motion/react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Logo } from "../ui/Icon";
import { Progress } from "../ui/Progress";
import { t } from "../ui/motion";

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
        <Logo size={72} />
        <div className="flex flex-col items-center gap-1">
          <p className="text-lg font-semibold text-fg">Keepsake</p>
          <p className="text-sm text-fg-2">Downloads with a memory.</p>
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
