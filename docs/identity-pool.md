# IdentityPool — long-running session and identity rotation (v0.4.0)

`IdentityPool` is BlackTip's answer to the question "how do I rotate across many identities cleanly without my whole flow looking like one bot retried under different IPs?" An identity is the union of everything that makes a session look like one specific human: cookies, localStorage, proxy, device profile, behavior profile, locale, timezone. The pool persists to a JSON file so identities survive restarts, and each identity has a per-domain burn list so an identity blocked on opentable.com is still eligible for amazon.com.

## When you need this

Most BlackTip flows do not need an IdentityPool. A single launch with the right device profile and a residential connection covers the common case. The pool earns its keep when:

1. You're running many flows against the same target and need to look like many different users (price scraping, market research, multi-account ops on services where multi-account is allowed).
2. You want resilience: when identity A gets blocked on opentable.com, you want identity B to take over without manual intervention.
3. You want session persistence across process restarts so a logged-in identity from yesterday is still logged in today.
4. You want a feedback loop: when an identity gets burned, the proxy bound to it should be marked dirty in `ProxyPool` so it isn't reused for the same target until the ban window decays.

## Composition

`IdentityPool` does not reinvent persistence or proxy selection. It composes:

- **`SnapshotManager`** for cookies + localStorage + sessionStorage. The pool calls `captureSnapshot(bt, identity)` after a successful flow to save state.
- **`ProxyPool`** for proxy selection and ban tracking. New identities draw a proxy from the pool at creation time. When an identity is burned per-domain, the pool reports a ban on that proxy/domain pair so future selections skip it.
- **`BlackTipConfig`** is produced by `pool.applyToConfig(identity)` and passed to `new BlackTip(config)`.

## Quick start

```typescript
import { BlackTip, IdentityPool, ProxyPool, ProxyProviders } from '@rester159/blacktip';

// 1. Build a ProxyPool from whatever provider you use.
const proxyPool = new ProxyPool([
  ProxyProviders.brightData('your-customer-id', 'your-password', 'residential'),
  ProxyProviders.oxylabs('your-username', 'your-password'),
]);

// 2. Build the IdentityPool, backed by a JSON file on disk.
const pool = new IdentityPool({
  storePath: './.blacktip/identities.json',
  proxyPool,
  rotationPolicy: {
    maxUses: 50,            // burn after 50 uses
    maxAgeMs: 7 * 24 * 60 * 60 * 1000, // burn after 7 days idle
  },
});

// 3. First time only: seed the pool with N identities. Subsequent runs
// load from the store file.
if (pool.size() === 0) {
  for (let i = 0; i < 5; i++) {
    pool.add({
      deviceProfile: i % 2 === 0 ? 'desktop-windows' : 'desktop-macos',
      label: `identity-${i + 1}`,
      locale: 'en-US',
      timezone: 'America/New_York',
    });
  }
}

// 4. For each flow: acquire, launch, run, capture, release.
const identity = pool.acquire('opentable.com');
if (!identity) throw new Error('No eligible identity for opentable.com — pool exhausted');

const config = pool.applyToConfig(identity, { logLevel: 'info', timeout: 15_000 });
const bt = new BlackTip(config);
await bt.launch();

// Restore the identity's prior session (cookies, storage). No-op if first use.
await pool.restoreSnapshot(bt, identity);

try {
  await bt.navigate('https://www.opentable.com/');
  await bt.waitForStable();
  // ... rest of the flow

  // On success, save the updated session state back into the identity.
  await pool.captureSnapshot(bt, identity);
} catch (err) {
  // On failure, mark this identity burned for this domain. The proxy
  // gets banned in ProxyPool too, so the next identity drawn from the
  // pool won't reuse the same proxy on this target.
  pool.markBurned(identity.id, err instanceof Error ? err.message : String(err), 'opentable.com');
} finally {
  await bt.close();
}
```

## API

### `new IdentityPool(options)`

```typescript
{
  storePath: string;              // required — JSON file path
  proxyPool?: ProxyPool;          // optional — for proxy binding & feedback
  rotationPolicy?: {
    maxUses?: number;             // default: Infinity
    maxAgeMs?: number;            // default: Infinity
    preferLeastRecentlyUsed?: boolean; // default: true
  };
}
```

### `add(init)` → `Identity`

Create a new identity. `deviceProfile` is required. If a `proxyPool` was supplied to the IdentityPool and `proxy` is omitted, the pool draws one. Auto-saves to disk.

### `acquire(domain?)` → `Identity | null`

Pick an identity for use. Skips identities burned on the requested domain. Applies rotation policy: identities exceeding `maxUses` or `maxAgeMs` are auto-burned. Returns null if no eligible identity exists.

### `markBurned(id, reason, domain?)` → `boolean`

Mark an identity burned. With `domain`, only burns for that domain (per-domain burn list). Without `domain`, fully burns the identity. Per-domain burns also report a proxy ban back to `ProxyPool` if one is wired up.

### `clearBurn(id, domain?)` → `boolean`

Manually unban. Useful when you know the burn was a transient issue.

### `applyToConfig(identity, baseConfig?)` → `BlackTipConfig`

Build a `BlackTipConfig` from an identity. Sets `deviceProfile`, `behaviorProfile`, `locale`, `timezone`, and `proxy` (URL-formatted via `proxyToUrl`). Other base config fields pass through unchanged.

### `restoreSnapshot(bt, identity)` → `Promise<void>`

After `bt.launch()`, apply the identity's saved cookies + localStorage to the running browser. No-op if the identity has no snapshot yet.

### `captureSnapshot(bt, identity)` → `Promise<void>`

Save the current BlackTip session state into the identity. Call after a successful flow so the next acquire of this identity starts from a known-good logged-in state.

### `list()`, `available()`, `size()`, `remove(id)`

Standard inspection. `available()` returns identities not fully burned (per-domain burns don't count).

## Persistence format

The store file is plain JSON with a schema version. Sample:

```json
{
  "version": 1,
  "savedAt": "2026-04-10T22:30:00.000Z",
  "identities": [
    {
      "id": "1f2e3d4c-...",
      "label": "identity-1",
      "createdAt": "2026-04-10T20:00:00.000Z",
      "lastUsedAt": "2026-04-10T22:25:00.000Z",
      "useCount": 12,
      "burnedAt": null,
      "burnedReason": null,
      "burnedDomains": ["sears.com"],
      "snapshot": { /* SessionSnapshot */ },
      "proxy": { "id": "brightdata-residential", "...": "..." },
      "behaviorProfile": "human",
      "deviceProfile": "desktop-windows",
      "locale": "en-US",
      "timezone": "America/New_York"
    }
  ]
}
```

The schema is versioned so future migrations are explicit. Don't hand-edit the file while a process is reading it — use the API.

## IP reputation gate

v0.4.0 also adds `BlackTipConfig.requireResidentialIp`. When set, BlackTip runs `bt.checkIpReputation()` immediately after `launch()` and either warns or throws based on the verdict:

```typescript
new BlackTip({
  // 'throw': refuse to launch if egress IP is on a known datacenter ASN.
  // 'warn':  log a warning but allow the launch.
  // false / unset: no check.
  requireResidentialIp: 'throw',
});
```

Use `'throw'` in production / CI where a flagged IP would burn a real account. Use `'warn'` for local dev. Combine with `IdentityPool` and `ProxyPool` to ensure every launch goes through a residential exit before touching the target.
