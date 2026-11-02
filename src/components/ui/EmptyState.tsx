import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { Glyph } from "./Glyph";
import type { IconName } from "./Icon";
import { t } from "./motion";

/** Empty page: a breathing pebble with a layered glyph, a title, a line of copy and an action. */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  const reduced = useReducedMotion();
  return (
    <div className="flex h-full min-h-[320px] items-center justify-center">
      <motion.div
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={t.spring}
        className="glyph-host icon-host flex w-full max-w-[300px] flex-col items-center gap-3 text-center"
      >
        <span className="breathe shape-pebble text-accent">
          <Glyph icon={icon} size={24} box={64} on />
        </span>
        <div className="text-[15px] font-semibold">{title}</div>
        <p className="text-fg-2">{body}</p>
        {action}
      </motion.div>
    </div>
  );
}
