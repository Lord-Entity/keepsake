import { Mascot, mascotHand } from "./Mascot";
import { Scene, Sparkle, type IllustrationProps } from "./Scene";

/** "No results": curious Kip sweeps a big magnifying glass over a trail of dots while a "?" floats by. */
export function EmptySearch({ label, className }: IllustrationProps) {
  const [hx, hy] = mascotHand("point", "right", 85, 150, 1);
  return (
    <Scene label={label} className={className}>
      <Mascot x={85} y={150} scale={1} mood="curious" pose="point" />

      {/* Magnifying glass: handle sits in Kip's hand, lens up and to the right */}
      <g transform={`translate(${hx + 10} ${hy - 10}) rotate(45)`}>
        <rect x={-3.5} y={0} width={7} height={20} rx={3.5} fill="var(--ill-gold)" />
      </g>
      <circle cx={hx + 22} cy={hy - 22} r={18} fill="var(--ill-paper)" fillOpacity={0.55} />
      <circle cx={hx + 22} cy={hy - 22} r={18} fill="none" stroke="var(--ill-teal)" strokeWidth={4} />
      <path d={`M${hx + 12} ${hy - 26}Q${hx + 14} ${hy - 34} ${hx + 22} ${hy - 36}`} stroke="#fff" strokeOpacity={0.8} strokeWidth={2.5} strokeLinecap="round" fill="none" />

      {/* Trail of footprints / dots on the ground */}
      <circle cx={168} cy={144} r={2.5} fill="var(--ill-ink-soft)" />
      <circle cx={182} cy={141} r={2.5} fill="var(--ill-ink-soft)" />
      <circle cx={196} cy={144} r={2.5} fill="var(--ill-ink-soft)" />
      <circle cx={208} cy={141} r={2} fill="var(--ill-ink-soft)" opacity={0.6} />

      {/* Floating question mark, built from a path and a dot */}
      <g transform="translate(192 46)">
        <g className="ill-float" style={{ animationDelay: "0.6s" }}>
          <path d="M-7 -6C-7 -16 7 -16 7 -6C7 0 0 1 0 8" stroke="var(--ill-gold)" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <circle cx={0} cy={17} r={2.8} fill="var(--ill-gold)" />
        </g>
      </g>

      <Sparkle x={50} y={52} size={5} delay={0.3} />
      <Sparkle x={150} y={36} size={4} color="var(--ill-teal)" delay={1.2} />
    </Scene>
  );
}
