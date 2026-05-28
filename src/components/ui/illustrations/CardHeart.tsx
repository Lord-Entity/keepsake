import type { CSSProperties } from "react";
import "./CardArt.css";

const HEART = "M12 20s-7.5-4.6-9.2-9.3C1.7 7.6 3.8 4.5 7 4.5c2.1 0 3.6 1.2 5 3 1.4-1.8 2.9-3 5-3 3.2 0 5.3 3.1 4.2 6.2C19.5 15.4 12 20 12 20z";

const DOTS = Array.from({ length: 6 }, (_, i) => {
  const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { i, x: 12 + 7 * c, y: 11.5 + 7 * s, dx: `${(6 * c).toFixed(2)}px`, dy: `${(6 * s).toFixed(2)}px` };
});

/** Filled heart that pops with a burst whenever popKey changes, then beats gently. */
export function CardHeart({ popKey = 0, className = "" }: { popKey?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false" style={{ overflow: "visible" }}>
      <g key={popKey}>
        <g className="cart-pop">
          <g className="cart-beat">
            <path d={HEART} fill="currentColor" />
            <ellipse cx={8} cy={8.6} rx={1.6} ry={1} transform="rotate(-35 8 8.6)" fill="#fff" opacity={0.35} />
          </g>
        </g>
        <circle className="cart-ring" cx={12} cy={11.5} r={6} fill="none" stroke="currentColor" strokeWidth={0.8} />
        {DOTS.map((d) => (
          <circle
            key={d.i}
            className="cart-dot"
            cx={d.x}
            cy={d.y}
            r={1}
            fill={d.i % 2 === 0 ? "var(--ill-gold)" : "currentColor"}
            style={{ "--dx": d.dx, "--dy": d.dy } as CSSProperties}
          />
        ))}
      </g>
    </svg>
  );
}
