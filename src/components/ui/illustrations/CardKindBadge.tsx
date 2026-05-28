import { useId } from "react";
import "./CardArt.css";

const SPARKLE = "M0 -3Q0.5 -0.5 3 0Q0.5 0.5 0 3Q-0.5 0.5 -3 0Q-0.5 -0.5 0 -3z";

function Glyph({ kind }: { kind: "video" | "audio" | "image" }) {
  // Per-instance clip ids: a shared id resolves to the first badge in the document, which can be
  // in an off-screen (content-visibility skipped) card and then fail to clip.
  const clip = `cart-clip-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  if (kind === "video") {
    return (
      <>
        <defs>
          <clipPath id={clip}>
            <rect x={8} y={10} width={16} height={12} rx={2.5} />
          </clipPath>
        </defs>
        <rect x={8} y={10} width={16} height={12} rx={2.5} fill="var(--ill-body)" />
        <g clipPath={`url(#${clip})`}>
          <g className="cart-film">
            {[6, 10, 14, 18, 22, 26].map((x) => (
              <g key={x}>
                <circle cx={x} cy={11.7} r={0.8} fill="var(--ill-paper)" opacity={0.8} />
                <circle cx={x} cy={20.3} r={0.8} fill="var(--ill-paper)" opacity={0.8} />
              </g>
            ))}
          </g>
        </g>
        <path className="cart-play" d="M14.6 13.2L19.8 16L14.6 18.8z" fill="var(--ill-paper)" />
      </>
    );
  }
  if (kind === "audio") {
    return (
      <>
        <rect className="cart-bar cart-bar-1" x={9} y={13} width={4} height={10} rx={2} fill="var(--ill-body)" />
        <rect className="cart-bar cart-bar-2" x={14} y={9} width={4} height={14} rx={2} fill="var(--ill-gold)" />
        <rect className="cart-bar cart-bar-3" x={19} y={15} width={4} height={8} rx={2} fill="var(--ill-teal)" />
      </>
    );
  }
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <rect x={7} y={9} width={18} height={14} rx={3} />
        </clipPath>
      </defs>
      <rect x={7} y={9} width={18} height={14} rx={3} fill="var(--ill-paper-2)" />
      <g clipPath={`url(#${clip})`}>
        <circle className="cart-sun" cx={20.5} cy={14} r={2} fill="var(--ill-gold)" />
        <path d="M6 24L13 14.5L18 20.5L21 17.5L26 24z" fill="var(--ill-teal)" />
      </g>
      <path className="cart-twinkle" d="M11 11.5Q11.4 12.4 12.3 12.8Q11.4 13.2 11 14.1Q10.6 13.2 9.7 12.8Q10.6 12.4 11 11.5z" fill="var(--ill-gold)" />
      <g transform="translate(22.5 21) scale(0.4)">
        <path className="cart-twinkle cart-twinkle-2" d={SPARKLE} fill="var(--ill-paper)" />
      </g>
    </>
  );
}

/** Round chip with a gently animated glyph for a library card's media kind. */
export function CardKindBadge({ kind, className = "" }: { kind: "video" | "audio" | "image"; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <circle cx={16} cy={16} r={15} fill="var(--ill-paper)" />
      <circle cx={16} cy={16} r={14} fill="none" stroke="var(--ill-body)" strokeWidth={1.5} opacity={0.3} />
      <Glyph kind={kind} />
    </svg>
  );
}
