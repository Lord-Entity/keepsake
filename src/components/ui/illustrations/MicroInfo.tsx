import "./illustrations.css";
import "./MicroToast.css";
import { Mascot } from "./Mascot";
import { microA11y } from "./MicroToastKit";

const CX = 58;
const CY = 20;
const RAYS = [-170, -130, -90, -50, -10] as const;

function ray(angle: number) {
  const r = (angle * Math.PI) / 180;
  const p = (d: number) => `${(CX + d * Math.cos(r)).toFixed(2)} ${(CY + d * Math.sin(r)).toFixed(2)}`;
  return `M${p(13.5)}L${p(18)}`;
}

/** Curious Kip with a lightbulb that switches on beside his head. */
export function MicroInfo({ size = 36, className = "", label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 80 80"
      className={`mt-icon ${className}`}
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
      {...microA11y(label)}
    >
      <g className="mt-bob">
        <Mascot x={31} y={72} scale={0.7} mood="curious" pose="rest" bob={false} />
      </g>

      <circle className="mt-halo" cx={CX} cy={CY} r={15} fill="var(--ill-gold)" />
      <g className="mt-rays">
        {RAYS.map((a) => (
          <path key={a} d={ray(a)} stroke="currentColor" strokeWidth={4} strokeLinecap="round" fill="none" />
        ))}
      </g>

      <g className="mt-bulb-pop">
        <g className="mt-bulb-sway">
          <rect x={53.5} y={27} width={9} height={6} rx={2} fill="var(--ill-ink-soft)" />
          <rect x={54.5} y={32} width={7} height={4} rx={2} fill="var(--ill-ink-soft)" />
          <circle cx={CX} cy={CY} r={9.5} fill="var(--ill-gold)" />
          <ellipse cx={54.5} cy={16.5} rx={2.4} ry={3.4} transform="rotate(25 54.5 16.5)" fill="#fff" opacity={0.6} />
        </g>
      </g>
    </svg>
  );
}
