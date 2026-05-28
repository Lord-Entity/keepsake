import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { CardChipGlyph } from "../ui/illustrations/CardChipGlyph";
import { t } from "../ui/motion";

type SiteKey = "youtube" | "tiktok" | "instagram";

const SITES: { key: SiteKey; label: string; hint: string }[] = [
  {
    key: "youtube",
    label: "YouTube",
    hint: "Videos, Shorts, music and playlists. Tap Share, then Copy link (youtu.be/… or youtube.com/watch?v=…).",
  },
  {
    key: "tiktok",
    label: "TikTok",
    hint: "Any public video. Tap Share, then Copy link (vm.tiktok.com/… or tiktok.com/@user/video/…).",
  },
  {
    key: "instagram",
    label: "Instagram",
    hint: "Public Reels and video posts. Tap the ⋯ menu, then Copy link (instagram.com/reel/…).",
  },
];

const CHIP =
  "hit inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium shadow-sm transition-[color,background-color,border-color] duration-150";

/** Tappable site chips that explain which link to paste. */
export function SiteChips({ onMore }: { onMore?: () => void }) {
  const reduced = useReducedMotion();
  const [site, setSite] = useState<SiteKey | null>(null);
  const hint = SITES.find((s) => s.key === site)?.hint ?? "Copy a link from YouTube, TikTok or Instagram, then tap Paste.";

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div role="group" aria-label="Supported sites" className="flex flex-wrap gap-2">
        {SITES.map((s) => {
          const on = site === s.key;
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={on}
              onClick={() => setSite(on ? null : s.key)}
              className={`${CHIP} ${on ? "border-accent-border bg-accent-soft text-accent" : "border-line bg-inset text-fg-2 hover:text-fg"}`}
            >
              <CardChipGlyph name={s.key} active={on} className="size-4 shrink-0" />
              {s.label}
            </button>
          );
        })}
        {onMore && (
          <button
            type="button"
            onClick={onMore}
            className={`${CHIP} border-line bg-inset text-fg-2 hover:text-fg`}
          >
            <CardChipGlyph name="more" className="size-4 shrink-0" />
            More sites
          </button>
        )}
      </div>
      <p aria-live="polite" className="min-h-8 text-[12px] leading-4 text-fg-2">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={site ?? "none"}
            className="block"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={t.fast}
          >
            {hint}
          </motion.span>
        </AnimatePresence>
      </p>
    </div>
  );
}
