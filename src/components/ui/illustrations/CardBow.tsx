import "./CardArt.css";

/** Kip's gold ribbon bow, loops swaying gently; a decorative corner ribbon. */
export function CardBow({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 22" className={className} aria-hidden="true" focusable="false">
      <path d="M16 11L11.5 20M16 11L20.5 20" stroke="var(--ill-gold)" strokeWidth={2.6} strokeLinecap="round" fill="none" />
      <g className="cart-sway">
        <g transform="rotate(-20 16 10)">
          <ellipse cx={9} cy={10} rx={7} ry={4} fill="var(--ill-gold)" />
        </g>
        <g transform="rotate(20 16 10)">
          <ellipse cx={23} cy={10} rx={7} ry={4} fill="var(--ill-gold)" />
        </g>
      </g>
      <circle cx={16} cy={10} r={3} fill="var(--ill-body-shade)" />
    </svg>
  );
}
