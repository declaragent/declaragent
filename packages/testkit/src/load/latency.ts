/**
 * Latency recorder with accurate percentile computation.
 *
 * Stores every sample — acceptable up to ~1M samples given the typical
 * use (10-minute runs at 1K msg/sec = 600K samples). For larger runs the
 * `maxSamples` cap applies reservoir sampling, trading exact percentiles
 * for bounded memory.
 */
export class LatencyRecorder {
  private readonly samples: number[] = [];
  private readonly maxSamples: number;
  /** Total observations seen; may exceed samples.length when reservoir sampling kicks in. */
  private totalObservations = 0;

  constructor(options: { maxSamples?: number } = {}) {
    this.maxSamples = Math.max(1, options.maxSamples ?? 1_000_000);
  }

  record(latencyMs: number): void {
    this.totalObservations += 1;
    if (this.samples.length < this.maxSamples) {
      this.samples.push(latencyMs);
      return;
    }
    // Reservoir sampling: replace a random prior sample with probability
    // `maxSamples / totalObservations`. Keeps a uniform random sample of
    // the full stream so the percentile estimate remains unbiased.
    const idx = Math.floor(Math.random() * this.totalObservations);
    if (idx < this.maxSamples) {
      this.samples[idx] = latencyMs;
    }
  }

  get count(): number {
    return this.totalObservations;
  }

  /** Average over samples (may be a subset of total observations). */
  avg(): number {
    if (this.samples.length === 0) return 0;
    let sum = 0;
    for (const s of this.samples) sum += s;
    return sum / this.samples.length;
  }

  /** Min / max over samples. */
  min(): number {
    if (this.samples.length === 0) return 0;
    let v = this.samples[0] as number;
    for (const s of this.samples) if (s < v) v = s;
    return v;
  }

  max(): number {
    if (this.samples.length === 0) return 0;
    let v = this.samples[0] as number;
    for (const s of this.samples) if (s > v) v = s;
    return v;
  }

  /**
   * Percentile (0..1). Uses the nearest-rank method on the sorted
   * sample array. For acceptance runs where `totalObservations <=
   * maxSamples` this is exact.
   */
  percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const clamped = p < 0 ? 0 : p > 1 ? 1 : p;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.min(Math.floor(clamped * sorted.length), sorted.length - 1);
    return sorted[idx] ?? 0;
  }

  /** Common quantiles, computed together to avoid re-sorting. */
  summary(): { avg: number; min: number; max: number; p50: number; p95: number; p99: number } {
    if (this.samples.length === 0) {
      return { avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const q = (p: number): number => {
      const idx = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
      return sorted[idx] ?? 0;
    };
    let sum = 0;
    for (const s of sorted) sum += s;
    return {
      avg: sum / sorted.length,
      min: sorted[0] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
      p50: q(0.5),
      p95: q(0.95),
      p99: q(0.99),
    };
  }
}
