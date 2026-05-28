import type { ReactNode } from "react";
import "./CardChipGlyph.css";

export type CardChipGlyphName = "best" | "1080" | "720" | "audio" | "youtube" | "tiktok" | "instagram" | "more";

const GOLD = "var(--ill-gold)";
const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** 4-point sparkle centred on (x, y), sized by s. Outer g places, inner path animates. */
function Sparkle({ x, y, s, cls }: { x: number; y: number; s: number; cls: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path
        className={`cchip-part ${cls}`}
        d={`M0 ${-s} Q0 0 ${s} 0 Q0 0 0 ${s} Q0 0 ${-s} 0 Q0 0 0 ${-s}Z`}
        fill={GOLD}
      />
    </g>
  );
}

function Screen() {
  return (
    <>
      <rect x="2" y="4" width="16" height="11" rx="2.5" {...STROKE} />
      <path d="M7 17.5h6" {...STROKE} />
    </>
  );
}

function glyph(name: CardChipGlyphName): ReactNode {
  switch (name) {
    case "best":
      return (
        <>
          <path d="M3 16 L3.8 7.5 L7.8 11 L10 5.5 L12.2 11 L16.2 7.5 L17 16 Z" fill="currentColor" />
          <circle cx="10" cy="12.6" r="1.4" fill={GOLD} />
          <Sparkle x={16.5} y={3.5} s={3} cls="cchip-spark" />
        </>
      );
    case "1080":
      return (
        <>
          <Screen />
          <path d="M6 8.2h8M6 11.2h5" {...STROKE} />
          <Sparkle x={17} y={3} s={2.8} cls="cchip-pop" />
        </>
      );
    case "720":
      return (
        <>
          <Screen />
          <g className="cchip-part cchip-nudge">
            <path d="M8.6 7.3 L12.6 9.5 L8.6 11.7 Z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
          </g>
        </>
      );
    case "audio":
      return (
        <>
          <g className="cchip-part cchip-bob-a">
            <circle cx="5.5" cy="15.5" r="2.2" fill="currentColor" />
            <path d="M7.7 15.5V5.5l5 1.5" {...STROKE} />
          </g>
          <g className="cchip-part cchip-bob-b">
            <circle cx="13.5" cy="14" r="2.2" fill="currentColor" />
            <path d="M15.7 14V4" {...STROKE} />
          </g>
        </>
      );
    case "youtube":
      return (
        <>
          <rect x="1.8" y="4.5" width="16.4" height="11" rx="3.4" {...STROKE} />
          <path className="cchip-part cchip-pulse" d="M8.4 7.6 L12.6 10 L8.4 12.4 Z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
        </>
      );
    case "tiktok":
      return (
        <g className="cchip-part cchip-wiggle">
          <circle cx="7.2" cy="15.2" r="2.6" fill="currentColor" />
          <path d="M9.8 15.2V3.5c.4 2.6 2.2 4 5 4.2" {...STROKE} />
          <circle cx="15.6" cy="12.6" r="1" fill={GOLD} />
        </g>
      );
    case "instagram":
      return (
        <>
          <rect x="2.5" y="2.5" width="15" height="15" rx="4.5" {...STROKE} />
          <circle cx="10" cy="10" r="3.4" {...STROKE} />
          <circle className="cchip-part cchip-blink" cx="10" cy="10" r="1.2" fill="currentColor" />
          <circle className="cchip-part cchip-flash" cx="14.6" cy="5.4" r="1.1" fill={GOLD} />
        </>
      );
    case "more":
      return (
        <>
          <circle cx="10" cy="10" r="7" {...STROKE} />
          <path d="M3 10h14" {...STROKE} strokeWidth={1.2} />
          <ellipse className="cchip-part cchip-meridian" cx="10" cy="10" rx="3.2" ry="7" {...STROKE} strokeWidth={1.2} />
          <g className="cchip-part cchip-orbit">
            <circle cx="10" cy="10" r="9.5" fill="none" stroke="none" />
            <circle cx="10" cy="0.5" r="1.3" fill={GOLD} />
          </g>
        </>
      );
  }
}

/** Tiny animated chip glyph; paints with currentColor plus gold accents. */
export function CardChipGlyph({
  name,
  active = false,
  className = "",
}: {
  name: CardChipGlyphName;
  active?: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      className={`cchip ${active ? "cchip-on" : ""} ${className}`}
      style={{ overflow: "visible" }}
    >
      {glyph(name)}
    </svg>
  );
}
