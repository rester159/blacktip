/**
 * Unit tests for the dataset parsers in src/behavioral/parsers.ts.
 *
 * We don't bundle the real CMU or Balabit datasets — both are
 * non-redistributable. Instead, the fixtures here are tiny hand-crafted
 * snippets that match the published file format byte-for-byte. If a
 * future dataset version changes its column layout, these tests will
 * fail and the parsers can be updated accordingly.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCmuKeystrokeCsv,
  parseBalabitMouseCsv,
  parseGenericTelemetryJson,
  CMU_PHRASE,
} from '../src/behavioral/parsers.js';
import { fitFromSamples, deriveProfileConfig, fitMouseDynamics, fitTypingDynamics } from '../src/behavioral/calibration.js';

describe('parseCmuKeystrokeCsv', () => {
  // Hand-built header matching the CMU DSL-StrongPasswordData.csv layout.
  // Columns in source order: subject, sessionIndex, rep, then for the
  // phrase `.tie5Roanl` followed by Return: H.<key>, DD.<k1>.<k2>, UD.<k1>.<k2>
  // tuples for each adjacent pair.
  const phraseKeys = [...CMU_PHRASE.split(''), 'Return'];
  const cmuKeyLabel = (k: string): string => {
    if (k === '.') return 'period';
    if (k === '5') return 'five';
    if (k === 'R') return 'Shift.r';
    return k;
  };
  const headerCols: string[] = ['subject', 'sessionIndex', 'rep'];
  for (let i = 0; i < phraseKeys.length; i++) {
    headerCols.push(`H.${cmuKeyLabel(phraseKeys[i]!)}`);
    if (i > 0) {
      headerCols.push(`DD.${cmuKeyLabel(phraseKeys[i - 1]!)}.${cmuKeyLabel(phraseKeys[i]!)}`);
      headerCols.push(`UD.${cmuKeyLabel(phraseKeys[i - 1]!)}.${cmuKeyLabel(phraseKeys[i]!)}`);
    }
  }

  // One subject, one rep — hold = 0.10s on each key, UD flight = 0.15s on each transition.
  const buildRow = (): string => {
    const cells: string[] = ['s002', '1', '1'];
    for (let i = 0; i < phraseKeys.length; i++) {
      cells.push('0.10'); // H.key
      if (i > 0) {
        cells.push('0.25'); // DD (down-down)
        cells.push('0.15'); // UD (up-down) — flight time we read
      }
    }
    return cells.join(',');
  };

  const csv = [headerCols.join(','), buildRow(), buildRow()].join('\n');

  it('parses two rows into two TypingSessions', () => {
    const sessions = parseCmuKeystrokeCsv(csv);
    expect(sessions.length).toBe(2);
    expect(sessions[0]!.phrase).toBe(CMU_PHRASE);
  });

  it('produces 11 keystrokes per session (10 phrase chars + Return)', () => {
    const sessions = parseCmuKeystrokeCsv(csv);
    expect(sessions[0]!.keystrokes.length).toBe(11);
  });

  it('converts seconds to milliseconds for hold and flight times', () => {
    const sessions = parseCmuKeystrokeCsv(csv);
    const ks = sessions[0]!.keystrokes;
    // Hold: 0.10s → 100ms
    expect(ks[0]!.holdTimeMs).toBeCloseTo(100, 1);
    // First key has no flight (no previous keystroke)
    expect(ks[0]!.flightTimeMs).toBe(0);
    // Subsequent keys have UD flight time: 0.15s → 150ms
    expect(ks[1]!.flightTimeMs).toBeCloseTo(150, 1);
    expect(ks[5]!.flightTimeMs).toBeCloseTo(150, 1);
  });

  it('returns empty array on header-only input', () => {
    expect(parseCmuKeystrokeCsv(headerCols.join(','))).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const crlf = csv.replace(/\n/g, '\r\n');
    expect(parseCmuKeystrokeCsv(crlf).length).toBe(2);
  });

  it('feeds end-to-end through fitTypingDynamics with realistic output', () => {
    const sessions = parseCmuKeystrokeCsv(csv);
    const fit = fitTypingDynamics(sessions);
    // We fed all 100ms holds — fitted distribution should center there.
    expect(fit.holdTime.mean).toBeCloseTo(100, 0);
    // All flights are 150ms (except the leading 0s from each session start);
    // mean is somewhere between 0 and 150.
    expect(fit.flightTime.mean).toBeGreaterThan(0);
    expect(fit.flightTime.mean).toBeLessThanOrEqual(150);
  });
});

describe('parseBalabitMouseCsv', () => {
  // Two synthetic movements: each is a sequence of Move rows ending in
  // Pressed. Format matches the published Balabit session CSV layout.
  const csv = [
    'record_timestamp,client_timestamp,button,state,x,y',
    // Movement 1: 5 moves to (820,440) ending in a Left press
    '1424866316.93,0.000,NoButton,Move,1192,529',
    '1424866316.99,0.064,NoButton,Move,1100,510',
    '1424866317.05,0.128,NoButton,Move,1000,490',
    '1424866317.11,0.192,NoButton,Move,900,460',
    '1424866317.17,0.256,NoButton,Move,820,440',
    '1424866317.84,0.911,Left,Pressed,820,440',
    // Released — should be ignored
    '1424866317.95,1.022,Left,Released,820,440',
    // Movement 2: 3 moves to (300,200), no press at end
    '1424866318.50,1.500,NoButton,Move,500,300',
    '1424866318.56,1.564,NoButton,Move,400,250',
    '1424866318.62,1.628,NoButton,Move,300,200',
  ].join('\n');

  it('parses two movements', () => {
    const movements = parseBalabitMouseCsv(csv);
    expect(movements.length).toBe(2);
  });

  it('marks the first movement as endedWithClick: true', () => {
    const movements = parseBalabitMouseCsv(csv);
    expect(movements[0]!.endedWithClick).toBe(true);
    expect(movements[1]!.endedWithClick).toBe(false);
  });

  it('normalizes timestamps to milliseconds-since-movement-start', () => {
    const movements = parseBalabitMouseCsv(csv);
    expect(movements[0]!.samples[0]!.timestampMs).toBe(0);
    // Last sample of movement 1 (the Pressed event) — clientTs 0.911s
    // minus start 0s = 911ms
    const lastIdx = movements[0]!.samples.length - 1;
    expect(movements[0]!.samples[lastIdx]!.timestampMs).toBeCloseTo(911, 0);
  });

  it('records target coordinates on the press sample', () => {
    const movements = parseBalabitMouseCsv(csv);
    const press = movements[0]!.samples[movements[0]!.samples.length - 1]!;
    expect(press.targetX).toBe(820);
    expect(press.targetY).toBe(440);
  });

  it('handles header-less input', () => {
    const noHeader = csv.split('\n').slice(1).join('\n');
    const movements = parseBalabitMouseCsv(noHeader);
    expect(movements.length).toBe(2);
  });

  it('feeds end-to-end through fitMouseDynamics without throwing', () => {
    const movements = parseBalabitMouseCsv(csv);
    const fit = fitMouseDynamics(movements);
    expect(fit.fittsA).toBeTypeOf('number');
    expect(fit.fittsB).toBeTypeOf('number');
    expect(fit.pathCurvatureRatio.sampleCount).toBeGreaterThan(0);
  });
});

describe('parseGenericTelemetryJson', () => {
  it('parses both fields when present', () => {
    const json = JSON.stringify({
      movements: [{ samples: [{ timestampMs: 0, x: 0, y: 0 }, { timestampMs: 100, x: 50, y: 50 }], endedWithClick: false }],
      sessions: [{ keystrokes: [{ key: 'a', flightTimeMs: 0, holdTimeMs: 80 }] }],
    });
    const out = parseGenericTelemetryJson(json);
    expect(out.movements.length).toBe(1);
    expect(out.sessions.length).toBe(1);
  });

  it('defaults missing fields to empty arrays', () => {
    expect(parseGenericTelemetryJson('{}')).toEqual({ movements: [], sessions: [] });
    expect(parseGenericTelemetryJson('{"movements":[]}').sessions).toEqual([]);
  });
});

describe('end-to-end calibration via parsers + fitFromSamples', () => {
  it('CMU CSV → CalibratedProfile → ProfileConfig usable by BehavioralEngine', () => {
    // Build a tiny CMU-shaped CSV with 5 rows so the fitters have enough samples.
    const phraseKeys = [...CMU_PHRASE.split(''), 'Return'];
    const cmuKeyLabel = (k: string): string => {
    if (k === '.') return 'period';
    if (k === '5') return 'five';
    if (k === 'R') return 'Shift.r';
    return k;
  };
    const headerCols: string[] = ['subject', 'sessionIndex', 'rep'];
    for (let i = 0; i < phraseKeys.length; i++) {
      headerCols.push(`H.${cmuKeyLabel(phraseKeys[i]!)}`);
      if (i > 0) {
        headerCols.push(`DD.${cmuKeyLabel(phraseKeys[i - 1]!)}.${cmuKeyLabel(phraseKeys[i]!)}`);
        headerCols.push(`UD.${cmuKeyLabel(phraseKeys[i - 1]!)}.${cmuKeyLabel(phraseKeys[i]!)}`);
      }
    }
    const rows: string[] = [headerCols.join(',')];
    for (let r = 0; r < 5; r++) {
      const cells: string[] = ['s002', '1', String(r + 1)];
      const jitter = (r * 0.005);
      for (let i = 0; i < phraseKeys.length; i++) {
        cells.push(String(0.10 + jitter));
        if (i > 0) {
          cells.push(String(0.25 + jitter));
          cells.push(String(0.15 + jitter));
        }
      }
      rows.push(cells.join(','));
    }
    const csv = rows.join('\n');

    const sessions = parseCmuKeystrokeCsv(csv);
    expect(sessions.length).toBe(5);

    const profile = fitFromSamples('cmu-test', 'CMU Keystroke Dynamics (synthetic fixture)', [], sessions);
    expect(profile.typing.holdTime.mean).toBeGreaterThan(95);
    expect(profile.typing.holdTime.mean).toBeLessThan(130);
    expect(profile.profileConfig.typingSpeedMs[0]).toBeGreaterThanOrEqual(0);
    expect(profile.profileConfig.typingSpeedMs[1]).toBeGreaterThanOrEqual(profile.profileConfig.typingSpeedMs[0]);

    // The derived ProfileConfig should be a valid shape.
    const cfg = deriveProfileConfig(profile.mouse, profile.typing);
    expect(cfg.mistakeRate).toBeGreaterThan(0);
    expect(cfg.mistakeRate).toBeLessThan(1);
  });
});
