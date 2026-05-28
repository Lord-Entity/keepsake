import type { ReactNode } from "react";
import { Icon, type IconName } from "../../ui/Icon";

export function StatChip({
  icon,
  children,
  title,
  minWidth,
  className = "",
}: {
  icon: IconName;
  children: ReactNode;
  title?: string;
  minWidth?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      style={{ minWidth }}
      className={`tabular inline-flex h-6 items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-full bg-inset px-2 text-[11px] text-fg-2 ${className}`}
    >
      <Icon name={icon} size={12} className="shrink-0" />
      {children}
    </span>
  );
}
