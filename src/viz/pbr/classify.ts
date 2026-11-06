/**
 * Stage 4: classify CC0 PBR texture files by map type from their file names (pure; unit-tested; used by
 * scripts/scan-assets.ts). Supports the Poly Haven (`name_diff_1k.jpg`, `_nor_gl_`, `_rough_`, `_ao_`) and
 * ambientCG (`Name_1K-JPG_Color.jpg`, `_NormalGL`, `_NormalDX`, `_Roughness`, `_AmbientOcclusion`) conventions,
 * and plain names (`albedo.jpg`, `normal.png`, `roughness.jpg`).
 */
export type MapKind = 'albedo' | 'normal' | 'roughness' | 'ao' | 'displacement' | 'metalness' | 'unknown';

export function classifyTexture(file: string): { kind: MapKind; normalConvention?: 'GL' | 'DX' } {
  const n = file.toLowerCase().replace(/\.(jpe?g|png|webp|ktx2)$/, '');
  if (/(normal[_-]?dx|nor[_-]?dx)/.test(n)) return { kind: 'normal', normalConvention: 'DX' };
  if (/(normal[_-]?gl|nor[_-]?gl|normal|_nrm|_nor(\b|_))/.test(n)) return { kind: 'normal', normalConvention: 'GL' };
  if (/(rough)/.test(n)) return { kind: 'roughness' };
  if (/(ambientocclusion|ambient_occlusion|(^|[_-])ao([_-]|$))/.test(n)) return { kind: 'ao' };
  if (/(displacement|disp|height|bump)/.test(n)) return { kind: 'displacement' };
  if (/(metal)/.test(n)) return { kind: 'metalness' };
  if (/(diff|albedo|basecolor|base_color|color|colour|(^|[_-])col([_-]|$))/.test(n)) return { kind: 'albedo' };
  return { kind: 'unknown' };
}

export interface TextureMaps {
  albedo?: string;
  normal?: string;
  normalConvention?: 'GL' | 'DX';
  roughness?: string;
  metalness?: string;
  ao?: string;
}
export interface TextureSetEntry extends TextureMaps {
  /** Real-world size of one texture tile, m (from tile.json or the slot default). */
  tile_m?: number;
  /** Per-resolution map sets, e.g. { "1k": {...}, "2k": {...} } (top-level maps = the smallest). */
  res?: Record<string, TextureMaps>;
  /** Mean albedo (sRGB 0–255) — lets the painted site map match the terrain asset. From tile.json. */
  mean_rgb?: [number, number, number];
}

/** Resolution token in a file name (`_1k`, `-2K-`, `_1K-JPG_`), or null. */
export function resolutionOf(file: string): string | null {
  const m = /(?:^|[_-])(\d+)k(?=[._-]|$)/i.exec(file);
  return m ? `${m[1]}k` : null;
}

function buildMaps(files: string[], dir: string): TextureMaps {
  const out: TextureMaps = {};
  const rank = (f: string) => (/\.(jpe?g|png)$/i.test(f) ? 0 : 1);
  for (const f of [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    const c = classifyTexture(f);
    const path = `${dir}/${f}`;
    if (c.kind === 'albedo' && !out.albedo) out.albedo = path;
    else if (c.kind === 'normal' && (!out.normal || (out.normalConvention === 'DX' && c.normalConvention === 'GL'))) {
      out.normal = path;
      out.normalConvention = c.normalConvention;
    } else if (c.kind === 'roughness' && !out.roughness) out.roughness = path;
    else if (c.kind === 'metalness' && !out.metalness) out.metalness = path;
    else if (c.kind === 'ao' && !out.ao) out.ao = path;
  }
  return out;
}

/**
 * Build one texture-set entry from the files of a folder; prefers GL normals and JPG/PNG over others.
 * Files carrying resolution tokens (`_1k`, `_2k`, …) are grouped per resolution; the smallest set is
 * also the top-level (default) set.
 */
export function buildTextureSet(files: string[], dir: string): TextureSetEntry {
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const r = resolutionOf(f) ?? '';
    groups.set(r, [...(groups.get(r) ?? []), f]);
  }
  const keys = [...groups.keys()].filter((k) => k).sort((a, b) => parseInt(a) - parseInt(b));
  if (keys.length < 2) return buildMaps(files, dir);
  const res: Record<string, TextureMaps> = {};
  for (const k of keys) res[k] = buildMaps(groups.get(k)!, dir);
  return { ...res[keys[0]], res };
}

/** Material slots the scene uses; a folder public/assets/textures/<slot>/ fills that slot. */
export const TEXTURE_SLOTS = {
  sand: { tile_m: 9, use: 'desert terrain' },
  ground: { tile_m: 3, use: 'site apron detail (normal/roughness over the painted site map)' },
  asphalt: { tile_m: 3, use: 'roads (detail)' },
  concrete: { tile_m: 2.5, use: 'control building, stack, barriers, debris' },
  corrugated_metal: { tile_m: 2, use: 'warehouse walls and roof, container yard' },
  painted_steel: { tile_m: 3, use: 'storage tanks, vehicles' },
  rust: { tile_m: 2, use: 'rusted containers, debris, drums' },
} as const;
export type TextureSlot = keyof typeof TEXTURE_SLOTS;

/** Optional GLB models (decorative or fitted exactly to a simulation obstacle footprint). */
export const MODEL_SLOTS = {
  tank: 'storage tank — fitted to each tank obstacle (radius × height)',
  container: 'shipping container — fitted to the container obstacle and the decorative yard',
  barrier: 'concrete jersey barrier (≈ 3 × 0.6 × 0.8 m)',
  fire_truck: 'fire engine (≈ 8.5 × 2.5 × 3.2 m)',
  ambulance: 'ambulance (≈ 6 × 2.2 × 2.7 m)',
  hazmat_van: 'CBRN / hazmat response van (≈ 6 × 2.2 × 2.8 m)',
  tent: 'decontamination / medical tent (≈ 6 × 4 × 3 m)',
  debris: 'rubble pile (≈ 3 × 3 × 1 m)',
} as const;
export type ModelSlot = keyof typeof MODEL_SLOTS;

export interface AssetManifest {
  generated: string | null;
  textures: Partial<Record<TextureSlot, TextureSetEntry>>;
  models: Partial<Record<ModelSlot, string>>;
  hdri: string | null;
}

export const EMPTY_MANIFEST: AssetManifest = { generated: null, textures: {}, models: {}, hdri: null };
