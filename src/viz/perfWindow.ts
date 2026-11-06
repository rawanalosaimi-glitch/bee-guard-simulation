/** Rolling frame-time window (pure; unit-tested). */
export class FrameWindow {
  private buf: number[] = [];
  constructor(private readonly size = 240) {}
  push(ms: number): void {
    if (!(ms > 0) || !Number.isFinite(ms)) return;
    this.buf.push(ms);
    if (this.buf.length > this.size) this.buf.shift();
  }
  stats(): { n: number; mean: number; p95: number; worst: number; fps: number } {
    const n = this.buf.length;
    if (!n) return { n: 0, mean: 0, p95: 0, worst: 0, fps: 0 };
    const mean = this.buf.reduce((a, b) => a + b, 0) / n;
    const s = [...this.buf].sort((a, b) => a - b);
    const p95 = s[Math.min(n - 1, Math.ceil(0.95 * n) - 1)];
    return { n, mean, p95, worst: s[n - 1], fps: 1000 / mean };
  }
  clear(): void {
    this.buf = [];
  }
}
