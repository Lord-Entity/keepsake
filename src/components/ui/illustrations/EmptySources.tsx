import { Mascot, mascotHand } from "./Mascot";
import { Scene, Sparkle, type IllustrationProps } from "./Scene";

/** Kip waters a potted sprout whose leaves are rounded play buttons, with a few drops falling and sparkles above. */
export function EmptySources({ label, className }: IllustrationProps) {
  const [hx, hy] = mascotHand("point", "right", 80, 150, 0.95);
  return (
    <Scene label={label} className={className}>
      {/* Sprout with play-button leaves */}
      <g transform="translate(172 128)">
        <g className="ill-sway">
          <rect x={-3} y={-34} width={6} height={36} rx={3} fill="var(--ill-teal)" />
          <g transform="translate(-4 -20) rotate(-14)">
            <rect x={-28} y={-10} width={28} height={20} rx={7} fill="var(--ill-teal)" />
            <path d="M-17 -5L-8 0L-17 5Z" fill="#fff" opacity={0.9} />
          </g>
          <g transform="translate(4 -33) rotate(12)">
            <rect x={0} y={-12} width={30} height={22} rx={7} fill="var(--ill-teal)" />
            <path d="M11 -6L20 -1L11 4Z" fill="#fff" opacity={0.9} />
          </g>
        </g>
      </g>
      {/* Pot */}
      <rect x={157} y={126} width={30} height={7} rx={3.5} fill="var(--ill-gold)" />
      <path d="M160 133L184 133L181 148Q180.5 150 178.5 150L165.5 150Q163.5 150 163 148Z" fill="var(--ill-gold)" />
      <rect x={164} y={137} width={5} height={8} rx={2.5} fill="#fff" opacity={0.3} />
      <Mascot x={80} y={150} scale={0.95} mood="happy" pose="point" />
      {/* Watering can tipped toward the sprout */}
      <g transform={`translate(${hx} ${hy}) rotate(15)`}>
        <rect x={-16} y={-6} width={7} height={12} rx={3} fill="var(--ill-ink-soft)" />
        <rect x={10} y={-6} width={16} height={6} rx={3} transform="rotate(-35 10 -3)" fill="var(--ill-teal)" />
        <rect x={-12} y={-10} width={24} height={20} rx={6} fill="var(--ill-teal)" />
        <rect x={-8} y={-6} width={4} height={8} rx={2} fill="#fff" opacity={0.3} />
      </g>
      {/* Water drops */}
      <ellipse className="ill-pulse" cx={151} cy={119} rx={2.2} ry={3} fill="var(--ill-teal)" />
      <ellipse className="ill-pulse" style={{ animationDelay: "0.5s" }} cx={155} cy={124.5} rx={2.2} ry={3} fill="var(--ill-teal)" />
      <ellipse className="ill-pulse" style={{ animationDelay: "1s" }} cx={159} cy={130} rx={2.2} ry={3} fill="var(--ill-teal)" />
      <Sparkle x={200} y={52} size={6} delay={0.3} />
      <Sparkle x={140} y={56} size={5} color="var(--ill-body)" delay={1.2} />
      <Sparkle x={46} y={60} size={5} color="var(--ill-teal)" delay={2} />
    </Scene>
  );
}
