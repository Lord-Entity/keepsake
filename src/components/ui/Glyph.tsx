import { Icon, type IconName } from "./Icon";

/**
 * Layered hover glyph. A relative container holds four separate, absolutely
 * positioned SVG parts plus the core icon; each part animates on its own when the
 * nearest `.glyph-host` ancestor is hovered or focused (CSS in theme.css):
 *   halo  - organic blob behind the icon, turns and swells
 *   orbit - dashed ring, spins in from nothing
 *   spark - four-point star, flies out to the top-right corner
 *   dot   - small bead, drifts in to the bottom-left corner
 * Hosts usually also carry `icon-host` so the core icon plays its own pose.
 */
export function Glyph({
  icon,
  size = 18,
  box = 36,
  on,
  className = "",
  sparks = true,
}: {
  icon: IconName;
  size?: number;
  box?: number;
  /** Selected/active: the halo stays filled. */
  on?: boolean;
  className?: string;
  /** Turn off the orbit, spark and dot (dense lists). */
  sparks?: boolean;
}) {
  const s = Math.max(6, Math.round(box * 0.26));
  return (
    <span
      className={`glyph relative inline-grid shrink-0 place-items-center ${className}`}
      style={{ width: box, height: box }}
      data-on={on ? "true" : undefined}
      aria-hidden="true"
    >
      <svg className="glyph-halo absolute inset-0 size-full" viewBox="0 0 40 40">
        <path
          fill="currentColor"
          d="M21 3.2c8.6.4 15.6 5.9 15.6 15.2 0 9.8-7.4 18.4-17.6 18.4C9.8 36.8 3.4 30.6 3.4 21.9 3.4 11.4 11 2.7 21 3.2z"
        />
      </svg>
      {sparks && (
        <>
          <svg className="glyph-orbit absolute -inset-[3px]" viewBox="0 0 46 46" style={{ width: box + 6, height: box + 6 }}>
            <circle cx="23" cy="23" r="21" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 5" strokeLinecap="round" />
          </svg>
          <svg className="glyph-spark absolute -top-0.5 -right-0.5" viewBox="0 0 10 10" style={{ width: s, height: s }}>
            <path fill="currentColor" d="M5 0 6 4 10 5 6 6 5 10 4 6 0 5 4 4z" />
          </svg>
          <svg className="glyph-dot absolute bottom-0.5 left-0" viewBox="0 0 6 6" style={{ width: s * 0.55, height: s * 0.55 }}>
            <circle cx="3" cy="3" r="3" fill="currentColor" />
          </svg>
        </>
      )}
      <span className="glyph-core relative grid place-items-center">
        <Icon name={icon} size={size} animated />
      </span>
    </span>
  );
}
