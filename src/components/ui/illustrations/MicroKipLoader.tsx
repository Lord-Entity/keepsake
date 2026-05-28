import "./illustrations.css";
import "./MicroLoader.css";

/**
 * Inline "Kip is working" loader: Kip hops in place while a gold sparkle and a teal
 * dot orbit around it. Decorative only; the caller wraps it in role="status".
 *
 * Geometry: viewBox 0 0 100 100, Kip's feet at (50, 82) at scale 0.8, orbit centre
 * (50, 56) radius 36. Elements with an SVG transform attribute are never animated
 * directly; the CSS classes (ml-*) sit on wrapper groups.
 */

const FACE = "var(--ill-face)";
const R = 36;
const CX = 50;
const CY = 56;

/** Point on the orbit at `deg` degrees counter-clockwise of 3 o'clock (behind a clockwise mover). */
function behind(deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CX + R * Math.cos(a), CY - R * Math.sin(a)];
}

const TRAIL: ReadonlyArray<{ deg: number; r: number; o: number }> = [
  { deg: 14, r: 1.9, o: 0.5 },
  { deg: 28, r: 1.5, o: 0.35 },
  { deg: 42, r: 1.1, o: 0.2 },
];

export function MicroKipLoader({
  size = 40,
  className = "",
  detail,
}: {
  size?: number;
  className?: string;
  detail?: "low" | "high";
}) {
  const level = detail ?? (size < 28 ? "low" : "high");
  const high = level === "high";
  const s = high ? 5.5 : 7;
  const spark = `M0 ${-s}Q0 0 ${s} 0Q0 0 0 ${s}Q0 0 ${-s} 0Q0 0 0 ${-s}Z`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={`ml-svg ${className}`.trim()}
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Ground shadow */}
      <ellipse className="ml-shadow" cx={50} cy={83.5} rx={19} ry={3.2} fill="var(--ill-ground)" />

      {/* Kip */}
      <g transform="translate(50 82) scale(0.8)">
        <g className="ml-hop">
          <ellipse cx={-12} cy={-3} rx={high ? 8 : 9.5} ry={high ? 4.5 : 5.5} fill="var(--ill-body-shade)" />
          <ellipse cx={12} cy={-3} rx={high ? 8 : 9.5} ry={high ? 4.5 : 5.5} fill="var(--ill-body-shade)" />
          {high && (
            <>
              <path d="M-23 -28L-31 -15" stroke="var(--ill-body-shade)" strokeWidth={7} strokeLinecap="round" fill="none" />
              <path d="M23 -28L31 -15" stroke="var(--ill-body-shade)" strokeWidth={7} strokeLinecap="round" fill="none" />
            </>
          )}
          <rect x={-26} y={-48} width={52} height={44} rx={14} fill="var(--ill-body)" />
          {high && (
            <>
              <rect x={-21} y={-43} width={5} height={10} rx={2.5} fill="#fff" opacity={0.28} />
              <rect x={-12} y={-17} width={24} height={8} rx={4} fill="var(--ill-belly)" />
            </>
          )}

          {/* Face */}
          <g className="ml-blink">
            <ellipse cx={-9} cy={-32} rx={high ? 3.2 : 4.4} ry={high ? 3.8 : 5} fill={FACE} />
            <ellipse cx={9} cy={-32} rx={high ? 3.2 : 4.4} ry={high ? 3.8 : 5} fill={FACE} />
            {high && (
              <>
                <circle cx={-8} cy={-33.4} r={1.1} fill="#fff" />
                <circle cx={10} cy={-33.4} r={1.1} fill="#fff" />
              </>
            )}
          </g>
          {high && (
            <>
              <ellipse cx={-16} cy={-25} rx={4} ry={2.5} fill="var(--ill-cheek)" />
              <ellipse cx={16} cy={-25} rx={4} ry={2.5} fill="var(--ill-cheek)" />
            </>
          )}
          <path
            d="M-4 -25Q0 -21 4 -25"
            stroke={FACE}
            strokeWidth={high ? 2.5 : 3.4}
            strokeLinecap="round"
            fill="none"
          />

          {/* Lid lags behind the body, bow wiggles on top */}
          <g className="ml-lid">
            <rect x={-30} y={-58} width={60} height={13} rx={6} fill="var(--ill-body-shade)" />
            <rect x={-4} y={-58} width={8} height={13} fill="var(--ill-gold)" />
            <g className="ml-bow">
              <ellipse cx={-6.5} cy={-62} rx={6.5} ry={4} transform="rotate(-20 -6.5 -62)" fill="var(--ill-gold)" />
              <ellipse cx={6.5} cy={-62} rx={6.5} ry={4} transform="rotate(20 6.5 -62)" fill="var(--ill-gold)" />
              <circle cx={0} cy={-60} r={3} fill="var(--ill-body-shade)" />
            </g>
          </g>
        </g>
      </g>

      {/* Orbit: rotates about (50, 56); sparkle parked at 3 o'clock, teal dot opposite */}
      <g className="ml-orbit">
        {high &&
          TRAIL.map((t) => {
            const [x, y] = behind(t.deg);
            return <circle key={t.deg} cx={x} cy={y} r={t.r} fill="var(--ill-gold)" opacity={t.o} />;
          })}
        <circle cx={CX - R} cy={CY} r={high ? 2.6 : 3.4} fill="var(--ill-teal)" />
        <g transform={`translate(${CX + R} ${CY})`}>
          <g className="ml-spark">
            <g className="ml-twinkle">
              <path d={spark} fill="var(--ill-gold)" />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
