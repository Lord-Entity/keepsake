import type { SVGProps } from "react";
import logoUrl from "../../assets/logo.png";

/**
 * Inline stroke icons (24px grid, 1.75 stroke). No icon dependency.
 * Multi-part icons are split so a single part can move on hover (see the
 * "hover icon language" block in theme.css); part i renders as path.ip-i.
 */
const PATHS = {
  home: ["M3 10.5 12 3l9 7.5", "M21 10.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1v-9.5"],
  download: ["M12 3v12m0 0-5-5m5 5 5-5", "M4 19h16"],
  library: ["M4 4h6v16H4z", "M14 4l6 1.5-3.5 15L11 19"],
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  clipboard: "M9 4h6v3H9zM7 5H5v16h14V5h-2",
  chevronLeft: "M15 18l-6-6 6-6",
  chevronRight: "M9 18l6-6-6-6",
  chevronDown: "M6 9l6 6 6-6",
  x: "M6 6l12 12M18 6 6 18",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  monitor: "M3 4h18v12H3zM8 20h8m-4-4v4",
  folder: ["M3 9V6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v1", "M3 9v9a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9"],
  open: ["M14 4h6v6m0-6-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
  trash: ["M4 7h16M9 7V4h6v3", "M7 7l1 13h8l1-13"],
  retry: "M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15m0 5v-5h5",
  copy: ["M8 8h12v12H8z", "M4 16V4h12"],
  video: ["M3 6h13v12H3z", "M16 10l5-3v10l-5-3"],
  audio: "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  image: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15 9.5a1.5 1.5 0 1 0 0-.01",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 2-4.3-4.3",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  check: "M5 12l5 5L20 7",
  alert: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 8v4l3 2"],
  bolt: "M13 2 3 14h9l-1 8 10-12h-9z",
  database: "M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  heart: "M12 20s-7.5-4.6-9.2-9.3C1.7 7.6 3.8 4.5 7 4.5c2.1 0 3.6 1.2 5 3 1.4-1.8 2.9-3 5-3 3.2 0 5.3 3.1 4.2 6.2C19.5 15.4 12 20 12 20z",
  sources: ["M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z", "M8.5 8.5a5 5 0 0 0 0 7m7 0a5 5 0 0 0 0-7", "M5.6 5.6a9 9 0 0 0 0 12.8m12.8 0a9 9 0 0 0 0-12.8"],
  user: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 21a8 8 0 0 1 16 0"],
  play: "M6 4.5v15l13-7.5z",
  camera: ["M4 7h3l2-3h6l2 3h3v13H4z", "M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"],
  note: "M9 18V6l10-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  chart: ["M4 20h16", "M7 16v-5M12 16V6M17 16v-8"],
  layers: ["M12 3 2 8l10 5 10-5z", "M2 13l10 5 10-5"],
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
} as const satisfies Record<string, string | readonly string[]>;

export type IconName = keyof typeof PATHS;

/**
 * animated: the icon plays its own hover motion when the nearest `.icon-host`
 * ancestor (Button, IconButton, nav items...) is hovered or keyboard-focused.
 */
export function Icon({
  name,
  size = 20,
  animated,
  className,
  ...rest
}: { name: IconName; size?: number; animated?: boolean } & Omit<SVGProps<SVGSVGElement>, "name">) {
  const d: string | readonly string[] = PATHS[name];
  const parts = typeof d === "string" ? [d] : d;
  const cls = [animated ? "icon-anim" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-icon={name}
      className={cls || undefined}
      {...rest}
    >
      {parts.map((p, i) => (
        <path key={p} className={parts.length > 1 ? `ip-${i}` : undefined} d={p} />
      ))}
    </svg>
  );
}

/**
 * Keepsake logo (src/assets/logo.png). Same artwork as the
 * generated app icons in src-tauri/icons.
 */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="shrink-0 select-none"
    />
  );
}
