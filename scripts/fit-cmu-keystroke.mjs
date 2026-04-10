#!/usr/bin/env node
/**
 * Fit a behavioral profile against the real CMU Keystroke Dynamics
 * dataset and report a held-out validation result.
 *
 * This is the v0.3.0 calibration validation script. It:
 *
 *   1. Loads `data/cmu-keystroke/DSL-StrongPasswordData.csv` (51 subjects
 *      × 8 sessions × 50 reps = 20,400 phrases of `.tie5Roanl`).
 *   2. Splits subjects 80/20 into training and held-out sets.
 *   3. Fits a `CalibratedProfile` against the training subjects.
 *   4. Reports the fitted distribution parameters.
 *   5. Computes a Kolmogorov–Smirnov-style distribution-similarity score
 *      (max CDF distance) of the fit against (a) the training set,
 *      (b) the held-out set, and (c) BlackTip's canonical HUMAN_PROFILE.
 *      A good fit beats the canonical profile on the held-out set.
 *   6. Writes the resulting profile to
 *      `data/cmu-keystroke/calibrated-profile.json` so users can load
 *      it in their own code without re-running the fit every time.
 *
 * Run with: node scripts/fit-cmu-keystroke.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCmuKeystrokeCsv } from '../dist/behavioral/parsers.js';
import { fitTypingDynamics, fitMouseDynamics, deriveProfileConfig } from '../dist/behavioral/calibration.js';
import { HUMAN_PROFILE } from '../dist/behavioral-engine.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const csvPath = join(root, 'data', 'cmu-keystroke', 'DSL-StrongPasswordData.csv');
const outPath = join(root, 'data', 'cmu-keystroke', 'calibrated-profile.json');

console.log('Loading CMU CSV from', csvPath);
const csv = readFileSync(csvPath, 'utf-8');
const allSessions = parseCmuKeystrokeCsv(csv);
console.log(`Parsed ${allSessions.length} typing sessions (each is one rep of .tie5Roanl)`);

if (allSessions.length === 0) {
  console.error('No sessions parsed — check CSV format');
  process.exit(1);
}

// The phrase has 11 keys; sanity check the first session.
const first = allSessions[0];
console.log(`First session: ${first.keystrokes.length} keystrokes, phrase=${first.phrase}`);
if (first.keystrokes.length !== 11) {
  console.error(`Expected 11 keystrokes per session, got ${first.keystrokes.length}`);
  process.exit(1);
}

// CMU subjects are encoded in the source CSV but not exposed by the
// parser (which throws away subject IDs). For an honest 80/20 train/test
// split we re-read the CSV's first column ourselves.
const lines = csv.trim().split(/\r?\n/);
const subjectsInOrder = lines.slice(1).map((l) => l.split(',')[0]);
const uniqueSubjects = [...new Set(subjectsInOrder)];
console.log(`Found ${uniqueSubjects.length} unique subjects`);

// Deterministic 80/20 split — sort then slice, so re-runs are stable.
const trainSubjects = new Set(uniqueSubjects.slice(0, Math.floor(uniqueSubjects.length * 0.8)));
const testSubjects = new Set(uniqueSubjects.slice(Math.floor(uniqueSubjects.length * 0.8)));
console.log(`Train: ${trainSubjects.size} subjects, Test: ${testSubjects.size} subjects`);

const trainSessions = [];
const testSessions = [];
for (let i = 0; i < allSessions.length; i++) {
  const subj = subjectsInOrder[i];
  if (trainSubjects.has(subj)) trainSessions.push(allSessions[i]);
  else if (testSubjects.has(subj)) testSessions.push(allSessions[i]);
}
console.log(`Train sessions: ${trainSessions.length}, Test sessions: ${testSessions.length}`);

// Fit
console.log('\nFitting typing dynamics on training set...');
const trainTyping = fitTypingDynamics(trainSessions);
console.log(`  Hold time:   mean=${trainTyping.holdTime.mean.toFixed(1)}ms  p5=${trainTyping.holdTime.p5.toFixed(1)}  p50=${trainTyping.holdTime.p50.toFixed(1)}  p95=${trainTyping.holdTime.p95.toFixed(1)}`);
console.log(`  Flight time: mean=${trainTyping.flightTime.mean.toFixed(1)}ms  p5=${trainTyping.flightTime.p5.toFixed(1)}  p50=${trainTyping.flightTime.p50.toFixed(1)}  p95=${trainTyping.flightTime.p95.toFixed(1)}`);
console.log(`  Digraphs fit: ${Object.keys(trainTyping.digraphFlightTime).length}`);
console.log(`  Mistake rate: ${(trainTyping.mistakeRate * 100).toFixed(2)}%`);

// Mouse fit isn't applicable to CMU keystroke data — leave it at the
// canonical defaults so the derived ProfileConfig is well-formed.
const mouseFit = fitMouseDynamics([]);

// Held-out evaluation: extract raw flight and hold samples from each set,
// then compare empirical CDFs.
const flightsFromSessions = (sessions) => {
  const out = [];
  for (const s of sessions) for (let i = 1; i < s.keystrokes.length; i++) out.push(s.keystrokes[i].flightTimeMs);
  return out;
};
const holdsFromSessions = (sessions) => {
  const out = [];
  for (const s of sessions) for (const k of s.keystrokes) out.push(k.holdTimeMs);
  return out;
};

const ksDistance = (a, b) => {
  // Empirical KS distance: max |F_a(x) - F_b(x)| over the merged sample set.
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  const all = [...new Set([...sortedA, ...sortedB])].sort((x, y) => x - y);
  const cdf = (sorted, x) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= x) lo = mid + 1; else hi = mid; }
    return lo / sorted.length;
  };
  let maxDiff = 0;
  for (const x of all) {
    const d = Math.abs(cdf(sortedA, x) - cdf(sortedB, x));
    if (d > maxDiff) maxDiff = d;
  }
  return maxDiff;
};

const trainFlights = flightsFromSessions(trainSessions);
const testFlights = flightsFromSessions(testSessions);
const trainHolds = holdsFromSessions(trainSessions);
const testHolds = holdsFromSessions(testSessions);

// Synthesize samples from BlackTip's canonical profile to compare against.
// HUMAN_PROFILE.typingSpeedMs is a [min, max] uniform-ish range — sample
// 5000 values uniformly to build a synthetic distribution.
const sampleUniform = (lo, hi, n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(lo + Math.random() * (hi - lo));
  return out;
};
const canonicalFlights = sampleUniform(HUMAN_PROFILE.typingSpeedMs[0], HUMAN_PROFILE.typingSpeedMs[1], 5000);
const canonicalHolds = sampleUniform(HUMAN_PROFILE.clickDwellMs?.[0] ?? 40, HUMAN_PROFILE.clickDwellMs?.[1] ?? 100, 5000);

// Synthesize "calibrated" samples from the fitted distribution by
// sampling within [p5, p95]. This mirrors what BehavioralEngine will
// actually emit when configured with the fitted ProfileConfig.
const calibratedFlights = sampleUniform(trainTyping.flightTime.p5, trainTyping.flightTime.p95, 5000);
const calibratedHolds = sampleUniform(trainTyping.holdTime.p5, trainTyping.holdTime.p95, 5000);

const ksCanonicalFlight = ksDistance(testFlights, canonicalFlights);
const ksCalibratedFlight = ksDistance(testFlights, calibratedFlights);
const ksCanonicalHold = ksDistance(testHolds, canonicalHolds);
const ksCalibratedHold = ksDistance(testHolds, calibratedHolds);

console.log('\n=== Held-out KS distance (lower = closer to real human distribution) ===');
console.log(`Flight time:`);
console.log(`  Canonical HUMAN_PROFILE [${HUMAN_PROFILE.typingSpeedMs[0]}, ${HUMAN_PROFILE.typingSpeedMs[1]}]ms:  KS=${ksCanonicalFlight.toFixed(4)}`);
console.log(`  Calibrated [p5=${trainTyping.flightTime.p5.toFixed(0)}, p95=${trainTyping.flightTime.p95.toFixed(0)}]ms:        KS=${ksCalibratedFlight.toFixed(4)}`);
console.log(`  Improvement: ${(ksCanonicalFlight - ksCalibratedFlight).toFixed(4)} (${((1 - ksCalibratedFlight / ksCanonicalFlight) * 100).toFixed(1)}% closer)`);
console.log(`Hold time:`);
console.log(`  Canonical clickDwellMs [${HUMAN_PROFILE.clickDwellMs?.[0]}, ${HUMAN_PROFILE.clickDwellMs?.[1]}]ms:  KS=${ksCanonicalHold.toFixed(4)}`);
console.log(`  Calibrated [p5=${trainTyping.holdTime.p5.toFixed(0)}, p95=${trainTyping.holdTime.p95.toFixed(0)}]ms:           KS=${ksCalibratedHold.toFixed(4)}`);
console.log(`  Improvement: ${(ksCanonicalHold - ksCalibratedHold).toFixed(4)} (${((1 - ksCalibratedHold / ksCanonicalHold) * 100).toFixed(1)}% closer)`);

const profileConfig = deriveProfileConfig(mouseFit, trainTyping);
const calibrated = {
  name: 'cmu-keystroke-2009',
  source: 'CMU Keystroke Dynamics dataset (Killourhy & Maxion 2009), 80% subject train split',
  fittedAt: new Date().toISOString(),
  trainSubjects: trainSubjects.size,
  testSubjects: testSubjects.size,
  trainSessions: trainSessions.length,
  testSessions: testSessions.length,
  validation: {
    flightTime: {
      canonicalKsDistance: ksCanonicalFlight,
      calibratedKsDistance: ksCalibratedFlight,
      improvementRatio: 1 - ksCalibratedFlight / ksCanonicalFlight,
    },
    holdTime: {
      canonicalKsDistance: ksCanonicalHold,
      calibratedKsDistance: ksCalibratedHold,
      improvementRatio: 1 - ksCalibratedHold / ksCanonicalHold,
    },
  },
  fits: {
    typing: trainTyping,
  },
  profileConfig,
};

writeFileSync(outPath, JSON.stringify(calibrated, null, 2));
console.log(`\nWrote calibrated profile to ${outPath}`);
console.log(`\nUse it via:`);
console.log(`  import calibrated from './data/cmu-keystroke/calibrated-profile.json' with { type: 'json' };`);
console.log(`  const bt = new BlackTip({ behaviorProfile: calibrated.profileConfig });`);
