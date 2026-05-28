import type { CSSProperties, ReactNode } from "react";
import "./illustrations.css";

/** Props every finished illustration accepts. Omit `label` when text sits beside it. */
export type IllustrationProps = { label?: string; className?: string };

/**
 * Shared frame for every empty-state illustration: one 240 x 180 viewBox, a soft sky
 * blob behind the action and a ground shadow at y = 150 where characters stand.
 *
 * Accessibility: with a `label` the drawing is announced (role="img"); without one it
 * is decorative (aria-hidden), which is right when a heading and text sit beside it.
 */
export function Scene({
  label,
  children,
  className = "",
  style,
  blob = true,
}: {
  label?: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Draw the default sky blob and ground shadow. */
  blob?: boolean;
}) {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
  return (
    <svg
      viewBox="0 0 240 180"
      className={`ill ${className}`}
      style={style}
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
      {...a11y}
    >
      {blob && (
        <>
          <path
            d="M60 70C60 35 100 22 130 26C170 30 196 50 194 88C192 126 160 146 120 146C80 146 48 128 52 100C54 88 60 82 60 70Z"
            fill="var(--ill-sky)"
          />
          <ellipse cx={120} cy={151} rx={74} ry={7} fill="var(--ill-ground)" />
        </>
      )}
      {children}
    </svg>
  );
}

/** A four-point twinkle. `delay` staggers it against its neighbours (seconds). */
export function Sparkle({
  x,
  y,
  size = 6,
  color = "var(--ill-gold)",
  delay = 0,
}: {
  x: number;
  y: number;
  size?: number;
  color?: string;
  delay?: number;
}) {
  const s = size;
  return (
    <g transform={`translate(${x} ${y})`}>
      <path
        className="ill-twinkle"
        style={delay ? { animationDelay: `${delay}s` } : undefined}
        d={`M0 ${-s}Q0 0 ${s} 0Q0 0 0 ${s}Q0 0 ${-s} 0Q0 0 0 ${-s}Z`}
        fill={color}
      />
    </g>
  );
}

export type PersonPose = "stand" | "reach" | "hold" | "wave";

type Pt = readonly [number, number];

/** Hand positions per pose, in person coordinates (feet centre at 0, 0): [left, right]. */
export const PERSON_HANDS: Record<PersonPose, readonly [Pt, Pt]> = {
  stand: [
    [-15, -32],
    [15, -32],
  ],
  reach: [
    [-15, -32],
    [17, -86],
  ],
  hold: [
    [-8, -38],
    [8, -38],
  ],
  wave: [
    [-15, -32],
    [24, -74],
  ],
};

const OUTFIT = {
  accent: { top: "var(--ill-body)", legs: "var(--ill-teal)" },
  teal: { top: "var(--ill-teal)", legs: "var(--ill-body-shade)" },
  gold: { top: "var(--ill-gold)", legs: "var(--ill-teal)" },
} as const;

/**
 * A little person in the same rounded, outline-free style as Kip: about 90 units
 * tall at scale 1, feet centre at (0, 0).
 */
export function Person({
  x,
  y = 150,
  scale = 1,
  skin = 1,
  outfit = "teal",
  hair = "short",
  pose = "stand",
  flip = false,
  bob = false,
}: {
  x: number;
  y?: number;
  scale?: number;
  skin?: 1 | 2;
  outfit?: keyof typeof OUTFIT;
  hair?: "short" | "bun" | "long";
  pose?: PersonPose;
  flip?: boolean;
  bob?: boolean;
}) {
  const skinFill = `var(--ill-skin-${skin})`;
  const colors = OUTFIT[outfit];
  const [handL, handR] = PERSON_HANDS[pose];
  const front = pose === "hold";
  const arm = (from: Pt, to: Pt, wave?: boolean) => (
    <path
      className={wave ? "ill-wave" : undefined}
      d={`M${from[0]} ${from[1]}L${to[0]} ${to[1]}`}
      stroke={skinFill}
      strokeWidth={6}
      strokeLinecap="round"
      fill="none"
    />
  );
  const arms = (
    <>
      {arm([-10, -52], handL)}
      {arm([10, -52], handR, pose === "wave")}
    </>
  );
  return (
    <g transform={`translate(${x} ${y}) scale(${flip ? -scale : scale} ${scale})`}>
      <g className={bob ? "ill-bob" : undefined}>
        {/* Legs and shoes */}
        <path d="M-6 -26L-7 -4M6 -26L7 -4" stroke={colors.legs} strokeWidth={8} strokeLinecap="round" fill="none" />
        <ellipse cx={-8} cy={-2.5} rx={6} ry={3} fill="var(--ill-face)" />
        <ellipse cx={8} cy={-2.5} rx={6} ry={3} fill="var(--ill-face)" />
        {hair === "long" && <rect x={-13} y={-82} width={26} height={28} rx={12} fill="var(--ill-hair)" />}
        {!front && arms}
        {/* Torso */}
        <path d="M-12 -46C-12 -55 -7 -58 0 -58C7 -58 12 -55 12 -46L13 -26C13 -22 10 -20 6 -20L-6 -20C-10 -20 -13 -22 -13 -26Z" fill={colors.top} />
        {front && arms}
        {/* Head */}
        <rect x={-3.5} y={-62} width={7} height={6} rx={3} fill={skinFill} />
        <circle cx={0} cy={-70} r={11} fill={skinFill} />
        <path d="M-11.5 -71C-12 -88 12 -88 11.5 -71C8 -77 -4 -79 -11.5 -71Z" fill="var(--ill-hair)" />
        {hair === "bun" && <circle cx={0} cy={-84} r={5} fill="var(--ill-hair)" />}
        <g className="ill-blink">
          <circle cx={-4} cy={-69} r={1.6} fill="var(--ill-face)" />
          <circle cx={4} cy={-69} r={1.6} fill="var(--ill-face)" />
        </g>
        <ellipse cx={-7} cy={-65.5} rx={2.2} ry={1.3} fill="var(--ill-cheek)" opacity={0.8} />
        <ellipse cx={7} cy={-65.5} rx={2.2} ry={1.3} fill="var(--ill-cheek)" opacity={0.8} />
        <path d="M-2.5 -64.5Q0 -62.5 2.5 -64.5" stroke="var(--ill-face)" strokeWidth={1.6} strokeLinecap="round" fill="none" />
      </g>
    </g>
  );
}
