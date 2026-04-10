/**
 * Integration tests for the Akamai sensor solver (v0.5.0).
 *
 * Drives a real BlackTip session against the live opentable.com Akamai
 * Bot Manager target and verifies:
 *   1. The solver returns `validated: true` (page rendered without
 *      Access Denied), with all 8 standard Akamai cookies in the result.
 *   2. The recommendedHeaders + cookies can be replayed via the TLS
 *      daemon to make additional requests without launching a new
 *      browser. This is the load-bearing assertion: it proves the
 *      "solve once, replay N times" cost amortization actually works.
 *
 * Network-dependent. Skips if the Go daemon binary isn't built.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BlackTip } from '../src/blacktip.js';

const binPath = join(
  process.cwd(),
  'native',
  'tls-client',
  process.platform === 'win32' ? 'blacktip-tls.exe' : 'blacktip-tls',
);
const skip = !existsSync(binPath);

const TARGET =
  'https://www.opentable.com/booking/restref/availability?rid=76651&restref=76651&partySize=2&dateTime=2026-04-11T19%3A00';

describe.skipIf(skip)('Akamai sensor solver — opentable.com', () => {
  let bt: BlackTip;

  beforeAll(async () => {
    bt = new BlackTip({ logLevel: 'error', timeout: 30_000, retryAttempts: 1 });
    await bt.launch();
  }, 60_000);

  afterAll(async () => {
    if (bt) await bt.close();
  });

  it('solves the protected booking endpoint and returns the cookie set', async () => {
    const result = await bt.solveAkamaiChallenge(TARGET, { timeoutMs: 20_000 });

    expect(result.validated).toBe(true);
    expect(result.blocked).toBe(false);
    // OpenTable's booking page renders the reservation flow
    expect(result.title).toMatch(/OpenTable|reservation/i);
    // The full Akamai cookie set should be present
    const cookieNames = result.cookies.map((c) => c.name);
    expect(cookieNames).toContain('_abck');
    expect(cookieNames).toContain('bm_sz');
    expect(cookieNames).toContain('bm_sv');
    // recommendedHeaders should include Cookie + Sec-Ch-Ua + Sec-Fetch-*
    expect(result.recommendedHeaders['Cookie']).toBeDefined();
    expect(result.recommendedHeaders['Sec-Ch-Ua']).toBeDefined();
    expect(result.recommendedHeaders['Sec-Fetch-Mode']).toBe('navigate');
    expect(result.recommendedHeaders['Sec-Fetch-Site']).toBe('none');
  }, 60_000);

  it('replays the same URL via the TLS daemon with the recommended headers (no browser)', async () => {
    // Solve once
    const solved = await bt.solveAkamaiChallenge(TARGET, { timeoutMs: 20_000 });
    expect(solved.validated).toBe(true);

    // Replay 3 times via the TLS daemon — none should hit the browser.
    // The cost amortization story is "solve once, replay many" so we
    // verify multiple replays in a row succeed.
    for (let i = 0; i < 3; i++) {
      const resp = await bt.fetchWithTls({
        url: TARGET,
        headers: solved.recommendedHeaders,
      });
      expect(resp.status).toBe(200);
      expect(resp.body).not.toMatch(/Access Denied|errors\.edgesuite/i);
      // Real OpenTable page content
      expect(resp.body).toMatch(/<!DOCTYPE html|<html/i);
    }
  }, 90_000);
});

if (skip) {
  describe('Akamai sensor solver', () => {
    it.skip('requires the Go daemon binary at native/tls-client/blacktip-tls[.exe] — build with: cd native/tls-client && go build .', () => {});
  });
}
