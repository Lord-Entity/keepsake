import { Mascot } from "./Mascot";
import { Scene, Sparkle, Person, type IllustrationProps } from "./Scene";

/** An almost empty two-shelf bookcase: a person reaches for the top shelf while Kip carries a little box to put away. */
export function EmptyLibrary({ label, className }: IllustrationProps) {
  return (
    <Scene label={label} className={className}>
      {/* Shelf unit */}
      <rect x={84} y={34} width={80} height={114} rx={7} fill="var(--ill-paper-2)" />
      <rect x={90} y={40} width={68} height={102} rx={4} fill="var(--ill-paper)" />
      {/* Boards */}
      <rect x={86} y={62} width={76} height={6} rx={3} fill="var(--ill-paper-2)" />
      <rect x={86} y={104} width={76} height={6} rx={3} fill="var(--ill-paper-2)" />
      <rect x={90} y={68} width={68} height={3} rx={1.5} fill="var(--ill-ink-soft)" opacity={0.25} />
      <rect x={90} y={110} width={68} height={3} rx={1.5} fill="var(--ill-ink-soft)" opacity={0.25} />
      {/* One small box leaning on the middle board */}
      <g transform="rotate(-12 110 104)">
        <rect x={100} y={88} width={20} height={16} rx={4} fill="var(--ill-gold)" />
        <rect x={108} y={88} width={4} height={16} fill="var(--ill-body)" />
      </g>
      {/* Person reaching up to the top shelf */}
      <Person x={66} pose="reach" outfit="accent" hair="bun" skin={2} />
      {/* Kip carrying a box to put away */}
      <Mascot x={194} scale={0.9} mood="happy" pose="hold" flip />
      <rect x={185} y={125} width={18} height={14} rx={4} fill="var(--ill-teal)" />
      <rect x={192} y={125} width={4} height={14} fill="var(--ill-gold)" />
      <Sparkle x={176} y={28} size={6} />
      <Sparkle x={40} y={58} size={5} delay={0.8} color="var(--ill-body)" />
    </Scene>
  );
}
