import { Mascot } from "./Mascot";
import { Scene, Sparkle, type IllustrationProps } from "./Scene";

/** Kip waits patiently beside an empty teal mailbox with its flag up, while a little envelope floats down towards it. */
export function EmptyDownloads({ label, className }: IllustrationProps) {
  return (
    <Scene label={label} className={className}>
      {/* Post and mailbox */}
      <ellipse cx={152} cy={150} rx={16} ry={3.5} fill="var(--ill-ground)" />
      <rect x={148} y={94} width={9} height={56} rx={3} fill="var(--ill-ink-soft)" />
      <rect x={126} y={62} width={54} height={36} rx={17} fill="var(--ill-teal)" />
      <rect x={126} y={62} width={16} height={36} rx={8} fill="var(--ill-face)" opacity={0.85} />
      <rect x={146} y={70} width={26} height={4} rx={2} fill="var(--ill-face)" opacity={0.6} />
      <rect x={148} y={85} width={22} height={5} rx={2.5} fill="#fff" opacity={0.28} />
      {/* Raised flag */}
      <rect x={172} y={46} width={4} height={20} rx={2} fill="var(--ill-ink-soft)" />
      <rect x={176} y={44} width={14} height={10} rx={3} fill="var(--ill-gold)" />
      {/* Kip waiting */}
      <Mascot x={86} scale={1} mood="curious" pose="rest" />
      {/* Envelope drifting in */}
      <g transform="translate(150 34)">
        <g className="ill-float">
          <rect x={-10} y={-7} width={20} height={14} rx={4} fill="var(--ill-paper)" stroke="var(--ill-ink-soft)" strokeWidth={2.5} strokeLinejoin="round" />
          <path d="M-8 -4L0 2L8 -4" fill="none" stroke="var(--ill-ink-soft)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </g>
      <Sparkle x={120} y={32} size={6} />
      <Sparkle x={196} y={30} size={5} delay={0.9} color="var(--ill-body)" />
      <Sparkle x={52} y={52} size={5} delay={0.5} color="var(--ill-teal)" />
    </Scene>
  );
}
