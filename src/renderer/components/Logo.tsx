import { useId } from 'react';

/**
 * The drift logo, redrawn as vector artwork from the supplied image (no background):
 * four curved blades turning around a four-pointed star of negative space, plus the
 * lowercase "drift" wordmark. One blade is drawn; the others are 90° rotations.
 */
const BLADE = 'M9 -242C13 -180 10 -125 -8 -88C-30 -45 -85 -27 -149 -22C-110 -40 -80 -70 -60 -110C-35 -160 -5 -230 9 -242Z';

export function DriftMark({ size = 28, gradient = false, className, title }: { size?: number; gradient?: boolean; className?: string; title?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="-250 -250 500 500" width={size} height={size} className={className} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      {gradient && (
        <defs>
          <linearGradient id={`drift-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a78bfa" />
            <stop offset="0.55" stopColor="#7c5cff" />
            <stop offset="1" stopColor="#ec4899" />
          </linearGradient>
        </defs>
      )}
      <g fill={gradient ? `url(#drift-${id})` : 'currentColor'}>
        {[0, 90, 180, 270].map((r) => (
          <path key={r} d={BLADE} transform={`rotate(${r})`} />
        ))}
      </g>
    </svg>
  );
}
