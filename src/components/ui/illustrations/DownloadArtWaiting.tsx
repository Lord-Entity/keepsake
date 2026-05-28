import type { ReactNode } from "react";
import { Mascot, mascotHand } from "./Mascot";

/**
 * Download state art, "waiting" layers (drawn inside the 240 x 120 DownloadStateArt frame,
 * feet on y = 106): queued (Kip holds a ticket in line), fetching (Kip reads the link with a
 * magnifier) and cancelled (a flattened parcel and a sleepy Kip). Styles: download.css, dsa-w-*.
 */

const SQUASH = 0.4;

/**
 * An elliptical orbit: a static scaleY squash on the outside (SVG attr), a CSS-rotating group
 * inside. Children are <OrbitItem>s, which undo the squash and the rotation so they stay upright.
 */
function Orbit({ cx, cy, children }: { cx: number; cy: number; children: ReactNode }) {
  return (
    <g transform={`translate(${cx} ${cy}) scale(1 ${SQUASH})`}>
      <g className="dsa-w-orb">{children}</g>
    </g>
  );
}

function OrbitItem({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className="dsa-w-unorb">
        <g transform={`scale(1 ${1 / SQUASH})`}>{children}</g>
      </g>
    </g>
  );
}

const STROKE = { fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** A small ghost parcel waiting ahead in the queue, centred on x, standing on y = 106. */
function Ghost({ x, cls }: { x: number; cls: string }) {
  return (
    <g transform={`translate(${x} 106)`}>
      <g className={`dsa-w-par ${cls}`}>
        <rect x={-11} y={-18} width={22} height={18} rx={6} fill="var(--ill-paper-2)" />
        <rect x={-13} y={-22} width={26} height={7} rx={3.5} fill="var(--ill-ink-soft)" />
        <rect x={-2} y={-22} width={4} height={7} fill="var(--ill-gold)" />
        <path
          d="M0 -23Q-7 -29 -7 -24.5Q-7 -22.5 0 -23Q7 -22.5 7 -24.5Q7 -29 0 -23Z"
          fill="var(--ill-gold)"
        />
      </g>
    </g>
  );
}

/** Kip waiting in line with a ticket; a clock token circles his head. Uses y 38..107. */
export function QueuedLayer() {
  return (
    <g className="dsa-w-queued">
      <Ghost x={62} cls="dsa-w-par1" />
      <Ghost x={100} cls="dsa-w-par2" />
      {/* Rope barrier */}
      <rect x={187.5} y={84} width={5} height={22} rx={2.5} fill="var(--ill-teal)" />
      <rect x={221.5} y={84} width={5} height={22} rx={2.5} fill="var(--ill-teal)" />
      <circle cx={190} cy={83} r={3.6} fill="var(--ill-gold)" />
      <circle cx={224} cy={83} r={3.6} fill="var(--ill-gold)" />
      <path d="M190 87Q207 99 224 87" stroke="var(--ill-gold)" strokeWidth={2.4} {...STROKE} />
      {/* Kip and the ticket move together */}
      <g className="dsa-w-kipbob">
        <Mascot x={150} y={106} scale={0.62} mood="happy" pose="hold" bob={false} />
        <g transform={`translate(150 98)`}>
          <g className="dsa-w-ticket">
            <path
              d="M-9 -5.5H9V-1.5A1.5 1.5 0 0 0 9 1.5V5.5H-9V1.5A1.5 1.5 0 0 0 -9 -1.5Z"
              fill="var(--ill-paper)"
            />
            <path d="M-6 -2.4H1M-6 1.6H-0.5" stroke="var(--ill-ink-soft)" strokeWidth={1.4} {...STROKE} />
            <circle cx={5} cy={-2.2} r={1.7} fill="var(--ill-gold)" />
          </g>
        </g>
      </g>
      {/* Waiting dots */}
      <circle className="dsa-w-dot dsa-w-dot1" cx={133} cy={47} r={1.8} fill="var(--ill-ink-soft)" />
      <circle className="dsa-w-dot dsa-w-dot2" cx={141} cy={42} r={2.3} fill="var(--ill-ink-soft)" />
      <circle className="dsa-w-dot dsa-w-dot3" cx={150} cy={38} r={2.9} fill="var(--ill-ink-soft)" />
      {/* Clock token circling Kip's head */}
      <Orbit cx={150} cy={58}>
        <OrbitItem x={21} y={-21}>
          <circle r={5.6} fill="var(--ill-gold)" />
          <circle r={3.7} fill="var(--ill-paper)" />
          <path d="M0 -2.3V0H1.9" stroke="var(--ill-ink-soft)" strokeWidth={1.2} {...STROKE} />
        </OrbitItem>
      </Orbit>
    </g>
  );
}

/** Kip reading the link: magnifier on a globe with link / play / note orbiting. Uses y 48..107. */
export function FetchingLayer() {
  return (
    <g className="dsa-w-fetching">
      {/* Radar rings */}
      <circle className="dsa-w-ring dsa-w-ring1" cx={168} cy={74} r={19} stroke="var(--ill-teal-soft)" strokeWidth={1.6} fill="none" />
      <circle className="dsa-w-ring dsa-w-ring2" cx={168} cy={74} r={19} stroke="var(--ill-teal-soft)" strokeWidth={1.6} fill="none" />
      {/* Globe */}
      <circle cx={168} cy={74} r={15} fill="var(--ill-teal)" />
      <ellipse className="dsa-w-mer" cx={168} cy={74} rx={6.5} ry={14.2} stroke="var(--ill-teal-soft)" strokeWidth={1.4} fill="none" />
      <path d="M153.5 74H182.5M156 66.5Q168 70 180 66.5M156 81.5Q168 78 180 81.5" stroke="var(--ill-teal-soft)" strokeWidth={1.4} {...STROKE} />
      <path d="M159 65Q162 61.5 166 60.5" stroke="#fff" strokeWidth={2} opacity={0.28} {...STROKE} />
      {/* Orbit: link, play chip, note */}
      <Orbit cx={168} cy={74}>
        <OrbitItem x={33} y={0}>
          <rect x={-6.5} y={-2.5} width={7.5} height={5} rx={2.5} stroke="var(--ill-teal)" strokeWidth={2} fill="none" />
          <rect x={-1} y={-2.5} width={7.5} height={5} rx={2.5} stroke="var(--ill-gold)" strokeWidth={2} fill="none" />
        </OrbitItem>
        <OrbitItem x={-16.5} y={28.6}>
          <rect x={-6} y={-4.5} width={12} height={9} rx={3} fill="var(--ill-body)" />
          <path d="M-2 -2.5L3 0L-2 2.5Z" fill="var(--ill-paper)" stroke="var(--ill-paper)" strokeWidth={1} strokeLinejoin="round" />
        </OrbitItem>
        <OrbitItem x={-16.5} y={-28.6}>
          <circle cx={-2} cy={3} r={2.6} fill="var(--ill-gold)" />
          <path d="M0.6 3V-5Q5 -4 4.5 -1" stroke="var(--ill-gold)" strokeWidth={2} {...STROKE} />
        </OrbitItem>
      </Orbit>
      {/* Kip and the magnifier move together */}
      <g className="dsa-w-kipbob">
        <Mascot x={78} y={106} scale={0.62} mood="curious" pose="point" bob={false} />
        <g className="dsa-w-lens">
          <path d="M106 86L119 82.5" stroke="var(--ill-ink-soft)" strokeWidth={3.6} {...STROKE} />
          <circle cx={126} cy={80.5} r={8.5} fill="var(--ill-teal-soft)" stroke="var(--ill-gold)" strokeWidth={2.6} />
          <path d="M121 78Q122 74.5 125.5 73.5" stroke="#fff" strokeWidth={1.8} opacity={0.3} {...STROKE} />
        </g>
      </g>
    </g>
  );
}

/** A flattened parcel with its ribbon loose on the floor, a sleepy Kip holding a tag. Uses y 76..107. */
export function CancelledLayer() {
  const [hx, hy] = mascotHand("rest", "right", 84, 106, 0.62);
  return (
    <g className="dsa-w-cancelled">
      {/* Folded, flattened parcel */}
      <rect x={128} y={97} width={44} height={9} rx={4} fill="var(--ill-paper-2)" />
      <path d="M129 98L144 92.5L150 98Z" fill="var(--ill-paper)" />
      <path d="M171 98L156 92.5L150 98Z" fill="var(--ill-paper)" />
      <path d="M150 98V105M136 101.5L142 104.5M164 100.5L159 104" stroke="var(--ill-ink-soft)" strokeWidth={1.4} {...STROKE} />
      {/* Loose ribbon */}
      <path d="M172 103.5Q181 108 190 104" stroke="var(--ill-gold)" strokeWidth={3.4} {...STROKE} />
      <path className="dsa-w-tail" d="M190 104Q197 99.5 202 103.5" stroke="var(--ill-gold)" strokeWidth={3.4} {...STROKE} />
      {/* Kip with the tag dangling from a hand */}
      <g className="dsa-w-kipbob">
        <Mascot x={84} y={106} scale={0.62} mood="sleepy" pose="rest" bob={false} />
        <g className="dsa-w-tag">
          <path d={`M${hx} ${hy}V${hy + 3}`} stroke="var(--ill-ink-soft)" strokeWidth={1.2} {...STROKE} />
          <path
            d={`M${hx - 3} ${hy + 3.5}H${hx + 3}L${hx + 5} ${hy + 6}V${hy + 12}Q${hx + 5} ${hy + 13} ${hx + 4} ${hy + 13}H${hx - 4}Q${hx - 5} ${hy + 13} ${hx - 5} ${hy + 12}V${hy + 6}Z`}
            fill="var(--ill-paper)"
          />
          <path
            d={`M${hx - 2} ${hy + 7}L${hx + 2} ${hy + 11}M${hx + 2} ${hy + 7}L${hx - 2} ${hy + 11}`}
            stroke="var(--ill-ink-soft)"
            strokeWidth={1.4}
            {...STROKE}
          />
        </g>
      </g>
      {/* A leaf drifting round the box */}
      <Orbit cx={150} cy={88}>
        <OrbitItem x={0} y={-34}>
          <ellipse rx={3.4} ry={1.9} transform="rotate(-25)" fill="var(--ill-teal-soft)" />
          <path d="M-2.4 1.2L2.4 -1.2" stroke="var(--ill-teal)" strokeWidth={0.8} {...STROKE} />
        </OrbitItem>
      </Orbit>
    </g>
  );
}
