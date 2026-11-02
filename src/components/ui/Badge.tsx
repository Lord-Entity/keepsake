import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-inset text-fg-2",
  accent: "bg-accent-soft text-accent",
  success: "bg-success/16 text-success",
  warning: "bg-warning/16 text-warning",
  danger: "bg-danger/16 text-danger",
};

export function Badge({
  tone = "neutral",
  children,
  className = "",
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`tabular inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] leading-[14px] font-medium whitespace-nowrap transition-colors duration-200 ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Dot({ tone, className = "" }: { tone: BadgeTone; className?: string }) {
  const color =
    tone === "success"
      ? "bg-success"
      : tone === "warning"
        ? "bg-warning"
        : tone === "danger"
          ? "bg-danger"
          : tone === "accent"
            ? "bg-accent"
            : "bg-fg-3";
  return <span className={`inline-block size-2 shrink-0 rounded-full transition-colors duration-200 ${color} ${className}`} />;
}

/** Tag badge: rounded left edge, tapered point on the right (clip-path `.tag-badge`). */
export function TagBadge({
  tone = "accent",
  children,
  className = "",
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`tag-badge tabular inline-flex h-5 shrink-0 items-center pl-2 text-[10px] leading-3 font-semibold tracking-[0.04em] whitespace-nowrap uppercase ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
