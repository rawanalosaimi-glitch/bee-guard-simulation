import { useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { cameraSubject, isCloseUp, useViewSettings, viewSettings } from '../../state/viewSettings';
import { entityPose } from '../visualState';
import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import type { QualityProfile } from '../quality';
import { assetUrl, getManifest } from '../pbr/library';

/** Sun direction shared by the sky, the shadow-casting light and the environment map. */
export const SUN: [number, number, number] = [120, 140, -70];

/**
 * Stage 4 lighting (presentation only):
 *  - image-based ambient light: the procedural desert sky (same parameters as the visible sky) is
 *    pre-filtered once with PMREM into scene.environment — or a local HDRI from public/assets/hdri;
 *  - shadow map: 'static' quality renders it once (and again after asset/texture changes), 'live' every frame;
 *  - exposure / tone mapping (ACES) tuned so the bright desert is not washed out nor dark.
 */
export function SceneLighting({ q }: { q: QualityProfile }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 0.95;
    // image-based ambient at reduced strength: the direct sun stays dominant (crisp desert contrast)
    (scene as unknown as { environmentIntensity: number }).environmentIntensity = 0.4;
    gl.shadowMap.type = q.shadows.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    gl.shadowMap.autoUpdate = q.shadows.mode === 'live';
    gl.shadowMap.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(gl);
    let target: THREE.WebGLRenderTarget | null = null;
    let cancelled = false;
    const hdri = getManifest().hdri;
    if (!q.envMap) {
      // Performance: no image-based light (hemisphere fill only)
      scene.environment = null;
      const t0 = setTimeout(() => (gl.shadowMap.needsUpdate = true), 600);
      return () => {
        clearTimeout(t0);
        pmrem.dispose();
      };
    }
    const fromSky = () => {
      // Calibrated low-dynamic-range environment (the visible Sky shader's radiance is far brighter than
      // the scene's direct light and washed the desert out): zenith sky blue → warm horizon haze → sand
      // bounce below the horizon, plus a soft warm sun lobe. Values ≤ 1, so environmentIntensity is a
      // true fill-light fraction.
      const geo = new THREE.SphereGeometry(500, 48, 24);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const col = new Float32Array(pos.count * 3);
      const zen = new THREE.Color('#7f9fc2');
      const hor = new THREE.Color('#e6d3ae');
      const sand = new THREE.Color('#a89274');
      const sunCol = new THREE.Color('#fff2d8');
      const sd = new THREE.Vector3(...SUN).normalize();
      const c = new THREE.Color();
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
        const h = v.y;
        if (h >= 0) c.copy(hor).lerp(zen, Math.pow(h, 0.6));
        else c.copy(hor).lerp(sand, Math.min(1, -h * 4));
        const lobe = Math.pow(Math.max(0, v.dot(sd)), 24);
        c.lerp(sunCol, lobe * 0.8);
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
      const s = new THREE.Scene();
      s.add(new THREE.Mesh(geo, mat));
      // three r170 API: fromScene(scene, sigma, near, far) — the PMREM cube size is fixed by three (256)
      target = pmrem.fromScene(s, 0.04, 1, 2000);
      scene.environment = target.texture;
      geo.dispose();
      mat.dispose();
    };
    if (hdri) {
      new RGBELoader()
        .loadAsync(assetUrl(hdri))
        .then((tex: THREE.Texture) => {
          if (cancelled) return;
          tex.mapping = THREE.EquirectangularReflectionMapping;
          target = pmrem.fromEquirectangular(tex);
          scene.environment = target.texture;
          tex.dispose();
        })
        .catch(() => fromSky());
    } else fromSky();
    // the static shadow map must be re-rendered once the scene content has settled (merging, textures)
    const t1 = setTimeout(() => (gl.shadowMap.needsUpdate = true), 600);
    const t2 = setTimeout(() => (gl.shadowMap.needsUpdate = true), 2500);
    return () => {
      cancelled = true;
      clearTimeout(t1);
      clearTimeout(t2);
      scene.environment = null;
      target?.dispose();
      pmrem.dispose();
    };
  }, [gl, scene, q]);
  return null;
}

/**
 * With a STATIC shadow map (Performance) anything that moves must not cast into it, or its shadow would
 * stay frozen where it was when the map was rendered. Meshes under a group tagged `userData.dynamic`
 * or `userData.aerialHide` (drones, overlays, patrols, flashing lights) stop casting; drones get a
 * ground blob instead (Drones.tsx). Live shadow maps are left untouched.
 */
export function StaticShadowPolicy({ q }: { q: QualityProfile }) {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    if (q.shadows.mode !== 'static') return;
    const apply = () => {
      // Stage 5: during a close-up the shadow map runs live and the drones cast (CloseUpShadows)
      if (isCloseUp(viewSettings.get().cameraMode)) return;
      let changed = false;
      const visit = (o: THREE.Object3D, dyn: boolean) => {
        const d = dyn || !!o.userData?.dynamic || !!o.userData?.aerialHide;
        if (d && (o as THREE.Mesh).isMesh && o.castShadow) {
          o.castShadow = false;
          o.userData.castShadow0 = true; // remembered so a close-up can restore it
          changed = true;
        }
        for (const c of o.children) visit(c, d);
      };
      visit(scene, false);
      // static map: refresh periodically so late-mounting static content (merged meshes, GLB models,
      // textures) is always in it — one shadow pass every 3 s instead of every frame
      void changed;
      gl.shadowMap.needsUpdate = true;
    };
    apply();
    const id = setInterval(apply, 3000);
    return () => clearInterval(id);
  }, [scene, gl, q]);
  return null;
}

/**
 * Stage 5 close-up cameras: real drone shadows at any quality level. While a close-up is active the
 * sun's shadow map renders every frame, the drones cast again, and the shadow camera is centred on
 * the subject drone (±45 m instead of ±110 m, so shadow texels are ≈ 2.4× finer). The light DIRECTION
 * is unchanged (the light is only translated along it). Everything is restored when the close-up ends.
 */
const CLOSE_HALF = 45;
const sunDir = new THREE.Vector3(...SUN).normalize();

function findSun(scene: THREE.Scene): THREE.DirectionalLight | null {
  let sun: THREE.DirectionalLight | null = null;
  scene.traverse((o: THREE.Object3D) => {
    if (!sun && (o as THREE.DirectionalLight).isDirectionalLight && o.castShadow) sun = o as THREE.DirectionalLight;
  });
  return sun;
}

export function CloseUpShadows({ q }: { q: QualityProfile }) {
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const { cameraMode } = useViewSettings();
  const close = isCloseUp(cameraMode);
  useEffect(() => {
    if (!close) return;
    const sun = findSun(scene);
    if (!sun) return;
    const cam = sun.shadow.camera as THREE.OrthographicCamera;
    const saved = { l: cam.left, r: cam.right, t: cam.top, b: cam.bottom, pos: sun.position.clone() };
    gl.shadowMap.autoUpdate = true;
    const restoreCasters = () =>
      scene.traverse((o: THREE.Object3D) => {
        if (o.userData?.castShadow0) o.castShadow = true;
      });
    restoreCasters();
    const id = setInterval(restoreCasters, 1000); // drones' meshes may remount
    cam.left = -CLOSE_HALF;
    cam.right = CLOSE_HALF;
    cam.top = CLOSE_HALF;
    cam.bottom = -CLOSE_HALF;
    cam.updateProjectionMatrix();
    return () => {
      clearInterval(id);
      cam.left = saved.l;
      cam.right = saved.r;
      cam.top = saved.t;
      cam.bottom = saved.b;
      cam.updateProjectionMatrix();
      sun.position.copy(saved.pos);
      sun.target.position.set(0, 0, 0);
      sun.target.updateMatrixWorld();
      gl.shadowMap.autoUpdate = q.shadows.mode === 'live';
      if (q.shadows.mode === 'static') {
        // the next StaticShadowPolicy pass strips the drone casters again; refresh the static map now
        scene.traverse((o: THREE.Object3D) => {
          if (o.userData?.castShadow0) o.castShadow = false;
        });
        gl.shadowMap.needsUpdate = true;
      }
    };
  }, [close, scene, gl, q]);
  useFrame(() => {
    if (!close) return;
    const sun = findSunCached(scene);
    const id = cameraSubject(viewSettings.get().cameraMode);
    if (!sun || !id) return;
    const p = entityPose(id);
    sun.target.position.set(p.x, p.y, p.z);
    sun.target.updateMatrixWorld();
    sun.position.set(p.x + sunDir.x * 200, p.y + sunDir.y * 200, p.z + sunDir.z * 200);
  });
  return null;
}

let cachedSun: { scene: THREE.Scene; sun: THREE.DirectionalLight | null } | null = null;
function findSunCached(scene: THREE.Scene): THREE.DirectionalLight | null {
  if (!cachedSun || cachedSun.scene !== scene || !cachedSun.sun?.parent) cachedSun = { scene, sun: findSun(scene) };
  return cachedSun.sun;
}
