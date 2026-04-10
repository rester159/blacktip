/**
 * Unit tests for `IdentityPool` (v0.4.0).
 *
 * The pool is in-memory + file-backed; tests use a temp file per test
 * so they don't pollute each other or leave artifacts in the working tree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityPool } from '../src/identity-pool.js';
import { ProxyPool, type ProxyDescriptor } from '../src/proxy-pool.js';

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bt-identity-pool-'));
  storePath = join(tmpDir, 'pool.json');
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('IdentityPool — basic CRUD', () => {
  it('starts empty when the store file does not exist', () => {
    const pool = new IdentityPool({ storePath });
    expect(pool.size()).toBe(0);
    expect(pool.list()).toEqual([]);
  });

  it('adds an identity and persists it to disk', () => {
    const pool = new IdentityPool({ storePath });
    const identity = pool.add({ deviceProfile: 'desktop-windows', label: 'first' });
    expect(identity.id).toMatch(/^[0-9a-f-]+$/);
    expect(identity.deviceProfile).toBe('desktop-windows');
    expect(identity.label).toBe('first');
    expect(identity.useCount).toBe(0);
    expect(identity.burnedAt).toBeNull();
    expect(pool.size()).toBe(1);
    expect(existsSync(storePath)).toBe(true);
  });

  it('reloads identities from disk on a new pool instance', () => {
    const a = new IdentityPool({ storePath });
    const id1 = a.add({ deviceProfile: 'desktop-macos', label: 'a' });
    const id2 = a.add({ deviceProfile: 'desktop-linux', label: 'b' });

    const b = new IdentityPool({ storePath });
    expect(b.size()).toBe(2);
    const ids = b.list().map((i) => i.id);
    expect(ids).toContain(id1.id);
    expect(ids).toContain(id2.id);
  });

  it('removes an identity by id', () => {
    const pool = new IdentityPool({ storePath });
    const id = pool.add({ deviceProfile: 'desktop-windows' });
    expect(pool.remove(id.id)).toBe(true);
    expect(pool.size()).toBe(0);
    expect(pool.remove('nonexistent')).toBe(false);
  });
});

describe('IdentityPool — acquisition', () => {
  it('acquire returns null on an empty pool', () => {
    const pool = new IdentityPool({ storePath });
    expect(pool.acquire()).toBeNull();
  });

  it('acquire bumps useCount and lastUsedAt', () => {
    const pool = new IdentityPool({ storePath });
    const created = pool.add({ deviceProfile: 'desktop-windows' });
    expect(created.useCount).toBe(0);
    expect(created.lastUsedAt).toBeNull();

    const got = pool.acquire();
    expect(got).not.toBeNull();
    expect(got!.id).toBe(created.id);
    expect(got!.useCount).toBe(1);
    expect(got!.lastUsedAt).not.toBeNull();
  });

  it('acquire prefers least-recently-used by default', () => {
    const pool = new IdentityPool({ storePath });
    const a = pool.add({ deviceProfile: 'desktop-windows', label: 'A' });
    const b = pool.add({ deviceProfile: 'desktop-windows', label: 'B' });

    // Use A first, then B should be preferred next.
    const first = pool.acquire();
    // Both have lastUsedAt:null at start. The reduce picks the first
    // one in eligible order, which depends on add order. Force A's
    // lastUsedAt forward by one tick by doing nothing: just acquire,
    // which sets it. Then acquire again — B (still unused) should win.
    const second = pool.acquire();
    expect(first!.id).not.toBe(second!.id);
    expect(new Set([first!.id, second!.id])).toEqual(new Set([a.id, b.id]));
  });

  it('acquire skips identities burned on the requested domain', () => {
    const pool = new IdentityPool({ storePath });
    const a = pool.add({ deviceProfile: 'desktop-windows', label: 'A' });
    const b = pool.add({ deviceProfile: 'desktop-windows', label: 'B' });

    pool.markBurned(a.id, 'block at edge', 'opentable.com');

    const got1 = pool.acquire('opentable.com');
    expect(got1!.id).toBe(b.id);

    // A is still eligible for amazon.com
    const got2 = pool.acquire('amazon.com');
    expect([a.id, b.id]).toContain(got2!.id);
  });

  it('acquire returns null when all identities are fully burned', () => {
    const pool = new IdentityPool({ storePath });
    const a = pool.add({ deviceProfile: 'desktop-windows' });
    pool.markBurned(a.id, 'fully burned');
    expect(pool.acquire()).toBeNull();
    expect(pool.available()).toEqual([]);
  });
});

describe('IdentityPool — rotation policy', () => {
  it('auto-burns an identity that exceeds maxUses', () => {
    const pool = new IdentityPool({
      storePath,
      rotationPolicy: { maxUses: 2 },
    });
    const a = pool.add({ deviceProfile: 'desktop-windows' });
    pool.acquire(); // useCount=1
    pool.acquire(); // useCount=2 — at the limit
    // Next acquire should auto-burn it (>=) and return null since it's
    // the only identity.
    const got = pool.acquire();
    expect(got).toBeNull();
    const reloaded = pool.list().find((i) => i.id === a.id)!;
    expect(reloaded.burnedAt).not.toBeNull();
    expect(reloaded.burnedReason).toMatch(/maxUses/);
  });
});

describe('IdentityPool — proxy integration', () => {
  it('binds a proxy from a ProxyPool when add() omits one', () => {
    const proxyPool = new ProxyPool([
      { id: 'p1', protocol: 'http', host: 'proxy.example.com', port: 8080 } as ProxyDescriptor,
    ]);
    const pool = new IdentityPool({ storePath, proxyPool });
    const identity = pool.add({ deviceProfile: 'desktop-windows' });
    expect(identity.proxy).not.toBeNull();
    expect(identity.proxy!.id).toBe('p1');
  });

  it('reports a proxy ban back to ProxyPool on per-domain burn', () => {
    const proxyPool = new ProxyPool([
      { id: 'p1', protocol: 'http', host: 'proxy.example.com', port: 8080 } as ProxyDescriptor,
    ]);
    const pool = new IdentityPool({ storePath, proxyPool });
    const identity = pool.add({ deviceProfile: 'desktop-windows' });

    pool.markBurned(identity.id, 'akamai blocked us', 'opentable.com');

    const snapshot = proxyPool.getReputationSnapshot();
    expect(snapshot.activeBans.length).toBe(1);
    expect(snapshot.activeBans[0]!.proxyId).toBe('p1');
    expect(snapshot.activeBans[0]!.domain).toBe('opentable.com');
  });
});

describe('IdentityPool — applyToConfig', () => {
  it('produces a BlackTipConfig with the identity values', () => {
    const pool = new IdentityPool({ storePath });
    const identity = pool.add({
      deviceProfile: 'desktop-macos',
      locale: 'en-GB',
      timezone: 'Europe/London',
      proxy: { id: 'p1', protocol: 'http', host: 'proxy.example.com', port: 3128, username: 'u', password: 'p' },
    });
    const config = pool.applyToConfig(identity, { logLevel: 'info' });
    expect(config.deviceProfile).toBe('desktop-macos');
    expect(config.locale).toBe('en-GB');
    expect(config.timezone).toBe('Europe/London');
    expect(config.logLevel).toBe('info'); // base config preserved
    expect(config.proxy).toBe('http://u:p@proxy.example.com:3128');
  });

  it('falls back to baseConfig.proxy when identity has no proxy', () => {
    const pool = new IdentityPool({ storePath });
    const identity = pool.add({ deviceProfile: 'desktop-windows' });
    const config = pool.applyToConfig(identity, { proxy: 'http://fallback:8080' });
    expect(config.proxy).toBe('http://fallback:8080');
  });
});

describe('IdentityPool — clearBurn', () => {
  it('clears a per-domain burn', () => {
    const pool = new IdentityPool({ storePath });
    const id = pool.add({ deviceProfile: 'desktop-windows' });
    pool.markBurned(id.id, 'temp', 'opentable.com');
    expect(pool.acquire('opentable.com')).toBeNull();
    pool.clearBurn(id.id, 'opentable.com');
    expect(pool.acquire('opentable.com')).not.toBeNull();
  });

  it('clears a full burn', () => {
    const pool = new IdentityPool({ storePath });
    const id = pool.add({ deviceProfile: 'desktop-windows' });
    pool.markBurned(id.id, 'fully burned');
    expect(pool.acquire()).toBeNull();
    pool.clearBurn(id.id);
    expect(pool.acquire()).not.toBeNull();
  });
});
