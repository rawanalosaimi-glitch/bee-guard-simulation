/**
 * Radiation intensity colour ramp used by the 3D heat-map, the aerial / tactical
 * maps and the legend: green (lowest) → light green → yellow → orange → red
 * (highest), applied on the LOG10 dose-rate scale of doseScale(). The stop
 * POSITIONS are visual palette positions, not dose thresholds — the legend ticks
 * give the calibrated µSv/h. Same ramp everywhere, so colours mean the same µSv/h.
 */
const STOPS: [number, [number, number, number]][] = [
  [0.0, [0x35, 0xa9, 0x69]], // #35A969 low — green
  [0.25, [0x9c, 0xce, 0x49]], // #9CCE49 light green
  [0.5, [0xf3, 0xdf, 0x48]], // #F3DF48 yellow
  [0.75, [0xf3, 0x8b, 0x36]], // #F38B36 orange
  [1.0, [0xe6, 0x32, 0x32]], // #E63232 high — red
];

export function rampRGB(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i];
    const [t0, c0] = STOPS[i - 1];
    if (x <= t1) {
      const f = (x - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/** Map a dose rate to 0..1 on a log scale between lo and hi (µSv/h). */
export function logNorm(v: number, lo: number, hi: number): number {
  const a = Math.log10(Math.max(lo, 1e-6));
  const b = Math.log10(Math.max(hi, lo * 1.0001));
  return (Math.log10(Math.max(v, lo)) - a) / (b - a);
}

/** Inverse of logNorm (for legend tick values). */
export function logValue(t: number, lo: number, hi: number): number {
  const a = Math.log10(Math.max(lo, 1e-6));
  const b = Math.log10(Math.max(hi, lo * 1.0001));
  return 10 ** (a + (b - a) * t);
}

export const rampCss = (t: number, alpha = 1) => {
  const [r, g, b] = rampRGB(t);
  return alpha === 1 ? `rgb(${r | 0}, ${g | 0}, ${b | 0})` : `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${alpha})`;
};

export const RAMP_GRADIENT = `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => rampCss(t)).join(', ')})`;

/**
 * Common scale for heat-map + legend: from half the background to
 * max(observed, 10 × background). It changes only when the observed maximum does.
 */
export function doseScale(background: number, observedMax: number): { lo: number; hi: number } {
  const lo = Math.max(background * 0.5, 1e-3);
  return { lo, hi: Math.max(observedMax, background * 10) };
}
