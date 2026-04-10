import type { ProfileConfig, Point, BoundingBox } from './types';

// ── Exported step types ──

/**
 * Importance level for an action. Drives how long the pre-action hesitation
 * is (humans hesitate more on consequential actions) and how careful the
 * mouse path is (more overshoot correction for high-importance targets).
 */
export type ActionImportance = 'low' | 'normal' | 'high';

export interface MouseStep {
  x: number;
  y: number;
  delay: number;
}

export interface KeystrokeStep {
  key: string;
  delay: number;
  holdDuration: number;
  isTypo?: boolean;
  correctionSequence?: { key: string; delay: number; holdDuration: number }[];
}

export interface ScrollStep {
  deltaY: number;
  delay: number;
}

// ── Built-in profiles ──

export const HUMAN_PROFILE: ProfileConfig = {
  typingSpeedMs: [80, 150],
  pauseBetweenActionsMs: [300, 1000],
  scrollSpeedMs: [150, 300],
  mouseMovementCurve: 'bezier',
  clickDwellMs: [50, 200],
  readingWpm: [200, 300],
  mistakeRate: 0.02,
  recoveryBehavior: 'natural',
  pasteThreshold: 50,
};

export const SCRAPER_PROFILE: ProfileConfig = {
  typingSpeedMs: [40, 80],
  pauseBetweenActionsMs: [100, 300],
  scrollSpeedMs: [50, 150],
  mouseMovementCurve: 'bezier',
  clickDwellMs: [20, 50],
  readingWpm: [500, 800],
  mistakeRate: 0.005,
  recoveryBehavior: 'fast',
  pasteThreshold: 20,
};

// ── Sampling utilities ──

/**
 * Box-Muller transform: generates a normally-distributed random number
 * centered on (min+max)/2 with sigma = (max-min)/6, clamped to [min, max].
 *
 * The 6-sigma span means ~99.7% of raw samples already fall within bounds;
 * clamping handles the remaining tail.
 */
export function sampleNormal(min: number, max: number): number {
  const mean = (min + max) / 2;
  const sigma = (max - min) / 6;

  // Box-Muller requires two uniform random numbers in (0,1)
  let u1: number;
  let u2: number;
  do { u1 = Math.random(); } while (u1 === 0); // avoid log(0)
  u2 = Math.random();

  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const raw = mean + z * sigma;

  return Math.max(min, Math.min(max, raw));
}

/**
 * Uniform random in [min, max].
 */
function uniform(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Uniform random integer in [min, max] (inclusive).
 */
function uniformInt(min: number, max: number): number {
  return Math.floor(uniform(min, max + 1));
}

/**
 * Evaluate a cubic Bézier at parameter t ∈ [0,1].
 */
function cubicBezier(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const u = 1 - t;
  return u * u * u * p0
    + 3 * u * u * t * p1
    + 3 * u * t * t * p2
    + t * t * t * p3;
}

/**
 * Euclidean distance between two points.
 */
function distance(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ── Common digraphs for typing cadence ──

const COMMON_DIGRAPHS = new Set([
  'th', 'er', 'in', 'he', 'an', 'en', 'on', 'at', 'es', 'or',
]);

const UNCOMMON_CHARS = new Set([
  '@', '#', '$', '%', '^', '&', '*', '(', ')', '{', '}', '[', ']',
  '|', '\\', '~', '`', '<', '>', '/', '?', '!', '+', '=', '_',
]);

// ── Engine ──

export class BehavioralEngine {
  private readonly profile: ProfileConfig;

  constructor(profile: ProfileConfig) {
    this.profile = profile;
  }

  // ────────────────────────────────────────────
  // Mouse movement
  // ────────────────────────────────────────────

  /**
   * Generate a cubic Bézier mouse path from `from` to `to`.
   *
   * - Two random control points are offset perpendicular to the straight line.
   * - Step count scales with distance (20-50 steps).
   * - Timing uses an ease-in/ease-out curve (accelerate then decelerate).
   * - Micro-jitter (±1-3px) simulates hand tremor.
   * - For distances < 50px to target the path overshoots by 5-15px, then
   *   curves back, simulating the corrective saccade real users perform.
   */
  generateMousePath(from: Point, to: Point): MouseStep[] {
    const dist = distance(from, to);

    // Step count: more steps for longer distances
    const stepCount = Math.round(
      Math.max(20, Math.min(50, 20 + (dist / 800) * 30)),
    );

    // Perpendicular direction to the from→to vector
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = dist || 1;
    const perpX = -dy / len;
    const perpY = dx / len;

    // Two random control points offset 20-100px perpendicular
    const offset1 = uniform(20, 100) * (Math.random() < 0.5 ? 1 : -1);
    const offset2 = uniform(20, 100) * (Math.random() < 0.5 ? 1 : -1);

    // Control point 1 at ~33% along the line
    const cp1: Point = {
      x: from.x + dx * 0.33 + perpX * offset1,
      y: from.y + dy * 0.33 + perpY * offset1,
    };
    // Control point 2 at ~66% along the line
    const cp2: Point = {
      x: from.x + dx * 0.66 + perpX * offset2,
      y: from.y + dy * 0.66 + perpY * offset2,
    };

    // Base movement duration scales with distance (faster ≠ instant)
    // ~200ms for short moves, up to ~800ms for long moves
    const totalDurationMs = Math.max(200, Math.min(800, dist * 0.6));

    const steps: MouseStep[] = [];

    for (let i = 0; i <= stepCount; i++) {
      const t = i / stepCount;

      // Ease-in-out via smoothstep: accelerate from start, decelerate at end
      const eased = t * t * (3 - 2 * t);

      let x = cubicBezier(from.x, cp1.x, cp2.x, to.x, eased);
      let y = cubicBezier(from.y, cp1.y, cp2.y, to.y, eased);

      // Micro-jitter (hand tremor) — skip first and last points for precision
      if (i > 0 && i < stepCount) {
        const jitter = uniform(1, 3);
        const angle = Math.random() * 2 * Math.PI;
        x += Math.cos(angle) * jitter;
        y += Math.sin(angle) * jitter;
      }

      // Delay for this step: derived from the eased timing curve
      // The derivative of smoothstep maps to velocity; invert for delay
      const stepFraction = 1 / stepCount;
      // Velocity factor: higher in the middle, lower at edges
      const velocityScale = 6 * t * (1 - t) || 0.1; // derivative of smoothstep, floored
      const rawDelay = (totalDurationMs * stepFraction) / velocityScale;
      const delay = Math.max(2, Math.min(rawDelay, totalDurationMs * 0.15));

      steps.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, delay: Math.round(delay) });
    }

    // Overshoot-and-correct for close targets (distance < 50px)
    if (dist < 50 && dist > 5) {
      const overshootDist = uniform(5, 15);
      const overshootAngle = Math.atan2(dy, dx) + uniform(-0.3, 0.3);
      const overshootPoint: Point = {
        x: to.x + Math.cos(overshootAngle) * overshootDist,
        y: to.y + Math.sin(overshootAngle) * overshootDist,
      };

      // Replace last few steps with overshoot then correction
      // Remove final 3 steps and append overshoot + correction
      const cutIndex = Math.max(0, steps.length - 3);
      steps.length = cutIndex;

      // Overshoot step
      steps.push({
        x: Math.round(overshootPoint.x * 100) / 100,
        y: Math.round(overshootPoint.y * 100) / 100,
        delay: uniformInt(15, 30),
      });

      // Brief pause at overshoot (reaction time)
      // Then 2-3 corrective steps back to target
      const correctionSteps = uniformInt(2, 3);
      for (let c = 1; c <= correctionSteps; c++) {
        const ct = c / correctionSteps;
        const cx = overshootPoint.x + (to.x - overshootPoint.x) * ct;
        const cy = overshootPoint.y + (to.y - overshootPoint.y) * ct;
        steps.push({
          x: Math.round(cx * 100) / 100,
          y: Math.round(cy * 100) / 100,
          delay: uniformInt(20, 50),
        });
      }
    }

    return steps;
  }

  // ────────────────────────────────────────────
  // Typing simulation
  // ────────────────────────────────────────────

  /**
   * Generate a realistic keystroke sequence for the given text.
   *
   * Cadence rules:
   *  - Common digraphs  → 60-80% of base delay (muscle-memory pairs)
   *  - Uncommon symbols  → 130-170% of base delay (hunt-and-peck)
   *  - Numeric digits    → 110-130% of base delay
   *  - Everything else   → 100% of base delay (with normal-distribution jitter)
   *
   * Typos are injected at the configured `mistakeRate`. Each typo produces:
   *   wrong char → pause (200-500ms) → backspace → correct char
   *
   * Hold duration for every key is 40-100ms, normally distributed.
   */
  generateTypingSequence(text: string): KeystrokeStep[] {
    const [minSpeed, maxSpeed] = this.profile.typingSpeedMs;
    const mistakeRate = this.profile.mistakeRate;
    const steps: KeystrokeStep[] = [];

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const prevChar = i > 0 ? text[i - 1] : null;

      // Base delay sampled from the profile range
      let baseDelay = sampleNormal(minSpeed, maxSpeed);

      // Adjust for digraph / char class
      if (prevChar !== null) {
        const digraph = (prevChar + char).toLowerCase();
        if (COMMON_DIGRAPHS.has(digraph)) {
          baseDelay *= uniform(0.6, 0.8);
        }
      }

      if (UNCOMMON_CHARS.has(char)) {
        baseDelay *= uniform(1.3, 1.7);
      } else if (/[0-9]/.test(char)) {
        baseDelay *= uniform(1.1, 1.3);
      }

      const delay = Math.round(Math.max(20, baseDelay));
      const holdDuration = Math.round(sampleNormal(40, 100));

      // Determine if this keystroke should be a typo
      const isTypo = Math.random() < mistakeRate;

      if (isTypo) {
        // Pick a plausible wrong key (adjacent on QWERTY or random alpha)
        const wrongChar = this.pickAdjacentKey(char);
        const pauseAfterTypo = uniformInt(200, 500);
        const backspaceHold = Math.round(sampleNormal(40, 100));
        const correctionHold = Math.round(sampleNormal(40, 100));

        const correctionSequence = [
          // Pause while noticing the mistake, then backspace
          { key: 'Backspace', delay: pauseAfterTypo, holdDuration: backspaceHold },
          // Re-type the correct character
          { key: char, delay: uniformInt(50, 120), holdDuration: correctionHold },
        ];

        steps.push({
          key: wrongChar,
          delay,
          holdDuration,
          isTypo: true,
          correctionSequence,
        });
      } else {
        steps.push({ key: char, delay, holdDuration });
      }
    }

    return steps;
  }

  // ────────────────────────────────────────────
  // Pauses & dwell
  // ────────────────────────────────────────────

  /**
   * Pre-action pause: sampled from the profile's `pauseBetweenActionsMs` range
   * using a normal distribution so most pauses cluster around the middle.
   *
   * If `importance` is provided, the pause is scaled:
   *   - 'low'    → 0.5× (skim/browse actions)
   *   - 'normal' → 1.0× (default)
   *   - 'high'   → 2.0–3.0× + a hesitation spike for consequential actions
   *
   * The rationale: real humans don't hesitate uniformly. They take longer
   * before clicking "Submit Payment" than before scrolling. Behavioral
   * biometrics systems profile this correlation — if every click has the
   * same pre-pause distribution regardless of target importance, that's
   * itself a bot signal.
   */
  generatePreActionPause(importance: ActionImportance = 'normal'): number {
    const [min, max] = this.profile.pauseBetweenActionsMs;
    const base = sampleNormal(min, max);

    switch (importance) {
      case 'low':
        return Math.round(base * 0.5);
      case 'high': {
        // High-importance actions get a 2–3× base pause plus a small
        // hesitation spike from a second normal draw (simulates "stopping
        // to think"). This produces the long-tail distribution behavioral
        // biometrics systems look for on submit/payment buttons.
        const scaled = base * uniform(2.0, 3.0);
        const hesitation = sampleNormal(200, 800);
        return Math.round(scaled + hesitation);
      }
      case 'normal':
      default:
        return Math.round(base);
    }
  }

  /**
   * Post-action pause: shorter than pre-action (100-400ms).
   */
  generatePostActionPause(): number {
    return Math.round(sampleNormal(100, 400));
  }

  /**
   * Fitts' Law-based movement time estimate for a pointing motion from
   * the current mouse position to a target of width W at distance D.
   *
   * MT = a + b * log2(D / W + 1)
   *
   * Where a and b are device-specific constants. For mouse on desktop:
   *   a ≈ 90 ms  (starting latency)
   *   b ≈ 140 ms (slope of the speed-accuracy tradeoff)
   *
   * These constants are from Card, English & Burr (1978) and have been
   * reconfirmed many times for general mouse use. Fitts' Law is the best-
   * validated model of human motor control for pointing tasks and is
   * exactly what behavioral biometric systems calibrate against. Using
   * it here means our mouse timings match the distribution real users
   * produce.
   *
   * Returns an estimated movement time in milliseconds, clamped to a
   * reasonable range so tiny/huge moves don't produce absurd values.
   */
  fittsLawMovementTime(distancePx: number, targetWidthPx: number): number {
    const a = 90;
    const b = 140;
    const width = Math.max(1, targetWidthPx);
    const indexOfDifficulty = Math.log2(distancePx / width + 1);
    const mt = a + b * indexOfDifficulty;
    return Math.max(120, Math.min(1200, mt));
  }

  /**
   * Estimate how long it would take a human to read a given piece of text,
   * based on the profile's WPM range and an average word length of ~5
   * characters. Used for "reading pause" simulation before clicking a
   * button that follows a block of text the user would plausibly scan
   * (terms of service, error messages, important notices).
   */
  generateReadingPause(textLength: number): number {
    if (textLength <= 0) return 0;
    const [minWpm, maxWpm] = this.profile.readingWpm;
    const wpm = sampleNormal(minWpm, maxWpm);
    const avgCharsPerWord = 5;
    const words = textLength / avgCharsPerWord;
    const minutes = words / wpm;
    const ms = Math.round(minutes * 60 * 1000);
    // Clamp so reading a single word doesn't return 0ms and reading a
    // whole article doesn't pause 30s.
    return Math.max(120, Math.min(8000, ms));
  }

  /**
   * Generate a mouse path that scans left-to-right across a text block
   * like an eye tracker follows reading gaze. Used before clicking a
   * button that follows important copy.
   *
   * Returns a series of mouse positions sweeping across each line of
   * the text block, with short dwells at the end of each line (like
   * a saccade back to the start of the next line).
   */
  generateReadingScanPath(textBox: BoundingBox, lineCount: number): MouseStep[] {
    const steps: MouseStep[] = [];
    const safeLines = Math.max(1, Math.min(20, Math.floor(lineCount)));
    const lineHeight = textBox.height / safeLines;

    for (let lineIdx = 0; lineIdx < safeLines; lineIdx++) {
      const y = textBox.y + lineHeight * (lineIdx + 0.5) + uniform(-2, 2);
      // Start slightly left of the box, end slightly right
      const startX = textBox.x + uniform(5, 20);
      const endX = textBox.x + textBox.width - uniform(10, 40);

      // Sweep from left to right in 3-5 sub-steps
      const sweepSteps = uniformInt(3, 5);
      for (let s = 0; s <= sweepSteps; s++) {
        const t = s / sweepSteps;
        const x = startX + (endX - startX) * t + uniform(-1, 1);
        steps.push({
          x: Math.round(x * 100) / 100,
          y: Math.round(y * 100) / 100,
          delay: Math.round(sampleNormal(40, 100)),
        });
      }

      // Brief dwell at end of line (saccade back)
      if (lineIdx < safeLines - 1) {
        steps.push({
          x: Math.round(endX),
          y: Math.round(y),
          delay: Math.round(sampleNormal(80, 160)),
        });
      }
    }

    return steps;
  }

  /**
   * Click dwell: time the button is held down, sampled from profile range.
   */
  generateClickDwell(): number {
    const [min, max] = this.profile.clickDwellMs;
    return Math.round(sampleNormal(min, max));
  }

  // ────────────────────────────────────────────
  // Scroll simulation
  // ────────────────────────────────────────────

  /**
   * Break a total scroll amount into 3-8 steps with deceleration:
   * larger deltas first, tapering off toward the end (mimicking a
   * flick-then-settle scroll gesture).
   *
   * Delay between steps is 30-100ms, sampled from the profile's scroll speed.
   */
  generateScrollSteps(amount: number, direction: 'up' | 'down'): ScrollStep[] {
    const stepCount = uniformInt(3, 8);
    const sign = direction === 'down' ? 1 : -1;
    const absAmount = Math.abs(amount);

    // Generate raw weights that decrease (deceleration pattern)
    // weight_i = (stepCount - i) + random jitter
    const weights: number[] = [];
    let weightSum = 0;
    for (let i = 0; i < stepCount; i++) {
      const w = (stepCount - i) + uniform(0, 1);
      weights.push(w);
      weightSum += w;
    }

    const [scrollMin, scrollMax] = this.profile.scrollSpeedMs;
    const steps: ScrollStep[] = [];

    for (let i = 0; i < stepCount; i++) {
      const fraction = weights[i] / weightSum;
      const deltaY = Math.round(absAmount * fraction) * sign;
      const delay = Math.round(sampleNormal(
        Math.max(30, scrollMin * 0.2),
        Math.min(100, scrollMax * 0.35),
      ));
      steps.push({ deltaY, delay });
    }

    return steps;
  }

  // ────────────────────────────────────────────
  // Decision helpers
  // ────────────────────────────────────────────

  /**
   * Should the engine paste rather than type? True when text length exceeds
   * the profile's paste threshold.
   */
  shouldPaste(text: string): boolean {
    return text.length > this.profile.pasteThreshold;
  }

  // ────────────────────────────────────────────
  // Click position within a bounding box
  // ────────────────────────────────────────────

  /**
   * Pick a click position inside `box`, biased toward the center via a
   * normal distribution (sigma = dimension/6). A minimum ±2px offset from
   * the exact center prevents pixel-perfect robotic clicks.
   */
  generateClickPosition(box: BoundingBox): Point {
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;

    // Sample from center-biased normal distribution
    let x = sampleNormal(box.x, box.x + box.width);
    let y = sampleNormal(box.y, box.y + box.height);

    // Ensure we never land exactly at center — add minimum offset
    const dx = x - centerX;
    const dy = y - centerY;

    if (Math.abs(dx) < 2) {
      x = centerX + (dx >= 0 ? 2 : -2);
    }
    if (Math.abs(dy) < 2) {
      y = centerY + (dy >= 0 ? 2 : -2);
    }

    // Clamp to box boundaries
    x = Math.max(box.x, Math.min(box.x + box.width, x));
    y = Math.max(box.y, Math.min(box.y + box.height, y));

    return {
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
    };
  }

  // ────────────────────────────────────────────
  // Internal helpers
  // ────────────────────────────────────────────

  /**
   * Pick a plausible "wrong" key for a given character by looking at
   * QWERTY adjacency. Falls back to a random alpha character if the
   * target isn't in the adjacency map.
   */
  private pickAdjacentKey(char: string): string {
    const adjacency: Record<string, string[]> = {
      a: ['s', 'q', 'w', 'z'],
      b: ['v', 'g', 'h', 'n'],
      c: ['x', 'd', 'f', 'v'],
      d: ['s', 'e', 'r', 'f', 'c', 'x'],
      e: ['w', 'r', 'd', 's'],
      f: ['d', 'r', 't', 'g', 'v', 'c'],
      g: ['f', 't', 'y', 'h', 'b', 'v'],
      h: ['g', 'y', 'u', 'j', 'n', 'b'],
      i: ['u', 'o', 'k', 'j'],
      j: ['h', 'u', 'i', 'k', 'n', 'm'],
      k: ['j', 'i', 'o', 'l', 'm'],
      l: ['k', 'o', 'p', ';'],
      m: ['n', 'j', 'k'],
      n: ['b', 'h', 'j', 'm'],
      o: ['i', 'p', 'l', 'k'],
      p: ['o', 'l', '['],
      q: ['w', 'a'],
      r: ['e', 't', 'f', 'd'],
      s: ['a', 'w', 'e', 'd', 'x', 'z'],
      t: ['r', 'y', 'g', 'f'],
      u: ['y', 'i', 'j', 'h'],
      v: ['c', 'f', 'g', 'b'],
      w: ['q', 'e', 's', 'a'],
      x: ['z', 's', 'd', 'c'],
      y: ['t', 'u', 'h', 'g'],
      z: ['a', 's', 'x'],
    };

    const lower = char.toLowerCase();
    const neighbors = adjacency[lower];

    if (neighbors && neighbors.length > 0) {
      const wrong = neighbors[Math.floor(Math.random() * neighbors.length)];
      // Preserve original case
      return char === char.toUpperCase() ? wrong.toUpperCase() : wrong;
    }

    // Fallback: random letter different from the original
    const alpha = 'abcdefghijklmnopqrstuvwxyz';
    let fallback: string;
    do {
      fallback = alpha[Math.floor(Math.random() * alpha.length)];
    } while (fallback === lower);

    return char === char.toUpperCase() ? fallback.toUpperCase() : fallback;
  }
}
