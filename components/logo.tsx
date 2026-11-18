// SiteSync mark: a two-arrow sync ring around a small bolt (same geometry as
// the PWA icons in scripts/gen-icons.ts). Neutral, fictional: no real brand.
import { cn } from "@/lib/utils";

const R = 30;
const W = 6.5;
const ARCS: [number, number][] = [
  [-150, -5],
  [30, 175],
];
const pt = (deg: number, r = R) => [50 + r * Math.cos((deg * Math.PI) / 180), 50 + r * Math.sin((deg * Math.PI) / 180)] as const;
const arc = ([s, e]: [number, number]) => {
  const [x1, y1] = pt(s);
  const [x2, y2] = pt(e);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
};
const head = (deg: number) => {
  const a = (deg * Math.PI) / 180;
  const [cx, cy] = pt(deg);
  const [tx, ty, nx, ny] = [-Math.sin(a), Math.cos(a), Math.cos(a), Math.sin(a)];
  const half = W * 1.25;
  const len = W * 1.9;
  return [
    [cx + nx * half, cy + ny * half],
    [cx + tx * len, cy + ty * len],
    [cx - nx * half, cy - ny * half],
  ]
    .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" ");
};
const BOLT = [
  [58, 8],
  [24, 56],
  [47, 56],
  [40, 92],
  [76, 42],
  [53, 42],
  [62, 8],
]
  .map(([x, y]) => `${(50 + (x - 50) * 0.36).toFixed(2)},${(50 + (y - 50) * 0.36).toFixed(2)}`)
  .join(" ");

export function LogoMark({ className, tile = true }: { className?: string; tile?: boolean }) {
  return (
    <svg viewBox="0 0 100 100" className={cn("size-7 shrink-0", className)} aria-hidden="true">
      {tile && <rect width="100" height="100" rx="20" fill="#0f172a" />}
      <g fill="none" stroke={tile ? "#e2e8f0" : "currentColor"} strokeWidth={W}>
        {ARCS.map((a) => (
          <path key={a[0]} d={arc(a)} />
        ))}
      </g>
      {ARCS.map(([, e]) => (
        <polygon key={e} points={head(e)} fill={tile ? "#e2e8f0" : "currentColor"} />
      ))}
      <polygon points={BOLT} fill="#fbbf24" />
    </svg>
  );
}

/** Mark + "SiteSync" wordmark. */
export function Wordmark({ className, sub }: { className?: string; sub?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark />
      <span className="leading-tight">
        <span className="block font-semibold tracking-tight">SiteSync</span>
        {sub && <span className="block text-xs font-normal text-muted-foreground">{sub}</span>}
      </span>
    </span>
  );
}
