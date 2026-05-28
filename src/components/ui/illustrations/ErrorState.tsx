import { Mascot, mascotHand } from "./Mascot";
import { Scene, Sparkle, type IllustrationProps } from "./Scene";

/** "Something went wrong": a sad Kip holds an unplugged cable whose other end still trails to a wall box, under a small grey cloud. */
export function ErrorState({ label, className }: IllustrationProps) {
  const [hx, hy] = mascotHand("hold", "right", 90, 150, 1);
  return (
    <Scene label={label} className={className}>
      {/* Socket box on the ground */}
      <rect x={172} y={122} width={34} height={28} rx={7} fill="var(--ill-teal-soft)" />
      <rect x={181} y={131} width={4} height={9} rx={2} fill="var(--ill-ink)" />
      <rect x={193} y={131} width={4} height={9} rx={2} fill="var(--ill-ink)" />

      {/* Cable curling from the socket back to the plug */}
      <path d={`M172 142C158 138 148 150 134 150C118 150 ${hx + 2} 156 ${hx} ${hy + 6}`} stroke="var(--ill-ink-soft)" strokeWidth={4} strokeLinecap="round" fill="none" />

      <Mascot x={90} y={150} scale={1} mood="sad" pose="hold" />

      {/* Unplugged plug in Kip's hand, prongs pointing toward the socket */}
      <rect x={hx - 7} y={hy - 7} width={14} height={14} rx={4} fill="var(--ill-ink)" />
      <rect x={hx + 6} y={hy - 5} width={8} height={3} rx={1.5} fill="var(--ill-gold)" />
      <rect x={hx + 6} y={hy + 2} width={8} height={3} rx={1.5} fill="var(--ill-gold)" />

      {/* Small grey cloud with a gentle zigzag */}
      <g transform="translate(138 38)">
        <g className="ill-float">
          <circle cx={0} cy={4} r={10} fill="var(--ill-paper-2)" />
          <circle cx={13} cy={-3} r={13} fill="var(--ill-paper-2)" />
          <circle cx={27} cy={4} r={10} fill="var(--ill-paper-2)" />
          <rect x={-6} y={4} width={40} height={10} rx={5} fill="var(--ill-paper-2)" />
          <path className="ill-pulse" d="M15 18L10 26L17 26L12 34" stroke="var(--ill-gold)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </g>
      </g>

      <Sparkle x={52} y={56} size={4} color="var(--ill-teal)" delay={0.8} />
    </Scene>
  );
}
