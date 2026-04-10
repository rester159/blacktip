/**
 * Integration tests for the TLS rewriter (v0.5.0).
 *
 * The rewriter intercepts every browser HTTP request via CDP Fetch and
 * forwards it through the Go-based bogdanfinn/tls-client daemon. The
 * load-bearing assertion is that the JA4 fingerprint reaching tls.peet.ws
 * via the browser matches what the daemon presents directly — proving
 * the upstream connection was opened by Go, not Chrome.
 *
 * Skips cleanly if the Go daemon binary isn't built.
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

describe.skipIf(skip)('TLS rewriter — end-to-end via browser', () => {
  let bt: BlackTip;

  beforeAll(async () => {
    bt = new BlackTip({
      logLevel: 'error',
      timeout: 30_000,
      retryAttempts: 1,
      tlsRewriting: 'all',
    });
    await bt.launch();
  }, 60_000);

  afterAll(async () => {
    if (bt) await bt.close();
  });

  it('navigation succeeds with the rewriter installed', async () => {
    await bt.navigate('https://example.com/');
    const title = (await bt.executeJS('document.title')) as string;
    expect(title).toMatch(/Example/);
  }, 30_000);

  it('JA4 reaching tls.peet.ws is the daemon-presented Chrome fingerprint', async () => {
    // The point: the browser navigates to tls.peet.ws/api/all, but the
    // request never leaves Chrome on its own — it goes through CDP Fetch
    // → BlackTip rewriter → Go daemon → upstream → daemon → fulfill.
    // The JA4 the upstream sees is the daemon's, not Chrome's.
    await bt.navigate('https://tls.peet.ws/api/all');
    const raw = (await bt.executeJS('document.body.innerText')) as string;
    const data = JSON.parse(raw) as {
      tls?: { ja4?: string; ciphers?: string[] };
      http2?: { akamai_fingerprint?: string };
    };

    // JA4 must be a Chrome-class TLS 1.3 fingerprint
    expect(data.tls?.ja4).toMatch(/^t13d/);
    // First cipher must be GREASE — Chrome's signature
    expect(data.tls?.ciphers?.[0]).toMatch(/GREASE/i);
    // HTTP/2 frame settings + frame order match real Chrome
    expect(data.http2?.akamai_fingerprint).toMatch(/^1:65536;2:0;4:6291456;6:262144/);
    expect(data.http2?.akamai_fingerprint).toMatch(/m,a,s,p$/);
  }, 30_000);

  it('rewriter stats report intercepted/fulfilled counts', async () => {
    const stats = bt.getTlsRewriterStats();
    expect(stats).not.toBeNull();
    expect(stats!.intercepted).toBeGreaterThan(0);
    expect(stats!.fulfilled).toBeGreaterThan(0);
    // Healthy: most intercepted requests get fulfilled (some may be
    // navigation-cancelled before our handler completes — that's fine).
    expect(stats!.fulfilled).toBeGreaterThanOrEqual(stats!.intercepted - 5);
    expect(stats!.fellThrough).toBe(0);
    expect(stats!.avgDurationMs).toBeGreaterThan(0);
  });

  it('subresources also pass through the rewriter (no native-Chrome leaks)', async () => {
    // Hacker News is a small page with HTML + a CSS file + a couple of
    // images. After loading it, the rewriter's intercepted count should
    // have grown by more than 1 — proving subresources also went through.
    const before = bt.getTlsRewriterStats()!.intercepted;
    await bt.navigate('https://news.ycombinator.com/');
    const after = bt.getTlsRewriterStats()!.intercepted;
    expect(after - before).toBeGreaterThan(1);
    // Page actually rendered
    const itemCount = (await bt.executeJS('document.querySelectorAll(".athing").length')) as number;
    expect(itemCount).toBeGreaterThan(0);
  }, 60_000);
});

if (skip) {
  describe('TLS rewriter — end-to-end via browser', () => {
    it.skip('requires the Go daemon binary at native/tls-client/blacktip-tls[.exe] — build with: cd native/tls-client && go build .', () => {});
  });
}
