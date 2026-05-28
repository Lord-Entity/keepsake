import { Scene } from "./Scene";
import "./cooking.css";

/**
 * "Kip is cooking your download": an animated replacement for a fetching spinner.
 * Kip stirs a teal pot on a camp stove while link-shaped ingredients drop in; steam,
 * bubbles and a rattling lid build up per stage; on success the lid pops and a plate
 * with a glowing play badge rises out with a one-time confetti burst; on error the
 * pot tips, the flame goes out and Kip gets a sweatdrop.
 *
 * Everything is always mounted and drawn in absolute 240 x 180 scene coordinates; the
 * state lives only in classes on the root <svg> (ck-s0|1|2, ck-working|success|error),
 * so stage/phase changes glide via CSS transitions with no remount. All motion sits in
 * cooking.css under prefers-reduced-motion: no-preference; otherwise each state is a
 * calm static pose.
 */
export function CookingScene({
  stage = 0,
  phase = "working",
  className = "",
  label,
}: {
  stage?: 0 | 1 | 2;
  phase?: "working" | "success" | "error";
  className?: string;
  label?: string;
}) {
  return (
    <Scene label={label} className={`ck ck-s${stage} ck-${phase} ${className}`}>
      <Steam />
      <Stove />
      <PotBack />
      <Bubbles />
      <Ingredients />
      <Plate />
      <CookKip />
      <PotFront />
      <Lid />
      <Fx />
    </Scene>
  );
}

/** Camp burner base, flames, error smoke puff and error spill puddle. */
function Stove() {
  return (
    <g className="ck-stove">
      {/* spill puddle (error only) */}
      <g className="ck-spill">
        <ellipse cx={196} cy={149} rx={18} ry={2.4} fill="var(--ill-gold)" />
        <ellipse cx={192} cy={148.4} rx={6} ry={0.9} fill="var(--ill-paper)" opacity={0.5} />
      </g>
      {/* flames */}
      <g className="ck-flames">
        <g className="ck-flick ck-fl-a">
          <path d="M134 141 C128 141 128 133 133 126 C133 131 138 131 138 141 Z" fill="var(--ill-gold)" />
          <path d="M134 141 C131.5 141 131.5 137 133.5 133.5 C134.5 136 136 137 136 141 Z" fill="var(--ill-body)" />
        </g>
        <g className="ck-flick ck-fl-b">
          <path d="M158 141 C148 141 149 130 158 120 C167 130 168 141 158 141 Z" fill="var(--ill-gold)" />
          <path d="M158 141 C153 141 153.5 135 158 130 C162.5 135 163 141 158 141 Z" fill="var(--ill-body)" />
        </g>
        <g className="ck-flick ck-fl-c">
          <path d="M182 141 C188 141 188 133 183 126 C183 131 178 131 178 141 Z" fill="var(--ill-gold)" />
          <path d="M182 141 C184.5 141 184.5 137 182.5 133.5 C181.5 136 180 137 180 141 Z" fill="var(--ill-body)" />
        </g>
      </g>
      {/* base */}
      <rect x={132} y={141} width={54} height={9} rx={4} fill="var(--ill-paper-2)" />
      <rect x={138} y={142} width={42} height={2} rx={1} fill="var(--ill-teal-soft)" />
      <circle cx={142} cy={146.8} r={1.3} fill="var(--ill-ink-soft)" />
      <circle cx={148} cy={146.8} r={1.3} fill="var(--ill-ink-soft)" />
      <circle cx={176} cy={146.8} r={1.3} fill="var(--ill-ink-soft)" />
      {/* smoke puff (error only) */}
      <g className="ck-smoke">
        <g className="ck-smoke-in">
          <circle cx={127} cy={131} r={4} fill="var(--ill-paper-2)" />
          <circle cx={131} cy={126} r={3.2} fill="var(--ill-ink-soft)" opacity={0.35} />
          <circle cx={125} cy={124} r={2.4} fill="var(--ill-paper-2)" />
        </g>
      </g>
    </g>
  );
}

/** Dark pot opening with the gold soup surface (behind everything else on the pot). */
function PotBack() {
  return (
    <g className="ck-tip">
      <ellipse cx={158} cy={109} rx={24} ry={3.5} fill="var(--ill-face)" />
      <g className="ck-soup">
        <ellipse cx={158} cy={108} rx={21} ry={2.2} fill="var(--ill-gold)" />
        <ellipse cx={151} cy={107.2} rx={6} ry={0.8} fill="var(--ill-paper)" opacity={0.45} />
      </g>
    </g>
  );
}

/** Teal pot body, rim, handles, shine and a tiny gold heart label. */
function PotFront() {
  return (
    <g className="ck-tip">
      <rect x={126} y={113} width={8} height={6} rx={3} fill="var(--ill-teal-soft)" />
      <rect x={182} y={113} width={8} height={6} rx={3} fill="var(--ill-teal-soft)" />
      <path d="M136 112 H180 V132 Q180 140 172 140 H144 Q136 140 136 132 Z" fill="var(--ill-teal)" />
      <path
        d="M132 109 Q132 107 134 107 L138 107 A24 3.5 0 0 0 178 107 L182 107 Q184 107 184 109 V111.5 Q184 113.5 182 113.5 H134 Q132 113.5 132 111.5 Z"
        fill="var(--ill-teal-soft)"
      />
      <rect x={141} y={117} width={3} height={15} rx={1.5} fill="#fff" opacity={0.28} />
      <circle cx={158} cy={126.5} r={7} fill="var(--ill-paper-2)" opacity={0.9} />
      <path
        d="M158 130.5 C153 127 153.5 123 156 123 C157 123 158 123.8 158 124.5 C158 123.8 159 123 160 123 C162.5 123 163 127 158 130.5 Z"
        fill="var(--ill-gold)"
      />
    </g>
  );
}

/** Domed teal lid with rim band, gold knob and clatter ticks; rattles when almost done. */
function Lid() {
  return (
    <g className="ck-lid">
      <g className="ck-lid-rattle">
        <path d="M134 108 C134 90 182 90 182 108 Z" fill="var(--ill-teal)" />
        <rect x={132} y={106} width={52} height={3.5} rx={1.75} fill="var(--ill-teal-soft)" />
        <path d="M141 103 C142 98 147 95.5 152 95" fill="none" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" opacity={0.28} />
        <rect x={156.5} y={96} width={3} height={3} rx={1} fill="var(--ill-teal-soft)" />
        <circle cx={158} cy={95.5} r={3.2} fill="var(--ill-gold)" />
      </g>
      <path className="ck-tick ck-tick-l" d="M130 101 L127 98 M129 105 L125 105" fill="none" stroke="var(--ill-ink-soft)" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
      <path className="ck-tick ck-tick-r" d="M186 101 L189 98 M187 105 L191 105" fill="none" stroke="var(--ill-ink-soft)" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

/** Steam: three S-curl strokes plus two lid-edge puffs (s2). */
function Steam() {
  return (
    <g className="ck-steam" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path
        className="ck-curl ck-curl1"
        d="M142 98 Q136 91 142 85 Q148 79 142 74"
        stroke="var(--ill-ink-soft)"
        strokeWidth={3}
      />
      <path
        className="ck-curl ck-curl2"
        d="M152 98 Q146 91 152 85 Q158 79 152 74"
        stroke="var(--ill-ink-soft)"
        strokeWidth={3}
      />
      <path
        className="ck-curl ck-curl3"
        d="M162 98 Q156 91 162 85 Q168 79 162 74"
        stroke="var(--ill-ink-soft)"
        strokeWidth={3}
      />
      <circle className="ck-puff ck-puff1" cx={134} cy={106} r={3} fill="var(--ill-paper)" />
      <circle className="ck-puff ck-puff2" cx={182} cy={106} r={3} fill="var(--ill-paper)" />
    </g>
  );
}

/** Bubbles: small paper/gold circles popping on the soup surface (s1, s2). */
function Bubbles() {
  return (
    <g className="ck-tip">
      <circle className="ck-bub ck-bub1" cx={146} cy={108} r={2.2} fill="var(--ill-paper)" />
      <circle className="ck-bub ck-bub2" cx={152} cy={108.5} r={1.8} fill="var(--ill-gold)" />
      <circle className="ck-bub ck-bub3" cx={158} cy={108} r={2.5} fill="var(--ill-paper)" />
      <circle className="ck-bub ck-bub4" cx={165} cy={108.5} r={2} fill="var(--ill-gold)" />
      <circle className="ck-bub ck-bub5" cx={171} cy={108} r={1.6} fill="var(--ill-paper)" />
    </g>
  );
}

/** Ingredients: chain link, play chip, film frame, music note, each at its landing spot. */
function Ingredients() {
  return (
    <g className="ck-tip">
      <g className="ck-ing ck-ing1">
        <rect x={138} y={100} width={8} height={6} rx={3} fill="none" stroke="var(--ill-teal)" strokeWidth={2.5} />
        <rect x={142} y={102} width={8} height={6} rx={3} fill="none" stroke="var(--ill-gold)" strokeWidth={2.5} />
      </g>
      <g className="ck-ing ck-ing2">
        <rect x={138} y={99} width={12} height={9} rx={3} fill="var(--ill-body)" />
        <path d="M142.5 101 L147.5 103.5 L142.5 106 Z" fill="var(--ill-paper)" strokeLinejoin="round" />
      </g>
      <g className="ck-ing ck-ing3">
        <rect x={139} y={98} width={11} height={11} rx={2} fill="var(--ill-teal)" />
        <rect x={142} y={99} width={5} height={9} rx={1} fill="var(--ill-teal-soft)" />
        <circle cx={140.6} cy={100.5} r={0.9} fill="var(--ill-paper)" />
        <circle cx={140.6} cy={106.5} r={0.9} fill="var(--ill-paper)" />
        <circle cx={148.4} cy={100.5} r={0.9} fill="var(--ill-paper)" />
        <circle cx={148.4} cy={106.5} r={0.9} fill="var(--ill-paper)" />
      </g>
      <g className="ck-ing ck-ing4">
        <circle cx={143} cy={107} r={2.6} fill="var(--ill-gold)" />
        <path
          d="M145.4 107 V98 Q149.5 99 149 102.5"
          fill="none"
          stroke="var(--ill-gold)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </g>
  );
}

/** Fx: stage-2 twinkling sparkles and the one-shot success confetti (all pieces start at 158,70). */
function Fx() {
  return (
    <g className="ck-fx">
      <path
        className="ck-spark ck-spark1"
        d="M124 80 Q124 86 130 86 Q124 86 124 92 Q124 86 118 86 Q124 86 124 80 Z"
        fill="var(--ill-gold)"
      />
      <path
        className="ck-spark ck-spark2"
        d="M194 87 Q194 92 199 92 Q194 92 194 97 Q194 92 189 92 Q194 92 194 87 Z"
        fill="var(--ill-teal)"
      />
      <path
        className="ck-spark ck-spark3"
        d="M186 57 Q186 62 191 62 Q186 62 186 67 Q186 62 181 62 Q186 62 186 57 Z"
        fill="var(--ill-gold)"
      />
      <rect className="ck-cf ck-cf1" x={156.5} y={67.5} width={3} height={5} rx={1} fill="var(--ill-body)" />
      <circle className="ck-cf ck-cf2" cx={158} cy={70} r={2} fill="var(--ill-gold)" />
      <rect className="ck-cf ck-cf3" x={156.5} y={67.5} width={3} height={5} rx={1} fill="var(--ill-teal)" />
      <circle className="ck-cf ck-cf4" cx={158} cy={70} r={2} fill="var(--ill-cheek)" />
      <rect className="ck-cf ck-cf5" x={156.5} y={67.5} width={3} height={5} rx={1} fill="var(--ill-gold)" />
      <circle className="ck-cf ck-cf6" cx={158} cy={70} r={2} fill="var(--ill-teal-soft)" />
      <rect className="ck-cf ck-cf7" x={156.5} y={67.5} width={3} height={5} rx={1} fill="var(--ill-cheek)" />
      <circle className="ck-cf ck-cf8" cx={158} cy={70} r={2} fill="var(--ill-body)" />
      <rect className="ck-cf ck-cf9" x={156.5} y={67.5} width={3} height={5} rx={1} fill="var(--ill-teal-soft)" />
      <circle className="ck-cf ck-cf10" cx={158} cy={70} r={2} fill="var(--ill-teal)" />
      <rect className="ck-cf ck-cf11" x={156.5} y={67.5} width={3} height={5} rx={1} fill="var(--ill-body)" />
      <circle className="ck-cf ck-cf12" cx={158} cy={70} r={2} fill="var(--ill-gold)" />
    </g>
  );
}

const FACE = "var(--ill-face)";

/** Kip the cook: Mascot geometry (feet at 88,150) with arms, stirring spoon, four faces, a tiny toque and a sweatdrop. */
function CookKip() {
  return (
    <g className="ck-kip">
      <g className="ck-kip-bob">
        {/* Feet */}
        <ellipse cx={76} cy={147} rx={8} ry={4.5} fill="var(--ill-body-shade)" />
        <ellipse cx={100} cy={147} rx={8} ry={4.5} fill="var(--ill-body-shade)" />
        {/* Left arm */}
        <g className="ck-arm-l">
          <path d="M65 122L57 135" stroke="var(--ill-body-shade)" strokeWidth={7} strokeLinecap="round" fill="none" />
        </g>
        {/* Box body, shine and keepsake tag */}
        <rect x={62} y={102} width={52} height={44} rx={14} fill="var(--ill-body)" />
        <rect x={67} y={107} width={5} height={10} rx={2.5} fill="#fff" opacity={0.28} />
        <rect x={76} y={133} width={24} height={8} rx={4} fill="var(--ill-belly)" />
        {/* Cheeks */}
        <ellipse cx={72} cy={125} rx={4} ry={2.5} fill="var(--ill-cheek)" />
        <ellipse cx={104} cy={125} rx={4} ry={2.5} fill="var(--ill-cheek)" />
        {/* Happy: eyes glance toward the pot */}
        <g className="ck-face-happy">
          <g className="ck-blink">
            <ellipse cx={81} cy={118} rx={3.2} ry={3.8} fill={FACE} />
            <circle cx={82} cy={116.6} r={1.1} fill="#fff" />
            <ellipse cx={99} cy={118} rx={3.2} ry={3.8} fill={FACE} />
            <circle cx={100} cy={116.6} r={1.1} fill="#fff" />
          </g>
          <path d="M85 125Q89 129 93 125" stroke={FACE} strokeWidth={2.5} strokeLinecap="round" fill="none" />
        </g>
        {/* Curious: one raised brow, little "ooh" */}
        <g className="ck-face-curious">
          <ellipse cx={79} cy={118} rx={3.2} ry={3.8} fill={FACE} />
          <circle cx={80} cy={116.6} r={1.1} fill="#fff" />
          <ellipse cx={97} cy={118} rx={3.2} ry={3.8} fill={FACE} />
          <circle cx={98} cy={116.6} r={1.1} fill="#fff" />
          <path d="M93 110.5Q97 107.5 101 110" stroke={FACE} strokeWidth={2} strokeLinecap="round" fill="none" />
          <circle cx={88} cy={126} r={2.2} fill={FACE} />
        </g>
        {/* Joy: arc eyes, open mouth */}
        <g className="ck-face-joy">
          <path d="M75.5 119Q79 114.5 82.5 119" stroke={FACE} strokeWidth={2.5} strokeLinecap="round" fill="none" />
          <path d="M93.5 119Q97 114.5 100.5 119" stroke={FACE} strokeWidth={2.5} strokeLinecap="round" fill="none" />
          <path d="M83 124Q88 133 93 124Z" fill={FACE} />
        </g>
        {/* Sad: worried brows, small frown */}
        <g className="ck-face-sad">
          <ellipse cx={79} cy={118} rx={3.2} ry={3.8} fill={FACE} />
          <circle cx={80} cy={116.6} r={1.1} fill="#fff" />
          <ellipse cx={97} cy={118} rx={3.2} ry={3.8} fill={FACE} />
          <circle cx={98} cy={116.6} r={1.1} fill="#fff" />
          <path d="M75 112L82 110" stroke={FACE} strokeWidth={2} strokeLinecap="round" fill="none" />
          <path d="M101 112L94 110" stroke={FACE} strokeWidth={2} strokeLinecap="round" fill="none" />
          <path d="M84 128Q88 124 92 128" stroke={FACE} strokeWidth={2.5} strokeLinecap="round" fill="none" />
        </g>
        {/* Right arm with the stirring spoon */}
        <g className="ck-arm-r">
          <g className="ck-stir">
            <path d="M111 122L124 104" stroke="var(--ill-body-shade)" strokeWidth={7} strokeLinecap="round" fill="none" />
            <g className="ck-spoon">
              <path d="M120 98L148 122" stroke="var(--ill-gold)" strokeWidth={3.5} strokeLinecap="round" fill="none" />
              <ellipse cx={150} cy={124} rx={5} ry={3} fill="var(--ill-gold)" />
            </g>
          </g>
        </g>
        {/* Lid hat with gold ribbon and bow */}
        <rect x={58} y={92} width={60} height={13} rx={6} fill="var(--ill-body-shade)" />
        <rect x={84} y={92} width={8} height={13} fill="var(--ill-gold)" />
        <ellipse cx={81.5} cy={88} rx={6.5} ry={4} transform="rotate(-20 81.5 88)" fill="var(--ill-gold)" />
        <ellipse cx={94.5} cy={88} rx={6.5} ry={4} transform="rotate(20 94.5 88)" fill="var(--ill-gold)" />
        <circle cx={88} cy={90} r={3} fill="var(--ill-body-shade)" />
        {/* Tiny chef toque, tilted on the right of the lid */}
        <g transform="rotate(14 108 93)">
          <circle cx={104} cy={86} r={4} fill="var(--ill-paper)" />
          <circle cx={110} cy={84} r={4.5} fill="var(--ill-paper)" />
          <circle cx={115} cy={87.5} r={3.5} fill="var(--ill-paper)" />
          <rect x={102} y={86} width={15} height={7} rx={2.5} fill="var(--ill-paper)" />
        </g>
        {/* Sweatdrop (error only) */}
        <g className="ck-sweat">
          <path d="M110 105Q114.5 111 110 114Q105.5 111 110 105Z" fill="var(--ill-teal-soft)" />
          <circle cx={108.8} cy={110.6} r={1} fill="var(--ill-teal)" />
        </g>
      </g>
    </g>
  );
}

/** The success plate: glow, plate, play badge and a little gold check bubble, rising out of the pot. */
function Plate() {
  return (
    <g className="ck-tip">
      <g className="ck-plate">
        <circle className="ck-glow" cx={158} cy={70} r={30} fill="var(--ill-gold)" opacity={0.3} />
        <ellipse cx={158} cy={80} rx={26} ry={6} fill="var(--ill-paper)" />
        <ellipse cx={158} cy={79.5} rx={20} ry={4} fill="var(--ill-paper-2)" />
        <circle cx={158} cy={66} r={12} fill="var(--ill-body)" />
        <path d="M154.5 61L154.5 71L163.5 66Z" fill="var(--ill-paper)" stroke="var(--ill-paper)" strokeWidth={2} strokeLinejoin="round" />
        <circle cx={168} cy={57} r={5} fill="var(--ill-gold)" />
        <path d="M165.5 57L167.4 59L170.6 55" stroke="var(--ill-paper)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </g>
    </g>
  );
}

