import "./illustrations.css";

/**
 * Kip, the Keepsake mascot: a little keepsake box with a gold-ribboned lid for a hat,
 * stubby arms and feet. Drawn in its own coordinates with the feet centre at (0, 0)
 * and the top of the bow near y = -66, so a scene places it with x / y / scale.
 *
 * Layering rule: the placement transform lives on the outer <g>; CSS idle motion
 * (ill-bob, ill-blink, ill-wave) lives on inner groups, because a CSS transform
 * would otherwise replace the SVG transform attribute.
 */

export type MascotMood = "happy" | "joy" | "curious" | "sleepy" | "sad" | "wink";
export type MascotPose = "rest" | "wave" | "up" | "hold" | "point";

type Pt = readonly [number, number];

const SHOULDER_L: Pt = [-23, -28];
const SHOULDER_R: Pt = [23, -28];

/** Hand positions per pose, in mascot coordinates: [left, right]. */
export const MASCOT_HANDS: Record<MascotPose, readonly [Pt, Pt]> = {
  rest: [
    [-31, -15],
    [31, -15],
  ],
  wave: [
    [-31, -15],
    [36, -50],
  ],
  up: [
    [-34, -50],
    [34, -50],
  ],
  hold: [
    [-12, -15],
    [12, -15],
  ],
  point: [
    [-31, -15],
    [45, -32],
  ],
};

/** Scene coordinates of a mascot hand, for placing a held prop. */
export function mascotHand(pose: MascotPose, side: "left" | "right", x: number, y: number, scale = 1, flip = false): Pt {
  const [hx, hy] = MASCOT_HANDS[pose][side === "left" ? 0 : 1];
  return [x + (flip ? -hx : hx) * scale, y + hy * scale];
}

const FACE = "var(--ill-face)";

function Arm({ from, to, wave }: { from: Pt; to: Pt; wave?: boolean }) {
  return (
    <path
      className={wave ? "ill-wave" : undefined}
      d={`M${from[0]} ${from[1]}L${to[0]} ${to[1]}`}
      stroke="var(--ill-body-shade)"
      strokeWidth={7}
      strokeLinecap="round"
      fill="none"
    />
  );
}

function DotEye({ x }: { x: number }) {
  return (
    <>
      <ellipse cx={x} cy={-32} rx={3.2} ry={3.8} fill={FACE} />
      <circle cx={x + 1} cy={-33.4} r={1.1} fill="#fff" />
    </>
  );
}

function ArcEye({ x, down }: { x: number; down?: boolean }) {
  const d = down ? `M${x - 3.5} -32Q${x} -29 ${x + 3.5} -32` : `M${x - 3.5} -31Q${x} -35.5 ${x + 3.5} -31`;
  return <path d={d} stroke={FACE} strokeWidth={2.5} strokeLinecap="round" fill="none" />;
}

function Face({ mood, blink }: { mood: MascotMood; blink: boolean }) {
  const dots = mood === "happy" || mood === "curious" || mood === "sad";
  const line = { stroke: FACE, strokeWidth: 2.5, strokeLinecap: "round" as const, fill: "none" };
  return (
    <g>
      {dots && (
        <g className={blink ? "ill-blink" : undefined}>
          <DotEye x={-9} />
          <DotEye x={9} />
        </g>
      )}
      {mood === "joy" && (
        <>
          <ArcEye x={-9} />
          <ArcEye x={9} />
        </>
      )}
      {mood === "sleepy" && (
        <>
          <ArcEye x={-9} down />
          <ArcEye x={9} down />
        </>
      )}
      {mood === "wink" && (
        <>
          <g className={blink ? "ill-blink" : undefined}>
            <DotEye x={-9} />
          </g>
          <ArcEye x={9} />
        </>
      )}
      {/* Cheeks */}
      <ellipse cx={-16} cy={-25} rx={4} ry={2.5} fill="var(--ill-cheek)" />
      <ellipse cx={16} cy={-25} rx={4} ry={2.5} fill="var(--ill-cheek)" />
      {/* Brows for the expressive moods */}
      {mood === "curious" && <path d="M5 -39.5Q9 -42.5 13 -40" {...line} strokeWidth={2} />}
      {mood === "sad" && (
        <>
          <path d="M-13 -38L-6 -40" {...line} strokeWidth={2} />
          <path d="M13 -38L6 -40" {...line} strokeWidth={2} />
        </>
      )}
      {/* Mouth */}
      {(mood === "happy" || mood === "wink") && <path d="M-4 -25Q0 -21 4 -25" {...line} />}
      {mood === "joy" && <path d="M-5 -26Q0 -17 5 -26Z" fill={FACE} />}
      {mood === "curious" && <circle cx={0} cy={-24} r={2.2} fill={FACE} />}
      {mood === "sleepy" && <path d="M-2.5 -24Q0 -22.5 2.5 -24" {...line} strokeWidth={2} />}
      {mood === "sad" && <path d="M-4 -22Q0 -26 4 -22" {...line} />}
    </g>
  );
}

export function Mascot({
  x = 120,
  y = 150,
  scale = 1,
  mood = "happy",
  pose = "rest",
  lid = "on",
  flip = false,
  bob = true,
  blink = true,
}: {
  /** Feet centre in scene coordinates. */
  x?: number;
  y?: number;
  scale?: number;
  mood?: MascotMood;
  pose?: MascotPose;
  /** "tip" lifts and tilts the lid, as if Kip is peeking out of itself. */
  lid?: "on" | "tip";
  /** Mirror horizontally (the right hand becomes the left). */
  flip?: boolean;
  bob?: boolean;
  blink?: boolean;
}) {
  const [handL, handR] = MASCOT_HANDS[pose];
  const front = pose === "hold";
  const arms = (
    <>
      <Arm from={SHOULDER_L} to={handL} />
      <Arm from={SHOULDER_R} to={handR} wave={pose === "wave"} />
    </>
  );
  return (
    <g transform={`translate(${x} ${y}) scale(${flip ? -scale : scale} ${scale})`}>
      <g className={bob ? "ill-bob" : undefined}>
        {/* Feet */}
        <ellipse cx={-12} cy={-3} rx={8} ry={4.5} fill="var(--ill-body-shade)" />
        <ellipse cx={12} cy={-3} rx={8} ry={4.5} fill="var(--ill-body-shade)" />
        {!front && arms}
        {/* Box body, shine and keepsake tag */}
        <rect x={-26} y={-48} width={52} height={44} rx={14} fill="var(--ill-body)" />
        <rect x={-21} y={-43} width={5} height={10} rx={2.5} fill="#fff" opacity={0.28} />
        <rect x={-12} y={-17} width={24} height={8} rx={4} fill="var(--ill-belly)" />
        <Face mood={mood} blink={blink} />
        {front && arms}
        {/* Lid with a gold ribbon and bow */}
        <g transform={lid === "tip" ? "translate(-3 -7) rotate(-12)" : undefined}>
          <rect x={-30} y={-58} width={60} height={13} rx={6} fill="var(--ill-body-shade)" />
          <rect x={-4} y={-58} width={8} height={13} fill="var(--ill-gold)" />
          <ellipse cx={-6.5} cy={-62} rx={6.5} ry={4} transform="rotate(-20 -6.5 -62)" fill="var(--ill-gold)" />
          <ellipse cx={6.5} cy={-62} rx={6.5} ry={4} transform="rotate(20 6.5 -62)" fill="var(--ill-gold)" />
          <circle cx={0} cy={-60} r={3} fill="var(--ill-body-shade)" />
        </g>
      </g>
    </g>
  );
}
