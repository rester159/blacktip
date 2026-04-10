# Defeating Akamai Bot Manager

> Status as of v0.2.0: **passing on the User-Agent / Sec-Ch-Ua consistency layer** that previously blocked us. Validated against OpenTable (which uses Akamai Bot Manager). Future detection layers (sensor data, behavioral biometrics, IP reputation) are tracked below as the next areas to harden.

This is the BlackTip team's working plan against Akamai Bot Manager, the most layered commercial anti-bot service in the wild. It's structured so you can use it as a reference whether you're a contributor improving BlackTip or a user diagnosing why a specific Akamai-protected target isn't working for you.

## What Akamai Bot Manager actually is

Akamai Bot Manager runs a stack of detection layers, scored independently and combined into a "bot probability" that decides whether you get the page, get a JavaScript challenge, or get blocked at the edge with `Access Denied`. The layers, in the order they fire:

1. **TCP/IP layer** — IP reputation database. Datacenter ASNs (AWS, GCP, OVH, DigitalOcean) flagged automatically. Residential IPs scored by historical bot behavior on the same /24 block. Tor exit nodes blocked outright. **Cheapest signal, runs first.**
2. **TLS layer** — JA3, JA4, GREASE position and rotation pattern, cipher ordering, extension ordering, signature algorithms, EC curves, ALPN. Akamai is one of the few that checks GREASE *position* (Chrome puts GREASE first in both ciphers and extensions).
3. **HTTP/2 layer** — Akamai's own fingerprint format: `s[settings];w[window_update];p[priority_frames];h[header_order]`. Tracks SETTINGS values (HEADER_TABLE_SIZE, INITIAL_WINDOW_SIZE, MAX_FRAME_SIZE), WINDOW_UPDATE size, PRIORITY frame patterns, and pseudo-header order. Chrome's signature is `m,a,s,p` (method/authority/scheme/path).
4. **HTTP header layer** — header order, presence and consistency of `Sec-Fetch-*`, `Sec-Ch-Ua-*`, `Accept-Language`, `Accept-Encoding`, `User-Agent`. **This is where v0.1.0 was being caught.** See L016 below.
5. **Sensor data (the JavaScript challenge)** — Akamai injects a script that collects ~80 browser signals (mouse traces, keystroke timings, performance.now() resolution, Battery API, screen properties, WebGL info, canvas hash, audio fingerprint, plugins, fonts, timezone math, navigator properties) and POSTs them as a 30–50 KB blob to `/akam/11/...`. The server validates the blob and either sets a valid `_abck` cookie or marks the session as a bot. **All subsequent requests need a valid `_abck` cookie.**
6. **Cookie continuity** — `_abck`, `bm_sz`, `bm_sv`, `_bm_sz`. They expire, rotate, and need session affinity. Sessions that don't carry the cookies properly are flagged on the next request.
7. **Behavioral patterns** — after passing the initial gate, Akamai still profiles mouse dynamics, keystroke flight times, scroll patterns, and click timing distributions. Bot-like distributions get reclassified as bots even after passing the initial probe.

If your block happens **before any JavaScript runs** (you see the `Access Denied` page directly with a `Reference #...` and `errors.edgesuite.net` URL), Akamai flagged you at one of layers 1–4. The sensor never executed.

If your block happens **after the page partially loads** or you get a CAPTCHA challenge, you made it past layers 1–4 but the sensor data validation failed.

## Why v0.1.0 was blocked

When the BlackTip team first ran v0.1.0 against OpenTable in development, every request was rejected at the edge with Akamai's `Access Denied` page. We spent 30 minutes ruling out hypotheses one by one:

- **TLS fingerprint:** Captured via `tls.peet.ws/api/all`. Result: **byte-perfect match** for real Chrome 125 on Windows. JA4 `t13d1516h2_8daaf6152771_d8a2da3f94cd`, GREASE in position 0 of both ciphers and extensions, 16 ciphers, 18 extensions. Not the issue.
- **HTTP/2 fingerprint:** Akamai HTTP/2 string `1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p`. **Byte-perfect match** for real Chrome. Not the issue.
- **IP reputation:** Residential Frontier Communications IP in Los Angeles. Not on a known datacenter ASN. Plausible signal but couldn't confirm via free tools.
- **HTTP headers:** Captured via `httpbin.org/headers`. **FOUND IT.**

The `httpbin.org/headers` capture showed:

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/125.0.0.0 ...
Sec-Ch-Ua: "Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"
```

**Chrome/125 in `User-Agent` but Chrome/146 in `Sec-Ch-Ua`.** Real Chrome NEVER has these inconsistent. Akamai catches the mismatch as a textbook spoofing tell — they don't even need to run JavaScript, this header alone is enough.

### Root cause

`browser-core.ts` was setting `userAgent` at the Playwright context level via `newContext({userAgent: ...})`. Playwright's `userAgent` option overrides the `User-Agent` HTTP header value, but it does NOT update the `Sec-Ch-Ua` / `Sec-Ch-Ua-Mobile` / `Sec-Ch-Ua-Platform` client hint headers. Those come from the actual Chromium binary version (Chromium 146, the version patchright bundles, OR the version of Chrome Stable installed via `channel: 'chrome'`).

The result: BlackTip was broadcasting "I am Chrome 125 (UA) but also Chrome 146 (client hints)" to every site since v0.1.0. Detectors that don't cross-check (CreepJS, bot.sannysoft, browserleaks) didn't notice. Detectors that do (Akamai, DataDome, PerimeterX) flagged it instantly.

### The v0.2.0 fix (L016)

Remove the `userAgent` context override entirely. Let real Chrome's natural User-Agent come through. UA and Sec-Ch-Ua match because they come from the same source (the actual Chromium binary).

```typescript
// browser-core.ts
this.context = await this.browser.newContext({
  viewport: {...},
  // userAgent: this.deviceProfile.userAgent,   // ← REMOVED in v0.2.0
  locale: this.config.locale,
  timezoneId: this.config.timezone,
  ...
});
```

**Result:** OpenTable's Akamai Bot Manager went from blocking us at the edge to letting us into the booking flow on the very next request. Same machine, same network, same IP — only the UA override removed.

### Side effect: cross-platform UA spoofing is no longer supported

Previously you could declare a `desktop-macos` device profile while running on Linux and BlackTip would set the User-Agent to a macOS Chrome string. That doesn't work in v0.2.0 — your reported UA matches the actual Chrome binary on the host machine.

If you need cross-platform spoofing, you have to override BOTH the User-Agent header AND all Sec-Ch-Ua-* headers in lockstep using `setExtraHTTPHeaders`. v0.2.0 doesn't ship a helper for this; v0.3.0 will.

For most production use cases, you want Chrome-on-your-platform anyway, so this isn't a meaningful loss.

## The phased response plan against Akamai

This is the BlackTip team's running plan against Akamai's full layer stack. Phases marked DONE shipped in the version noted; phases marked NEXT are the team's next priorities.

### Phase 1 — Diagnostics (DONE in v0.2.0)

You can't fix what you can't see. v0.2.0 ships diagnostic primitives that capture exactly what BlackTip is sending across the TLS, HTTP/2, and HTTP header layers, plus IP reputation queries.

```typescript
// Capture our actual TLS / HTTP2 / header fingerprint
const fp = await bt.captureFingerprint();
console.log(fp.tls.ja4);                       // 't13d1516h2_8daaf6152771_d8a2da3f94cd'
console.log(fp.http2.akamaiFingerprint);       // '1:65536;2:0;4:6291456;...'
console.log(fp.headers.userAgent);             // 'Mozilla/5.0 ... Chrome/146.0.0.0 ...'
console.log(fp.headers.secChUa);               // '"Google Chrome";v="146", ...'
console.log(fp.headers.uaConsistent);          // true (the L016 check)

// Check our IP reputation
const ip = await bt.checkIpReputation();
console.log(ip.ip);                            // '47.150.34.38'
console.log(ip.asn);                           // 'AS5650'
console.log(ip.org);                           // 'Frontier Communications of America, Inc.'
console.log(ip.isDatacenter);                  // false
console.log(ip.isResidential);                 // true

// Test against an Akamai-protected URL with diagnosis
const result = await bt.testAgainstAkamai('https://www.opentable.com/');
console.log(result.passed);                    // true
console.log(result.title);                     // 'Restaurants and Restaurant Bookings | OpenTable'
console.log(result.akamaiReference);           // null (no block)
```

### Phase 2 — Quick wins (DONE in v0.2.0)

Cheap fixes applied directly:

1. **L016 (UA / Sec-Ch-Ua consistency)** — described above, the load-bearing fix
2. **Aggressive Chrome flag cleanup** — minimum flags only, match Chrome's natural launch
3. **Optional persistent user-data-dir** — `BlackTipConfig.userDataDir` lets you carry cookies, history, and visited-sites context across sessions, which makes Akamai's "first request from unknown session" challenge less likely to fire

### Phase 3 — Session warming (DONE in v0.2.0)

Akamai's "first request" challenge is harder to pass than the second. Solution: warm the session before hitting the target.

```typescript
await bt.launch();
await bt.warmSession({
  sites: [
    'https://www.google.com/',
    'https://www.wikipedia.org/',
    'https://news.ycombinator.com/',
  ],
  dwellMsRange: [3000, 8000],   // human-like reading time on each site
});
// Now navigate to the target — the browser has cookies, history, and a
// realistic activity pattern.
await bt.navigate('https://target-protected-by-akamai.com/');
```

The warming visits accumulate cookies, populate the History API, and trigger the natural behavioral signals Akamai's profiler expects to see from a real user.

### Phase 4 — TLS-rewriting proxy (DEFERRED to v0.3.0)

For cases where the host machine's installed Chrome version is OLDER than what we want to declare, OR where the host has no Chrome installed at all and we're falling back to patchright's bundled Chromium with a different TLS profile, we need byte-level TLS impersonation. The plan:

- **Use [bogdanfinn/tls-client](https://github.com/bogdanfinn/tls-client)** as a local MITM proxy
- Spawn it as a subprocess on `bt.launch()`
- Generate a self-signed root CA, install it into Chrome's cert store at launch
- Point Chrome via `--proxy-server` at the local proxy
- Verify via `bt.captureFingerprint()` that the JA4 matches the desired Chrome version

Latency cost: ~5–20 ms per connection. Platform binaries: separate Linux/macOS/Windows × x64/arm64 builds. Will ship as an **optional dependency** so users who don't need this don't pay for it.

### Phase 5 — Sensor data (DEFERRED to v0.3.0+)

Akamai's JavaScript challenge collects ~80 signals and POSTs a 30–50 KB blob. To pass:

- Either let the real script run with a real environment (best, but requires every JS-level signal to be perfect)
- Or replay a pre-captured sensor payload from a real Chrome session (works once, then session expires)

Plan:

1. Run the Akamai sensor script in a controlled BlackTip session against a known-protected URL
2. Capture the full payload and the resulting `_abck` cookie
3. Identify which signals are flagged by analyzing the payload bytes
4. Patch those specific signals at the patchright layer
5. Re-test, repeat

This is reverse-engineering work and takes weeks. Until then, BlackTip relies on its native browser environment being good enough to pass the sensor naturally — which it does in many cases now that L016 is fixed.

### Phase 6 — Behavioral biometrics (DEFERRED to v0.3.0+)

Once past the gate, Akamai still profiles mouse dynamics and keystroke timing. BlackTip's `BehavioralEngine` already handles this with Bézier mouse paths, Fitts' Law movement time, and digraph-aware typing. Tier 2 calibration against real datasets (Balabit, CMU Keystroke) will tighten the distributions further.

The current behavioral engine is sufficient for most Akamai targets. The Tier 2 calibration is a "best-in-the-world" upgrade, not a "passes Akamai" requirement.

### Phase 7 — IP reputation (USER-PROVIDED)

This is the one layer BlackTip can't fix in code. If your IP is on Akamai's flagged list, no amount of fingerprint patching will help — you need a different network. Options:

1. **Use a different connection** (mobile hotspot, different ISP) for the affected sessions
2. **Use a residential proxy provider** (BrightData, Oxylabs, Smartproxy) — `BlackTipConfig.proxy` accepts the URL, and the `ProxyPool` class handles per-domain affinity
3. **Wait 24–48 hours** for Akamai's reputation cache to expire if you've been hammering a target

BlackTip's `bt.checkIpReputation()` will tell you if your current IP is on a known flagged list, but it can't fix it.

## Currently passing / failing matrix

As of v0.2.0:

| Akamai layer | Status | Notes |
|---|---|---|
| TCP/IP reputation | User-dependent | BlackTip can't fix; use `checkIpReputation()` to diagnose |
| TLS fingerprint | ✓ Passing | Real Chrome via `channel: 'chrome'` provides byte-perfect Chrome TLS |
| HTTP/2 fingerprint | ✓ Passing | Same — real Chrome HTTP/2 stack |
| HTTP headers (UA / Sec-Ch-Ua consistency) | ✓ Passing in v0.2.0 | The L016 fix |
| HTTP headers (Sec-Fetch-*, order) | ✓ Passing | Real Chrome emits these naturally |
| Sensor data validation | Best-effort | Native browser environment passes most Akamai sensors; sites with deeper sensor analysis may still flag |
| Cookie continuity | ✓ Passing | Real Chrome handles cookies normally; persistent profile via `userDataDir` improves it further |
| Behavioral patterns | Mostly passing | Behavioral engine generates plausible distributions; Tier 2 dataset calibration tightens further |

**Validated against:**

- ✓ **OpenTable** (Akamai Bot Manager) — passing as of v0.2.0
- (More targets to be added as the team validates)

## Recipe: get into an Akamai-protected target

```typescript
import { BlackTip } from '@rester159/blacktip';

async function bookOnAkamaiSite() {
  const bt = new BlackTip({
    logLevel: 'info',
    timeout: 15_000,
    retryAttempts: 2,
    behaviorProfile: 'human',
    // userDataDir: './.bt-profile',   // optional: persist Chrome state across runs
  });
  await bt.launch();

  // Verify we're set up correctly before touching the target
  const fp = await bt.captureFingerprint();
  if (!fp.headers.uaConsistent) {
    throw new Error('UA / Sec-Ch-Ua mismatch — upgrade BlackTip to v0.2.0+');
  }

  const ip = await bt.checkIpReputation();
  if (ip.isDatacenter) {
    console.warn(`IP is on a datacenter ASN (${ip.asn}). Akamai will likely block.`);
  }

  // Warm the session before the target
  await bt.warmSession({
    sites: ['https://www.google.com/', 'https://en.wikipedia.org/wiki/Special:Random'],
    dwellMsRange: [3000, 6000],
  });

  // Navigate to the target
  await bt.navigate('https://www.opentable.com/');
  await bt.waitForStable({ networkIdleMs: 1000, maxMs: 10_000 });

  // Drive the booking flow as a normal user would
  // ...
}
```

## When BlackTip is NOT enough

If `bt.testAgainstAkamai(targetUrl)` reports a block, walk this checklist:

1. **Run `bt.captureFingerprint()`** — does `headers.uaConsistent` say `true`? If `false`, you're on v0.1.0 or older — upgrade.
2. **Run `bt.checkIpReputation()`** — is `isDatacenter: true`? Then the IP itself is the problem. Switch networks or use a residential proxy.
3. **Test in your normal Chrome from the same machine.** If your normal Chrome ALSO gets blocked, the IP is flagged regardless of what BlackTip does. You need a different network.
4. **Try a session warm-up** — call `bt.warmSession()` before the target navigation.
5. **Try a persistent profile** — set `userDataDir` in `BlackTipConfig` and let cookies accumulate across runs.
6. **Try with a residential proxy** — configure via `BlackTipConfig.proxy`.
7. **If all else fails, file an issue** at https://github.com/rester159/blacktip/issues with the output of `bt.captureFingerprint()` and `bt.checkIpReputation()` so the team can investigate.

## What we learned

The most important lesson from the v0.1.0 → v0.2.0 transition is that **fingerprint consistency matters more than fingerprint stealth**. We were emitting byte-perfect Chrome TLS, byte-perfect Chrome HTTP/2, and byte-perfect Chrome headers — except for ONE inconsistency between User-Agent and Sec-Ch-Ua. That single bug invalidated everything else against the highest-tier detectors.

Top-tier commercial detectors (Akamai, DataDome, PerimeterX) don't just look at individual fingerprint values — they cross-check that values from different layers tell the same story. A "Chrome 125" UA and "Chrome 146" client hints together is a louder signal than either value being slightly off would be alone.

**Implication:** if you're building stealth, prioritize consistency over richness. A complete, internally-consistent Chrome 125 fingerprint beats a perfectly-tuned Chrome 130 fingerprint that disagrees with itself somewhere.
