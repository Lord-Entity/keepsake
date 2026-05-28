import { Mascot } from "./Mascot";
import { Sparkle } from "./Scene";

/**
 * Download state art, journey layers (CSS in download.css, prefix dsa-j-).
 * DownloadingLayer: Kip carries a keepsake parcel along a trail; the svg root's --dsa-p
 * (0..1) drives the ribbon and the walker. SavingLayer: Kip slides the parcel onto a shelf.
 */

const MILESTONES = [25, 50, 75, 100] as const;

export function DownloadingLayer({ progress }: { progress: number }) {
  return (
    <g className="dsa-j-downloading">
      {/* Trail: dotted base track and the growing gold ribbon */}
      <path className="dsa-j-track" d="M24 110H216" />
      <rect className="dsa-j-ribbon" x={24} y={108} width={192} height={4} rx={2} />
      {MILESTONES.map((m) => (
        <circle
          key={m}
          className={progress >= m ? "dsa-j-ms dsa-j-lit" : "dsa-j-ms"}
          cx={24 + (192 * m) / 100}
          cy={110}
          r={3}
        />
      ))}

      {/* Start: little cloud with a down arrow */}
      <circle cx={18} cy={54} r={6} fill="var(--ill-paper)" />
      <circle cx={27} cy={52} r={7.5} fill="var(--ill-paper)" />
      <rect x={12} y={54} width={26} height={9} rx={4.5} fill="var(--ill-paper)" />
      <path
        d="M22 49V58M18.5 54.5L22 58.5L25.5 54.5"
        stroke="var(--ill-body)"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* End: gold flag on a teal post */}
      <rect x={221} y={84} width={3} height={26} rx={1.5} fill="var(--ill-teal)" />
      <path
        d="M224.5 86L236 90.5L224.5 95Z"
        fill="var(--ill-gold)"
        stroke="var(--ill-gold)"
        strokeWidth={2}
        strokeLinejoin="round"
      />

      {/* Walker: translated along the trail by --dsa-p */}
      <g className="dsa-j-walker">
        <circle className="dsa-j-dust dsa-j-dust-a" cx={20} cy={104} r={3} fill="var(--ill-paper-2)" />
        <circle className="dsa-j-dust dsa-j-dust-b" cx={14} cy={102} r={2} fill="var(--ill-paper-2)" />
        <g className="dsa-j-waddle">
          <Mascot x={34} y={106} scale={0.62} mood="happy" pose="hold" />
          {/* Keepsake parcel held in front */}
          <rect x={23} y={89} width={22} height={15} rx={3} fill="var(--ill-paper-2)" />
          <rect x={32} y={89} width={4} height={15} fill="var(--ill-gold)" />
          <rect x={23} y={95} width={22} height={3.5} fill="var(--ill-gold)" />
          <ellipse cx={30.5} cy={87.5} rx={3.4} ry={2} transform="rotate(-20 30.5 87.5)" fill="var(--ill-gold)" />
          <ellipse cx={37.5} cy={87.5} rx={3.4} ry={2} transform="rotate(20 37.5 87.5)" fill="var(--ill-gold)" />
        </g>
        {/* Data bits orbiting the parcel (placed on a squashed ring around it) */}
        <g transform="translate(34 97) scale(1 0.5)">
          <g className="dsa-j-orbit">
            <rect x={18.5} y={-1.5} width={3} height={3} rx={0.8} fill="var(--ill-teal)" />
            <circle cx={-10} cy={17.3} r={1.7} fill="var(--ill-gold)" />
            <rect x={-11.5} y={-18.8} width={3} height={3} rx={0.8} fill="var(--ill-body)" />
          </g>
        </g>
      </g>
    </g>
  );
}

export function SavingLayer() {
  return (
    <g className="dsa-j-saving">
      {/* Shelf back panel, slot glow and the gliding parcel (behind the left post) */}
      <rect x={165} y={62} width={54} height={44} fill="var(--ill-teal-soft)" opacity={0.3} />
      <circle className="dsa-j-glow" cx={192} cy={74} r={15} fill="var(--ill-gold)" />
      <g className="dsa-j-parcel">
        <rect x={162} y={70} width={20} height={14} rx={3} fill="var(--ill-paper-2)" />
        <rect x={170} y={70} width={4} height={14} fill="var(--ill-gold)" />
        <rect x={162} y={75} width={20} height={3} fill="var(--ill-gold)" />
        <ellipse cx={169} cy={68.6} rx={3.2} ry={1.9} transform="rotate(-20 169 68.6)" fill="var(--ill-gold)" />
        <ellipse cx={175} cy={68.6} rx={3.2} ry={1.9} transform="rotate(20 175 68.6)" fill="var(--ill-gold)" />
      </g>

      {/* Shelf unit: teal posts, two soft planks */}
      <rect x={160} y={60} width={5} height={50} rx={2.5} fill="var(--ill-teal)" />
      <rect x={219} y={60} width={5} height={50} rx={2.5} fill="var(--ill-teal)" />
      <rect x={160} y={84} width={64} height={4} rx={2} fill="var(--ill-teal-soft)" />
      <rect x={160} y={106} width={64} height={4} rx={2} fill="var(--ill-teal-soft)" />

      {/* Lower slot: two keepsake boxes and a framed photo */}
      <rect x={169} y={94} width={16} height={12} rx={3} fill="var(--ill-body)" />
      <rect x={175.5} y={94} width={3} height={12} fill="var(--ill-gold)" />
      <rect x={188} y={97} width={13} height={9} rx={2.5} fill="var(--ill-paper-2)" />
      <rect x={192.5} y={97} width={3} height={9} fill="var(--ill-teal)" />
      <rect x={204} y={92} width={12} height={14} rx={2.5} fill="var(--ill-body-shade)" />
      <rect x={206} y={94} width={8} height={10} rx={1.5} fill="var(--ill-paper)" />
      <path d="M206 104L209 99.5L211 102L212.5 100.5L214 104Z" fill="var(--ill-teal-soft)" />

      {/* Orbiting sparkle ring around the empty slot */}
      <g className="dsa-j-ring">
        <circle cx={192} cy={53} r={1.8} fill="var(--ill-gold)" />
        <circle cx={213} cy={74} r={1.4} fill="var(--ill-teal)" />
        <circle cx={171} cy={74} r={1.4} fill="var(--ill-gold)" />
      </g>
      <g className="dsa-j-twinkle">
        <Sparkle x={205} y={66} size={5} />
      </g>

      <Mascot x={110} y={106} scale={0.62} mood="happy" pose="point" />
    </g>
  );
}
