import { Mascot, mascotHand } from "./Mascot";
import { Sparkle } from "./Scene";

/**
 * Finale layers for the download state art (240 x 120 frame, feet at y = 106):
 * ProcessingLayer (Kip seals the parcel), DoneLayer (check stamp + confetti) and
 * FailedLayer (tipped parcel with a friendly retry badge). Styles live in download.css.
 * Orbiting bits are CSS-driven: each orbit item sits at the centre of a placement <g>
 * and travels an ellipse via the shared dsa-f-around keyframes (--rx / --ry).
 */

/** Parcel body: lid, box, gold ribbon and a bow, laid out from the top-left corner (x, y). */
function Parcel({ x, y, bow = true }: { x: number; y: number; bow?: boolean }) {
  return (
    <>
      <rect x={x} y={y + 8} width={34} height={18} rx={3} fill="var(--ill-paper)" />
      <rect x={x - 2} y={y} width={38} height={9} rx={3.5} fill="var(--ill-paper-2)" />
      <rect x={x + 15} y={y} width={4} height={26} fill="var(--ill-gold)" />
      {bow && (
        <>
          <ellipse cx={x + 13} cy={y - 2} rx={5} ry={3} transform={`rotate(-20 ${x + 13} ${y - 2})`} fill="var(--ill-gold)" />
          <ellipse cx={x + 21} cy={y - 2} rx={5} ry={3} transform={`rotate(20 ${x + 21} ${y - 2})`} fill="var(--ill-gold)" />
        </>
      )}
    </>
  );
}

/** Merging / converting: Kip tapes the parcel shut while two ribbons twist into it. */
export function ProcessingLayer() {
  const [rx, ry] = mascotHand("point", "right", 96, 106, 0.62);
  return (
    <g className="dsa-f-processing">
      {/* Two ribbons (teal + body colour) curl in from the top-left and twist into the parcel */}
      <path className="dsa-f-rib dsa-f-rib-a" d="M112 40C130 34 134 56 154 61" fill="none" stroke="var(--ill-teal)" strokeWidth={2.6} strokeLinecap="round" />
      <path className="dsa-f-rib dsa-f-rib-b" d="M106 50C124 42 140 64 160 62" fill="none" stroke="var(--ill-body)" strokeWidth={2.6} strokeLinecap="round" />
      {/* Work table */}
      <rect x={140} y={96} width={4} height={10} rx={1.5} fill="var(--ill-ink-soft)" />
      <rect x={176} y={96} width={4} height={10} rx={1.5} fill="var(--ill-ink-soft)" />
      <rect x={138} y={93} width={44} height={4} rx={1.5} fill="var(--ill-teal-soft)" />
      <rect x={136} y={88} width={48} height={6} rx={3} fill="var(--ill-paper-2)" />
      {/* Parcel with tape and stitch */}
      <Parcel x={143} y={62} />
      <g className="dsa-f-tape">
        <rect x={143} y={72} width={34} height={4} rx={1} fill="var(--ill-gold)" />
        <rect x={143} y={72.6} width={34} height={1.2} rx={0.6} fill="#fff" opacity={0.3} />
      </g>
      <path className="dsa-f-stitch" d="M146 82H174" fill="none" stroke="var(--ill-teal)" strokeWidth={1.8} strokeLinecap="round" />
      {/* Kip, holding the spinning tape roll */}
      <Mascot x={96} y={106} scale={0.62} mood="happy" pose="point" />
      <g className="dsa-f-roll">
        <circle cx={rx} cy={ry} r={6} fill="var(--ill-gold)" />
        <circle cx={rx} cy={ry} r={2.4} fill="var(--ill-paper-2)" />
        <rect x={rx - 1} y={ry - 5.2} width={2} height={3} rx={1} fill="var(--ill-paper)" opacity={0.8} />
      </g>
      {/* Sparkles orbiting the parcel */}
      <g transform="translate(160 76)">
        <g className="dsa-f-orb dsa-f-o1">
          <Sparkle x={0} y={0} size={5} />
        </g>
        <g className="dsa-f-orb dsa-f-o2">
          <Sparkle x={0} y={0} size={4} color="var(--ill-teal)" delay={0.4} />
        </g>
        <g className="dsa-f-orb dsa-f-o3">
          <Sparkle x={0} y={0} size={4.5} delay={0.9} />
        </g>
      </g>
    </g>
  );
}

/** Success: Kip cheers, a check stamp lands on the sealed parcel, confetti and stars follow. */
export function DoneLayer() {
  return (
    <g className="dsa-f-done">
      <g className="dsa-f-hop">
        <Mascot x={92} y={106} scale={0.62} mood="joy" pose="up" bob={false} />
      </g>
      {/* Parcel, stamp and confetti sit 4 units lower so the parcel rests on the ground (y = 106). */}
      <g transform="translate(0 4)">
        <Parcel x={143} y={76} />
        <circle className="dsa-f-ripple" cx={160} cy={94} r={13} fill="none" stroke="var(--ill-teal-soft)" strokeWidth={2.4} />
        <g className="dsa-f-stamp">
          <circle cx={160} cy={94} r={13} fill="var(--ill-teal)" />
          <circle cx={160} cy={94} r={10} fill="none" stroke="var(--ill-teal-soft)" strokeWidth={1} opacity={0.7} />
          <path d="M153.6 94.5L158 99L166.6 89.5" fill="none" stroke="var(--ill-paper)" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" />
        </g>
        {/* One-shot confetti burst from the stamp */}
        <rect className="dsa-f-cf dsa-f-cf1" x={158.5} y={83.5} width={3} height={5} rx={1} fill="var(--ill-body)" />
        <circle className="dsa-f-cf dsa-f-cf2" cx={160} cy={86} r={2} fill="var(--ill-gold)" />
        <rect className="dsa-f-cf dsa-f-cf3" x={158.5} y={83.5} width={3} height={5} rx={1} fill="var(--ill-teal)" />
        <circle className="dsa-f-cf dsa-f-cf4" cx={160} cy={86} r={2} fill="var(--ill-cheek)" />
        <rect className="dsa-f-cf dsa-f-cf5" x={158.5} y={83.5} width={3} height={5} rx={1} fill="var(--ill-gold)" />
        <circle className="dsa-f-cf dsa-f-cf6" cx={160} cy={86} r={2} fill="var(--ill-teal-soft)" />
        <rect className="dsa-f-cf dsa-f-cf7" x={158.5} y={83.5} width={3} height={5} rx={1} fill="var(--ill-cheek)" />
        <circle className="dsa-f-cf dsa-f-cf8" cx={160} cy={86} r={2} fill="var(--ill-body)" />
      </g>
      {/* Stars orbiting Kip's head */}
      <g className="dsa-f-stars" transform="translate(92 60)">
        <g className="dsa-f-orb dsa-f-o1">
          <Sparkle x={0} y={0} size={4} />
        </g>
        <g className="dsa-f-orb dsa-f-o2">
          <Sparkle x={0} y={0} size={3.5} color="var(--ill-teal)" delay={0.5} />
        </g>
        <g className="dsa-f-orb dsa-f-o3">
          <Sparkle x={0} y={0} size={4} delay={1} />
        </g>
      </g>
    </g>
  );
}

/** Failure, kindly: the parcel tipped over with its lid ajar, and a retry badge to try again. */
export function FailedLayer() {
  return (
    <g className="dsa-f-failed">
      {/* Tipped parcel (rests on its bottom-left corner) */}
      <g transform="rotate(-18 133 106)">
        <rect x={133} y={88} width={34} height={18} rx={3} fill="var(--ill-paper)" />
        <rect x={133} y={86} width={34} height={4} fill="var(--ill-ink-soft)" opacity={0.55} />
        <rect x={148} y={88} width={4} height={18} fill="var(--ill-gold)" />
        <g transform="rotate(-14 133 85)">
          <rect x={131} y={77} width={38} height={9} rx={3.5} fill="var(--ill-paper-2)" />
          <rect x={146} y={77} width={4} height={9} fill="var(--ill-gold)" />
        </g>
      </g>
      {/* Spilled film chip */}
      <g transform="translate(112 98) rotate(-12)">
        <rect width={15} height={10} rx={2.2} fill="var(--ill-teal)" />
        <rect x={2.2} y={1.8} width={10.6} height={6.4} rx={1.2} fill="var(--ill-teal-soft)" />
        <path d="M6.3 3L10 5L6.3 7Z" fill="var(--ill-paper)" stroke="var(--ill-paper)" strokeWidth={0.8} strokeLinejoin="round" />
      </g>
      {/* Retry badge */}
      <g className="dsa-f-badge">
        <circle cx={146} cy={50} r={12} fill="var(--ill-body)" />
        <circle cx={146} cy={50} r={12} fill="none" stroke="var(--ill-body-shade)" strokeWidth={1.4} opacity={0.5} />
        <g className="dsa-f-retry">
          <path d="M152.5 50A6.5 6.5 0 1 1 148.2 43.9" fill="none" stroke="var(--ill-paper)" strokeWidth={2.4} strokeLinecap="round" />
          <path d="M151.6 45.1L147.2 46.7L149.2 41.1Z" fill="var(--ill-paper)" stroke="var(--ill-paper)" strokeWidth={1} strokeLinejoin="round" />
        </g>
      </g>
      <Mascot x={84} y={106} scale={0.62} mood="sad" pose="point" />
      <g className="dsa-f-sweat">
        <path d="M103 70Q106.5 75 103 78Q99.5 75 103 70Z" fill="var(--ill-teal-soft)" />
        <circle cx={102} cy={75.6} r={0.8} fill="var(--ill-teal)" />
      </g>
    </g>
  );
}
