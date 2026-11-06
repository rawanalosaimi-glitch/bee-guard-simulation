import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { QualityProfile } from '../quality';
import { getManifest, pbrMaterial, tileOf } from '../pbr/library';
import { WORLD } from '../../sim';
import { DEFAULT_CONFIG } from '../../sim';
import { SITE_HALF, fbm, siteGroundTexture } from './textures';
import type { PaintOps } from './textures';

/**
 * Painted site ground — one textured plane (a single draw call) laid on the
 * flat operations area. Adds the visual detail an overhead photograph would
 * show (gravel road, concrete apron with slab joints, tyre tracks, oil stains,
 * scorch marks, the ground-station compound) WITHOUT any geometry: the
 * simulation's flat ground and obstacle footprints are unchanged.
 */

type Ctx = CanvasRenderingContext2D;

function road(ctx: Ctx, o: PaintOps, pts: [number, number][], width: number, color: string, edge?: string) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const path = () => {
    ctx.beginPath();
    pts.forEach(([x, z], i) => (i ? ctx.lineTo(o.px(x), o.pz(z)) : ctx.moveTo(o.px(x), o.pz(z))));
  };
  if (edge) {
    ctx.strokeStyle = edge;
    ctx.lineWidth = (width + 1.2) * o.k;
    path();
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width * o.k;
  path();
  ctx.stroke();
}

function tracks(ctx: Ctx, o: PaintOps, pts: [number, number][], gauge: number, alpha: number) {
  for (const side of [-1, 1]) {
    ctx.strokeStyle = `rgba(95,78,55,${alpha})`;
    ctx.lineWidth = 0.35 * o.k;
    ctx.beginPath();
    pts.forEach(([x, z], i) => {
      const [nx, nz] = i < pts.length - 1 ? [pts[i + 1][0] - x, pts[i + 1][1] - z] : [x - pts[i - 1][0], z - pts[i - 1][1]];
      const L = Math.hypot(nx, nz) || 1;
      const ox = (-nz / L) * gauge * 0.5 * side;
      const oz = (nx / L) * gauge * 0.5 * side;
      if (i) ctx.lineTo(o.px(x + ox), o.pz(z + oz));
      else ctx.moveTo(o.px(x + ox), o.pz(z + oz));
    });
    ctx.stroke();
  }
}

function blot(ctx: Ctx, o: PaintOps, x: number, z: number, r: number, inner: string, outer = 'rgba(0,0,0,0)', sx = 1, sz = 1) {
  const g = ctx.createRadialGradient(o.px(x), o.pz(z), 0, o.px(x), o.pz(z), r * o.k);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.save();
  ctx.translate(o.px(x), o.pz(z));
  ctx.scale(sx, sz);
  ctx.translate(-o.px(x), -o.pz(z));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(o.px(x), o.pz(z), r * o.k, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function paintSite(ctx: Ctx, o: PaintOps): void {
  const pad = DEFAULT_CONFIG.mission.pad;
  const gs = WORLD.groundStation.position;

  // --- ground-station compound: compacted, darker ground
  blot(ctx, o, -72, 64, 30, 'rgba(150,120,80,0.30)', 'rgba(150,120,80,0)');

  // --- access road (graded gravel) from the base to the south gate
  const access: [number, number][] = [
    [gs.x - 6, gs.z + 8],
    [gs.x + 2, gs.z - 2],
    [-52, 52],
    [-36, 47],
    [-22, 44.5],
    [-20, 36],
  ];
  road(ctx, o, access, 7, '#a8977a', 'rgba(120,100,72,0.55)');
  tracks(ctx, o, access, 2.1, 0.35);
  // spur to the landing pad
  road(ctx, o, [[gs.x + 2, gs.z - 2], [pad.x - 6, pad.z - 6], [pad.x, pad.z]], 5, '#ad9d80');

  // --- concrete apron inside the fence with slab joints and stains
  const x0 = -42;
  const x1 = 62;
  const z0 = -52;
  const z1 = 44;
  ctx.fillStyle = '#bdb3a2';
  ctx.fillRect(o.px(x0), o.pz(z0), (x1 - x0) * o.k, (z1 - z0) * o.k);
  // weathering: low-frequency mottling
  for (let x = x0; x < x1; x += 2) {
    for (let z = z0; z < z1; z += 2) {
      const n = fbm(x * 0.05, z * 0.05, 3, 51);
      ctx.fillStyle = n > 0.55 ? `rgba(120,108,92,${(n - 0.55) * 0.5})` : `rgba(235,228,214,${(0.55 - n) * 0.25})`;
      ctx.fillRect(o.px(x), o.pz(z), 2 * o.k + 1, 2 * o.k + 1);
    }
  }
  // slab joints: faint, broken (worn sealant), per-segment varying strength
  ctx.lineWidth = Math.max(1, 0.06 * o.k);
  const joint = (ax: number, az: number, bx: number, bz: number, seed: number) => {
    const a = fbm(ax * 0.13 + seed, az * 0.13, 2, 77);
    if (a < 0.35) return; // sealant gone / covered by dust
    ctx.strokeStyle = `rgba(95,88,78,${(0.04 + (a - 0.35) * 0.12).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(o.px(ax), o.pz(az));
    ctx.lineTo(o.px(bx), o.pz(bz));
    ctx.stroke();
  };
  for (let x = x0 + 8; x < x1; x += 8) for (let z = z0; z < z1; z += 8) joint(x, z, x, Math.min(z1, z + 8), 1.7);
  for (let z = z0 + 8; z < z1; z += 8) for (let x = x0; x < x1; x += 8) joint(x, z, Math.min(x1, x + 8), z, 5.3);
  // internal asphalt service road loop + yellow centre line
  const loop: [number, number][] = [
    [-20, 40],
    [-20, 12],
    [-36, 2],
    [-36, -40],
    [-14, -48],
    [24, -32],
    [28, 2],
    [26, 40],
    [-20, 40],
  ];
  road(ctx, o, loop, 6, '#6f6a63', 'rgba(60,56,50,0.5)');
  ctx.setLineDash([2.5 * o.k, 2.5 * o.k]);
  road(ctx, o, loop, 0.18, '#d9b13b');
  ctx.setLineDash([]);
  // parking bays by the control building
  ctx.strokeStyle = 'rgba(245,242,232,0.8)';
  ctx.lineWidth = 0.15 * o.k;
  for (let i = 0; i < 7; i++) {
    const x = -34 + i * 3;
    ctx.beginPath();
    ctx.moveTo(o.px(x), o.pz(-12));
    ctx.lineTo(o.px(x), o.pz(-7));
    ctx.stroke();
  }
  // tank bund walls (low concrete outlines around the tank farm)
  ctx.strokeStyle = 'rgba(150,140,125,0.9)';
  ctx.lineWidth = 0.6 * o.k;
  ctx.strokeRect(o.px(27), o.pz(5), 32 * o.k, 36 * o.k);

  // --- oil stains around the tanks, scorch marks around the damaged buildings
  for (const [x, z, r] of [
    [32, 20, 4],
    [40, 26, 3],
    [47, 18, 3.5],
    [34, 38, 2.5],
  ] as const)
    blot(ctx, o, x, z, r, 'rgba(45,38,30,0.28)', 'rgba(45,38,30,0)', 1.4, 0.8);
  blot(ctx, o, 22, -10, 12, 'rgba(25,20,16,0.55)', 'rgba(25,20,16,0)', 1.3, 1); // warehouse fire
  blot(ctx, o, 18, 21, 7, 'rgba(30,24,18,0.45)', 'rgba(30,24,18,0)'); // breached container
  blot(ctx, o, -27, -15, 5, 'rgba(30,24,18,0.25)', 'rgba(30,24,18,0)');
  // rubble scatter (flat specks) east of the warehouse
  ctx.fillStyle = 'rgba(70,64,58,0.65)';
  for (let i = 0; i < 260; i++) {
    const a = fbm(i * 1.7, 3.1, 1, 61) * Math.PI * 4;
    const d = 3 + fbm(i * 2.9, 7.7, 1, 62) * 14;
    const x = 24 + 0.8 * d * Math.cos(a);
    const z = -10 + d * Math.sin(a);
    const s = (0.15 + fbm(i, 1, 1, 63) * 0.5) * o.k;
    ctx.fillRect(o.px(x), o.pz(z), s, s * 0.8);
  }
  // tyre tracks across the open sand to the facility (emergency vehicles)
  tracks(ctx, o, [[-64, 58], [-50, 40], [-40, 26], [-34, 18]], 2.0, 0.22);
  tracks(ctx, o, [[-80, 70], [-92, 82], [-104, 100]], 2.0, 0.18);
}

/** Concrete apron inside the fence (painted on the site map; see paintSite). */
const APRON = { x0: -42, x1: 62, z0: -52, z1: 44 };

/** Clone a shared slot texture with its own world-scale repeat (the image is shared, not copied). */
function tiled(t: THREE.Texture | null, rx: number, rz: number): THREE.Texture | null {
  if (!t) return null;
  const c = t.clone();
  c.repeat.set(rx, rz);
  c.needsUpdate = true;
  return c;
}

export function SiteGround({ q }: { q: QualityProfile }) {
  const size = q.siteDecalSize;
  const terrainAsset = !!getManifest().textures.sand;
  const tex = useMemo(() => siteGroundTexture(size, paintSite, terrainAsset), [size, terrainAsset]);
  // The painted site map is the colour layer (what an overhead photo shows). Fine relief / roughness come
  // from PBR slots at world scale: 'ground' over the whole decal, 'concrete' over the apron.
  const detail = pbrMaterial('ground');
  const concrete = pbrMaterial('concrete');
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0, envMapIntensity: 0.7, transparent: true, depthWrite: false }), [tex]);
  // apron overlay: same site-map image, sampled over the apron rectangle only, with concrete relief
  const apron = useMemo(() => {
    const w = APRON.x1 - APRON.x0;
    const h = APRON.z1 - APRON.z0;
    const m = tex.clone();
    m.repeat.set(w / (2 * SITE_HALF), h / (2 * SITE_HALF));
    m.offset.set((APRON.x0 + SITE_HALF) / (2 * SITE_HALF), (SITE_HALF - APRON.z1) / (2 * SITE_HALF));
    m.needsUpdate = true;
    return { w, h, mat: new THREE.MeshStandardMaterial({ map: m, roughness: 1, metalness: 0, envMapIntensity: 0.7 }) };
  }, [tex]);
  useEffect(() => {
    const repG = (2 * SITE_HALF) / tileOf('ground');
    const repCx = apron.w / tileOf('concrete');
    const repCz = apron.h / tileOf('concrete');
    const sync = () => {
      mat.normalMap = tiled(detail.normalMap, repG, repG);
      mat.roughnessMap = tiled(detail.roughnessMap, repG, repG);
      mat.normalScale.set(0.8, 0.8 * (detail.normalScale.y < 0 ? -1 : 1));
      mat.needsUpdate = true;
      apron.mat.normalMap = tiled(concrete.normalMap, repCx, repCz);
      apron.mat.roughnessMap = tiled(concrete.roughnessMap, repCx, repCz);
      apron.mat.normalScale.set(0.9, 0.9 * (concrete.normalScale.y < 0 ? -1 : 1));
      apron.mat.needsUpdate = true;
    };
    sync();
    // re-sync when a slot's maps change (quality switch, or a CC0 asset finished loading)
    const id = setInterval(() => {
      if (mat.normalMap?.source !== detail.normalMap?.source || apron.mat.normalMap?.source !== concrete.normalMap?.source || mat.roughnessMap?.source !== detail.roughnessMap?.source) sync();
    }, 1000);
    return () => clearInterval(id);
  }, [mat, apron, detail, concrete]);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} receiveShadow material={mat}>
        <planeGeometry args={[SITE_HALF * 2, SITE_HALF * 2]} />
      </mesh>
      {q.pbrMaps && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[(APRON.x0 + APRON.x1) / 2, 0.014, (APRON.z0 + APRON.z1) / 2]} receiveShadow material={apron.mat}>
          <planeGeometry args={[apron.w, apron.h]} />
        </mesh>
      )}
    </group>
  );
}
