import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { press, t } from "./motion";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-outline";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-on-accent font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_10px_22px_-12px_var(--accent)] hover:bg-accent-hover hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.26),0_14px_26px_-12px_var(--accent)] active:bg-accent-active active:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_6px_14px_-10px_var(--accent)]",
  secondary:
    "bg-inset text-fg border border-line shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:border-line-strong hover:bg-card-hover hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_18px_-12px_rgba(0,0,0,0.5)] active:bg-card",
  ghost: "bg-transparent text-fg-2 hover:bg-accent-soft hover:text-fg",
  danger:
    "bg-danger text-white font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_10px_22px_-12px_var(--danger)] hover:brightness-110",
  "danger-outline": "bg-transparent text-danger border border-danger/50 hover:bg-danger/10",
};

/** Raised variants lift 1px on hover; flat ones (ghost, outline) stay put. */
const LIFTS: Record<Variant, boolean> = {
  primary: true,
  secondary: true,
  danger: true,
  ghost: false,
  "danger-outline": false,
};

export interface ButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  loading,
  disabled,
  className = "",
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const reduced = useReducedMotion();
  const off = disabled || loading;
  const h = size === "sm" ? "h-8 px-3" : size === "lg" ? "h-12 px-5 text-[14px]" : "h-9 px-4";
  return (
    <motion.button
      type={type}
      disabled={off}
      whileHover={off || reduced || !LIFTS[variant] ? undefined : { y: -1 }}
      whileTap={off ? undefined : press}
      transition={t.press}
      className={`hit icon-host group inline-flex items-center justify-center gap-2 rounded-md text-[12px] font-medium leading-4 whitespace-nowrap transition-[background-color,border-color,color,box-shadow,filter] duration-150 disabled:opacity-45 disabled:pointer-events-none ${h} ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={16} animated /> : null}
      {children}
    </motion.button>
  );
}

export function IconButton({
  icon,
  label,
  size = 36,
  className = "",
  active,
  ...rest
}: Omit<HTMLMotionProps<"button">, "children"> & {
  icon: IconName;
  label: string;
  size?: number;
  active?: boolean;
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      whileTap={rest.disabled ? undefined : press}
      transition={t.press}
      style={{ width: size, height: size }}
      className={`hit icon-host group inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-150 disabled:opacity-45 disabled:pointer-events-none ${
        active ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-accent-soft hover:text-fg"
      } ${className}`}
      {...rest}
    >
      <Icon name={icon} size={size >= 36 ? 20 : 16} animated />
    </motion.button>
  );
}
