import type { SVGProps } from "react";

/**
 * Section icons for topics the shared `Icon` semantic set doesn't cover
 * (see `astryx docs icons`). Same pattern as `dashboard/glyphs.tsx`: a plain
 * outline SVG component, sized and colored by `Icon` like any other.
 */

export function UserGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c1.4-3.6 4.4-5.5 7.5-5.5s6.1 1.9 7.5 5.5" strokeLinecap="round" />
    </svg>
  );
}

export function ShieldGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M12 3.5 5 6v5.5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-2.5Z" strokeLinejoin="round" />
      <path d="M9 12.2 11.2 14.4 15.3 10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PaletteGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M12 3.5c-4.7 0-8.5 3.6-8.5 8 0 3.2 2.4 4.3 4 4.3.9 0 1.3-.5 1.3-1.1 0-.6-.4-1-.4-1.8 0-1.2 1-2.1 2.6-2.1h2c2.8 0 5-1.8 5-4.6 0-1.5-2.6-2.7-6-2.7Z" strokeLinejoin="round" />
      <circle cx="7.2" cy="11" r="1" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="7.3" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.3" cy="7" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CloudGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path
        d="M7 18.5a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17.2 9.4 4.25 4.25 0 0 1 16.75 18.5H7Z"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Settings → AI: a spark, for the model that reads a bookmark and decides. */
export function SparkGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M10.5 4q1.6 3.9 5.5 5.5-3.9 1.6-5.5 5.5Q8.9 11.1 5 9.5 8.9 7.9 10.5 4Z" strokeLinejoin="round" />
      <path d="M18 14q.9 2.1 3 3-2.1.9-3 3-.9-2.1-3-3 2.1-.9 3-3Z" strokeLinejoin="round" />
    </svg>
  );
}

export function DatabaseGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <ellipse cx="12" cy="6" rx="7" ry="2.5" />
      <path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" strokeLinecap="round" />
      <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" strokeLinecap="round" />
    </svg>
  );
}

/** Active-sessions row icon for a `device: "desktop"` session (see describe-session.ts). */
export function DesktopGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <rect x="3.5" y="4.5" width="17" height="11" rx="1.5" strokeLinejoin="round" />
      <path d="M9 19.5h6M12 15.5v4" strokeLinecap="round" />
    </svg>
  );
}

/** Active-sessions row icon for a `device: "mobile"` session (see describe-session.ts). */
export function MobileGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <rect x="7" y="2.5" width="10" height="19" rx="2" strokeLinejoin="round" />
      <path d="M11 18.2h2" strokeLinecap="round" />
    </svg>
  );
}

/** Active-sessions row icon for a `device: "tablet"` session (see describe-session.ts). */
export function TabletGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <rect x="4.5" y="2.5" width="15" height="19" rx="2" strokeLinejoin="round" />
      <path d="M11.2 18.2h1.6" strokeLinecap="round" />
    </svg>
  );
}
