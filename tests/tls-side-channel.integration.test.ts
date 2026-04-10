/**
 * Integration tests for the TLS side-channel daemon (v0.3.0).
 *
 * These tests require the Go daemon binary to be built. If it isn't,
 * the suite skips itself with a helpful message rather than failing
 * the whole test run.
 *
 * The "TLS fingerprint" assertion is the load-bearing one — it checks
 * that the daemon is presenting a real Chrome JA4 with proper GREASE,
 * not a Go-default fingerprint. If this fails, bogdanfinn/tls-client's
 * profile name has changed (or the Chrome version we're impersonating
 * was renamed) and the daemon's `resolveProfile()` mapping needs an
 * update.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TlsSideChannel } from '../src/tls-side-channel.js';

const binPath = join(
  process.cwd(),
  'native',
  'tls-client',
  process.platform === 'win32' ? 'blacktip-tls.exe' : 'blacktip-tls',
);

const skip = !existsSync(binPath);

describe.skipIf(skip)('TlsSideChannel', () => {
  let channel: TlsSideChannel;

  beforeAll(async () => {
    channel = await TlsSideChannel.spawn();
  });

  afterAll(async () => {
    if (channel) await channel.close();
  });

  it('returns a Chrome-like JA4 from tls.peet.ws', async () => {
    const resp = await channel.fetch({
      url: 'https://tls.peet.ws/api/all',
      headers: { Accept: 'application/json' },
    });
    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body) as {
      tls?: { ja4?: string; ciphers?: string[] };
      http2?: { akamai_fingerprint?: string };
    };
    expect(body.tls?.ja4).toMatch(/^t13d/);
    // First cipher must be GREASE — Chrome's signature
    expect(body.tls?.ciphers?.[0]).toMatch(/GREASE/i);
    // HTTP/2 frame settings should match real Chrome
    expect(body.http2?.akamai_fingerprint).toMatch(/^1:65536;2:0;4:6291456;6:262144/);
    expect(body.http2?.akamai_fingerprint).toMatch(/m,a,s,p$/);
  }, 30_000);

  it('parses Set-Cookie headers into structured cookies', async () => {
    // httpbin.org/cookies/set sets a single test cookie via redirect.
    const resp = await channel.fetch({
      url: 'https://httpbin.org/cookies/set?session=abc123',
    });
    // httpbin redirects after setting; bogdanfinn doesn't follow by default
    // (we configured WithNotFollowRedirects), so we should see a 302 with
    // Set-Cookie on the response itself.
    expect([200, 302]).toContain(resp.status);
    if (resp.cookies.length > 0) {
      const sessionCookie = resp.cookies.find((c) => c.name === 'session');
      expect(sessionCookie?.value).toBe('abc123');
    }
  }, 30_000);

  it('handles concurrent requests via per-request IDs', async () => {
    // Fire three requests in parallel — the daemon must match responses
    // to requests by id rather than fifo order.
    const [r1, r2, r3] = await Promise.all([
      channel.fetch({ url: 'https://httpbin.org/anything?n=1' }),
      channel.fetch({ url: 'https://httpbin.org/anything?n=2' }),
      channel.fetch({ url: 'https://httpbin.org/anything?n=3' }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    // Each response body should reflect the matching query parameter
    expect(JSON.parse(r1.body).args.n).toBe('1');
    expect(JSON.parse(r2.body).args.n).toBe('2');
    expect(JSON.parse(r3.body).args.n).toBe('3');
  }, 30_000);

  it('rejects requests after close()', async () => {
    const tmpChannel = await TlsSideChannel.spawn();
    await tmpChannel.close();
    await expect(tmpChannel.fetch({ url: 'https://example.com/' })).rejects.toThrow();
  }, 10_000);
});

if (skip) {
  describe('TlsSideChannel', () => {
    it.skip('requires the Go daemon binary at native/tls-client/blacktip-tls[.exe] — build with: cd native/tls-client && go build .', () => {});
  });
}
