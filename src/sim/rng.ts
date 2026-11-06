/**
 * Seeded pseudo-random number generator (Mulberry32).
 * Every stochastic element of the simulation draws from an instance of this
 * class, so a given seed always reproduces the exact same run.
 * Math.random() is never used inside src/sim.
 */
export class SeededRng {
  private state: number;
  private spareGaussian: number | null = null;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Standard normal N(0,1) via Box–Muller (caches the paired sample). */
  gaussian(): number {
    if (this.spareGaussian !== null) {
      const s = this.spareGaussian;
      this.spareGaussian = null;
      return s;
    }
    let u = 0;
    while (u <= Number.EPSILON) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spareGaussian = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
}

/**
 * Derive an independent seed for a named sub-stream (SplitMix32-style mix).
 * Each subsystem (flight, radiation counting, casualty physiology, detection,
 * vital-sign noise, comms) has its own stream, so adding or changing one
 * subsystem never shifts the random numbers another one sees. In particular
 * Phase-1 flight trajectories are unchanged by the Phase-2 sensors.
 */
export function deriveSeed(seed: number, stream: number): number {
  let z = (seed >>> 0) ^ Math.imul(stream + 1, 0x9e3779b9);
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

export const RNG_STREAM = {
  radiation: 1,
  vitalsTruth: 2,
  detection: 3,
  vitalsNoise: 4,
  comms: 5,
  casualtyLocation: 6,
  temperatureTruth: 7,
  temperatureNoise: 8,
} as const;

/** Poisson draw: Knuth for small means, rounded normal approximation for λ ≥ 30. */
export function poisson(rng: SeededRng, lambda: number): number {
  if (!(lambda > 0)) return 0;
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= rng.next();
    } while (p > L);
    return k - 1;
  }
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * rng.gaussian()));
}

/** Exponential draw with the given mean. */
export function exponential(rng: SeededRng, mean: number): number {
  let u = 0;
  while (u <= Number.EPSILON) u = rng.next();
  return -Math.log(u) * mean;
}
