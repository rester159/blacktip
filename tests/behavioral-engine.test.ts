import { describe, it, expect } from 'vitest';
import {
  BehavioralEngine,
  HUMAN_PROFILE,
  sampleNormal,
} from '../src/behavioral-engine.js';
import type { ProfileConfig } from '../src/types.js';

const engine = new BehavioralEngine(HUMAN_PROFILE);

// ── Mouse path generation ──

describe('generateMousePath', () => {
  it('path starts near the from point and ends near the to point (within jitter ±5px)', () => {
    const from = { x: 100, y: 100 };
    const to = { x: 500, y: 400 };
    const path = engine.generateMousePath(from, to);

    const first = path[0];
    const last = path[path.length - 1];

    expect(Math.abs(first.x - from.x)).toBeLessThanOrEqual(5);
    expect(Math.abs(first.y - from.y)).toBeLessThanOrEqual(5);
    expect(Math.abs(last.x - to.x)).toBeLessThanOrEqual(5);
    expect(Math.abs(last.y - to.y)).toBeLessThanOrEqual(5);
  });

  it('path has a reasonable number of steps (10-60)', () => {
    const path = engine.generateMousePath({ x: 0, y: 0 }, { x: 300, y: 200 });
    expect(path.length).toBeGreaterThanOrEqual(10);
    expect(path.length).toBeLessThanOrEqual(60);
  });

  it('all steps have positive delays', () => {
    const path = engine.generateMousePath({ x: 50, y: 50 }, { x: 400, y: 300 });
    for (const step of path) {
      expect(step.delay).toBeGreaterThan(0);
    }
  });

  it('path length is longer than straight-line distance (Bezier curves)', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 600, y: 400 };
    const path = engine.generateMousePath(from, to);

    const straightLine = Math.sqrt(
      (to.x - from.x) ** 2 + (to.y - from.y) ** 2,
    );

    let pathLength = 0;
    for (let i = 1; i < path.length; i++) {
      const dx = path[i].x - path[i - 1].x;
      const dy = path[i].y - path[i - 1].y;
      pathLength += Math.sqrt(dx * dx + dy * dy);
    }

    expect(pathLength).toBeGreaterThan(straightLine);
  });

  it('no two consecutive steps are identical', () => {
    const path = engine.generateMousePath({ x: 10, y: 10 }, { x: 800, y: 600 });
    for (let i = 1; i < path.length; i++) {
      const same = path[i].x === path[i - 1].x && path[i].y === path[i - 1].y;
      expect(same).toBe(false);
    }
  });

  it('long distances (>500px) generate more steps than short distances (<100px)', () => {
    const shortPath = engine.generateMousePath({ x: 0, y: 0 }, { x: 50, y: 50 });
    const longPath = engine.generateMousePath({ x: 0, y: 0 }, { x: 800, y: 600 });
    expect(longPath.length).toBeGreaterThanOrEqual(shortPath.length);
  });
});

// ── Typing sequence ──

describe('generateTypingSequence', () => {
  it('generates one keystroke step per character (plus typo corrections)', () => {
    const noTypoProfile: ProfileConfig = { ...HUMAN_PROFILE, mistakeRate: 0 };
    const noTypoEngine = new BehavioralEngine(noTypoProfile);
    const text = 'hello world';
    const steps = noTypoEngine.generateTypingSequence(text);
    expect(steps.length).toBe(text.length);
  });

  it('all delays are positive', () => {
    const steps = engine.generateTypingSequence('testing delays');
    for (const step of steps) {
      expect(step.delay).toBeGreaterThan(0);
    }
  });

  it('all hold durations are positive and within reasonable range (20-200ms)', () => {
    const steps = engine.generateTypingSequence('a reasonable string to type');
    for (const step of steps) {
      expect(step.holdDuration).toBeGreaterThanOrEqual(20);
      expect(step.holdDuration).toBeLessThanOrEqual(200);
    }
  });

  it('common digraphs have shorter average delays than uncommon characters', () => {
    // Use a no-typo engine to isolate delay differences
    const noTypoEngine = new BehavioralEngine({ ...HUMAN_PROFILE, mistakeRate: 0 });

    // Generate many samples for statistical reliability
    const digraphDelays: number[] = [];
    const uncommonDelays: number[] = [];

    for (let run = 0; run < 50; run++) {
      // "th" is a common digraph -- measure delay of the 'h' after 't'
      const digraphSteps = noTypoEngine.generateTypingSequence('th');
      digraphDelays.push(digraphSteps[1].delay);

      // "@" is uncommon
      const uncommonSteps = noTypoEngine.generateTypingSequence('a@');
      uncommonDelays.push(uncommonSteps[1].delay);
    }

    const avgDigraph = digraphDelays.reduce((a, b) => a + b, 0) / digraphDelays.length;
    const avgUncommon = uncommonDelays.reduce((a, b) => a + b, 0) / uncommonDelays.length;

    expect(avgDigraph).toBeLessThan(avgUncommon);
  });

  it('when mistakeRate > 0, some sequences contain typos (high rate for reliability)', () => {
    const typoProfile: ProfileConfig = { ...HUMAN_PROFILE, mistakeRate: 0.5 };
    const typoEngine = new BehavioralEngine(typoProfile);

    let sequencesWithTypos = 0;
    const runs = 20;

    for (let i = 0; i < runs; i++) {
      const steps = typoEngine.generateTypingSequence('abcdefghij');
      if (steps.some(s => s.isTypo)) {
        sequencesWithTypos++;
      }
    }

    // With 50% mistake rate on 10 chars, virtually all runs should have at least one typo
    expect(sequencesWithTypos).toBeGreaterThan(runs * 0.5);
  });

  it('typo steps have correctionSequence with backspace', () => {
    const typoProfile: ProfileConfig = { ...HUMAN_PROFILE, mistakeRate: 0.5 };
    const typoEngine = new BehavioralEngine(typoProfile);

    // Generate enough text to virtually guarantee a typo
    let typoStep = null;
    for (let attempt = 0; attempt < 20 && !typoStep; attempt++) {
      const steps = typoEngine.generateTypingSequence('abcdefghijklmnop');
      typoStep = steps.find(s => s.isTypo) ?? null;
    }

    expect(typoStep).not.toBeNull();
    expect(typoStep!.correctionSequence).toBeDefined();
    expect(typoStep!.correctionSequence!.length).toBe(2);
    expect(typoStep!.correctionSequence![0].key).toBe('Backspace');
  });
});

// ── Pause generation ──

describe('pause generation', () => {
  it('generatePreActionPause returns values within profile pauseBetweenActionsMs range (with tolerance)', () => {
    const [min, max] = HUMAN_PROFILE.pauseBetweenActionsMs;
    for (let i = 0; i < 100; i++) {
      const pause = engine.generatePreActionPause();
      expect(pause).toBeGreaterThanOrEqual(min * 0.8);
      expect(pause).toBeLessThanOrEqual(max * 1.2);
    }
  });

  it('generatePostActionPause returns positive values', () => {
    for (let i = 0; i < 100; i++) {
      const pause = engine.generatePostActionPause();
      expect(pause).toBeGreaterThan(0);
    }
  });

  it('generateClickDwell returns values within profile clickDwellMs range (with tolerance)', () => {
    const [min, max] = HUMAN_PROFILE.clickDwellMs;
    for (let i = 0; i < 100; i++) {
      const dwell = engine.generateClickDwell();
      expect(dwell).toBeGreaterThanOrEqual(min * 0.8);
      expect(dwell).toBeLessThanOrEqual(max * 1.2);
    }
  });
});

// ── Scroll steps ──

describe('generateScrollSteps', () => {
  it('total deltaY approximately equals the requested amount (within 10%)', () => {
    const amount = 500;
    const steps = engine.generateScrollSteps(amount, 'down');
    const total = steps.reduce((sum, s) => sum + s.deltaY, 0);
    expect(Math.abs(total - amount)).toBeLessThanOrEqual(amount * 0.1);
  });

  it('steps have deceleration pattern (first step deltaY >= last step deltaY)', () => {
    const steps = engine.generateScrollSteps(600, 'down');
    expect(Math.abs(steps[0].deltaY)).toBeGreaterThanOrEqual(
      Math.abs(steps[steps.length - 1].deltaY),
    );
  });

  it('all delays are positive', () => {
    const steps = engine.generateScrollSteps(300, 'up');
    for (const step of steps) {
      expect(step.delay).toBeGreaterThan(0);
    }
  });

  it('generates 3-10 steps', () => {
    // Run multiple times since step count is random
    for (let i = 0; i < 20; i++) {
      const steps = engine.generateScrollSteps(400, 'down');
      expect(steps.length).toBeGreaterThanOrEqual(3);
      expect(steps.length).toBeLessThanOrEqual(10);
    }
  });
});

// ── Click position ──

describe('generateClickPosition', () => {
  const box = { x: 100, y: 200, width: 200, height: 100 };

  it('generated point is within the bounding box', () => {
    for (let i = 0; i < 50; i++) {
      const point = engine.generateClickPosition(box);
      expect(point.x).toBeGreaterThanOrEqual(box.x);
      expect(point.x).toBeLessThanOrEqual(box.x + box.width);
      expect(point.y).toBeGreaterThanOrEqual(box.y);
      expect(point.y).toBeLessThanOrEqual(box.y + box.height);
    }
  });

  it('multiple calls generate different points (not always center)', () => {
    const points = Array.from({ length: 10 }, () =>
      engine.generateClickPosition(box),
    );
    const uniqueX = new Set(points.map(p => p.x));
    expect(uniqueX.size).toBeGreaterThan(1);
  });

  it('points cluster near center (>50% within inner 50% of box)', () => {
    const innerMinX = box.x + box.width * 0.25;
    const innerMaxX = box.x + box.width * 0.75;
    const innerMinY = box.y + box.height * 0.25;
    const innerMaxY = box.y + box.height * 0.75;

    let insideCount = 0;
    const samples = 100;

    for (let i = 0; i < samples; i++) {
      const point = engine.generateClickPosition(box);
      if (
        point.x >= innerMinX &&
        point.x <= innerMaxX &&
        point.y >= innerMinY &&
        point.y <= innerMaxY
      ) {
        insideCount++;
      }
    }

    expect(insideCount).toBeGreaterThan(samples * 0.5);
  });
});

// ── Paste threshold ──

describe('shouldPaste', () => {
  it('returns false for short strings (below threshold)', () => {
    expect(engine.shouldPaste('hi')).toBe(false);
  });

  it('returns true for long strings (above threshold)', () => {
    const longText = 'a'.repeat(HUMAN_PROFILE.pasteThreshold + 10);
    expect(engine.shouldPaste(longText)).toBe(true);
  });
});

// ── Normal distribution sampling ──

describe('sampleNormal', () => {
  it('mean is close to midpoint (within 10%) and all values within [min, max]', () => {
    const min = 100;
    const max = 200;
    const midpoint = (min + max) / 2;
    const samples: number[] = [];

    for (let i = 0; i < 1000; i++) {
      const s = sampleNormal(min, max);
      expect(s).toBeGreaterThanOrEqual(min);
      expect(s).toBeLessThanOrEqual(max);
      samples.push(s);
    }

    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const tolerance = (max - min) * 0.1;
    expect(Math.abs(mean - midpoint)).toBeLessThanOrEqual(tolerance);
  });
});
