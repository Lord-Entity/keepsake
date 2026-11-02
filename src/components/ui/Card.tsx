import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { press, t } from "./motion";

export interface Span {
  /** Columns / rows at the wide layout. */
  wide: [number, number];
  /** Columns / rows at the narrow layout (content < 760px). */
  narrow?: [number, number];
}

interface CardProps extends Omit<HTMLMotionProps<"section">, "title" | "children"> {
  title?: ReactNode;
  action?: ReactNode;
  interactive?: boolean;
  tint?: boolean;
  span?: Span;
  narrow?: boolean;
  children?: ReactNode;
  bodyClassName?: string;
}

export function spanStyle(span: Span | undefined, narrow: boolean | undefined): CSSProperties {
  if (!span) return {};
  const [c, r] = narrow && span.narrow ? span.narrow : span.wide;
  return { gridColumn: `span ${c} / span ${c}`, gridRow: `span ${r} / span ${r}` };
}

export function Card({
  title,
  action,
  interactive,
  tint,
  span,
  narrow,
  className = "",
  bodyClassName = "",
  style,
  children,
  ...rest
}: CardProps) {
  const reduced = useReducedMotion();
  const lift = interactive && !reduced;
  return (
    <motion.section
      layout={reduced ? false : "position"}
      whileHover={lift ? { y: -3 } : undefined}
      whileTap={lift ? press : undefined}
      transition={t.spring}
      style={{ ...spanStyle(span, narrow), ...(style as CSSProperties) }}
      className={`card ${interactive ? "card-interactive" : ""} ${tint ? "card-tint" : ""} flex min-w-0 flex-col p-5 ${className}`}
      {...rest}
    >
      {(title || action) && (
        <header className="mb-3 flex h-7 shrink-0 items-center justify-between gap-2">
          <h2 className="truncate text-[15px] leading-[22px] font-semibold">{title}</h2>
          {action}
        </header>
      )}
      <div className={`flex min-h-0 flex-1 flex-col ${bodyClassName}`}>{children}</div>
    </motion.section>
  );
}
