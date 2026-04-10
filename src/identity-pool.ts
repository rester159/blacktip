/**
 * Identity pool — long-running session and identity rotation.
 *
 * An "identity" is the union of everything that makes a browser session
 * look like one specific human: cookies, localStorage, proxy, device
 * profile, behavior profile, locale, timezone. v0.4.0's answer to the
 * question "how do I rotate identities cleanly across many requests
 * without my whole flow looking like one bot retried under different IPs?"
 *
 * The pool persists to a JSON file at a caller-supplied path so identities
 * survive process restarts. Each identity has its own burn-list (per
 * domain), so an identity that got blocked on opentable.com is still
 * eligible for amazon.com.
 *
 * Composition:
 *   - Snapshots (cookies + storage) come from `SnapshotManager`.
 *   - Proxies come from `ProxyPool` and are bound to an identity at
 *     creation time.
 *   - Device + behavior profiles are part of the identity itself.
 *
 * Lifecycle:
 *   1. `pool.add(...)` — create an identity (no snapshot yet).
 *   2. `pool.acquire(domain)` — pick one not burned for this domain.
 *   3. `pool.applyToConfig(identity)` — produces a `BlackTipConfig` to
 *      pass to `new BlackTip(...)`.
 *   4. After flow, `pool.captureFromBlackTip(bt, identity)` — save the
 *      session state back into the identity for next time.
 *   5. `pool.markBurned(id, reason, domain?)` — when something blocks.
 *
 * The pool is in-memory + file-backed. There's no SQL, no LRU cache,
 * no daemon. It's a single class with two file-IO methods.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BlackTip } from './blacktip.js';
import type { BlackTipConfig, ProfileConfig } from './types.js';
import type { SessionSnapshot } from './snapshot.js';

/** Device profile names BlackTip ships with. */
export type DeviceProfileName = 'desktop-windows' | 'desktop-macos' | 'desktop-linux';
import { SnapshotManager } from './snapshot.js';
import type { ProxyDescriptor, ProxyPool } from './proxy-pool.js';
import { proxyToUrl } from './proxy-pool.js';

// ── Identity ──

export interface Identity {
  /** UUID. Generated on `add()` if not supplied. */
  id: string;
  label?: string;
  createdAt: string;
  /** ISO timestamp of last `acquire()` call, or null if never used. */
  lastUsedAt: string | null;
  /** Number of times this identity has been acquired. */
  useCount: number;
  /** ISO timestamp of when the identity was fully burned (across all domains). */
  burnedAt: string | null;
  /** Reason from the most recent burn. */
  burnedReason: string | null;
  /** Domains on which this identity is burned. Per-domain so an identity
   *  blocked on opentable can still be used elsewhere. */
  burnedDomains: string[];
  /** Cookies + localStorage. Null until the first capture. */
  snapshot: SessionSnapshot | null;
  /** The proxy bound to this identity, if any. */
  proxy: ProxyDescriptor | null;
  /** Behavior profile — either a built-in name or a full ProfileConfig
   *  (e.g. one fitted via `fitFromSamples`). */
  behaviorProfile: ProfileConfig | 'human' | 'scraper';
  /** Device profile. */
  deviceProfile: DeviceProfileName;
  locale: string;
  timezone: string;
}

// ── Rotation policy ──

export interface RotationPolicy {
  /** Burn an identity after this many uses. Default: never. */
  maxUses?: number;
  /** Burn an identity if its first use was longer than this ago. Default: never. */
  maxAgeMs?: number;
  /** When acquiring, prefer the least-recently-used identity (otherwise
   *  uses round-robin order). Default: true. */
  preferLeastRecentlyUsed?: boolean;
}

// ── On-disk shape ──

interface PoolFile {
  version: 1;
  savedAt: string;
  identities: Identity[];
}

// ── IdentityPool ──

export interface IdentityPoolOptions {
  /** Path to a JSON file that backs the pool. Will be created if missing. */
  storePath: string;
  /** Optional ProxyPool to draw new identities' proxies from when
   *  `add()` is called without an explicit proxy. */
  proxyPool?: ProxyPool;
  /** Rotation policy. Defaults to no automatic burning. */
  rotationPolicy?: RotationPolicy;
}

export class IdentityPool {
  private storePath: string;
  private proxyPool: ProxyPool | undefined;
  private rotationPolicy: Required<RotationPolicy>;
  private identities: Identity[] = [];
  private acquireCursor = 0;

  constructor(options: IdentityPoolOptions) {
    this.storePath = options.storePath;
    this.proxyPool = options.proxyPool;
    this.rotationPolicy = {
      maxUses: options.rotationPolicy?.maxUses ?? Infinity,
      maxAgeMs: options.rotationPolicy?.maxAgeMs ?? Infinity,
      preferLeastRecentlyUsed: options.rotationPolicy?.preferLeastRecentlyUsed ?? true,
    };
    this.load();
  }

  // ── File I/O ──

  /** Load identities from the store file. Called automatically by the
   *  constructor; safe to call again to refresh from disk. */
  load(): void {
    if (!existsSync(this.storePath)) {
      this.identities = [];
      return;
    }
    try {
      const raw = readFileSync(this.storePath, 'utf-8');
      const parsed = JSON.parse(raw) as PoolFile;
      if (parsed.version !== 1) {
        throw new Error(`Unsupported pool file version: ${parsed.version}`);
      }
      this.identities = parsed.identities;
    } catch (err) {
      throw new Error(`IdentityPool: failed to load ${this.storePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Persist the in-memory state to the store file. Called automatically
   *  after every mutation. */
  save(): void {
    const dir = dirname(this.storePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file: PoolFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      identities: this.identities,
    };
    writeFileSync(this.storePath, JSON.stringify(file, null, 2));
  }

  // ── CRUD ──

  /**
   * Create a new identity. Required: deviceProfile. Optional: everything
   * else (sane defaults are filled in). If a `proxyPool` was supplied to
   * the IdentityPool and `proxy` is omitted, the pool draws one.
   */
  add(init: {
    label?: string;
    deviceProfile: DeviceProfileName;
    behaviorProfile?: Identity['behaviorProfile'];
    locale?: string;
    timezone?: string;
    proxy?: ProxyDescriptor | null;
  }): Identity {
    const id = randomUUID();
    let proxy = init.proxy ?? null;
    // If no proxy supplied and a pool exists, take the next round-robin pick
    // from the pool. We use a placeholder domain key since identities
    // are domain-agnostic at creation time.
    if (proxy === null && this.proxyPool && this.proxyPool.size() > 0) {
      proxy = this.proxyPool.selectForDomain('__identity-pool__');
    }
    const identity: Identity = {
      id,
      label: init.label,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      useCount: 0,
      burnedAt: null,
      burnedReason: null,
      burnedDomains: [],
      snapshot: null,
      proxy,
      behaviorProfile: init.behaviorProfile ?? 'human',
      deviceProfile: init.deviceProfile,
      locale: init.locale ?? 'en-US',
      timezone: init.timezone ?? 'America/New_York',
    };
    this.identities.push(identity);
    this.save();
    return identity;
  }

  remove(id: string): boolean {
    const before = this.identities.length;
    this.identities = this.identities.filter((i) => i.id !== id);
    if (this.identities.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  list(): Identity[] {
    return [...this.identities];
  }

  size(): number {
    return this.identities.length;
  }

  /** Identities not fully burned (i.e. eligible for at least some domains). */
  available(): Identity[] {
    return this.identities.filter((i) => i.burnedAt === null);
  }

  // ── Acquisition ──

  /**
   * Pick an identity for use. If `domain` is supplied, the result is
   * guaranteed not to be in that identity's `burnedDomains` list. Applies
   * the rotation policy: identities exceeding `maxUses` or `maxAgeMs`
   * are auto-burned and skipped.
   *
   * Returns null if no eligible identity exists.
   */
  acquire(domain?: string): Identity | null {
    this.applyRotationPolicy();

    const eligible = this.identities.filter((i) => {
      if (i.burnedAt !== null) return false;
      if (domain && i.burnedDomains.includes(domain)) return false;
      return true;
    });
    if (eligible.length === 0) return null;

    let chosen: Identity;
    if (this.rotationPolicy.preferLeastRecentlyUsed) {
      chosen = eligible.reduce((best, i) => {
        const bestT = best.lastUsedAt ? Date.parse(best.lastUsedAt) : 0;
        const iT = i.lastUsedAt ? Date.parse(i.lastUsedAt) : 0;
        return iT < bestT ? i : best;
      });
    } else {
      this.acquireCursor = (this.acquireCursor + 1) % eligible.length;
      chosen = eligible[this.acquireCursor]!;
    }

    chosen.lastUsedAt = new Date().toISOString();
    chosen.useCount++;
    this.save();
    return chosen;
  }

  // ── Burning ──

  /**
   * Mark an identity as burned, either fully (omit `domain`) or only on
   * one specific domain. Burned identities are skipped by `acquire()`.
   * Domain-specific burns also report the proxy ban back to the
   * `ProxyPool` if one is wired up — that's the feedback loop that
   * keeps the pool clean.
   */
  markBurned(id: string, reason: string, domain?: string): boolean {
    const identity = this.identities.find((i) => i.id === id);
    if (!identity) return false;

    if (domain) {
      if (!identity.burnedDomains.includes(domain)) identity.burnedDomains.push(domain);
      // If the identity has a proxy and a ProxyPool, report the ban so
      // the pool's reputation tracking learns from this failure.
      if (identity.proxy && this.proxyPool) {
        this.proxyPool.reportBan(identity.proxy.id, domain, reason);
      }
    } else {
      identity.burnedAt = new Date().toISOString();
      identity.burnedReason = reason;
    }
    this.save();
    return true;
  }

  /** Clear a burn (full or per-domain). Useful for manually unbanning. */
  clearBurn(id: string, domain?: string): boolean {
    const identity = this.identities.find((i) => i.id === id);
    if (!identity) return false;
    if (domain) {
      identity.burnedDomains = identity.burnedDomains.filter((d) => d !== domain);
    } else {
      identity.burnedAt = null;
      identity.burnedReason = null;
    }
    this.save();
    return true;
  }

  private applyRotationPolicy(): void {
    const now = Date.now();
    let mutated = false;
    for (const i of this.identities) {
      if (i.burnedAt !== null) continue;
      if (i.useCount >= this.rotationPolicy.maxUses) {
        i.burnedAt = new Date().toISOString();
        i.burnedReason = `auto-burn: useCount >= maxUses (${this.rotationPolicy.maxUses})`;
        mutated = true;
        continue;
      }
      if (i.lastUsedAt) {
        const ageMs = now - Date.parse(i.lastUsedAt);
        if (ageMs > this.rotationPolicy.maxAgeMs) {
          i.burnedAt = new Date().toISOString();
          i.burnedReason = `auto-burn: age ${ageMs}ms > maxAgeMs ${this.rotationPolicy.maxAgeMs}`;
          mutated = true;
        }
      }
    }
    if (mutated) this.save();
  }

  // ── BlackTip integration ──

  /**
   * Build a `BlackTipConfig` for the given identity. The caller passes
   * this to `new BlackTip(config)`. The result includes:
   *   - deviceProfile, behaviorProfile, locale, timezone from the identity
   *   - proxy URL if the identity has one bound
   *
   * Cookies and localStorage from the identity's snapshot are NOT applied
   * here (they need a launched browser). Call `restoreSnapshot(bt, identity)`
   * after `bt.launch()` to apply them.
   */
  applyToConfig(identity: Identity, baseConfig: Partial<BlackTipConfig> = {}): BlackTipConfig {
    return {
      ...baseConfig,
      deviceProfile: identity.deviceProfile,
      behaviorProfile: identity.behaviorProfile,
      locale: identity.locale,
      timezone: identity.timezone,
      proxy: identity.proxy ? proxyToUrl(identity.proxy) : baseConfig.proxy,
    };
  }

  /**
   * After `bt.launch()`, apply the identity's snapshot (cookies +
   * localStorage) to the running browser. No-op if the identity has
   * no snapshot yet.
   */
  async restoreSnapshot(bt: BlackTip, identity: Identity): Promise<void> {
    if (!identity.snapshot) return;
    const mgr = new SnapshotManager((bt as unknown as { core: ConstructorParameters<typeof SnapshotManager>[0] }).core);
    await mgr.restore(identity.snapshot);
  }

  /**
   * Capture the current BlackTip session state into the identity. Call
   * after a successful flow so the next acquire of this identity starts
   * from a known-good logged-in state.
   */
  async captureSnapshot(bt: BlackTip, identity: Identity): Promise<void> {
    const mgr = new SnapshotManager((bt as unknown as { core: ConstructorParameters<typeof SnapshotManager>[0] }).core);
    identity.snapshot = await mgr.capture(identity.label);
    this.save();
  }
}
