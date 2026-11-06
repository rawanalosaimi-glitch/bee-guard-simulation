import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, WORLD } from '../src/sim';
import { DEFAULT_GRAPHICS, GRAPHICS_LEVELS, QUALITY, qualityOf } from '../src/viz/quality';
import shippedManifest from '../public/assets/manifest.json';
import { FrameWindow } from '../src/viz/perfWindow';
import { EMPTY_MANIFEST, MODEL_SLOTS, TEXTURE_SLOTS, buildTextureSet, classifyTexture, resolutionOf } from '../src/viz/pbr/classify';
import { ALBEDO_TARGET, albedoGain, castCorrection, toLin } from '../src/viz/pbr/calibrate';
import { PROPS, propAabb } from '../src/viz/propLayout';
import { completedRun } from './helpers';


/** Stage 4 (presentation only) — quality profiles, asset pipeline, performance probe, prop placement. */
describe('Stage 4 — graphics quality levels', () => {
  it('three levels in cost order; Performance is the default / fallback', () => {
    expect([...GRAPHICS_LEVELS]).toEqual(['performance', 'balanced', 'high']);
    expect(qualityOf(undefined).id).toBe('performance');
    expect(qualityOf('ultra').id).toBe('performance');
    expect(qualityOf('high').id).toBe('high');
    const [p, b, h] = GRAPHICS_LEVELS.map((g) => QUALITY[g]);
    for (const k of ['textureSize', 'terrainSegments', 'rocks', 'siteDecalSize', 'envMapSize', 'anisotropy'] as const) {
      expect(p[k]).toBeLessThanOrEqual(b[k]);
      expect(b[k]).toBeLessThanOrEqual(h[k]);
    }
    expect(p.shadows.mapSize).toBeLessThan(b.shadows.mapSize);
    expect(b.shadows.mapSize).toBeLessThan(h.shadows.mapSize);
    expect(p.dpr[1]).toBe(1);
    expect(p.antialias).toBe(false);
    // Intel UHD profile: static shadow map, blob drone shadows, merged static meshes
    expect(p.shadows.mode).toBe('static');
    expect(p.droneShadow).toBe('blob');
    expect(p.mergeStatic).toBe(true);
    // CC0 anti-tiling (extra albedo fetch) only above Performance
    expect(p.antiTile).toBe(false);
    expect(b.antiTile && h.antiTile).toBe(true);
  });

  it('the default level (used by the view settings) is Performance', () => {
    expect(DEFAULT_GRAPHICS).toBe('performance');
  });
});

describe('Stage 4 — local CC0 asset pipeline', () => {
  it('classifies Poly Haven, ambientCG and plain file names by map type', () => {
    expect(classifyTexture('aerial_sand_diff_1k.jpg').kind).toBe('albedo');
    expect(classifyTexture('aerial_sand_nor_gl_1k.jpg')).toEqual({ kind: 'normal', normalConvention: 'GL' });
    expect(classifyTexture('aerial_sand_nor_dx_1k.jpg')).toEqual({ kind: 'normal', normalConvention: 'DX' });
    expect(classifyTexture('aerial_sand_rough_1k.jpg').kind).toBe('roughness');
    expect(classifyTexture('Ground054_1K-JPG_Color.jpg').kind).toBe('albedo');
    expect(classifyTexture('Ground054_1K-JPG_NormalGL.jpg')).toEqual({ kind: 'normal', normalConvention: 'GL' });
    expect(classifyTexture('Ground054_1K-JPG_NormalDX.jpg')).toEqual({ kind: 'normal', normalConvention: 'DX' });
    expect(classifyTexture('Ground054_1K-JPG_Roughness.jpg').kind).toBe('roughness');
    expect(classifyTexture('Ground054_1K-JPG_AmbientOcclusion.jpg').kind).toBe('ao');
    expect(classifyTexture('Ground054_1K-JPG_Displacement.jpg').kind).toBe('displacement');
    expect(classifyTexture('albedo.png').kind).toBe('albedo');
    expect(classifyTexture('normal.png').kind).toBe('normal');
    expect(classifyTexture('readme.txt').kind).toBe('unknown');
  });

  it('builds a texture set, preferring GL normals and JPG/PNG', () => {
    const set = buildTextureSet(['X_NormalDX.jpg', 'X_NormalGL.jpg', 'X_Color.jpg', 'X_Roughness.jpg', 'X_Color.exr'], 'assets/textures/sand');
    expect(set).toEqual({ albedo: 'assets/textures/sand/X_Color.jpg', normal: 'assets/textures/sand/X_NormalGL.jpg', normalConvention: 'GL', roughness: 'assets/textures/sand/X_Roughness.jpg' });
  });

  it('the shipped manifest is local-only and consistent with the slot list', () => {
    const m = shippedManifest as { textures: Record<string, object>; models: Record<string, string>; hdri: string | null };
    expect(Object.keys({ ...EMPTY_MANIFEST, ...m }).sort()).toEqual(['generated', 'hdri', 'models', 'textures']);
    for (const slot of Object.keys(m.textures)) expect(slot in TEXTURE_SLOTS).toBe(true);
    for (const slot of Object.keys(m.models)) expect(slot in MODEL_SLOTS).toBe(true);
    const keys = ['albedo', 'normal', 'roughness', 'metalness', 'ao'];
    const maps = (t: Record<string, unknown>) => [...keys.map((k) => t[k]), ...Object.values((t.res ?? {}) as Record<string, Record<string, unknown>>).flatMap((r) => keys.map((k) => r[k]))];
    const paths = [...Object.values(m.textures).flatMap((t) => maps(t as Record<string, unknown>)), ...Object.values(m.models), m.hdri].filter((p): p is string => typeof p === 'string');
    expect(paths.length).toBeGreaterThanOrEqual(0);
    for (const p of paths) {
      expect(/^assets\//.test(p)).toBe(true);
      expect(/^[a-z]+:\/\//i.test(p)).toBe(false);
    }
  });
  // (the source scan for absolute http(s) URLs is `npm run check:offline`, scripts/check-offline.ts)

  it('reads resolution tokens and groups a multi-resolution set (smallest = default), incl. metalness', () => {
    expect(resolutionOf('corrugated_iron_diff_1k.jpg')).toBe('1k');
    expect(resolutionOf('corrugated_iron_nor_gl_2k.jpg')).toBe('2k');
    expect(resolutionOf('Ground054_1K-JPG_Color.jpg')).toBe('1k');
    expect(resolutionOf('albedo.jpg')).toBe(null);
    const d = 'assets/textures/corrugated_metal';
    const files = ['ci_diff_2k.jpg', 'ci_diff_1k.jpg', 'ci_nor_gl_1k.jpg', 'ci_nor_gl_2k.jpg', 'ci_rough_1k.jpg', 'ci_rough_2k.jpg', 'ci_metal_1k.jpg', 'ci_metal_2k.jpg'];
    const set = buildTextureSet(files, d);
    expect(Object.keys(set.res ?? {})).toEqual(['1k', '2k']);
    expect(set.albedo).toBe(`${d}/ci_diff_1k.jpg`);
    expect(set.metalness).toBe(`${d}/ci_metal_1k.jpg`);
    expect(set.res!['2k']).toEqual({ albedo: `${d}/ci_diff_2k.jpg`, normal: `${d}/ci_nor_gl_2k.jpg`, normalConvention: 'GL', roughness: `${d}/ci_rough_2k.jpg`, metalness: `${d}/ci_metal_2k.jpg` });
  });

  it('ships the three supplied CC0 sets at 1K + 2K, at their physical tile sizes, no EXR / .blend', () => {
    const t = (shippedManifest as { textures: Record<string, { tile_m?: number; albedo?: string; normal?: string; roughness?: string; metalness?: string; res?: Record<string, Record<string, string>> }> }).textures;
    expect(/rocky_trail_02_diff_1k\.jpg$/.test(String(t.sand?.albedo))).toBe(true);
    expect(/concrete_layers_diff_1k\.jpg$/.test(String(t.concrete?.albedo))).toBe(true);
    expect(/corrugated_iron_metal_1k\.jpg$/.test(String(t.corrugated_metal?.metalness))).toBe(true);
    expect(t.sand?.tile_m).toBe(2);
    expect(t.concrete?.tile_m).toBe(1.55);
    expect(t.corrugated_metal?.tile_m).toBe(1.12);
    expect(t.ground?.albedo).toBe(t.sand?.albedo); // `same_as: sand`
    for (const s of ['sand', 'concrete', 'corrugated_metal']) {
      expect(Object.keys(t[s].res ?? {})).toEqual(['1k', '2k']);
      for (const p of [t[s].albedo, t[s].normal, t[s].roughness, ...Object.values(t[s].res!['2k'])].filter((x) => x && x !== 'GL')) {
        expect(/\.jpg$/.test(p!)).toBe(true);
      }
    }
  });

  it('albedo calibration lifts dark scans to plausible reflectance; cast correction neutralises the mean', () => {
    expect(albedoGain('sand', null)).toBe(1);
    expect(albedoGain('rust', [100, 100, 100])).toBe(1); // no target → unchanged
    const lum = (m: [number, number, number]) => 0.2126 * toLin(m[0]) + 0.7152 * toLin(m[1]) + 0.0722 * toLin(m[2]);
    const sand: [number, number, number] = [136, 107, 82];
    expect(Math.abs(albedoGain('sand', sand) * lum(sand) - ALBEDO_TARGET.sand!)).toBeLessThan(1e-9);
    expect(albedoGain('sand', [255, 255, 255])).toBe(1); // never darkens
    expect(albedoGain('concrete', [2, 2, 2])).toBe(3); // clamped
    const mean: [number, number, number] = [109, 101, 94];
    const k = castCorrection(mean);
    const out = mean.map((c, i) => toLin(c) * k[i]);
    expect(Math.abs(out[0] - out[1])).toBeLessThan(1e-12);
    expect(Math.abs(out[1] - out[2])).toBeLessThan(1e-12);
    expect(Math.abs(out[0] - (toLin(109) + toLin(101) + toLin(94)) / 3)).toBeLessThan(1e-12);
  });
});

describe('Stage 4 — performance probe', () => {
  it('frame-time window: mean, p95, worst, fps; ignores invalid samples; bounded size', () => {
    const w = new FrameWindow(5);
    for (const ms of [10, 20, 30, 40, 50, -1, Number.NaN, 0]) w.push(ms);
    const s = w.stats();
    expect(s.n).toBe(5);
    expect(s.mean).toBe(30);
    expect(s.p95).toBe(50);
    expect(s.worst).toBe(50);
    expect(Math.abs(s.fps - 1000 / 30)).toBeLessThan(1e-9);
    w.push(60);
    expect(w.stats().n).toBe(5);
    expect(w.stats().mean).toBe(40);
    w.clear();
    expect(w.stats()).toEqual({ n: 0, mean: 0, p95: 0, worst: 0, fps: 0 });
  });
});

describe('Stage 4 — decorative props stay clear of everything the simulation uses', () => {
  const { state } = completedRun();
  const cas = WORLD.casualty.position;
  const pad = DEFAULT_CONFIG.mission.pad;
  const minFlightAlt = Math.min(DEFAULT_CONFIG.survey.altitude_m, DEFAULT_CONFIG.survey.corridor.altitude_m, DEFAULT_CONFIG.mission.cruiseAltitude_m);
  const distToBox = (x: number, z: number, b: [number, number, number, number]) => Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - z, 0, z - b[3]));
  const segBoxDist = (a: { x: number; z: number }, c: { x: number; z: number }, b: [number, number, number, number]) => {
    let d = Infinity;
    for (let i = 0; i <= 40; i++) d = Math.min(d, distToBox(a.x + ((c.x - a.x) * i) / 40, a.z + ((c.z - a.z) * i) / 40, b));
    return d;
  };

  it('outside every obstacle (+1 m), ≥ 15 m from the casualty, off the pad, below every flight altitude', () => {
    expect(PROPS.length).toBeGreaterThanOrEqual(10);
    for (const p of PROPS) {
      const b = propAabb(p);
      for (const o of WORLD.obstacles) {
        const ob: [number, number, number, number] = o.shape === 'box' ? [o.cx - o.hx, o.cz - o.hz, o.cx + o.hx, o.cz + o.hz] : [o.cx - o.radius, o.cz - o.radius, o.cx + o.radius, o.cz + o.radius];
        const sep = Math.max(ob[0] - b[2], b[0] - ob[2], ob[1] - b[3], b[1] - ob[3]);
        expect(sep).toBeGreaterThan(1);
      }
      expect(distToBox(cas.x, cas.z, b)).toBeGreaterThanOrEqual(15);
      const pr = 9 + 4; // pad half-size incl. markings + clearance
      const sepPad = Math.max(pad.x - pr - b[2], b[0] - (pad.x + pr), pad.z - pr - b[3], b[1] - (pad.z + pr));
      expect(sepPad).toBeGreaterThan(0);
      expect(p.height).toBeLessThanOrEqual(5.2);
      expect(p.height).toBeLessThan(minFlightAlt);
    }
  });

  it('≥ 3 m from the recommended rescue route and the casualty → CCP corridor of the actual run', () => {
    const rescue = state.rescue.current!;
    const pts = rescue.sections.flatMap((s) => s.points);
    expect(pts.length).toBeGreaterThan(2);
    const ccp = DEFAULT_CONFIG.evacuation.collectionPoint.position;
    for (const p of PROPS) {
      const b = propAabb(p);
      for (let i = 1; i < pts.length; i++) expect(segBoxDist(pts[i - 1], pts[i], b)).toBeGreaterThanOrEqual(3);
      expect(segBoxDist(cas, ccp, b)).toBeGreaterThanOrEqual(3);
    }
  });
});
