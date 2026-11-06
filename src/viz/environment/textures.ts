import * as THREE from 'three';

/** Small procedural canvas textures (no external image assets needed). */

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  draw(ctx);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

let trefoil: THREE.CanvasTexture | null = null;
/** Standard ionising-radiation trefoil on a yellow sign. */
export function trefoilTexture(): THREE.CanvasTexture {
  if (trefoil) return trefoil;
  trefoil = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#f5c400';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 10;
    ctx.strokeRect(8, 8, 240, 240);
    const cx = 128;
    const cy = 128;
    ctx.fillStyle = '#111';
    for (let i = 0; i < 3; i++) {
      const a0 = -Math.PI / 2 + i * ((2 * Math.PI) / 3) - Math.PI / 6;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a0) * 22, cy + Math.sin(a0) * 22);
      ctx.arc(cx, cy, 92, a0, a0 + Math.PI / 3);
      ctx.arc(cx, cy, 22, a0 + Math.PI / 3, a0, true);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, 15, 0, Math.PI * 2);
    ctx.fill();
  });
  return trefoil;
}

let hazardRing: THREE.CanvasTexture | null = null;
/** Yellow/black hazard stripes (wrapped around a ring). */
export function hazardStripeTexture(): THREE.CanvasTexture {
  if (hazardRing) return hazardRing;
  hazardRing = canvasTexture(512, 32, (ctx) => {
    for (let i = 0; i < 32; i++) {
      ctx.fillStyle = i % 2 ? '#111' : '#f5c400';
      ctx.beginPath();
      ctx.moveTo(i * 16, 32);
      ctx.lineTo(i * 16 + 16, 0);
      ctx.lineTo(i * 16 + 32, 0);
      ctx.lineTo(i * 16 + 16, 32);
      ctx.fill();
    }
  });
  hazardRing.wrapS = THREE.RepeatWrapping;
  return hazardRing;
}

let labelCache = new Map<string, THREE.CanvasTexture>();
/** Painted sign text (e.g. building codes). */
export function signTexture(text: string, bg = '#e7e2d6', fg = '#202020'): THREE.CanvasTexture {
  const key = `${text}|${bg}|${fg}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const t = canvasTexture(256, 96, (ctx) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 256, 96);
    ctx.fillStyle = fg;
    ctx.font = 'bold 54px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 50);
  });
  labelCache.set(key, t);
  return t;
}

export function resetTextureCache(): void {
  labelCache = new Map();
}

// ---------------------------------------------------------------- Phase 3B
// Procedural surface textures for a realistic overhead (aerial) look.
// Deterministic: hash-based value noise, no Math.random.

function h2(x: number, y: number, s = 0): number {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1). */
export function vnoise(x: number, y: number, s = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = h2(xi, yi, s);
  const b = h2(xi + 1, yi, s);
  const c = h2(xi, yi + 1, s);
  const d = h2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, y: number, oct = 4, s = 0): number {
  let a = 0.5;
  let f = 1;
  let t = 0;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    t += a * vnoise(x * f, y * f, s + i * 17);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return t / n;
}

/** World square covered by the painted site ground (x, z ∈ [−SITE_HALF, SITE_HALF]). */
export const SITE_HALF = 128;

export interface PaintOps {
  /** world → canvas pixel */
  px: (x: number) => number;
  pz: (z: number) => number;
  k: number;
}

let siteTex: { key: string; tex: THREE.CanvasTexture } | null = null;

/**
 * Painted site ground: desert sand with multi-scale variation, gravel access
 * road, concrete apron with slab joints, service roads, vehicle tracks, oil
 * stains, scorch marks around the damaged buildings and the ground-station
 * compound. Only colours — the ground stays flat (y = 0), like the simulation.
 */
export function siteGroundTexture(size: number, paint: (ctx: CanvasRenderingContext2D, o: PaintOps) => void, transparentBase = false): THREE.CanvasTexture {
  // transparentBase (Stage 4, CC0 terrain present): plain ground is left transparent so the photographic
  // terrain texture shows through; only painted features (apron, roads, tracks, stains, compound) are drawn.
  const key = `${size}|${transparentBase}`;
  if (siteTex && siteTex.key === key) return siteTex.tex;
  const tex = canvasTexture(size, size, (ctx) => {
    const k = size / (2 * SITE_HALF);
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const x = i / k - SITE_HALF;
        const z = j / k - SITE_HALF;
        const big = fbm(x * 0.018, z * 0.018, 3, 1);
        const mid = fbm(x * 0.09, z * 0.09, 3, 2);
        const fine = vnoise(x * 1.7, z * 1.7, 3);
        // wind ripples (anisotropic)
        const rip = 0.5 + 0.5 * Math.sin(x * 1.25 + z * 0.55 + 3 * fbm(x * 0.05, z * 0.05, 2, 4));
        const pebble = h2(i, j, 9) > 0.993 ? -0.18 : 0;
        const t = 0.55 * big + 0.3 * mid + 0.15 * fine;
        // Stage 4: base sand matched to the PBR terrain sand (pbr/library.ts 'sand'), so the decal reads as the same ground
        const r = 219 + 40 * (t - 0.5) + 3 * (rip - 0.5) + 170 * pebble;
        const g = 175 + 34 * (t - 0.5) + 2.5 * (rip - 0.5) + 150 * pebble;
        const b = 113 + 26 * (t - 0.5) + 1.5 * (rip - 0.5) + 110 * pebble;
        // Stage 4: fade OUT (alpha) at the border so the decal dissolves into the PBR terrain under any lighting
        const e = Math.min(i, j, size - 1 - i, size - 1 - j) / (size * 0.1);
        const w0 = Math.min(1, e);
        const w = w0 * w0 * (3 - 2 * w0);
        const p = (j * size + i) * 4;
        d[p] = r;
        d[p + 1] = g;
        d[p + 2] = b;
        d[p + 3] = transparentBase ? 0 : 255 * w;
      }
    }
    ctx.putImageData(img, 0, 0);
    paint(ctx, { px: (x) => (x + SITE_HALF) * k, pz: (z) => (z + SITE_HALF) * k, k });
  });
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  siteTex = { key, tex };
  return tex;
}

let roofTex: THREE.CanvasTexture | null = null;
/** Corrugated, weathered metal roof (ribs along the slope). */
export function corrugatedRoofTexture(): THREE.CanvasTexture {
  if (roofTex) return roofTex;
  roofTex = canvasTexture(512, 512, (ctx) => {
    for (let x = 0; x < 512; x++) {
      const rib = 0.5 + 0.5 * Math.cos((x / 512) * Math.PI * 2 * 48);
      const v = Math.round(150 + 40 * rib);
      ctx.fillStyle = `rgb(${v - 6},${v},${v + 4})`;
      ctx.fillRect(x, 0, 1, 512);
    }
    // rust / dust streaks
    for (let i = 0; i < 160; i++) {
      const x = h2(i, 1, 5) * 512;
      const y = h2(i, 2, 5) * 512;
      const L = 20 + h2(i, 3, 5) * 120;
      ctx.fillStyle = h2(i, 4, 5) > 0.6 ? 'rgba(120,72,40,0.18)' : 'rgba(210,190,150,0.16)';
      ctx.fillRect(x, y, 2 + h2(i, 6, 5) * 5, L);
    }
    // panel seams
    ctx.strokeStyle = 'rgba(40,40,40,0.35)';
    for (let y = 0; y < 512; y += 128) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(512, y + 0.5);
      ctx.stroke();
    }
  });
  roofTex.wrapS = roofTex.wrapT = THREE.RepeatWrapping;
  return roofTex;
}

let gravelTex: THREE.CanvasTexture | null = null;
/** Flat gravel roof with a parapet line (control building). */
export function gravelRoofTexture(): THREE.CanvasTexture {
  if (gravelTex) return gravelTex;
  gravelTex = canvasTexture(256, 256, (ctx) => {
    const img = ctx.createImageData(256, 256);
    for (let j = 0; j < 256; j++)
      for (let i = 0; i < 256; i++) {
        const n = 0.6 * vnoise(i * 0.08, j * 0.08, 11) + 0.4 * h2(i, j, 12);
        const v = 120 + 50 * n;
        const p = (j * 256 + i) * 4;
        img.data[p] = v;
        img.data[p + 1] = v - 3;
        img.data[p + 2] = v - 8;
        img.data[p + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    ctx.strokeStyle = 'rgba(230,226,215,0.9)';
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, 248, 248);
  });
  return gravelTex;
}

let tankTopTex: THREE.CanvasTexture | null = null;
/** Tank roof seen from above: concentric weld rings, centre hatch, staining. */
export function tankTopTexture(): THREE.CanvasTexture {
  if (tankTopTex) return tankTopTex;
  tankTopTex = canvasTexture(256, 256, (ctx) => {
    const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
    g.addColorStop(0, '#f1efe9');
    g.addColorStop(1, '#cfcac0');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = 'rgba(90,90,90,0.35)';
    for (let r = 24; r < 128; r += 22) {
      ctx.beginPath();
      ctx.arc(128, 128, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let a = 0; a < 12; a++) {
      ctx.beginPath();
      ctx.moveTo(128, 128);
      ctx.lineTo(128 + 128 * Math.cos((a * Math.PI) / 6), 128 + 128 * Math.sin((a * Math.PI) / 6));
      ctx.stroke();
    }
    ctx.fillStyle = '#5b6068';
    ctx.beginPath();
    ctx.arc(128, 128, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(120,90,60,0.18)';
    ctx.beginPath();
    ctx.ellipse(150, 170, 60, 30, 0.5, 0, Math.PI * 2);
    ctx.fill();
  });
  return tankTopTex;
}

let padTex: THREE.CanvasTexture | null = null;
/**
 * Drone landing pad at the ground station: concrete, hazard border, corner alignment
 * marks and a "UAV PAD · GS-1" stencil. Deliberately NO "H" / helipad circle — this is
 * a drone pad, not a helicopter landing site.
 */
export function landingPadTexture(): THREE.CanvasTexture {
  if (padTex) return padTex;
  padTex = canvasTexture(512, 512, (ctx) => {
    const img = ctx.createImageData(512, 512);
    for (let j = 0; j < 512; j++)
      for (let i = 0; i < 512; i++) {
        const n = 0.7 * fbm(i * 0.02, j * 0.02, 3, 21) + 0.3 * h2(i, j, 22);
        const v = 150 + 40 * n;
        const p = (j * 512 + i) * 4;
        img.data[p] = v + 4;
        img.data[p + 1] = v + 1;
        img.data[p + 2] = v - 6;
        img.data[p + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    // hazard border
    for (let i = 0; i < 32; i++) {
      ctx.fillStyle = i % 2 ? '#1d1d1d' : '#e8b100';
      ctx.fillRect(i * 16, 0, 16, 14);
      ctx.fillRect(i * 16, 498, 16, 14);
      ctx.fillRect(0, i * 16, 14, 16);
      ctx.fillRect(498, i * 16, 14, 16);
    }
    // corner alignment marks of the touchdown zone (L brackets) + small centre cross
    ctx.fillStyle = '#efeadf';
    const a = 128;
    const b = 384;
    const L = 46;
    const w = 9;
    for (const [x, y, sx, sy] of [
      [a, a, 1, 1],
      [b, a, -1, 1],
      [a, b, 1, -1],
      [b, b, -1, -1],
    ] as const) {
      ctx.fillRect(sx > 0 ? x : x - L, sy > 0 ? y : y - w, L, w);
      ctx.fillRect(sx > 0 ? x : x - w, sy > 0 ? y : y - L, w, L);
    }
    ctx.fillRect(256 - 14, 256 - 3, 28, 6);
    ctx.fillRect(256 - 3, 256 - 14, 6, 28);
    // stencil
    ctx.font = 'bold 30px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('UAV PAD · GS-1', 256, 448);
    // skid / scuff marks
    ctx.fillStyle = 'rgba(30,30,30,0.10)';
    ctx.fillRect(210, 120, 7, 270);
    ctx.fillRect(296, 126, 7, 262);
  });
  return padTex;
}

let camoTex: THREE.CanvasTexture | null = null;
/** Generic desert camouflage (no insignia). */
export function desertCamoTexture(): THREE.CanvasTexture {
  if (camoTex) return camoTex;
  camoTex = canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#c2a878';
    ctx.fillRect(0, 0, 128, 128);
    const cols = ['#a88c5f', '#8c7550', '#d4c19a'];
    for (let i = 0; i < 70; i++) {
      ctx.fillStyle = cols[i % 3];
      ctx.beginPath();
      ctx.ellipse(h2(i, 1, 31) * 128, h2(i, 2, 31) * 128, 4 + h2(i, 3, 31) * 9, 3 + h2(i, 4, 31) * 6, h2(i, 5, 31) * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  camoTex.wrapS = camoTex.wrapT = THREE.RepeatWrapping;
  return camoTex;
}

let canvasClothTex: THREE.CanvasTexture | null = null;
/** Tent canvas: tan cloth with seams and dust. */
export function tentCanvasTexture(): THREE.CanvasTexture {
  if (canvasClothTex) return canvasClothTex;
  canvasClothTex = canvasTexture(256, 256, (ctx) => {
    const img = ctx.createImageData(256, 256);
    for (let j = 0; j < 256; j++)
      for (let i = 0; i < 256; i++) {
        const n = 0.6 * fbm(i * 0.03, j * 0.03, 3, 41) + 0.4 * h2(i, j, 42);
        const p = (j * 256 + i) * 4;
        img.data[p] = 182 + 26 * n;
        img.data[p + 1] = 162 + 22 * n;
        img.data[p + 2] = 118 + 16 * n;
        img.data[p + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    ctx.strokeStyle = 'rgba(90,75,50,0.35)';
    ctx.lineWidth = 2;
    for (let x = 0; x <= 256; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 256);
      ctx.stroke();
    }
  });
  canvasClothTex.wrapS = canvasClothTex.wrapT = THREE.RepeatWrapping;
  return canvasClothTex;
}
