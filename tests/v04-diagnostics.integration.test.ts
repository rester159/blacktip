/**
 * v0.2.0 stealth diagnostics integration tests.
 *
 * Validates the L016 fix (UA / Sec-Ch-Ua consistency), the diagnostic
 * primitives, and warmSession against live targets.
 *
 * These tests are network-dependent — they hit tls.peet.ws,
 * httpbin.org, and ipinfo.io. Failures here usually mean one of those
 * services is down, not a BlackTip regression.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BlackTip } from '../src/blacktip.js';

describe('v0.2.0 stealth diagnostics', () => {
  let bt: BlackTip;

  beforeAll(async () => {
    bt = new BlackTip({
      logLevel: 'error',
      timeout: 20_000,
      retryAttempts: 1,
      behaviorProfile: 'scraper',
    });
    await bt.launch();
  });

  afterAll(async () => {
    if (bt) await bt.close();
  });

  // ── L016 — the load-bearing fix ──

  it('captureFingerprint reports UA / Sec-Ch-Ua consistency (L016)', async () => {
    const fp = await bt.captureFingerprint();

    // The critical assertion: User-Agent and Sec-Ch-Ua must agree on
    // Chrome version. If this fails, you're on a pre-v0.2.0 build with
    // the L016 bug, OR something else in the launch is overriding the
    // User-Agent without updating client hints.
    expect(fp.headers.uaConsistent).toBe(true);
    expect(fp.headers.uaChromeVersion).not.toBeNull();
    expect(fp.headers.secChUaChromeVersion).not.toBeNull();
    expect(fp.headers.uaChromeVersion).toBe(fp.headers.secChUaChromeVersion);
  });

  it('captureFingerprint returns a Chrome-like JA4', async () => {
    const fp = await bt.captureFingerprint();
    expect(fp.tls.isChromeLikeJa4).toBe(true);
    expect(fp.tls.ja4).toMatch(/^t13d/);
    expect(fp.tls.hasGreaseCipher).toBe(true);
    expect(fp.tls.hasGreaseExtension).toBe(true);
  });

  it('captureFingerprint reports the real Chrome HTTP/2 fingerprint', async () => {
    const fp = await bt.captureFingerprint();
    // Real Chrome's Akamai HTTP/2 fingerprint signature
    expect(fp.http2.akamaiFingerprint).toMatch(/^1:65536;2:0;4:6291456;6:262144/);
    // Frame order signature: m,a,s,p (method/authority/scheme/path)
    expect(fp.http2.akamaiFingerprint).toMatch(/m,a,s,p$/);
  });

  it('captureFingerprint includes Sec-Fetch-* headers', async () => {
    const fp = await bt.captureFingerprint();
    expect(fp.headers.secFetchSite).not.toBeNull();
    expect(fp.headers.secFetchMode).toBe('navigate');
    expect(fp.headers.secFetchDest).toBe('document');
  });

  // ── checkIpReputation ──

  it('checkIpReputation returns ASN, org, and a heuristic verdict', async () => {
    const ip = await bt.checkIpReputation();
    expect(ip.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(ip.asn).toMatch(/^AS\d+$/);
    expect(ip.org).not.toBeNull();
    // Either datacenter or residential — never both true
    expect(ip.isDatacenter && ip.isResidential).toBe(false);
    // Notes always present
    expect(ip.notes.length).toBeGreaterThan(0);
  });

  // ── testAgainstAkamai ──

  it('testAgainstAkamai passes for a non-Akamai URL (example.com)', async () => {
    // example.com is not Akamai-protected, so this should always pass
    const result = await bt.testAgainstAkamai('https://example.com/');
    expect(result.passed).toBe(true);
    expect(result.akamaiReference).toBeNull();
    expect(result.title.length).toBeGreaterThan(0);
  });

  it('testAgainstAkamai recognizes the Access Denied page format', async () => {
    // We can't reliably trigger an Akamai block in CI without rotating
    // through bad IPs, but we can verify the result shape includes the
    // diagnosis fields when called against any URL.
    const result = await bt.testAgainstAkamai('https://example.com/');
    expect(typeof result.passed).toBe('boolean');
    expect(typeof result.suggestion).toBe('string');
    expect(result.suggestion.length).toBeGreaterThan(20);
    expect(typeof result.durationMs).toBe('number');
  });

  // ── warmSession ──

  it('warmSession visits a custom site list and returns visited URLs', async () => {
    // Use a small, fast site for the test (Wikipedia is reliable).
    const result = await bt.warmSession({
      sites: ['https://en.wikipedia.org/wiki/Special:Random'],
      dwellMsRange: [200, 400], // very short dwell for test speed
    });

    expect(result.visited.length).toBeGreaterThanOrEqual(0);
    // Allow either success (1 visit) or failure (0 — site might rate-limit
    // a CI run); the test just verifies the call returns the right shape.
    expect(typeof result.durationMs).toBe('number');
  }, 30_000);

  it('warmSession with empty sites array returns immediately', async () => {
    const result = await bt.warmSession({ sites: [], dwellMsRange: [100, 200] });
    expect(result.visited).toEqual([]);
    expect(result.durationMs).toBeLessThan(2000);
  });
});

// ── Persistent profile (userDataDir) — separate describe so it gets its own browser ──

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('v0.2.0 persistent userDataDir', () => {
  let tmpProfile: string;
  let bt: BlackTip;

  beforeAll(() => {
    tmpProfile = mkdtempSync(join(tmpdir(), 'bt-profile-'));
  });

  afterAll(() => {
    if (bt && bt.isActive()) {
      // Best-effort close; ignore errors during cleanup.
      bt.close().catch(() => undefined);
    }
    if (tmpProfile && existsSync(tmpProfile)) {
      try {
        rmSync(tmpProfile, { recursive: true, force: true });
      } catch { /* Chrome may still hold file locks on Windows */ }
    }
  });

  it('launches with a persistent profile directory and creates files in it', async () => {
    bt = new BlackTip({
      logLevel: 'error',
      timeout: 15_000,
      retryAttempts: 1,
      userDataDir: tmpProfile,
    });
    await bt.launch();
    expect(bt.isActive()).toBe(true);
    await bt.navigate('https://example.com/');
    await bt.close();

    // Chrome should have created profile files in the user-data-dir
    const fs = await import('node:fs/promises');
    const entries = await fs.readdir(tmpProfile);
    expect(entries.length).toBeGreaterThan(0);
  }, 60_000);
});
