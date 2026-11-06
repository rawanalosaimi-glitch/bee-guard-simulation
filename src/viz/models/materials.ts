import * as THREE from 'three';

/**
 * Shared materials. Colours were sampled by eye from the reference images:
 *  - bee_reference.jpeg: warm yellow body/ducts, dark-grey bands & rims,
 *    light-grey hubs and lower legs, gold emblem on a dark front panel.
 *  - mother_drone_reference.webp: matte black body, slate-blue top strip.
 */
const std = (color: string, roughness = 0.5, metalness = 0.1, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

export const MAT = {
  beeYellow: std('#f2b01e', 0.42, 0.08),
  beeYellowDuct: std('#f2b01e', 0.45, 0.05, { side: THREE.DoubleSide }),
  beeDark: std('#3b3e44', 0.55, 0.25),
  beeLight: std('#c9ccd1', 0.4, 0.35),
  beeBlade: std('#2c2f34', 0.5, 0.2),
  beeGold: std('#d4a017', 0.3, 0.7, { emissive: '#3a2a00', emissiveIntensity: 0.4 }),

  motherBody: std('#15171a', 0.38, 0.35),
  motherHull: std('#1d2024', 0.45, 0.3),
  motherInterior: std('#2c3036', 0.7, 0.1, { side: THREE.DoubleSide }),
  motherStrip: std('#3d4c5e', 0.25, 0.6, { emissive: '#0d1a2a', emissiveIntensity: 0.6 }),
  motherBlade: std('#1f2125', 0.45, 0.2, { side: THREE.DoubleSide }),
  motherMetal: std('#8a9099', 0.3, 0.8),
  bayLight: new THREE.MeshBasicMaterial({ color: '#7dd3fc' }),
  lens: std('#0b1220', 0.1, 0.9, { emissive: '#1e3a5f', emissiveIntensity: 0.5 }),
  navRed: new THREE.MeshBasicMaterial({ color: '#ff3b3b' }),
  navGreen: new THREE.MeshBasicMaterial({ color: '#34ff6a' }),
  navWhite: new THREE.MeshBasicMaterial({ color: '#ffffff' }),
};
