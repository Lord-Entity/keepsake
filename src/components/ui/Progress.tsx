import { Bar, type LoaderTone } from "./Loader";

export type ProgressTone = LoaderTone;

/** pct: 0-100, or null for indeterminate. Thin wrapper over Loader's Bar. */
export function Progress({
  pct,
  tone = "accent",
  className = "",
  label,
}: {
  pct: number | null;
  tone?: ProgressTone;
  className?: string;
  label?: string;
}) {
  return <Bar value={pct} tone={tone} className={className} label={label} />;
}
