import "./illustrations.css";
import "./MicroToast.css";
import { Mascot } from "./Mascot";
import { microA11y } from "./MicroToastKit";

/** Worried Kip waving a rounded warning sign on a stick. */
export function MicroWarning({ size = 36, className = "", label }: { size?: number; className?: string; label?: string }) {
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
        <Mascot x={27} y={72} scale={0.66} mood="sad" pose="point" bob={false} />
      </g>
      <g className="mt-sign-raise">
        <g className="mt-sign-wobble">
          <path d="M57 40L57 52" stroke="var(--ill-ink-soft)" strokeWidth={4} strokeLinecap="round" />
          <path
            d="M57 12L72 38L42 38Z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth={5}
            strokeLinejoin="round"
          />
          <path d="M57 22L57 30" stroke="var(--ill-paper)" strokeWidth={4.4} strokeLinecap="round" />
          <circle cx={57} cy={35} r={2.4} fill="var(--ill-paper)" />
        </g>
      </g>
    </svg>
  );
}
