import { useEffect, useMemo, useState } from 'react';
import { PerfProbe } from './PerfProbe';
import { Canvas, invalidate } from '@react-three/fiber';
import { OrbitControls, Sky } from '@react-three/drei';
import { qualityOf } from './quality';
import { CloseUpShadows, SUN, SceneLighting, StaticShadowPolicy } from './environment/Lighting';
import { LabelDeclutter } from './LabelDeclutter';
import { loadManifest, setTextureQuality } from './pbr/library';
import { MergeStatic } from './MergeStatic';
import { EmergencyResponse } from './environment/Emergency';
import { Terrain } from './environment/Terrain';
import { Facility } from './environment/Facility';
import { Casualty, RadiationSourceMarker } from './environment/Landmarks';
import { GroundBase } from './environment/GroundBase';
import { SiteGround } from './environment/SiteGround';
import { AerialCapture } from './AerialCapture';
import { Drones } from './Drones';
import { FeatureLabels, Routes, Trails } from './Overlays';
import { CasualtyStatusRing, CommLinks, EvacRouteOverlay, RadiationHeatmap } from './SensorOverlays';
import { CameraRig, OVERVIEW_CAMERA, OVERVIEW_TARGET } from './CameraRig';
import { useViewSettings, viewSettings } from '../state/viewSettings';
import { useAerialImage } from '../state/aerial';
import { useWorldId } from '../state/hooks';


/** Read the GPU name and switch to 'performance' automatically on Intel integrated graphics. */
function detectGpu(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
  let name: string | null = null;
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    name = null;
  }
  const v = viewSettings.get();
  const patch: Partial<typeof v> = { gpu: name };
  if (v.graphicsAuto && name && /intel/i.test(name) && v.graphics !== 'performance') patch.graphics = 'performance';
  viewSettings.set(patch);
}

/**
 * 3D view root. Read-only consumer of simulation state.
 * The Canvas is remounted when the graphics mode changes (shadows / DPR are
 * creation-time settings).
 */
/**
 * Frame-by-frame recording mode (`?record=1`, used for the demo video): the 3D view renders only
 * when `window.beeguardRenderFrame()` is called. Not used in normal operation.
 */
const RECORD = typeof location !== 'undefined' && new URLSearchParams(location.search).has('record');
if (RECORD) (window as unknown as { beeguardRenderFrame: () => void }).beeguardRenderFrame = () => invalidate();

export default function Scene() {
  const { graphics, mainView, cleanView } = useViewSettings();
  const aerial = useAerialImage();
  const q = qualityOf(graphics);
  const worldId = useWorldId();
  // local CC0 assets (public/assets/manifest.json) — resolved before the materials are built; 2 s cap, then procedural
  const [assetsReady, setAssetsReady] = useState(false);
  useEffect(() => {
    let live = true;
    loadManifest().then(() => live && setAssetsReady(true));
    return () => {
      live = false;
    };
  }, []);
  useMemo(() => setTextureQuality(q.textureSize, q.anisotropy, q.pbrMaps, q.antiTile), [q]);
  // Intel-friendly: while the aerial map covers the viewport, the 3D view stops rendering
  // (it keeps running until the aerial image has been captured once).
  const frameloop = RECORD || (mainView === 'aerial' && aerial) ? 'demand' : 'always';
  return (
    <Canvas
      key={graphics}
      frameloop={frameloop}
      shadows
      dpr={q.dpr}
      camera={{ position: OVERVIEW_CAMERA.toArray(), fov: 48, near: 0.3, far: 3000 }}
      gl={{ antialias: q.antialias, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => detectGpu(gl.getContext())}
    >
      <color attach="background" args={['#d9c3a0']} />
      {/* atmospheric perspective: warm dust haze, distance-based */}
      <fogExp2 attach="fog" args={['#d6c09a', 0.0011]} />
      <Sky distance={2500} sunPosition={SUN} turbidity={9} rayleigh={1.4} mieCoefficient={0.012} mieDirectionalG={0.86} />
      <SceneLighting q={q} />
      <StaticShadowPolicy q={q} />
      <CloseUpShadows q={q} />
      {/* image-based ambient comes from the pre-filtered sky (SceneLighting); a weak sky/sand fill keeps shade readable */}
      <hemisphereLight args={['#eef0f1', '#a48a68', q.hemiFill]} />
      <directionalLight
        position={SUN}
        intensity={2.7}
        color="#fff1d6"
        castShadow
        shadow-mapSize={[q.shadows.mapSize, q.shadows.mapSize]}
        shadow-camera-left={-110}
        shadow-camera-right={110}
        shadow-camera-top={110}
        shadow-camera-bottom={-110}
        shadow-camera-near={10}
        shadow-camera-far={500}
        shadow-bias={-0.0005}
        shadow-normalBias={0.12}
      />

      {assetsReady && (
        <>
          {/* static site: what the aerial (top-down) capture photographs */}
          <Terrain q={q} />
          <SiteGround q={q} />
          <MergeStatic key={worldId} enabled={q.mergeStatic}>
            <Facility q={q} />
            <EmergencyResponse q={q} />
          </MergeStatic>
          {!cleanView && <RadiationSourceMarker />}
          <Casualty />
          <GroundBase detail={q.props === 'low' ? 'performance' : 'balanced'} />
        </>
      )}

      {/* dynamic / overlay layers: hidden during the aerial capture (drawn as live markers on the map instead) */}
      {/* Stage 5 "Clean view": every overlay hidden (drones stay) — presentation only */}
      <group userData={{ aerialHide: true }}>
        {!cleanView && (
          <>
            <CasualtyStatusRing />
            <RadiationHeatmap />
            <EvacRouteOverlay />
            <Routes />
            <Trails />
            <CommLinks />
          </>
        )}
        <Drones q={q} />
        {!cleanView && <FeatureLabels />}
      </group>
      <LabelDeclutter />
      {assetsReady && <AerialCapture />}

      <OrbitControls makeDefault target={OVERVIEW_TARGET.toArray()} maxPolarAngle={Math.PI * 0.62} minDistance={3} maxDistance={700} enableDamping />
      <CameraRig />
      <PerfProbe quality={graphics} shadows={`${q.shadows.mapSize} ${q.shadows.mode}`} />
    </Canvas>
  );
}
