import "./CardArt.css";

const SCALLOPS = Array.from({ length: 18 }, (_, i) => {
  const a = (i / 18) * Math.PI * 2;
  return { x: +(48 + 43 * Math.cos(a)).toFixed(2), y: +(48 + 43 * Math.sin(a)).toFixed(2) };
});

const SPARKLE = "M0 -5Q0.8 -0.8 5 0Q0.8 0.8 0 5Q-0.8 0.8 -5 0Q-0.8 -0.8 0 -5z";

/** Round postage-style "ready" stamp that slams in once; announced as an image. */
export function CardReadyStamp({ className = "", label = "Ready" }: { className?: string; label?: string }) {
  return (
    <svg viewBox="0 0 96 96" className={className} role="img" aria-label={label} focusable="false" style={{ overflow: "visible" }}>
      <g transform="rotate(-10 48 48)">
        <circle className="cart-ink" cx={48} cy={48} r={44} fill="none" stroke="var(--ill-teal)" strokeWidth={2} />
        <g className="cart-slam">
          <g className="cart-wobble">
            {SCALLOPS.map((p) => (
              <circle key={`${p.x}-${p.y}`} cx={p.x} cy={p.y} r={5} fill="var(--ill-teal)" />
            ))}
            <circle cx={48} cy={48} r={43} fill="var(--ill-teal)" />
            <circle cx={48} cy={48} r={37} fill="var(--ill-teal-soft)" />
            <circle cx={48} cy={48} r={33} fill="none" stroke="var(--ill-teal)" strokeWidth={1.5} strokeDasharray="3 3" />
            <path
              className="cart-check"
              d="M39 39L45.5 45.5L58 32"
              pathLength={1}
              strokeDasharray={1}
              fill="none"
              stroke="var(--ill-teal)"
              strokeWidth={4}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <text
              x={48}
              y={64}
              textAnchor="middle"
              fontSize={15}
              fontWeight={800}
              letterSpacing={1.5}
              fill="var(--ill-teal)"
              fontFamily="inherit"
            >
              {label.toUpperCase()}
            </text>
            <g transform="translate(48 5) scale(0.75) translate(-16 -10)">
              <path d="M16 11L11.5 20M16 11L20.5 20" stroke="var(--ill-gold)" strokeWidth={2.6} strokeLinecap="round" fill="none" />
              <ellipse cx={9} cy={10} rx={7} ry={4} fill="var(--ill-gold)" transform="rotate(-20 16 10)" />
              <ellipse cx={23} cy={10} rx={7} ry={4} fill="var(--ill-gold)" transform="rotate(20 16 10)" />
              <circle cx={16} cy={10} r={3} fill="var(--ill-body-shade)" />
            </g>
          </g>
        </g>
        <g transform="translate(6 26) scale(0.8)">
          <path className="cart-twinkle" d={SPARKLE} fill="var(--ill-gold)" />
        </g>
        <g transform="translate(91 36) scale(0.6)">
          <path className="cart-twinkle cart-twinkle-2" d={SPARKLE} fill="var(--ill-gold)" />
        </g>
        <g transform="translate(86 86) scale(0.7)">
          <path className="cart-twinkle cart-twinkle-3" d={SPARKLE} fill="var(--ill-gold)" />
        </g>
      </g>
    </svg>
  );
}
