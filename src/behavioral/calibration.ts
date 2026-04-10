/**
 * Behavioral calibration — ingestion and parameter-fitting for real
 * human mouse dynamics and keystroke dynamics datasets.
 *
 * This module is a scaffold. The actual dataset downloads (Balabit Mouse
 * Dynamics Challenge, Chao Shen's mouse data, CMU Keystroke Dynamics,
 * GREYC-NISLAB) are not bundled — they're free-for-research but have
 * varying license terms and live on academic FTP sites that come and go.
 * The structure here is designed so that when you DO have a dataset in
 * hand (CSV, JSON, or the dataset's native format), you can write a tiny
 * parser, feed it through `fitFromSamples`, and get back a
 * `CalibratedProfile` that plugs directly into `BehavioralEngine`.
 *
 * The philosophy is: we don't ship training data, we ship the
 * calibration pipeline. Users bring their own data, we turn it into a
 * behavioral profile. This avoids license issues and lets different
 * users calibrate against different populations (e.g., a bank's fraud
 * team might calibrate against their own telemetry).
 */

import type { ProfileConfig } from '../types.js';

// ── Raw sample shapes ──
//
// These are the normalized formats we fit distributions against. Dataset
// parsers live in the caller's code and convert from their source format
// into these shapes.

/** A single mouse-movement observation: one (x, y, t) triple plus the
 *  source target if known. */
export interface MouseSample {
  /** Time in milliseconds since the start of the movement. */
  timestampMs: number;
  /** Cursor position at that time. */
  x: number;
  y: number;
  /** Optional: the target center the user was aiming at, if known. */
  targetX?: number;
  targetY?: number;
  /** Optional: width of the target in pixels (needed for Fitts' Law fit). */
  targetWidth?: number;
}

/** A complete movement — cursor samples from the start of motion to the
 *  click. Many datasets ship this as a sequence. */
export interface MouseMovement {
  samples: MouseSample[];
  /** Did the movement end with a click? Some datasets mix navigation
   *  moves with target clicks. */
  endedWithClick: boolean;
}

/** A single keystroke observation. */
export interface KeystrokeSample {
  /** The key character produced (for layout-aware fitting). */
  key: string;
  /** Milliseconds from the previous keystroke's down-event. */
  flightTimeMs: number;
  /** Milliseconds the key was held down. */
  holdTimeMs: number;
}

/** A complete typing session — a sequence of keystrokes for a single
 *  phrase or field. */
export interface TypingSession {
  keystrokes: KeystrokeSample[];
  /** Original text that was typed, if known. */
  phrase?: string;
}

// ── Fitted distribution ──

export interface DistributionFit {
  min: number;
  max: number;
  mean: number;
  sigma: number;
  p5: number;
  p50: number;
  p95: number;
  sampleCount: number;
}

export interface MouseFit {
  /** Fitts' Law intercept constant a (ms). */
  fittsA: number;
  /** Fitts' Law slope constant b (ms per bit of index of difficulty). */
  fittsB: number;
  /** Distribution of path length divided by straight-line distance
   *  (how much the user's path curved). Real humans ~1.05–1.15. */
  pathCurvatureRatio: DistributionFit;
  /** Distribution of the maximum perpendicular deviation from the
   *  straight line, in pixels. */
  perpendicularDeviation: DistributionFit;
  /** Distribution of "overshoot and correct" distances in pixels for
   *  targets smaller than 50px. */
  overshootPx: DistributionFit;
}

export interface TypingFit {
  /** Overall flight-time distribution across all keystrokes. */
  flightTime: DistributionFit;
  /** Hold-time distribution. */
  holdTime: DistributionFit;
  /** Digraph-specific flight times for common pairs (th, er, in, etc.). */
  digraphFlightTime: Record<string, DistributionFit>;
  /** Mistake rate (typos per character). */
  mistakeRate: number;
}

/**
 * A calibrated behavioral profile: raw fits plus a `ProfileConfig` that
 * is derived from them and ready to pass to `new BehavioralEngine(...)`.
 */
export interface CalibratedProfile {
  name: string;
  source: string;
  sampleCount: number;
  mouse: MouseFit;
  typing: TypingFit;
  profileConfig: ProfileConfig;
}

// ── Distribution fitting ──

/**
 * Fit a `DistributionFit` to a 1D array of observations.
 * Uses the empirical min/max/mean/stddev and samples the empirical CDF
 * for the 5/50/95 percentiles rather than assuming normality — many
 * behavioral measurements are right-skewed (log-normal-ish).
 */
export function fitDistribution(samples: readonly number[]): DistributionFit {
  if (samples.length === 0) {
    throw new Error('Cannot fit distribution: empty sample set');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const min = sorted[0]!;
  const max = sorted[n - 1]!;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const sigma = Math.sqrt(variance);
  const pct = (p: number): number => {
    const idx = Math.max(0, Math.min(n - 1, Math.floor(p * n)));
    return sorted[idx]!;
  };
  return {
    min,
    max,
    mean,
    sigma,
    p5: pct(0.05),
    p50: pct(0.5),
    p95: pct(0.95),
    sampleCount: n,
  };
}

// ── Mouse fitting ──

/**
 * Fit Fitts' Law constants (a, b) from a set of mouse movements via
 * ordinary least squares on (log2(D/W + 1), MT).
 *
 * Falls back to the canonical (a=90, b=140) if the dataset doesn't
 * provide target widths.
 */
export function fitFittsLaw(movements: readonly MouseMovement[]): { a: number; b: number } {
  const points: { x: number; y: number }[] = [];
  for (const m of movements) {
    if (m.samples.length < 2) continue;
    const first = m.samples[0]!;
    const last = m.samples[m.samples.length - 1]!;
    const mt = last.timestampMs - first.timestampMs;
    if (mt <= 0) continue;
    // Require target info for this sample to contribute.
    if (last.targetX == null || last.targetY == null || last.targetWidth == null || last.targetWidth <= 0) continue;
    const d = Math.hypot(last.targetX - first.x, last.targetY - first.y);
    if (d <= 0) continue;
    const id = Math.log2(d / last.targetWidth + 1);
    points.push({ x: id, y: mt });
  }
  if (points.length < 5) {
    // Not enough data — return canonical desktop-mouse values.
    return { a: 90, b: 140 };
  }
  // OLS fit: y = a + b*x
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;
  const b = (sumXY - n * meanX * meanY) / (sumX2 - n * meanX * meanX);
  const a = meanY - b * meanX;
  return { a, b };
}

/**
 * Compute path curvature (observed path length / straight-line distance)
 * and max perpendicular deviation for a single movement.
 */
function mouseMovementGeometry(m: MouseMovement): { curvature: number; maxPerpDeviation: number } | null {
  const samples = m.samples;
  if (samples.length < 2) return null;

  const start = samples[0]!;
  const end = samples[samples.length - 1]!;
  const straightDist = Math.hypot(end.x - start.x, end.y - start.y);
  if (straightDist <= 0) return null;

  let pathLen = 0;
  for (let i = 1; i < samples.length; i++) {
    pathLen += Math.hypot(samples[i]!.x - samples[i - 1]!.x, samples[i]!.y - samples[i - 1]!.y);
  }

  // Perpendicular distance from each sample to the straight start→end line.
  let maxPerp = 0;
  const lineDX = end.x - start.x;
  const lineDY = end.y - start.y;
  const lineLen = Math.hypot(lineDX, lineDY);
  for (const s of samples) {
    const perp = Math.abs((s.x - start.x) * lineDY - (s.y - start.y) * lineDX) / lineLen;
    if (perp > maxPerp) maxPerp = perp;
  }

  return { curvature: pathLen / straightDist, maxPerpDeviation: maxPerp };
}

/**
 * Fit mouse dynamics from a set of recorded movements.
 */
export function fitMouseDynamics(movements: readonly MouseMovement[]): MouseFit {
  const curvatures: number[] = [];
  const perpDeviations: number[] = [];
  const overshoots: number[] = [];

  for (const m of movements) {
    const geo = mouseMovementGeometry(m);
    if (!geo) continue;
    curvatures.push(geo.curvature);
    perpDeviations.push(geo.maxPerpDeviation);
  }

  const { a: fittsA, b: fittsB } = fitFittsLaw(movements);

  // Overshoot detection requires knowing which samples are past the
  // target center. Skip for now — plug in once a dataset with target
  // labeling is available.
  const overshootFit = overshoots.length >= 5
    ? fitDistribution(overshoots)
    : fitDistribution([5, 8, 10, 12, 15]); // canonical fallback

  return {
    fittsA,
    fittsB,
    pathCurvatureRatio: curvatures.length >= 5
      ? fitDistribution(curvatures)
      : fitDistribution([1.05, 1.08, 1.10, 1.12, 1.15]),
    perpendicularDeviation: perpDeviations.length >= 5
      ? fitDistribution(perpDeviations)
      : fitDistribution([10, 15, 20, 25, 30]),
    overshootPx: overshootFit,
  };
}

// ── Typing fitting ──

/**
 * Fit typing dynamics from a set of recorded typing sessions.
 */
export function fitTypingDynamics(sessions: readonly TypingSession[]): TypingFit {
  const allFlights: number[] = [];
  const allHolds: number[] = [];
  const digraphBuckets = new Map<string, number[]>();

  let total = 0;
  let typos = 0;

  for (const session of sessions) {
    for (let i = 0; i < session.keystrokes.length; i++) {
      const ks = session.keystrokes[i]!;
      allFlights.push(ks.flightTimeMs);
      allHolds.push(ks.holdTimeMs);
      total++;

      // Record digraph if we have the previous character too.
      if (i > 0) {
        const prev = session.keystrokes[i - 1]!;
        const digraph = (prev.key + ks.key).toLowerCase();
        if (/^[a-z]{2}$/.test(digraph)) {
          const list = digraphBuckets.get(digraph) ?? [];
          list.push(ks.flightTimeMs);
          digraphBuckets.set(digraph, list);
        }
      }

      // A "typo" in this context is a key that was followed by a
      // backspace within the next 2 keystrokes (if the dataset tracks
      // that). Simple proxy: assume 2% mistake rate when we can't tell.
      if (ks.key === 'Backspace') typos++;
    }
  }

  const digraphFit: Record<string, DistributionFit> = {};
  for (const [digraph, samples] of digraphBuckets) {
    if (samples.length >= 5) {
      digraphFit[digraph] = fitDistribution(samples);
    }
  }

  return {
    flightTime: allFlights.length >= 5 ? fitDistribution(allFlights) : fitDistribution([80, 100, 120, 150, 200]),
    holdTime: allHolds.length >= 5 ? fitDistribution(allHolds) : fitDistribution([40, 60, 80, 100]),
    digraphFlightTime: digraphFit,
    mistakeRate: total > 0 ? typos / total : 0.02,
  };
}

// ── Full profile derivation ──

/**
 * Given fitted mouse and typing dynamics, derive a ProfileConfig that
 * plugs into `new BehavioralEngine(profileConfig)`.
 *
 * The mapping is conservative: we use the 5th–95th percentiles from the
 * fits as the `[min, max]` tuples for the engine's uniform-ish sampling.
 */
export function deriveProfileConfig(mouse: MouseFit, typing: TypingFit): ProfileConfig {
  return {
    typingSpeedMs: [Math.round(typing.flightTime.p5), Math.round(typing.flightTime.p95)],
    pauseBetweenActionsMs: [300, 1000],
    scrollSpeedMs: [150, 300],
    mouseMovementCurve: 'bezier',
    clickDwellMs: [Math.round(typing.holdTime.p5), Math.round(typing.holdTime.p95)],
    readingWpm: [200, 300],
    mistakeRate: Math.max(0.001, Math.min(0.1, typing.mistakeRate)),
    recoveryBehavior: 'natural',
    pasteThreshold: 50,
  };
}

/**
 * End-to-end calibration: take raw mouse movements and typing sessions,
 * produce a CalibratedProfile.
 */
export function fitFromSamples(
  name: string,
  source: string,
  movements: readonly MouseMovement[],
  sessions: readonly TypingSession[],
): CalibratedProfile {
  const mouse = fitMouseDynamics(movements);
  const typing = fitTypingDynamics(sessions);
  const profileConfig = deriveProfileConfig(mouse, typing);
  return {
    name,
    source,
    sampleCount: movements.length + sessions.length,
    mouse,
    typing,
    profileConfig,
  };
}
