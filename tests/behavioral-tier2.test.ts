/**
 * Tier 2 behavioral upgrade tests.
 *
 * Covers: Fitts' Law MT estimation, importance-scaled pre-action pauses,
 * reading pause estimation, reading scan path generation, and the
 * calibration pipeline end-to-end with synthetic samples.
 */

import { describe, it, expect } from 'vitest';
import { BehavioralEngine, HUMAN_PROFILE } from '../src/behavioral-engine.js';
import {
  fitDistribution,
  fitFittsLaw,
  fitMouseDynamics,
  fitTypingDynamics,
  fitFromSamples,
  deriveProfileConfig,
  type MouseMovement,
  type TypingSession,
} from '../src/behavioral/calibration.js';

describe('BehavioralEngine — Fitts Law movement time', () => {
  const engine = new BehavioralEngine(HUMAN_PROFILE);

  it('returns a longer time for farther targets at fixed width', () => {
    const short = engine.fittsLawMovementTime(50, 30);
    const long = engine.fittsLawMovementTime(800, 30);
    expect(long).toBeGreaterThan(short);
  });

  it('returns a longer time for smaller targets at fixed distance', () => {
    const bigTarget = engine.fittsLawMovementTime(400, 80);
    const smallTarget = engine.fittsLawMovementTime(400, 8);
    expect(smallTarget).toBeGreaterThan(bigTarget);
  });

  it('clamps to a realistic range (120–1200 ms)', () => {
    // Tiny move — wouldn't be less than the motor floor
    const tiny = engine.fittsLawMovementTime(1, 100);
    expect(tiny).toBeGreaterThanOrEqual(120);
    expect(tiny).toBeLessThanOrEqual(1200);

    // Huge move — wouldn't take a full second and change
    const huge = engine.fittsLawMovementTime(10_000, 1);
    expect(huge).toBeLessThanOrEqual(1200);
  });

  it('matches published desktop-mouse constants (a~90, b~140) within tolerance', () => {
    // ID = log2(D/W + 1). At D=300, W=30 → ID = log2(11) ≈ 3.46
    // Expected MT = 90 + 140 * 3.46 ≈ 574 ms
    const mt = engine.fittsLawMovementTime(300, 30);
    expect(mt).toBeGreaterThanOrEqual(500);
    expect(mt).toBeLessThanOrEqual(650);
  });
});

describe('BehavioralEngine — importance-scaled pauses', () => {
  const engine = new BehavioralEngine(HUMAN_PROFILE);

  it('high-importance pauses are longer than normal-importance on average', () => {
    const normalSamples: number[] = [];
    const highSamples: number[] = [];
    for (let i = 0; i < 200; i++) {
      normalSamples.push(engine.generatePreActionPause('normal'));
      highSamples.push(engine.generatePreActionPause('high'));
    }
    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    expect(avg(highSamples)).toBeGreaterThan(avg(normalSamples) * 1.5);
  });

  it('low-importance pauses are shorter than normal', () => {
    const lowAvg = (() => {
      let sum = 0;
      for (let i = 0; i < 200; i++) sum += engine.generatePreActionPause('low');
      return sum / 200;
    })();
    const normalAvg = (() => {
      let sum = 0;
      for (let i = 0; i < 200; i++) sum += engine.generatePreActionPause('normal');
      return sum / 200;
    })();
    expect(lowAvg).toBeLessThan(normalAvg);
  });

  it('no importance arg defaults to normal', () => {
    const samples: number[] = [];
    const defaulted: number[] = [];
    for (let i = 0; i < 200; i++) {
      samples.push(engine.generatePreActionPause('normal'));
      defaulted.push(engine.generatePreActionPause());
    }
    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    // Within 15% is close enough given the random draws.
    expect(Math.abs(avg(samples) - avg(defaulted))).toBeLessThan(avg(samples) * 0.15);
  });

  it('pauses are never negative', () => {
    for (let i = 0; i < 100; i++) {
      expect(engine.generatePreActionPause('low')).toBeGreaterThanOrEqual(0);
      expect(engine.generatePreActionPause('normal')).toBeGreaterThanOrEqual(0);
      expect(engine.generatePreActionPause('high')).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('BehavioralEngine — reading pause', () => {
  const engine = new BehavioralEngine(HUMAN_PROFILE);

  it('longer text → longer pause', () => {
    const short = engine.generateReadingPause(20);
    const long = engine.generateReadingPause(500);
    expect(long).toBeGreaterThan(short);
  });

  it('zero-length text returns zero', () => {
    expect(engine.generateReadingPause(0)).toBe(0);
  });

  it('clamps to an 8-second maximum', () => {
    // A huge wall of text shouldn't pause for minutes.
    const huge = engine.generateReadingPause(100_000);
    expect(huge).toBeLessThanOrEqual(8000);
  });

  it('clamps to a 120ms minimum for non-empty text', () => {
    const tiny = engine.generateReadingPause(1);
    expect(tiny).toBeGreaterThanOrEqual(120);
  });
});

describe('BehavioralEngine — reading scan path', () => {
  const engine = new BehavioralEngine(HUMAN_PROFILE);

  it('returns multiple steps spanning the text box horizontally', () => {
    const box = { x: 100, y: 200, width: 400, height: 80 };
    const steps = engine.generateReadingScanPath(box, 3);
    expect(steps.length).toBeGreaterThanOrEqual(10);

    const xs = steps.map((s) => s.x);
    const ys = steps.map((s) => s.y);
    // X should span at least 50% of the box width.
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(box.width * 0.5);
    // Y should stay within the box bounds with small tolerance for jitter.
    for (const y of ys) {
      expect(y).toBeGreaterThan(box.y - 5);
      expect(y).toBeLessThan(box.y + box.height + 5);
    }
  });

  it('all steps have positive delay', () => {
    const steps = engine.generateReadingScanPath({ x: 0, y: 0, width: 500, height: 100 }, 4);
    for (const s of steps) {
      expect(s.delay).toBeGreaterThan(0);
    }
  });

  it('more lines → more steps', () => {
    const twoLines = engine.generateReadingScanPath({ x: 0, y: 0, width: 500, height: 40 }, 2);
    const tenLines = engine.generateReadingScanPath({ x: 0, y: 0, width: 500, height: 200 }, 10);
    expect(tenLines.length).toBeGreaterThan(twoLines.length);
  });
});

describe('calibration — fitDistribution', () => {
  it('fits min/max/mean correctly', () => {
    const fit = fitDistribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(fit.min).toBe(1);
    expect(fit.max).toBe(10);
    expect(fit.mean).toBe(5.5);
    expect(fit.sampleCount).toBe(10);
  });

  it('p50 is close to the median', () => {
    const fit = fitDistribution(Array.from({ length: 100 }, (_, i) => i + 1));
    // p50 should land near 50 (exact depends on indexing).
    expect(fit.p50).toBeGreaterThanOrEqual(45);
    expect(fit.p50).toBeLessThanOrEqual(55);
  });

  it('throws on empty input', () => {
    expect(() => fitDistribution([])).toThrow();
  });
});

describe('calibration — fitFittsLaw', () => {
  it('recovers a~90, b~140 from synthetic data generated with those constants', () => {
    const movements: MouseMovement[] = [];
    const rnd = () => Math.random() * 30 - 15; // noise ±15 ms

    for (let d = 50; d <= 800; d += 50) {
      for (const w of [10, 30, 80]) {
        const id = Math.log2(d / w + 1);
        const mt = 90 + 140 * id + rnd();
        movements.push({
          samples: [
            { timestampMs: 0, x: 0, y: 0 },
            { timestampMs: mt, x: d, y: 0, targetX: d, targetY: 0, targetWidth: w },
          ],
          endedWithClick: true,
        });
      }
    }

    const { a, b } = fitFittsLaw(movements);
    // With small noise we should recover the constants within ±30.
    expect(Math.abs(a - 90)).toBeLessThan(30);
    expect(Math.abs(b - 140)).toBeLessThan(30);
  });

  it('falls back to canonical constants when no target info', () => {
    const movements: MouseMovement[] = [
      {
        samples: [
          { timestampMs: 0, x: 0, y: 0 },
          { timestampMs: 400, x: 300, y: 0 },
        ],
        endedWithClick: true,
      },
    ];
    const { a, b } = fitFittsLaw(movements);
    expect(a).toBe(90);
    expect(b).toBe(140);
  });
});

describe('calibration — end-to-end', () => {
  it('fitFromSamples produces a usable ProfileConfig', () => {
    const movements: MouseMovement[] = Array.from({ length: 20 }, (_, i) => ({
      samples: [
        { timestampMs: 0, x: 0, y: 0 },
        { timestampMs: 300 + i * 10, x: 200 + i * 5, y: i, targetX: 200 + i * 5, targetY: 0, targetWidth: 30 },
      ],
      endedWithClick: true,
    }));

    const sessions: TypingSession[] = [
      {
        phrase: 'hello world',
        keystrokes: [
          { key: 'h', flightTimeMs: 120, holdTimeMs: 60 },
          { key: 'e', flightTimeMs: 90, holdTimeMs: 55 },
          { key: 'l', flightTimeMs: 110, holdTimeMs: 65 },
          { key: 'l', flightTimeMs: 95, holdTimeMs: 60 },
          { key: 'o', flightTimeMs: 130, holdTimeMs: 70 },
        ],
      },
    ];

    const calibrated = fitFromSamples('test', 'synthetic', movements, sessions);
    expect(calibrated.name).toBe('test');
    expect(calibrated.source).toBe('synthetic');
    expect(calibrated.sampleCount).toBe(21);

    // ProfileConfig should have sane typingSpeedMs derived from p5/p95 of
    // our flight times.
    expect(calibrated.profileConfig.typingSpeedMs[0]).toBeGreaterThan(0);
    expect(calibrated.profileConfig.typingSpeedMs[1]).toBeGreaterThan(calibrated.profileConfig.typingSpeedMs[0]);
    expect(calibrated.profileConfig.mistakeRate).toBeGreaterThan(0);
  });

  it('deriveProfileConfig uses percentile-based ranges, not hardcoded constants', () => {
    const mouse = fitMouseDynamics([
      {
        samples: [
          { timestampMs: 0, x: 0, y: 0 },
          { timestampMs: 250, x: 100, y: 50, targetX: 100, targetY: 50, targetWidth: 20 },
        ],
        endedWithClick: true,
      },
    ]);
    const typing = fitTypingDynamics([
      {
        keystrokes: [
          { key: 'a', flightTimeMs: 60, holdTimeMs: 40 },
          { key: 'b', flightTimeMs: 70, holdTimeMs: 45 },
          { key: 'c', flightTimeMs: 80, holdTimeMs: 50 },
          { key: 'd', flightTimeMs: 90, holdTimeMs: 55 },
          { key: 'e', flightTimeMs: 100, holdTimeMs: 60 },
        ],
      },
    ]);
    const profile = deriveProfileConfig(mouse, typing);
    // Derived from p5/p95 of the flight-time samples (60..100).
    expect(profile.typingSpeedMs[0]).toBe(60);
    expect(profile.typingSpeedMs[1]).toBe(100);
  });
});
