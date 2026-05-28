import type { CSSProperties } from "react";
import "./illustrations.css";
import "./MicroSplash.css";

/**
 * Animated splash mark: Kip pops out of his box (boot) or sits sadly (error).
 * Geometry is copied from Mascot (feet centre at 0,0); parts are separate groups so
 * they can be animated. See MicroSplash.css for the timeline.
 */

const FACE = "var(--ill-face)";
const CY = -32; // Kip's centre, the orbit/burst centre

const line = { stroke: FACE, strokeWidth: 2.5, strokeLinecap: "round" as const, fill: "none" };

function star(cx: number, cy: number, s: number) {
  return `M${cx} ${cy - s}Q${cx} ${cy} ${cx + s} ${cy}Q${cx} ${cy} ${cx} ${cy + s}Q${cx} ${cy} ${cx - s} ${cy}Q${cx} ${cy} ${cx} ${cy - s}Z`;
}

type Bit = { dx: number; dy: number; kind: "dot" | "star" | "bit"; color: string; delay: number };

const GOLD = "var(--ill-gold)";
const TEAL = "var(--ill-teal)";
const CORAL = "var(--ill-body-shade)";

const BURST: readonly Bit[] = [
  { dx: -24, dy: -58, kind: "star", color: GOLD, delay: 0 },
  { dx: 28, dy: -58, kind: "dot", color: TEAL, delay: 0.03 },
  { dx: 54, dy: -22, kind: "bit", color: CORAL, delay: 0.06 },
  { dx: 48, dy: 20, kind: "star", color: TEAL, delay: 0.02 },
  { dx: -48, dy: 20, kind: "dot", color: GOLD, delay: 0.05 },
  { dx: -54, dy: -22, kind: "bit", color: TEAL, delay: 0.08 },
];

function Burst() {
  return (
    <g>
      {BURST.map((b, i) => {
        const style = { "--dx": `${b.dx}px`, "--dy": `${b.dy}px`, animationDelay: `${0.45 + b.delay}s` } as CSSProperties;
        return (
          <g key={i} className="ms-burst-p" style={style}>
            {b.kind === "dot" && <circle cx={0} cy={CY} r={3} fill={b.color} />}
            {b.kind === "star" && <path d={star(0, CY, 5.5)} fill={b.color} />}
            {b.kind === "bit" && <rect x={-2} y={CY - 3} width={4} height={6} rx={1} fill={b.color} transform={`rotate(${i * 25} 0 ${CY})`} />}
          </g>
        );
      })}
    </g>
  );
}

function Orbit() {
  return (
    <g className="ms-orbit">
      {/* Invisible ring: makes the fill-box centre exactly Kip's centre. */}
      <circle cx={0} cy={CY} r={60} fill="none" />
      <path d={star(0, CY - 48, 5.5)} fill={GOLD} />
      <circle cx={48} cy={CY} r={2.8} fill={TEAL} />
      <circle cx={0} cy={CY + 48} r={2.5} fill={CORAL} />
      <path d={star(-48, CY, 4)} fill={GOLD} />
    </g>
  );
}

function DotEye({ x }: { x: number }) {
  return (
    <>
      <ellipse cx={x} cy={CY} rx={3.2} ry={3.8} fill={FACE} />
      <circle cx={x + 1} cy={-33.4} r={1.1} fill="#fff" />
    </>
  );
}

export function MicroSplash({
  size = 120,
  state = "boot",
  className = "",
  label,
}: {
  size?: number;
  state?: "boot" | "error";
  className?: string;
  label?: string;
}) {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
  const boot = state === "boot";
  const armL = boot ? "M-23 -28L-34 -50" : "M-23 -28L-31 -15";
  const armR = boot ? "M23 -28L34 -50" : "M23 -28L31 -15";
  const arm = { stroke: "var(--ill-body-shade)", strokeWidth: 7, strokeLinecap: "round" as const, fill: "none" };
  return (
    <svg
      viewBox="-70 -105 140 140"
      width={size}
      height={size}
      className={`ms ms-${state} ${className}`.trim()}
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
      {...a11y}
    >
      <g className="ms-shadow">
        <ellipse cx={0} cy={1} rx={28} ry={5} fill="var(--ill-ground)" />
      </g>
      <g className="ms-drop">
        <g className="ms-bob">
          <ellipse cx={-12} cy={-3} rx={8} ry={4.5} fill="var(--ill-body-shade)" />
          <ellipse cx={12} cy={-3} rx={8} ry={4.5} fill="var(--ill-body-shade)" />
          <path className="ms-arm ms-arm-l" d={armL} {...arm} />
          <path className="ms-arm ms-arm-r" d={armR} {...arm} />
          <rect x={-26} y={-48} width={52} height={44} rx={14} fill="var(--ill-body)" />
          <rect x={-21} y={-43} width={5} height={10} rx={2.5} fill="#fff" opacity={0.28} />
          <rect x={-12} y={-17} width={24} height={8} rx={4} fill="var(--ill-belly)" />
          {/* Face */}
          <g className="ms-eyes">
            <g className="ms-blink">
              <DotEye x={-9} />
              <DotEye x={9} />
            </g>
          </g>
          <ellipse cx={-16} cy={-25} rx={4} ry={2.5} fill="var(--ill-cheek)" />
          <ellipse cx={16} cy={-25} rx={4} ry={2.5} fill="var(--ill-cheek)" />
          {boot ? (
            <path className="ms-mouth" d="M-4 -25Q0 -21 4 -25" {...line} />
          ) : (
            <>
              <path d="M-13 -38L-6 -40" {...line} strokeWidth={2} />
              <path d="M13 -38L6 -40" {...line} strokeWidth={2} />
              <path d="M-4 -22Q0 -26 4 -22" {...line} />
            </>
          )}
          {/* Lid with gold ribbon and bow */}
          <g className="ms-lid">
            <rect x={-30} y={-58} width={60} height={13} rx={6} fill="var(--ill-body-shade)" />
            <rect x={-4} y={-58} width={8} height={13} fill="var(--ill-gold)" />
            <g className="ms-bow">
              <ellipse cx={-6.5} cy={-62} rx={6.5} ry={4} transform="rotate(-20 -6.5 -62)" fill="var(--ill-gold)" />
              <ellipse cx={6.5} cy={-62} rx={6.5} ry={4} transform="rotate(20 6.5 -62)" fill="var(--ill-gold)" />
              <circle cx={0} cy={-60} r={3} fill="var(--ill-body-shade)" />
            </g>
          </g>
        </g>
      </g>
      {boot && <Burst />}
      {boot && <Orbit />}
    </svg>
  );
}
