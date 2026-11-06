import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { WORLD } from '../sim';
import { AERIAL_BOUNDS, aerialStore, useAerialNonce } from '../state/aerial';
import { useViewSettings } from '../state/viewSettings';

/** Direction toward the sun used by the scene's directional light (for 2-D shadow approximation). */
export const SUN_DIR = new THREE.Vector3(120, 140, -70).normalize();

/**
 * Captures an orthographic top-down image of the STATIC scene with the main
 * renderer (same geometry, materials, lights, tone mapping). Everything tagged
 * `userData.aerialHide` (drones, overlays, trails, labels) is hidden for the
 * capture; those are drawn live on the map from simulation state instead.
 *
 * Runs once after the scene has settled (and again on request). The capture is
 * tiled with camera view offsets so it works with any canvas size; each tile is
 * copied from the WebGL canvas within the same frame, before R3F renders the
 * normal view — so the user never sees it.
 */
export function AerialCapture() {
  const gl = useThree((s) => s.gl) as THREE.WebGLRenderer;
  const scene = useThree((s) => s.scene) as THREE.Scene;
  const { graphics } = useViewSettings();
  const nonce = useAerialNonce();
  const pending = useRef(true);
  const frames = useRef(0);
  const since = useRef<number | null>(null);
  useEffect(() => {
    pending.current = true;
    frames.current = 0;
    since.current = null;
  }, [nonce, graphics]);
  useFrame(({ clock }) => {
    if (!pending.current) return;
    if (since.current === null) since.current = clock.elapsedTime;
    // let textures upload and the shadow map render: ≥ 3 frames and ≥ 1.5 s
    if (++frames.current < 3 || clock.elapsedTime - since.current < 1.5) return;
    pending.current = false;
    try {
      capture(gl, scene, graphics === 'performance' ? 1536 : 2048);
    } catch (err) {
      console.warn('aerial capture failed', err);
    }
  });
  return null;
}

function capture(gl: THREE.WebGLRenderer, scene: THREE.Scene, S: number): void {
  const B = AERIAL_BOUNDS;
  const W = B.x1 - B.x0;
  const H = B.z1 - B.z0;
  const cx = (B.x0 + B.x1) / 2;
  const cz = (B.z0 + B.z1) / 2;
  const cam = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, 1, 700);
  cam.position.set(cx, 400, cz);
  cam.up.set(0, 0, -1); // north (−z) at the top of the image
  cam.lookAt(cx, 0, cz);
  cam.updateMatrixWorld();

  const hidden: THREE.Object3D[] = [];
  scene.traverse((o: THREE.Object3D) => {
    if (o.userData?.aerialHide && o.visible) {
      o.visible = false;
      hidden.push(o);
    }
  });
  const fog = scene.fog;
  scene.fog = null;

  const out = document.createElement('canvas');
  out.width = S;
  out.height = S;
  const ctx = out.getContext('2d')!;
  const size = new THREE.Vector2();
  gl.getDrawingBufferSize(size);
  const bw = Math.max(64, Math.floor(size.x));
  const bh = Math.max(64, Math.floor(size.y));
  const prevTarget = gl.getRenderTarget();
  gl.setRenderTarget(null);
  for (let ty = 0; ty * bh < S; ty++) {
    for (let tx = 0; tx * bw < S; tx++) {
      cam.setViewOffset(S, S, tx * bw, ty * bh, bw, bh);
      gl.render(scene, cam);
      ctx.drawImage(gl.domElement, 0, 0, bw, bh, tx * bw, ty * bh, bw, bh);
    }
  }
  gl.setRenderTarget(prevTarget);
  scene.fog = fog;
  for (const o of hidden) o.visible = true;

  const shadows = gl.shadowMap.enabled ? 'rendered' : 'approximated';
  if (!gl.shadowMap.enabled) paintApproxShadows(ctx, S);
  // mean border colour (sand) so the map can extend beyond the photographed rectangle without a seam
  const strip = ctx.getImageData(0, 0, S, 4).data;
  let r = 0;
  let g2 = 0;
  let b = 0;
  const n = strip.length / 4;
  for (let i = 0; i < strip.length; i += 4) {
    r += strip[i];
    g2 += strip[i + 1];
    b += strip[i + 2];
  }
  const rgb = `${Math.round(r / n)},${Math.round(g2 / n)},${Math.round(b / n)}`;
  const edge = `rgb(${rgb})`;
  // feather the image border into that colour
  const fw = Math.round(S * 0.04);
  const sides: [number, number, number, number, number, number, number, number][] = [
    [0, 0, fw, S, 0, 0, fw, 0], // left: edge colour at x = 0 → transparent at x = fw
    [S - fw, 0, fw, S, S, 0, S - fw, 0],
    [0, 0, S, fw, 0, 0, 0, fw],
    [0, S - fw, S, fw, 0, S, 0, S - fw],
  ];
  for (const [x, y, w, h, gx0, gy0, gx1, gy1] of sides) {
    const grad = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    grad.addColorStop(0, edge);
    grad.addColorStop(1, `rgba(${rgb},0)`); // same RGB: canvas gradients interpolate unpremultiplied
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
  }
  aerialStore.set({ canvas: out, ...B, shadows, edge, capturedAt: performance.now() });
}

/** Performance mode renders without shadow maps: add soft cast shadows of the obstacles in 2-D. */
function paintApproxShadows(ctx: CanvasRenderingContext2D, S: number): void {
  const B = AERIAL_BOUNDS;
  const kx = S / (B.x1 - B.x0);
  const kz = S / (B.z1 - B.z0);
  const px = (x: number) => (x - B.x0) * kx;
  const pz = (z: number) => (z - B.z0) * kz;
  const dx = -SUN_DIR.x / SUN_DIR.y;
  const dz = -SUN_DIR.z / SUN_DIR.y;
  ctx.save();
  for (const o of WORLD.obstacles) {
    const foot = new Path2D();
    if (o.shape === 'box') foot.rect(px(o.cx - o.hx), pz(o.cz - o.hz), 2 * o.hx * kx, 2 * o.hz * kz);
    else foot.arc(px(o.cx), pz(o.cz), o.radius * kx, 0, Math.PI * 2);
    const clip = new Path2D();
    clip.rect(0, 0, S, S);
    clip.addPath(foot);
    ctx.save();
    ctx.clip(clip, 'evenodd'); // never darken the roof itself
    ctx.fillStyle = 'rgba(40,30,20,0.06)';
    const steps = 18;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * o.height;
      ctx.save();
      ctx.translate(dx * t * kx, dz * t * kz);
      ctx.fill(foot);
      ctx.restore();
    }
    ctx.restore();
  }
  ctx.restore();
}
