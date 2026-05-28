import { Mascot } from "./Mascot";
import { Scene, Sparkle, Person, type IllustrationProps } from "./Scene";

/** A person holds a clapperboard while Kip points at a floating film strip. */
export function EmptyEditor({ label, className }: IllustrationProps) {
  return (
    <Scene label={label} className={className}>
      <Person x={58} y={150} scale={0.95} pose="hold" outfit="teal" hair="bun" />

      {/* Clapperboard held in front of the person */}
      <rect x={41} y={106} width={34} height={26} rx={4} fill="var(--ill-ink-soft)" />
      <rect x={41} y={94} width={34} height={11} rx={3} fill="var(--ill-ink)" />
      <rect x={46} y={94} width={6} height={11} rx={3} fill="var(--ill-paper)" />
      <rect x={57} y={94} width={6} height={11} rx={3} fill="var(--ill-paper)" />
      <rect x={68} y={94} width={5} height={11} rx={2.5} fill="var(--ill-paper)" />
      <rect x={46} y={113} width={24} height={4} rx={2} fill="var(--ill-paper-2)" />
      <rect x={46} y={121} width={14} height={4} rx={2} fill="var(--ill-paper-2)" />

      <Mascot x={190} y={150} scale={0.95} mood="happy" pose="point" flip />

      {/* Floating film strip */}
      <g transform="translate(84 100) rotate(-8)">
        <g className="ill-float">
          <rect x={0} y={0} width={54} height={28} rx={5} fill="var(--ill-teal)" />
          <rect x={5} y={7} width={12} height={14} rx={3} fill="var(--ill-teal-soft)" />
          <rect x={21} y={7} width={12} height={14} rx={3} fill="var(--ill-teal-soft)" />
          <rect x={37} y={7} width={12} height={14} rx={3} fill="var(--ill-teal-soft)" />
        </g>
      </g>

      <Sparkle x={36} y={46} size={6} />
      <Sparkle x={206} y={44} size={5} delay={0.6} />
      <Sparkle x={128} y={52} size={4} color="var(--ill-teal)" delay={1.2} />
    </Scene>
  );
}
