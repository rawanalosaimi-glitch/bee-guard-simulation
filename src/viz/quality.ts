/**
 * Stage 4 graphics quality profiles (presentation only — the simulation never reads these).
 * PERFORMANCE is the default and the auto-choice on Intel integrated GPUs.
 */
export type GraphicsQuality = 'performance' | 'balanced' | 'high';
export const GRAPHICS_LEVELS: readonly GraphicsQuality[] = ['performance', 'balanced', 'high'];
/** Default level (and the level an un-chosen / unknown setting falls back to): Intel UHD-friendly. */
export const DEFAULT_GRAPHICS: GraphicsQuality = 'performance';

export interface QualityProfile {
  id: GraphicsQuality;
  label: string;
  /** Canvas device-pixel-ratio range. */
  dpr: [number, number];
  antialias: boolean;
  /** Shadow map: 'static' = rendered once (scene is static; drones use blob shadows), 'live' = every frame. */
  shadows: { mapSize: number; mode: 'static' | 'live'; soft: boolean };
  /** Edge length of procedural PBR textures, px. */
  textureSize: number;
  anisotropy: number;
  /** Use normal + roughness maps (albedo-only when false). */
  pbrMaps: boolean;
  /** Anti-tiling of real-scale CC0 albedo maps (one extra fetch; ≈ 2× frame time on a software rasteriser). */
  antiTile: boolean;
  terrainSegments: number;
  rocks: number;
  siteDecalSize: number;
  /** Intended environment-map size. Not applied: in three r170, PMREMGenerator.fromScene() always uses a 256 cube. Kept for the profile ordering test. */
  envMapSize: number;
  /** Use the image-based ambient light at all (profiled: ≈ 45 % of the frame cost on a software rasteriser). */
  envMap: boolean;
  /** Hemisphere (sky / sand bounce) fill intensity — higher when there is no image-based light. */
  hemiFill: number;
  /** Decorative prop density (containers, debris scatter, vehicles' details). */
  props: 'low' | 'medium' | 'high';
  /** Translucent rotor discs at speed (presentation of fast-spinning blades). */
  rotorDiscs: boolean;
  /** Drone shadows: live shadow-map casters, or cheap ground blobs. */
  droneShadow: 'blob' | 'cast';
  /** Merge static meshes by material to cut draw calls. */
  mergeStatic: boolean;
}

export const QUALITY: Record<GraphicsQuality, QualityProfile> = {
  performance: {
    id: 'performance',
    label: 'Performance',
    dpr: [1, 1],
    antialias: false,
    shadows: { mapSize: 1024, mode: 'static', soft: false },
    textureSize: 256,
    anisotropy: 2,
    pbrMaps: false,
    antiTile: false,
    terrainSegments: 120,
    rocks: 70,
    siteDecalSize: 1536,
    envMapSize: 32,
    envMap: false,
    hemiFill: 0.95,
    props: 'low',
    rotorDiscs: true,
    droneShadow: 'blob',
    mergeStatic: true,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    dpr: [1, 1.5],
    antialias: true,
    shadows: { mapSize: 2048, mode: 'live', soft: true },
    textureSize: 512,
    anisotropy: 4,
    pbrMaps: true,
    antiTile: true,
    terrainSegments: 200,
    rocks: 180,
    siteDecalSize: 2048,
    envMapSize: 64,
    envMap: true,
    hemiFill: 0.5,
    props: 'medium',
    rotorDiscs: true,
    droneShadow: 'cast',
    mergeStatic: true,
  },
  high: {
    id: 'high',
    label: 'High',
    dpr: [1, 2],
    antialias: true,
    shadows: { mapSize: 4096, mode: 'live', soft: true },
    textureSize: 1024,
    anisotropy: 8,
    pbrMaps: true,
    antiTile: true,
    terrainSegments: 256,
    rocks: 320,
    siteDecalSize: 4096,
    envMapSize: 128,
    envMap: true,
    hemiFill: 0.5,
    props: 'high',
    rotorDiscs: true,
    droneShadow: 'cast',
    mergeStatic: false,
  },
};

export const qualityOf = (q: string | undefined): QualityProfile => QUALITY[(GRAPHICS_LEVELS as readonly string[]).includes(q ?? '') ? (q as GraphicsQuality) : 'performance'];
