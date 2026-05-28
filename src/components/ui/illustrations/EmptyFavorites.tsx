import { Mascot } from "./Mascot";
import { Scene, Sparkle, type IllustrationProps } from "./Scene";

const HEART = "M0 4C-7 -1 -5 -7 0 -3.5C5 -7 7 -1 0 4Z";

/** Kip cheers with both arms raised toward a big floating gold star, hearts and sparkles twinkling around. */
export function EmptyFavorites({ label, className }: IllustrationProps) {
  return (
    <Scene label={label} className={className}>
      <Mascot x={120} y={150} scale={0.95} mood="joy" pose="up" />
      <g transform="translate(120 58)">
        <g className="ill-float">
          <path
            d="M-1.3 -18.9Q0 -22 1.3 -18.9L5.9 -8.1L17.6 -7.1Q20.9 -6.8 18.4 -4.6L9.5 3.1L12.2 14.6Q12.9 17.8 10.1 16.1L0 10L-10.1 16.1Q-12.9 17.8 -12.2 14.6L-9.5 3.1L-18.4 -4.6Q-20.9 -6.8 -17.6 -7.1L-5.9 -8.1Z"
            fill="var(--ill-gold)"
            transform="scale(1.25)"
          />
          <rect x={-11} y={-12} width={5} height={9} rx={2.5} fill="#fff" opacity={0.4} transform="rotate(40 -8 -8)" />
        </g>
      </g>
      <g transform="translate(58 62)">
        <path className="ill-twinkle" d={HEART} fill="var(--ill-body)" />
      </g>
      <g transform="translate(184 48)">
        <path className="ill-twinkle" style={{ animationDelay: "0.9s" }} d={HEART} fill="var(--ill-body)" />
      </g>
      <g transform="translate(192 104) scale(0.8)">
        <path className="ill-twinkle" style={{ animationDelay: "1.7s" }} d={HEART} fill="var(--ill-body)" />
      </g>
      <Sparkle x={80} y={34} size={7} delay={0.4} />
      <Sparkle x={162} y={30} size={5} color="var(--ill-teal)" delay={1.3} />
      <Sparkle x={46} y={102} size={5} color="var(--ill-teal)" delay={2.1} />
      <Sparkle x={202} y={76} size={6} delay={0.2} />
    </Scene>
  );
}
