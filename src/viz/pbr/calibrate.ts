/**
 * Stage 4 CC0 albedo calibration (pure, no three.js — unit-tested in tests/visualStage4.test.ts).
 */
import type { TextureSlot } from './classify';

/**
 * Albedo calibration of photographed CC0 maps (Stage 4). A photo-scanned albedo keeps the exposure of
 * its capture; the three supplied sets average ≈ 13–15 % reflectance (linear), darker than the real
 * materials. The diffuse colour is scaled so the map's MEAN reflectance reaches a physically plausible
 * value for the material, preserving the map's own variation and hue:
 *   gain = target / L(mean_rgb),  L = linear luminance of the sRGB mean,  clamped to [1, 3].
 * Targets (broadband albedo, typical published ranges): desert ground / sand 0.30 (0.25–0.45),
 * weathered concrete 0.28 (0.2–0.35), galvanised steel sheet 0.35 (diffuse part; specular via metalness).
 */
export const ALBEDO_TARGET: Partial<Record<TextureSlot, number>> = { sand: 0.3, ground: 0.3, concrete: 0.28, corrugated_metal: 0.35 };
export const toLin = (c: number) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
/**
 * Slots whose scan carries a colour cast that is not part of the material (photo white balance): the
 * cast of the MEAN colour is divided out so the material keeps its texture but reads neutral (concrete
 * grey, galvanised steel grey). Terrain keeps its natural hue.
 */
export const NEUTRALISE: Partial<Record<TextureSlot, boolean>> = { concrete: true, corrugated_metal: true };
/** Per-channel linear multipliers that move the mean colour to neutral grey of the same mean. */
export function castCorrection(mean: [number, number, number]): [number, number, number] {
  const l = mean.map(toLin);
  const g = (l[0] + l[1] + l[2]) / 3;
  return [g / l[0], g / l[1], g / l[2]];
}

export function albedoGain(slot: TextureSlot, mean: [number, number, number] | null | undefined): number {
  const t = ALBEDO_TARGET[slot];
  if (!t || !mean) return 1;
  const L = 0.2126 * toLin(mean[0]) + 0.7152 * toLin(mean[1]) + 0.0722 * toLin(mean[2]);
  return L > 0 ? Math.min(3, Math.max(1, t / L)) : 1;
}
