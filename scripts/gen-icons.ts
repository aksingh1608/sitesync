// Generates the PWA icons with no image dependencies (rasterize shapes with
// supersampling, encode PNG with zlib). The mark: a two-arrow sync ring (the
// app's promise: nothing is lost, everything syncs) around a small bolt
// (electrical work), on a slate tile. Neutral on purpose: no real brand.
// The same geometry is drawn as SVG in components/logo.tsx.
// Run: pnpm icons
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [15, 23, 42]; // slate-900
const RING = [226, 232, 240]; // slate-200
const BOLT_C = [251, 191, 36]; // amber-400

// Bolt polygon in a 0..1 unit square, drawn small in the middle of the ring.
const BOLT_UNIT: [number, number][] = [
  [0.58, 0.08],
  [0.24, 0.56],
  [0.47, 0.56],
  [0.4, 0.92],
  [0.76, 0.42],
  [0.53, 0.42],
  [0.62, 0.08],
];
const BOLT: [number, number][] = BOLT_UNIT.map(([x, y]) => [0.5 + (x - 0.5) * 0.36, 0.5 + (y - 0.5) * 0.36]);

// Sync ring: two arcs (gaps at the top-right and bottom-left), each ending in an arrowhead.
export const RING_R = 0.3;
export const RING_W = 0.065;
/** Arcs in degrees (0 = right, clockwise, screen coordinates). */
export const ARCS: [number, number][] = [
  [-150, -5],
  [30, 175],
];
const rad = (d: number) => (d * Math.PI) / 180;
/** Arrowhead at the end of an arc, pointing clockwise along the ring. */
export function arrowHead(endDeg: number): [number, number][] {
  const a = rad(endDeg);
  const cx = 0.5 + RING_R * Math.cos(a);
  const cy = 0.5 + RING_R * Math.sin(a);
  const tx = -Math.sin(a); // clockwise tangent (screen coords)
  const ty = Math.cos(a);
  const nx = Math.cos(a); // outward normal
  const ny = Math.sin(a);
  const half = RING_W * 1.25;
  const len = RING_W * 1.9;
  return [
    [cx + nx * half, cy + ny * half],
    [cx + tx * len, cy + ty * len],
    [cx - nx * half, cy - ny * half],
  ];
}
const HEADS = ARCS.map(([, end]) => arrowHead(end));

function onRing(u: number, v: number): boolean {
  const dx = u - 0.5;
  const dy = v - 0.5;
  const r = Math.hypot(dx, dy);
  if (Math.abs(r - RING_R) > RING_W / 2) return false;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180
  return ARCS.some(([s, e]) => {
    for (const d of [deg, deg + 360, deg - 360]) if (d >= s && d <= e) return true;
    return false;
  });
}

function inside(x: number, y: number, poly: [number, number][]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** `scale` < 1 shrinks the glyph (maskable icons need an 80% safe zone). */
function render(size: number, scale: number, rounded: boolean): Buffer {
  const SS = 4; // supersampling
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = rounded ? size * 0.18 : 0;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let ring = 0;
      let bolt = 0;
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          // rounded-corner mask
          const cx = Math.min(Math.max(px, radius), size - radius);
          const cy = Math.min(Math.max(py, radius), size - radius);
          if ((px - cx) ** 2 + (py - cy) ** 2 > radius ** 2) continue;
          cover++;
          const u = (px / size - 0.5) / scale + 0.5;
          const v = (py / size - 0.5) / scale + 0.5;
          if (inside(u, v, BOLT)) bolt++;
          else if (onRing(u, v) || HEADS.some((h) => inside(u, v, h))) ring++;
        }
      }
      const n = SS * SS;
      const tr = cover ? ring / cover : 0;
      const tb = cover ? bolt / cover : 0;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      for (let k = 0; k < 3; k++) raw[o + k] = Math.round(BG[k] * (1 - tr - tb) + RING[k] * tr + BOLT_C[k] * tb);
      raw[o + 3] = Math.round((cover / n) * 255);
    }
  }
  return png(size, size, raw);
}

function crc32(buf: Buffer) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(w: number, h: number, raw: Buffer) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

if (process.argv[1]?.endsWith("gen-icons.ts")) main();

function main() {
mkdirSync("public/icons", { recursive: true });
const out: [string, Buffer][] = [
  ["public/icons/icon-192.png", render(192, 1, true)],
  ["public/icons/icon-512.png", render(512, 1, true)],
  // Maskable: full-bleed square, glyph inside the 80% safe zone.
  ["public/icons/maskable-512.png", render(512, 0.7, false)],
  // iOS ignores transparency and rounds corners itself: full-bleed.
  ["public/icons/apple-touch-icon-180.png", render(180, 0.85, false)],
  ["public/icons/favicon-32.png", render(32, 1, true)],
];
for (const [path, buf] of out) {
  writeFileSync(path, buf);
  console.log(`wrote ${path} (${buf.length} bytes)`);
}
}
