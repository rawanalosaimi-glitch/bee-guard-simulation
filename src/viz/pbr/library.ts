import * as THREE from 'three';
import { TEXTURE_SLOTS } from './classify';
import type { AssetManifest, TextureSlot } from './classify';
import { EMPTY_MANIFEST } from './classify';
import { applyAntiTiling, setAntiTiling } from './antiTile';
import { albedoGain, castCorrection, NEUTRALISE } from './calibrate';
export { ALBEDO_TARGET, albedoGain, castCorrection } from './calibrate';

/**
 * Stage 4 PBR material library (presentation only).
 *
 * Every material slot (sand, concrete, corrugated metal, …) gets albedo + normal + roughness maps:
 *   1. CC0 files listed in public/assets/manifest.json (local, loaded by TextureLoader), or
 *   2. a deterministic PROCEDURAL fallback generated here (tileable value-noise height fields;
 *      normal map = Sobel gradient of the height; no Math.random, no network).
 * Geometry carries WORLD-SCALE UVs (1 UV unit = one texture tile of `tile_m` metres; see uv.ts), so
 * texture scale is physically consistent across objects of different size.
 */

// ------------------------------------------------------------------ manifest

let manifest: AssetManifest = EMPTY_MANIFEST;
let manifestPromise: Promise<AssetManifest> | null = null;

/** Load public/assets/manifest.json once (falls back to "no assets" on any error or after 2 s). */
export function loadManifest(): Promise<AssetManifest> {
  if (manifestPromise) return manifestPromise;
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  const timeout = new Promise<AssetManifest>((res) => setTimeout(() => res(EMPTY_MANIFEST), 2000));
  const load = fetch(`${base}assets/manifest.json`, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : EMPTY_MANIFEST))
    .then((m: AssetManifest) => ({ ...EMPTY_MANIFEST, ...m, textures: m.textures ?? {}, models: m.models ?? {} }))
    .catch(() => EMPTY_MANIFEST);
  manifestPromise = Promise.race([load, timeout]).then((m) => {
    manifest = m;
    return m;
  });
  return manifestPromise;
}
export const getManifest = (): AssetManifest => manifest;
export const assetUrl = (p: string): string => `${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'}${p}`;

/** Tile size of a slot, m (asset tile.json overrides the slot default). */
export const tileOf = (slot: TextureSlot): number => manifest.textures[slot]?.tile_m ?? TEXTURE_SLOTS[slot].tile_m;

// ------------------------------------------------------------------ procedural (tileable) noise

function hashI(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
/** Periodic value noise: px × py lattice cells over the unit square (integer periods → seamless tile). */
function pnoise(u: number, v: number, p: number, s: number, py = p): number {
  const x = u * p;
  const y = v * py;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const w = (a: number) => ((a % p) + p) % p;
  const wy = (a: number) => ((a % py) + py) % py;
  const a = hashI(w(xi), wy(yi), s);
  const b = hashI(w(xi + 1), wy(yi), s);
  const c = hashI(w(xi), wy(yi + 1), s);
  const d = hashI(w(xi + 1), wy(yi + 1), s);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function pfbm(u: number, v: number, p0: number, oct: number, s: number, py0 = p0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = p0;
  let py = py0;
  for (let i = 0; i < oct; i++) {
    sum += amp * pnoise(u, v, p, s + i * 17, py);
    norm += amp;
    amp *= 0.5;
    p *= 2;
    py *= 2;
  }
  return sum / norm;
}

interface SlotRecipe {
  /** Returns [r, g, b] 0..255, height 0..1, roughness 0..1 at (u, v) in the unit tile. */
  sample: (u: number, v: number) => { c: [number, number, number]; h: number; r: number };
  normalStrength: number;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

const RECIPES: Record<TextureSlot, SlotRecipe> = {
  sand: {
    normalStrength: 1.4,
    sample: (u, v) => {
      const warp = pfbm(u, v, 3, 3, 11) * 0.35;
      // 9 ripples per tile; the warp is periodic and the ripple phase is integer → seamless
      const ripple = 0.5 + 0.5 * Math.sin((v + warp) * Math.PI * 2 * 9);
      const grain = pfbm(u, v, 64, 2, 12);
      const blot = pfbm(u, v, 4, 3, 13);
      const h = ripple * 0.35 + grain * 0.65; // fine grain dominates: no regular ripple grid at distance
      const k = 0.95 + (blot - 0.5) * 0.08 + (grain - 0.5) * 0.12; // weak in-tile mottling (large-scale variation = terrain vertex tint)
      return { c: [226 * k, 178 * k, 112 * k], h, r: 0.93 + (grain - 0.5) * 0.08 };
    },
  },
  ground: {
    normalStrength: 1.6,
    sample: (u, v) => {
      const g = pfbm(u, v, 48, 3, 21);
      const pit = pfbm(u, v, 96, 1, 22) > 0.82 ? 0.25 : 0;
      const h = g - pit;
      const k = 0.94 + (g - 0.5) * 0.15;
      return { c: [190 * k, 182 * k, 168 * k], h, r: 0.9 + (g - 0.5) * 0.1 };
    },
  },
  asphalt: {
    normalStrength: 2.0,
    sample: (u, v) => {
      const agg = pfbm(u, v, 80, 2, 31);
      const stone = pnoise(u, v, 160, 32) > 0.78 ? 1 : 0;
      const wear = pfbm(u, v, 3, 3, 33);
      const k = 0.85 + stone * 0.35 + (agg - 0.5) * 0.2 + wear * 0.12;
      return { c: [92 * k, 90 * k, 86 * k], h: agg * 0.7 + stone * 0.3, r: 0.86 - stone * 0.15 };
    },
  },
  concrete: {
    normalStrength: 1.4,
    sample: (u, v) => {
      const g = pfbm(u, v, 40, 3, 41);
      const pore = pnoise(u, v, 120, 42) > 0.86 ? 1 : 0;
      const stain = pfbm(u, v, 3, 4, 43);
      // form-tie holes and a panel joint at the tile edge
      const edge = Math.min(u, 1 - u, v, 1 - v) < 0.006 ? 1 : 0;
      const k = 0.92 + (g - 0.5) * 0.12 - stain * 0.12 - pore * 0.2 - edge * 0.1;
      return { c: [178 * k, 172 * k, 162 * k], h: g * 0.8 - pore * 0.5 - edge * 0.3, r: 0.92 };
    },
  },
  corrugated_metal: {
    normalStrength: 6.0,
    sample: (u, v) => {
      // 10 trapezoid-ish ridges per tile along u; vertical dirt streaks
      const ph = (u * 10) % 1;
      const ridge = ph < 0.3 ? 1 : ph < 0.5 ? 1 - (ph - 0.3) / 0.2 : ph < 0.8 ? 0 : (ph - 0.8) / 0.2;
      const streak = pfbm(u, v, 24, 3, 51, 2); // long vertical dirt streaks (24 × 2 cells, seamless)
      const dust = pfbm(u, v, 6, 3, 52);
      const k = 0.95 - Math.max(0, streak - 0.55) * 0.7 - dust * 0.1;
      return { c: [228 * k, 226 * k, 220 * k], h: ridge, r: 0.5 + dust * 0.25 + Math.max(0, streak - 0.55) * 0.5 };
    },
  },
  painted_steel: {
    normalStrength: 2.5,
    sample: (u, v) => {
      const seam = Math.abs(v - 0.5) < 0.004 || u < 0.003 ? 1 : 0; // weld seams of the plating
      const mott = pfbm(u, v, 8, 3, 61);
      const streak = pfbm(u, v, 20, 3, 62, 2);
      const rust = Math.max(0, streak - 0.7) * 1.6; // light weathering streaks only
      const k = 0.96 - mott * 0.06;
      const c: [number, number, number] = [mix(236 * k, 150, rust), mix(234 * k, 95, rust), mix(228 * k, 60, rust)];
      return { c, h: 0.5 + seam * 0.5 + (mott - 0.5) * 0.08, r: clamp01(0.42 + mott * 0.1 + rust * 0.4) };
    },
  },
  rust: {
    normalStrength: 3.0,
    sample: (u, v) => {
      const a = pfbm(u, v, 12, 4, 71);
      const b = pfbm(u, v, 40, 2, 72);
      const flake = b > 0.68 ? 1 : 0;
      const c: [number, number, number] = [mix(120, 168, a) - flake * 30, mix(62, 92, a) - flake * 20, mix(38, 52, a) - flake * 10];
      return { c, h: a * 0.6 + b * 0.4 - flake * 0.3, r: 0.85 + flake * 0.1 };
    },
  },
};

export interface PbrMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  /** Metalness map (assets only; three reads the blue channel — greyscale JPGs carry it in all channels). */
  metalnessMap?: THREE.Texture | null;
  normalScaleY: number;
  source: 'procedural' | 'asset';
  /** Asset resolution set that was loaded (e.g. '1k'), and whether its PBR maps were loaded. */
  key?: string;
}

const procCache = new Map<string, PbrMaps>();

function dataTexture(size: number, data: Uint8ClampedArray, srgb: boolean, aniso: number): THREE.Texture {
  let tex: THREE.Texture;
  if (typeof document !== 'undefined') {
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    cv.getContext('2d')!.putImageData(new ImageData(data as unknown as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
    tex = new THREE.CanvasTexture(cv);
  } else {
    tex = new THREE.DataTexture(data as Uint8ClampedArray<ArrayBuffer>, size, size, THREE.RGBAFormat);
  }
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = aniso;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Deterministic procedural albedo / normal / roughness maps for a slot. */
export function proceduralMaps(slot: TextureSlot, size: number, aniso: number, withPbr: boolean): PbrMaps {
  const key = `${slot}:${size}:${withPbr}`;
  const hit = procCache.get(key);
  if (hit) return hit;
  const rec = RECIPES[slot];
  const n = size * size;
  const col = new Uint8ClampedArray(n * 4);
  const rough = new Uint8ClampedArray(n * 4);
  const height = new Float32Array(n);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const s = rec.sample((x + 0.5) / size, (y + 0.5) / size);
      const i = y * size + x;
      col[i * 4] = s.c[0];
      col[i * 4 + 1] = s.c[1];
      col[i * 4 + 2] = s.c[2];
      col[i * 4 + 3] = 255;
      const r = clamp01(s.r) * 255;
      rough[i * 4] = rough[i * 4 + 1] = rough[i * 4 + 2] = r;
      rough[i * 4 + 3] = 255;
      height[i] = s.h;
    }
  let normalMap: THREE.Texture | null = null;
  let roughnessMap: THREE.Texture | null = null;
  if (withPbr) {
    const nrm = new Uint8ClampedArray(n * 4);
    const H = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
    const k = rec.normalStrength * (size / 256);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1) - H(x - 1, y - 1) - 2 * H(x - 1, y) - H(x - 1, y + 1)) / 8;
        const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1) - H(x - 1, y - 1) - 2 * H(x, y - 1) - H(x + 1, y - 1)) / 8;
        let nx = -dx * k;
        let ny = dy * k; // OpenGL convention (+Y up in tangent space; canvas rows grow downwards)
        let nz = 1;
        const L = Math.hypot(nx, ny, nz);
        nx /= L;
        ny /= L;
        nz /= L;
        const i = (y * size + x) * 4;
        nrm[i] = (nx * 0.5 + 0.5) * 255;
        nrm[i + 1] = (ny * 0.5 + 0.5) * 255;
        nrm[i + 2] = (nz * 0.5 + 0.5) * 255;
        nrm[i + 3] = 255;
      }
    normalMap = dataTexture(size, nrm, false, aniso);
    roughnessMap = dataTexture(size, rough, false, aniso);
  }
  const out: PbrMaps = { map: dataTexture(size, col, true, aniso), normalMap, roughnessMap, normalScaleY: 1, source: 'procedural' };
  procCache.set(key, out);
  return out;
}

// ------------------------------------------------------------------ materials

interface Registered {
  slot: TextureSlot;
  mat: THREE.MeshStandardMaterial;
  normalScale: number;
  /** The material's own tint (the albedo gain of a CC0 asset is applied on top of it). */
  base: THREE.Color;
  antiTile: boolean;
}

const registry: Registered[] = [];
const matCache = new Map<string, THREE.MeshStandardMaterial>();
let current = { size: 256, aniso: 2, pbr: true, antiTile: true };
const assetMaps = new Map<TextureSlot, PbrMaps | 'loading' | 'failed'>();

export interface PbrParams {
  color?: THREE.ColorRepresentation;
  roughness?: number;
  metalness?: number;
  normalScale?: number;
  envMapIntensity?: number;
  side?: THREE.Side;
  vertexColors?: boolean;
  /** Break the visible tile grid of real-scale albedo maps (pbr/antiTile.ts); 'v' = offsets along v only. */
  antiTile?: 'uv' | 'v';
}

function apply(r: Registered, maps: PbrMaps): void {
  r.mat.map = maps.map;
  r.mat.normalMap = maps.normalMap;
  r.mat.roughnessMap = maps.roughnessMap;
  r.mat.metalnessMap = maps.metalnessMap ?? null;
  if (maps.source === 'asset') {
    const mean = manifest.textures[r.slot]?.mean_rgb;
    r.mat.color.copy(r.base).multiplyScalar(albedoGain(r.slot, mean));
    if (NEUTRALISE[r.slot] && mean) r.mat.color.multiply(new THREE.Color(...castCorrection(mean)));
  } else r.mat.color.copy(r.base);
  r.mat.normalScale.set(r.normalScale, r.normalScale * maps.normalScaleY);
  r.mat.needsUpdate = true;
}

/** Shared PBR material for a slot (cached by slot + params). Maps follow the active quality / assets. */
export function pbrMaterial(slot: TextureSlot, p: PbrParams = {}): THREE.MeshStandardMaterial {
  const key = `${slot}|${JSON.stringify(p)}`;
  const hit = matCache.get(key);
  if (hit) return hit;
  const mat = new THREE.MeshStandardMaterial({
    color: p.color ?? '#ffffff',
    roughness: p.roughness ?? 1,
    metalness: p.metalness ?? 0,
    envMapIntensity: p.envMapIntensity ?? 1,
    side: p.side ?? THREE.FrontSide,
    vertexColors: p.vertexColors ?? false,
  });
  if (p.antiTile) {
    applyAntiTiling(mat, p.antiTile);
    setAntiTiling(mat, current.antiTile);
  }
  const r: Registered = { slot, mat, normalScale: p.normalScale ?? 1, base: mat.color.clone(), antiTile: !!p.antiTile };
  registry.push(r);
  matCache.set(key, mat);
  const a = assetMaps.get(slot);
  apply(r, a && a !== 'loading' && a !== 'failed' ? a : proceduralMaps(slot, current.size, current.aniso, current.pbr));
  if (!a) loadAssetSlot(slot);
  return mat;
}

/** Called by the scene when the quality level changes: rebuild procedural maps at the new size. */
export function setTextureQuality(size: number, aniso: number, pbr: boolean, antiTile = true): void {
  current = { size, aniso, pbr, antiTile };
  for (const r of registry) if (r.antiTile) setAntiTiling(r.mat, antiTile);
  const reload = new Set<TextureSlot>();
  for (const r of registry) {
    const a = assetMaps.get(r.slot);
    if (a && a !== 'loading' && a !== 'failed') {
      // a different resolution set (or PBR maps that were not loaded) is needed → reload that slot
      if (a.key !== assetKey(r.slot)) reload.add(r.slot);
      for (const t of [a.map, a.normalMap, a.roughnessMap, a.metalnessMap]) if (t) t.anisotropy = aniso;
      apply(r, pbr ? a : { ...a, normalMap: null, roughnessMap: null, metalnessMap: null });
    } else if (!a || a === 'failed') apply(r, proceduralMaps(r.slot, size, aniso, pbr));
  }
  for (const slot of reload) loadAssetSlot(slot);
}

/**
 * Asset resolution for the active quality: 2K for the High level (procedural size ≥ 1024), otherwise 1K —
 * Intel UHD friendly. Falls back to the slot's default (smallest) set.
 */
function assetRes(slot: TextureSlot): string | null {
  const set = manifest.textures[slot];
  if (!set?.res) return null;
  const want = current.size >= 1024 ? '2k' : '1k';
  return set.res[want] ? want : Object.keys(set.res).sort((a, b) => parseInt(a) - parseInt(b))[0];
}
const assetKey = (slot: TextureSlot): string => `${assetRes(slot) ?? 'single'}|${current.pbr ? 'pbr' : 'albedo'}`;

/** Mean albedo (sRGB 0–255) of a slot's CC0 asset, if the manifest provides it. */
export const slotMeanRgb = (slot: TextureSlot): [number, number, number] | null => manifest.textures[slot]?.mean_rgb ?? null;

const texCache = new Map<string, Promise<THREE.Texture>>();
function loadAssetSlot(slot: TextureSlot): void {
  const set = manifest.textures[slot];
  if (!set?.albedo || typeof document === 'undefined') return;
  const res = assetRes(slot);
  const maps = res && set.res ? set.res[res] : set;
  const key = assetKey(slot);
  const prev = assetMaps.get(slot);
  if (prev === 'loading') return;
  if (!prev) assetMaps.set(slot, 'loading');
  const loader = new THREE.TextureLoader();
  // textures are shared between slots that point at the same files (e.g. 'ground' same_as 'sand')
  const load = (p: string | undefined, srgb: boolean) => {
    if (!p) return Promise.resolve(null);
    const ck = `${p}|${srgb}`;
    const hit = texCache.get(ck);
    if (hit) return hit;
    {
      const t: Promise<THREE.Texture> = loader.loadAsync(assetUrl(p)).then((tex: THREE.Texture) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.anisotropy = current.aniso;
        return tex;
      });
      texCache.set(ck, t);
      return t;
    }
  };
  const pbr = current.pbr; // only download the PBR maps where they are used (not in Performance)
  Promise.all([load(maps.albedo, true), pbr ? load(maps.normal, false) : null, pbr ? load(maps.roughness, false) : null, pbr ? load(maps.metalness, false) : null])
    .then(([map, normalMap, roughnessMap, metalnessMap]) => {
      const out: PbrMaps = { map: map!, normalMap, roughnessMap, metalnessMap, normalScaleY: maps.normalConvention === 'DX' ? -1 : 1, source: 'asset', key };
      assetMaps.set(slot, out);
      for (const r of registry) if (r.slot === slot) apply(r, current.pbr ? out : { ...out, normalMap: null, roughnessMap: null, metalnessMap: null });
    })
    .catch(() => {
      assetMaps.set(slot, 'failed');
      for (const r of registry) if (r.slot === slot) apply(r, proceduralMaps(slot, current.size, current.aniso, current.pbr));
      console.warn(`[assets] could not load texture set "${slot}" — using the procedural fallback`);
    });
}

/** Which slots currently use real assets (for the docs / the perf HUD tooltip). */
export function textureSources(): Record<string, 'asset' | 'procedural' | 'loading'> {
  const out: Record<string, 'asset' | 'procedural' | 'loading'> = {};
  for (const slot of Object.keys(TEXTURE_SLOTS) as TextureSlot[]) {
    const a = assetMaps.get(slot);
    out[slot] = a === 'loading' ? 'loading' : a && a !== 'failed' ? 'asset' : 'procedural';
  }
  return out;
}
