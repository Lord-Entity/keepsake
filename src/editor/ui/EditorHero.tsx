import { motion, useReducedMotion } from "motion/react";
import { useId } from "react";
import { Icon } from "../../components/ui/Icon";
import type { IconName } from "../../components/ui/Icon";
import { t } from "../../components/ui/motion";
import type { MediaKind } from "../types";

const STROKE = { strokeLinecap: "round", strokeLinejoin: "round" } as const;

function Illustration({ phone }: { phone: boolean }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={t.spring}
      className={phone ? "w-[88%]" : "w-[min(400px,100%)]"}
    >
      <svg viewBox="0 0 400 260" className="block h-auto w-full" aria-hidden="true" focusable="false" {...STROKE}>
        {/* back photo card, tilted */}
        <g transform="rotate(-8 140 110)">
          <rect x="52" y="34" width="180" height="130" rx="14" fill="var(--bg-inset)" stroke="var(--border-strong)" strokeWidth="2" />
          <circle cx="94" cy="68" r="12" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2" />
          <polyline points="62,150 112,102 142,130 168,108 222,150" fill="none" stroke="var(--text-muted)" strokeWidth="3" />
        </g>
        {/* front video card */}
        <rect x="128" y="50" width="220" height="136" rx="14" fill="var(--bg-card)" stroke="var(--border-strong)" strokeWidth="2" />
        <rect x="128" y="50" width="220" height="22" rx="14" fill="var(--bg-inset)" />
        <rect x="128" y="62" width="220" height="10" fill="var(--bg-inset)" />
        {Array.from({ length: 10 }, (_, i) => (
          <rect key={i} x={140 + i * 21} y="56" width="10" height="9" rx="2" fill="var(--border-strong)" />
        ))}
        <circle cx="238" cy="128" r="26" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2" />
        <path d="M230 115 L252 128 L230 141 Z" fill="var(--accent)" stroke="var(--accent)" strokeWidth="3" />
        {/* crop corners */}
        <g fill="none" stroke="var(--accent)" strokeWidth="5">
          <path d="M116 78 V40 H154" />
          <path d="M360 78 V40 H322" />
          <path d="M116 160 V198 H154" />
          <path d="M360 160 V198 H322" />
        </g>
        {/* trim bar */}
        <rect x="84" y="222" width="232" height="10" rx="5" fill="var(--bg-inset)" stroke="var(--border-strong)" strokeWidth="2" />
        <rect x="126" y="222" width="150" height="10" rx="5" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2" />
        <rect x="120" y="212" width="9" height="30" rx="4" fill="var(--accent)" />
        <rect x="273" y="212" width="9" height="30" rx="4" fill="var(--accent)" />
        {/* scissors */}
        <g fill="none" stroke="var(--text-muted)" strokeWidth="2.5">
          <circle cx="332" cy="214" r="5" />
          <circle cx="332" cy="238" r="5" />
          <line x1="336" y1="217" x2="358" y2="234" />
          <line x1="336" y1="235" x2="358" y2="218" />
        </g>
      </svg>
    </motion.div>
  );
}

function Tile({
  icon,
  title,
  caption,
  phone,
  busy,
  onClick,
}: {
  icon: IconName;
  title: string;
  caption: string;
  phone: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  const captionId = useId();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-describedby={captionId}
      className={`icon-host flex items-center gap-3 rounded-[var(--radius-lg)] border border-line bg-card p-4 text-left transition hover:border-accent-border hover:bg-card-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 ${phone ? "min-h-[88px]" : "min-h-[72px]"}`}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-accent-soft text-accent">
        <Icon name={icon} size={20} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14px] font-semibold text-fg">{title}</span>
        <span id={captionId} className="text-[12px] text-fg-2">
          {caption}
        </span>
      </span>
    </button>
  );
}

export function EditorHero({
  phone,
  onPick,
  busy = false,
}: {
  phone: boolean;
  onPick: (kind: MediaKind) => void;
  busy?: boolean;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      aria-busy={busy}
      className="mx-auto flex w-full flex-col items-center gap-4 py-6 text-center"
    >
      <Illustration phone={phone} />
      <h2 id={headingId} className={`${phone ? "text-[18px]" : "text-[20px]"} font-semibold text-fg`}>
        Photo &amp; video editor
      </h2>
      <p className="text-fg-2">Crop, trim, mute and export. Nothing leaves your device.</p>
      <div className={`grid w-full gap-3 ${phone ? "grid-cols-1" : "max-w-[560px] grid-cols-2"}`}>
        <Tile
          icon="image"
          title="Edit a photo"
          caption="Crop and export as JPG or PNG"
          phone={phone}
          busy={busy}
          onClick={() => onPick("photo")}
        />
        <Tile
          icon="video"
          title="Edit a video"
          caption="Crop, trim and turn sound off. Saves MP4"
          phone={phone}
          busy={busy}
          onClick={() => onPick("video")}
        />
      </div>
      <p className="text-[11px] text-fg-3">Your original file is never changed. A new copy is saved.</p>
    </section>
  );
}
