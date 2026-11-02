import type { ReactNode } from "react";
import { Icon } from "./Icon";

/** Custom dropdown (Dropdown.tsx); re-exported here so existing imports keep working. */
export { Select, type DropdownOption } from "./Dropdown";

export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const btn =
    "icon-host flex size-9 items-center justify-center rounded-md text-fg-2 transition-[color,background-color,scale] duration-150 hover:bg-card-hover hover:text-fg active:scale-[0.92] disabled:opacity-45 disabled:pointer-events-none";
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex h-9 items-center rounded-[12px_12px_12px_5px] border border-line bg-inset shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
    >
      <button type="button" className={btn} aria-label="Decrease" disabled={value <= min} onClick={() => onChange(value - 1)}>
        <Icon name="minus" size={16} animated />
      </button>
      <span className="tabular w-8 text-center text-[13px] font-semibold" aria-live="polite">
        {value}
      </span>
      <button type="button" className={btn} aria-label="Increase" disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Icon name="plus" size={16} animated />
      </button>
    </div>
  );
}

/** Settings row: 48px, label left, control right. */
export function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    // Wraps the control under the label when both cannot fit (phones, narrow windows).
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line py-2 last:border-b-0">
      <div className="min-w-0 flex-1 basis-40">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="text-[11px] leading-[14px] text-fg-2">{hint}</div>}
      </div>
      <div className="flex max-w-full min-w-0 shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}
