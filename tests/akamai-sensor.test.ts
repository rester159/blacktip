/**
 * Unit tests for the Akamai sensor solver helpers.
 *
 * The end-to-end browser-driving solver test lives in
 * `tests/akamai-sensor.integration.test.ts` and requires a live network
 * connection to opentable.com. This file covers the pure-function
 * helpers that don't need a browser.
 */

import { describe, it, expect } from 'vitest';
import { parseAbckState } from '../src/akamai-sensor.js';

describe('parseAbckState', () => {
  it('returns -1 for an unvalidated cookie (Akamai\'s initial state)', () => {
    expect(parseAbckState('7B308038A3E417AE2DB148140BB1E891~-1~YAAQWAw0FzLoklCdAQAA2ueceQ9Bk39nWTzgEChLZE0v')).toBe(-1);
  });

  it('returns 0 for a validated cookie', () => {
    expect(parseAbckState('7B308038A3E417AE2DB148140BB1E891~0~YAAQWAw0FzLoklCdAQAA2ueceQ9Bk39nWTzgEChLZE0v')).toBe(0);
  });

  it('returns 1 for a flagged cookie', () => {
    expect(parseAbckState('7B308038A3E417AE2DB148140BB1E891~1~YAAQWAw0FzLoklCdAQAA2ueceQ9Bk39nWTzgEChLZE0v')).toBe(1);
  });

  it('treats higher flagged values (2, 3) as flagged (1)', () => {
    expect(parseAbckState('hash~2~data')).toBe(1);
    expect(parseAbckState('hash~3~data')).toBe(1);
  });

  it('returns null for null input', () => {
    expect(parseAbckState(null)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseAbckState('')).toBeNull();
  });

  it('returns null when the cookie has only one tilde-delimited field', () => {
    expect(parseAbckState('justahash')).toBeNull();
  });

  it('returns null when the state field is non-numeric', () => {
    expect(parseAbckState('hash~bogus~data')).toBeNull();
  });
});
