import "./illustrations.css";
import "./MicroToast.css";
import { Mascot } from "./Mascot";
import { MICRO_SPARK_D, microA11y } from "./MicroToastKit";

/** Kip with a round "approved" rubber stamp that thumps down beside him. */
export function MicroSuccess({ size = 36, className = "", label }: { size?: number; className?: string; label?: string }) {
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
        <Mascot x={29} y={70} scale={0.68} mood="joy" pose="rest" bob={false} />
      </g>
      <g transform="rotate(-8 56 50)">
        <g className="mt-stamp">
          <circle cx={56} cy={50} r={13} fill="var(--ill-paper)" />
          <circle cx={56} cy={50} r={13} fill="none" stroke="currentColor" strokeWidth={5} />
          <path
            className="mt-check"
            d="M49.5 50.5L54.5 55.5L63 44.5"
            pathLength={1}
            fill="none"
            stroke="currentColor"
            strokeWidth={5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </g>
      <g transform="translate(14 22)">
        <g className="mt-spark">
          <path d={MICRO_SPARK_D} fill="var(--ill-gold)" />
        </g>
      </g>
      <g transform="translate(66 18)">
        <g className="mt-spark mt-spark-2">
          <path d={MICRO_SPARK_D} fill="var(--ill-gold)" transform="scale(0.8)" />
        </g>
      </g>
    </svg>
  );
}
