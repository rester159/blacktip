# Akamai sensor challenge solver (v0.5.0)

`bt.solveAkamaiChallenge(url)` is the v0.5.0 answer to "I want to call Akamai-protected APIs from a sessionless TLS daemon, but the first request always 403s because Akamai gates everything behind a sensor data POST." Solve the challenge once in a real browser, get back the validated cookies plus a recommended header set, then replay arbitrary requests via `bt.fetchWithTls()` (or any other HTTP client) for as long as the cookies stay valid. **Empirically validated against OpenTable Akamai Bot Manager: 5/5 replay calls return 200 with real content. ~600ms per replay vs ~4s per browser launch.**

## Why this isn't a pure-Go solver

Reverse-engineering Akamai's `bm.js` to generate sensor data without a browser is intentionally hostile work and the maintenance economics are bad:

1. **bm.js is heavily obfuscated.** OpenTable's current sensor JS is 26 KB of hex-encoded string array references with no recognizable function names. References to `gyroscope`, `hardwareConcurrency`, `selenium`, `Chrome`, `vendor`, `ShockwaveFlash` are scattered through it — clearly the sensor collector — but extracting them requires symbolic execution, not just regex.
2. **Sensor data is encrypted with a runtime-derived key** that lives inside the obfuscated code. You can't just capture the POST body Chrome sends and replay it — the key changes per session.
3. **Akamai rotates the obfuscation monthly.** A pure-Go reimplementation would be a 1–2 week reverse engineering project, and the result would rot in ~6 weeks. Bad ROI.

What works instead, and what BlackTip ships in v0.5.0: launch a real BlackTip browser, navigate to the URL, let Akamai's bm.js execute naturally (real Chrome runs the JS, generates the sensor payload, POSTs it back), and capture the validated cookies. The caller then injects those cookies into thousands of sessionless TLS-daemon API calls until they expire.

**This is NOT "no browser needed for Akamai." It IS "amortize browser cost across many subsequent API calls instead of paying it per request."** For most use cases that's the same thing — you pay one browser session per hour and run hundreds of API calls in between.

## Quick start

```typescript
import { BlackTip } from '@rester159/blacktip';

const bt = new BlackTip({ logLevel: 'info' });
await bt.launch();

// 1. Solve the Akamai challenge in the browser. ~15s.
const solved = await bt.solveAkamaiChallenge(
  'https://www.opentable.com/booking/restref/availability?rid=76651&restref=76651&partySize=2&dateTime=2026-04-11T19:00',
);

console.log('Validated:', solved.validated);
console.log('Akamai cookies:', solved.cookies.map(c => c.name));
// → [ 'bm_ss', 'bm_so', 'bm_mi', 'bm_sz', 'ak_bmsc', 'bm_s', 'bm_sv', '_abck' ]

// 2. Replay arbitrary requests via the TLS daemon. ~600ms each, no browser.
for (let i = 0; i < 100; i++) {
  const resp = await bt.fetchWithTls({
    url: 'https://www.opentable.com/api/some-endpoint',
    headers: solved.recommendedHeaders, // Cookie + Sec-Ch-Ua + Sec-Fetch-* baked in
  });
  console.log('Call', i, '→', resp.status);
}

await bt.close();
```

## Result shape

```typescript
interface AkamaiChallengeResult {
  /**
   * True when EITHER:
   *   - _abck reached validated state (~0~), OR
   *   - The page rendered without an Akamai block (sensor not enforced).
   *
   * Akamai's sensor validation is only enforced when other signals
   * (TLS, IP, behavior) look suspicious. For real-Chrome sessions on
   * residential connections, Akamai often admits the request without
   * ever requiring the JS-layer sensor POST.
   */
  validated: boolean;

  /**
   * Actual sensor validation state:
   *   0  → validated as human (gold standard)
   *   -1 → sensor not enforced (page admitted without it)
   *   1+ → flagged as bot
   *   null → no _abck cookie set (target may not be Akamai-protected)
   */
  abckState: -1 | 0 | 1 | null;

  /** The full _abck cookie value at the end of the wait window. */
  abckValue: string | null;

  /** Whether the rendered page is the Akamai Access Denied block page. */
  blocked: boolean;

  /** All Akamai-related cookies, ready to inject into other sessions. */
  cookies: Array<{ name: string; value: string; domain: string; path: string }>;

  /**
   * Pre-built header set for replay calls. Includes Cookie, User-Agent,
   * Accept, Accept-Language, Sec-Ch-Ua, Sec-Ch-Ua-Mobile, Sec-Ch-Ua-Platform,
   * Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site, Sec-Fetch-User,
   * Upgrade-Insecure-Requests. Pass directly to `bt.fetchWithTls()`.
   *
   * Replays without these headers will 403 even with valid cookies —
   * Akamai validates the full request shape, not just the cookie jar.
   */
  recommendedHeaders: Record<string, string>;

  finalUrl: string;
  title: string;
  durationMs: number;
  notes: string[];
}
```

## The cost amortization story

OpenTable's Gjelina booking endpoint, measured on a residential connection:

| Approach | Cost per call | 100 calls |
|---|---|---|
| Browser launch + navigate per call | ~4s | ~400s |
| `solveAkamaiChallenge` once + 100 daemon replays | 15s + 100×0.6s = 75s | **75s** |
| **Speedup** | | **~5.3x** |

Larger N gets better. At 1,000 calls, it's 15s + 600s = 615s vs 4,000s — almost 7x. The crossover is at ~5 calls (below that, browser-per-call is faster because the solve overhead dominates).

## What "validated" actually means

Akamai's sensor validation has three observable states encoded in the second `~`-delimited field of the `_abck` cookie:

| `_abck` state | Meaning | What you can do |
|---|---|---|
| `~0~` | Sensor data validated as human | Maximum trust — replay anything |
| `~-1~` | Sensor not enforced (Akamai admitted on other signals) | Replay safely — same as `~0~` for most APIs |
| `~1~` (or higher) | Sensor flagged as bot | Session burned — solve again with a different identity |

The interesting case is `~-1~`. On every empirical test against OpenTable from a residential connection, Akamai admitted the request without ever requiring sensor validation — `_abck` stayed at `~-1~` but the page rendered fine and the cookies worked for daemon replays. This is consistent with Akamai's own marketing: the sensor JS is one layer of a multi-factor decision, and high-confidence requests (good TLS, good IP, real Chrome behavior) get admitted without it.

That's why `validated` is `true` for both `~0~` and `~-1~` outcomes — both unlock the replay path.

## Replay headers — why all of them matter

The first thing I tried after solving was naive: solve in browser, copy cookies, pass them through `Cookie:` header to the daemon. **It 403'd.** Then I added the full Chrome header set: `Sec-Ch-Ua`, `Sec-Ch-Ua-Mobile`, `Sec-Ch-Ua-Platform`, `Sec-Fetch-Dest`, `Sec-Fetch-Mode`, `Sec-Fetch-Site`, `Sec-Fetch-User`, `Upgrade-Insecure-Requests`. **It returned 200.**

Akamai is validating the full request shape, not just the cookie jar. Without the Sec-Fetch-* headers, the request looks like a programmatic fetch and Akamai blocks it even with valid cookies. With them, the request looks like a navigation from a real Chrome and Akamai admits it.

The `recommendedHeaders` field on the solver result includes all of these. Don't strip them; pass the whole object to `bt.fetchWithTls({ url, headers: solved.recommendedHeaders })`.

## Combining with IdentityPool

If you're running long-lived flows with identity rotation, the natural pattern is to attach the solved Akamai cookies to an IdentityPool snapshot:

```typescript
import { BlackTip, IdentityPool } from '@rester159/blacktip';

const pool = new IdentityPool({ storePath: './.bt/identities.json' });
const identity = pool.acquire('opentable.com')!;

const config = pool.applyToConfig(identity);
const bt = new BlackTip(config);
await bt.launch();
await pool.restoreSnapshot(bt, identity);

// Solve Akamai once for this identity
const solved = await bt.solveAkamaiChallenge('https://www.opentable.com/booking/...');
if (!solved.validated) {
  pool.markBurned(identity.id, 'Akamai blocked', 'opentable.com');
  return;
}

// Save the post-solve session state into the identity for next time
await pool.captureSnapshot(bt, identity);

// Run N daemon replays. When _abck eventually expires, re-solve.
for (let i = 0; i < 100; i++) {
  const resp = await bt.fetchWithTls({
    url: 'https://www.opentable.com/api/...',
    headers: solved.recommendedHeaders,
  });
  // ...
}

await bt.close();
```

Now your identity is durable: cookies + storage + solved Akamai state, all persisted, ready to resume tomorrow without re-solving.

## Limitations

- **Still requires a browser to solve.** This is the whole point of the architecture decision documented above. If you need pure-Go API access without ever launching a browser, you're going to write a lot of obfuscation reverse-engineering code that breaks every 6 weeks. v0.5.0 doesn't ship that path.
- **Cookies expire.** Akamai's session window is typically ~1 hour for the validated state. After that, replays start returning 403 again and you need to re-solve. Re-solving from the same browser context is fast (~3s on subsequent calls because the browser already has the prior state).
- **`_abck` flagged state means session burned.** If `abckState === 1`, the cookies are useless — Akamai marked you as a bot and even the browser session won't recover. You need a fresh BlackTip launch with a different identity (different proxy, fresh user data dir, possibly different device profile).
- **Per-domain.** This solver is tested against OpenTable. The pattern works against any Akamai Bot Manager target but the specific URL format and timing may vary. Adjust `dwellMsBeforePolling` and `timeoutMs` per-target.

## See also

- `docs/tls-side-channel.md` — the underlying `bt.fetchWithTls()` daemon
- `docs/tls-rewriting.md` — the v0.5.0 full-rewriting mode (TLS rewriter intercepts every browser request)
- `docs/identity-pool.md` — long-running session and identity rotation
- `docs/akamai-bypass.md` — the v0.2.0 plan that documents Akamai's detection layer stack and the L016 fix that opened the door
