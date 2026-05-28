import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { PAGE_BOTTOM } from "../layout/page";
import { Glyph } from "./Glyph";
import type { IconName } from "./Icon";
import { ILLUSTRATIONS, type IllustrationName } from "./illustrations";
import { t } from "./motion";

/**
 * Empty page: an illustration (or, as a fallback, a breathing pebble with a layered
 * glyph), a title, a line of copy and an action. `art` wins over `illustration`,
 * which wins over `icon`. The art is decorative because the title and copy say it all.
 */
export function EmptyState({
  icon,
  illustration,
  art,
  title,
  body,
  action,
}: {
  icon?: IconName;
  illustration?: IllustrationName;
  art?: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  const reduced = useReducedMotion();
  const Art = illustration ? ILLUSTRATIONS[illustration] : null;
  const visual = art ?? (Art ? <Art /> : null);
  return (
    <div className={`flex h-full min-h-[320px] min-w-0 items-center justify-center py-6 ${PAGE_BOTTOM}`}>
      <motion.div
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={t.spring}
        className="glyph-host icon-host flex w-full max-w-[320px] flex-col items-center gap-3 text-center"
      >
        {visual ? (
          <div className="mb-1 w-full max-w-[260px] sm:max-w-[300px]">{visual}</div>
        ) : icon ? (
          <span className="breathe shape-pebble text-accent">
            <Glyph icon={icon} size={24} box={64} on />
          </span>
        ) : null}
        <div className="text-[15px] font-semibold">{title}</div>
        <p className="text-fg-2">{body}</p>
        {action}
      </motion.div>
    </div>
  );
}
