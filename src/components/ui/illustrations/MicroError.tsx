import "./illustrations.css";
import "./MicroToast.css";
import { MICRO_SPARK_D, microA11y } from "./MicroToastKit";

const FACE = "var(--ill-face)";
const ORBIT = [0, 120, 240] as const;

/** Kip's box tipped over on its side, dizzy, lid knocked off, stars circling above. */
export function MicroError({ size = 36, className = "", label }: { size?: number; className?: string; label?: string }) {
  const line = { stroke: FACE, strokeLinecap: "round" as const, fill: "none" };
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
      {/* Fallen lid */}
      <g transform="translate(19 68) rotate(-16) scale(0.52)">
        <g className="mt-lid">
          <rect x={-30} y={-6.5} width={60} height={13} rx={6} fill="var(--ill-body-shade)" />
          <rect x={-4} y={-6.5} width={8} height={13} fill="var(--ill-gold)" />
          <ellipse cx={-6.5} cy={-10.5} rx={6.5} ry={4} transform="rotate(-20 -6.5 -10.5)" fill="var(--ill-gold)" />
          <ellipse cx={6.5} cy={-10.5} rx={6.5} ry={4} transform="rotate(20 6.5 -10.5)" fill="var(--ill-gold)" />
        </g>
      </g>

      {/* Box on its side: wobbles over from upright, then lies at -80deg */}
      <g className="mt-tip">
        <g transform="translate(64 54) rotate(-80) scale(0.62)">
          <ellipse cx={-12} cy={-3} rx={8} ry={4.5} fill="var(--ill-body-shade)" />
          <ellipse cx={12} cy={-3} rx={8} ry={4.5} fill="var(--ill-body-shade)" />
          <rect x={-26} y={-48} width={52} height={44} rx={14} fill="var(--ill-body)" />
          <rect x={-21} y={-43} width={5} height={10} rx={2.5} fill="#fff" opacity={0.28} />
          <rect x={-12} y={-17} width={24} height={8} rx={4} fill="var(--ill-belly)" />
          <ellipse cx={-16} cy={-25} rx={4.5} ry={3} fill="var(--ill-cheek)" />
          <ellipse cx={16} cy={-25} rx={4.5} ry={3} fill="var(--ill-cheek)" />
          {/* Dizzy x eyes */}
          <path d="M-13 -36L-5 -28M-5 -36L-13 -28" strokeWidth={4.4} {...line} />
          <path d="M5 -36L13 -28M13 -36L5 -28" strokeWidth={4.4} {...line} />
          <path d="M-6 -22Q-3 -26 0 -22Q3 -18 6 -22" strokeWidth={4} {...line} />
        </g>
      </g>

      {/* Stars circling above */}
      <g className="mt-orbit-in">
        <g className="mt-orbit">
          {ORBIT.map((a) => (
            <g key={a} transform={`rotate(${a} 46 22) translate(46 9)`}>
              <path d={MICRO_SPARK_D} fill="currentColor" />
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}
