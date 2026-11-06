import * as THREE from 'three';

/**
 * World-scale UVs (Stage 4): 1 UV unit = one texture tile of `tile` metres, so a 28 m wall and a 2 m box
 * show the same physical texture size. Pure geometry helpers (memoised by dimensions).
 */
const cache = new Map<string, THREE.BufferGeometry>();

/** BoxGeometry with per-face UVs scaled by that face's width/height in metres. */
export function boxGeo(w: number, h: number, d: number, tile: number): THREE.BufferGeometry {
  const key = `b${w}|${h}|${d}|${tile}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // face order: +x, −x (d × h), +y, −y (w × d), +z, −z (w × h); 4 vertices per face
  const dims: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let f = 0; f < 6; f++)
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / tile, (uv.getY(i) * dims[f][1]) / tile);
    }
  uv.needsUpdate = true;
  cache.set(key, g);
  return g;
}

/** CylinderGeometry with UVs: u along the circumference (2πr / tile), v along the height (h / tile). */
export function cylGeo(rTop: number, rBottom: number, h: number, seg: number, tile: number, openEnded = false): THREE.BufferGeometry {
  const key = `c${rTop}|${rBottom}|${h}|${seg}|${tile}|${openEnded}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, openEnded);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const circ = (2 * Math.PI * Math.max(rTop, rBottom)) / tile;
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    // CylinderGeometry stores the side (torso) vertices first: (heightSegments + 1) × (radialSegments + 1)
    if (i < 2 * (seg + 1)) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * (h / tile));
    else uv.setXY(i, pos.getX(i) / tile, pos.getZ(i) / tile); // caps: planar
  }
  uv.needsUpdate = true;
  cache.set(key, g);
  return g;
}

/** PlaneGeometry (XY) with UVs w/tile × h/tile. */
export function planeGeo(w: number, h: number, tile: number): THREE.BufferGeometry {
  const key = `p${w}|${h}|${tile}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / tile, (uv.getY(i) * h) / tile);
  uv.needsUpdate = true;
  cache.set(key, g);
  return g;
}
