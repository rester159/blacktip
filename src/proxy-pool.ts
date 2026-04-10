/**
 * Proxy pool abstraction.
 *
 * Zero-dependency reference implementation. The caller supplies proxy
 * credentials; this module handles:
 *
 *   - Round-robin or domain-sticky selection.
 *   - In-memory reputation tracking (which proxies got banned on which
 *     domains, decay window, avoid-list).
 *   - URL formatting for the common residential providers (BrightData,
 *     Oxylabs, Smartproxy, NetNut) — caller passes the provider name
 *     and credentials, we build the right URL string.
 *
 * This is a scaffold — the actual integration with BlackTip's
 * `BlackTipConfig.proxy` happens when `selectForDomain` is called and
 * the result is set on the config before `bt.launch()`.
 *
 * Residential proxy bandwidth costs money. For the zero-budget path,
 * callers can instantiate an empty pool and use BlackTip without any
 * proxy (the default), or plug in a single free datacenter proxy they
 * already have access to.
 */

export type ProxyProtocol = 'http' | 'https' | 'socks5';

export interface ProxyDescriptor {
  /** Human-readable ID for logging and reputation tracking. */
  id: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Optional: the exit country for this proxy, used for locale/timezone
   *  consistency checks. */
  exitCountry?: string;
  /** Optional: tags like 'residential', 'datacenter', 'mobile'. */
  tags?: string[];
}

/**
 * Provider-specific URL formatters. The caller provides the API key or
 * username/password and we produce a ProxyDescriptor ready to use.
 */
export const ProxyProviders = {
  brightData: (username: string, password: string, zone: string): ProxyDescriptor => ({
    id: `brightdata-${zone}`,
    protocol: 'http',
    host: 'brd.superproxy.io',
    port: 22225,
    username: `brd-customer-${username}-zone-${zone}`,
    password,
    tags: ['residential', 'brightdata'],
  }),
  oxylabs: (username: string, password: string): ProxyDescriptor => ({
    id: 'oxylabs',
    protocol: 'http',
    host: 'pr.oxylabs.io',
    port: 7777,
    username,
    password,
    tags: ['residential', 'oxylabs'],
  }),
  smartproxy: (username: string, password: string): ProxyDescriptor => ({
    id: 'smartproxy',
    protocol: 'http',
    host: 'gate.smartproxy.com',
    port: 10000,
    username,
    password,
    tags: ['residential', 'smartproxy'],
  }),
  custom: (descriptor: ProxyDescriptor): ProxyDescriptor => descriptor,
} as const;

/**
 * Format a ProxyDescriptor into the URL string BlackTipConfig.proxy expects.
 */
export function proxyToUrl(p: ProxyDescriptor): string {
  const auth = p.username && p.password ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : '';
  return `${p.protocol}://${auth}${p.host}:${p.port}`;
}

// ── Reputation tracking ──

interface BanRecord {
  proxyId: string;
  domain: string;
  bannedAt: number;
  reason?: string;
}

export interface PoolOptions {
  /** How long to remember a ban before retrying the same proxy on the
   *  same domain. Default: 24 hours. */
  banDecayMs?: number;
  /** Strategy for picking the next proxy. */
  strategy?: 'round-robin' | 'random' | 'least-used';
}

export class ProxyPool {
  private proxies: ProxyDescriptor[] = [];
  private bans: BanRecord[] = [];
  private usageCount = new Map<string, number>();
  private lastIndexByDomain = new Map<string, number>();
  private readonly banDecayMs: number;
  private readonly strategy: NonNullable<PoolOptions['strategy']>;

  constructor(proxies: ProxyDescriptor[] = [], options: PoolOptions = {}) {
    this.proxies = [...proxies];
    this.banDecayMs = options.banDecayMs ?? 24 * 60 * 60 * 1000;
    this.strategy = options.strategy ?? 'round-robin';
  }

  add(proxy: ProxyDescriptor): void {
    if (!this.proxies.find((p) => p.id === proxy.id)) {
      this.proxies.push(proxy);
    }
  }

  remove(proxyId: string): void {
    this.proxies = this.proxies.filter((p) => p.id !== proxyId);
  }

  size(): number {
    return this.proxies.length;
  }

  /**
   * Select the next proxy for a given domain, skipping any that are
   * currently banned on that domain.
   */
  selectForDomain(domain: string): ProxyDescriptor | null {
    if (this.proxies.length === 0) return null;

    // Filter out proxies banned on this domain (after decay window).
    const now = Date.now();
    const banned = new Set(
      this.bans
        .filter((b) => b.domain === domain && now - b.bannedAt < this.banDecayMs)
        .map((b) => b.proxyId),
    );
    const eligible = this.proxies.filter((p) => !banned.has(p.id));
    if (eligible.length === 0) return null;

    let chosen: ProxyDescriptor;
    switch (this.strategy) {
      case 'random':
        chosen = eligible[Math.floor(Math.random() * eligible.length)]!;
        break;
      case 'least-used':
        chosen = eligible.reduce((best, p) =>
          (this.usageCount.get(p.id) ?? 0) < (this.usageCount.get(best.id) ?? 0) ? p : best,
        );
        break;
      case 'round-robin':
      default: {
        const lastIdx = this.lastIndexByDomain.get(domain) ?? -1;
        const nextIdx = (lastIdx + 1) % eligible.length;
        this.lastIndexByDomain.set(domain, nextIdx);
        chosen = eligible[nextIdx]!;
        break;
      }
    }

    this.usageCount.set(chosen.id, (this.usageCount.get(chosen.id) ?? 0) + 1);
    return chosen;
  }

  /**
   * Record that a proxy got banned on a domain. Future calls to
   * `selectForDomain(domain)` will skip this proxy until the ban decays.
   */
  reportBan(proxyId: string, domain: string, reason?: string): void {
    this.bans.push({
      proxyId,
      domain,
      bannedAt: Date.now(),
      reason,
    });
  }

  /**
   * Clear expired bans from the in-memory list. Optional hygiene — not
   * required for correctness but keeps memory bounded.
   */
  pruneExpiredBans(): number {
    const now = Date.now();
    const before = this.bans.length;
    this.bans = this.bans.filter((b) => now - b.bannedAt < this.banDecayMs);
    return before - this.bans.length;
  }

  /**
   * Return a copy of the reputation state for observability.
   */
  getReputationSnapshot(): { proxies: ProxyDescriptor[]; activeBans: BanRecord[]; usage: Record<string, number> } {
    const now = Date.now();
    return {
      proxies: [...this.proxies],
      activeBans: this.bans.filter((b) => now - b.bannedAt < this.banDecayMs),
      usage: Object.fromEntries(this.usageCount.entries()),
    };
  }
}
