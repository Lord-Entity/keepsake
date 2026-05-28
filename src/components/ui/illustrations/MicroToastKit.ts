/** Shared bits for the micro toast icons. */

/** Four-point sparkle centred on (0, 0), about 12 units across. */
export const MICRO_SPARK_D = "M0 -6Q1 -1.2 6 0Q1 1.2 0 6Q-1 1.2 -6 0Q-1 -1.2 0 -6Z";

export function microA11y(label?: string) {
  return label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
}
