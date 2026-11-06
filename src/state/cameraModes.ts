/** Camera modes of the 3D view (pure; no React — unit-tested). Presentation only. */
export type CameraMode =
  | 'overview'
  | 'top'
  | 'base'
  | 'MOTHER-01'
  | 'BEE-01'
  | 'BEE-02'
  | 'BEE-03'
  /** Stage 5 close-up cameras: drones drawn at TRUE size, real shadows. */
  | 'CLOSE-MOTHER-01'
  | 'CLOSE-BEE-01'
  | 'CLOSE-BEE-02'
  | 'CLOSE-BEE-03'
  /** Stage 5: tripod at the launch pad tracking the mother drone. */
  | 'TAKEOFF';

/** Close-up camera modes (true-size drones, live drone shadows). */
export const CLOSE_UP_MODES: readonly CameraMode[] = ['CLOSE-MOTHER-01', 'CLOSE-BEE-01', 'CLOSE-BEE-02', 'CLOSE-BEE-03', 'TAKEOFF'];
export const isCloseUp = (m: CameraMode): boolean => CLOSE_UP_MODES.includes(m);
/** The drone a camera mode follows or looks at (null for the fixed presets). */
export function cameraSubject(m: CameraMode): string | null {
  if (m === 'TAKEOFF') return 'MOTHER-01';
  if (m.startsWith('CLOSE-')) return m.slice(6);
  if (m === 'MOTHER-01' || m.startsWith('BEE-')) return m;
  return null;
}
