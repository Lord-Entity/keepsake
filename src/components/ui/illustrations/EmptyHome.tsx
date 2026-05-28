import { Mascot } from "./Mascot";
import { Scene, Sparkle, type IllustrationProps } from "./Scene";

/** Kip waves hello beside a big floating "paste a link" card with a chain-link icon. */
export function EmptyHome({ label, className }: IllustrationProps) {
  return (
    <Scene label={label} className={className}>
      <Mascot x={72} y={150} scale={1} mood="joy" pose="wave" />

      <g className="ill-float">
        {/* Card with a clip tab on top */}
        <rect x={124} y={44} width={84} height={88} rx={12} fill="var(--ill-paper)" stroke="var(--ill-ink-soft)" strokeWidth={2.5} />
        <rect x={152} y={37} width={28} height={13} rx={6} fill="var(--ill-ink-soft)" />
        {/* Chain link: two interlocked rounded rects */}
        <rect x={140} y={66} width={32} height={17} rx={8.5} fill="none" stroke="var(--ill-body)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        <rect x={158} y={66} width={32} height={17} rx={8.5} fill="none" stroke="var(--ill-body)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        {/* Text lines */}
        <rect x={138} y={98} width={56} height={6} rx={3} fill="var(--ill-paper-2)" />
        <rect x={138} y={110} width={38} height={6} rx={3} fill="var(--ill-paper-2)" />
      </g>

      <Sparkle x={42} y={48} size={7} />
      <Sparkle x={214} y={34} size={5} delay={0.6} />
      <Sparkle x={108} y={36} size={4} color="var(--ill-teal)" delay={1.2} />
    </Scene>
  );
}
