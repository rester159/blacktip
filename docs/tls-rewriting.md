# Full TLS rewriting (v0.5.0)

The v0.5.0 answer to "every wire request should present a real Chrome TLS fingerprint, not just the gating ones." Without a TCP-level MITM proxy and the OS-specific cert installation hell that entails, BlackTip uses Chrome DevTools Protocol's `Fetch.enable` to pause every HTTP request the browser issues, hand it to the Go `bogdanfinn/tls-client` daemon for upstream execution, and fulfill the response back through CDP. **The browser never opens an upstream TCP connection. Every wire request presents real Chrome TLS via Go.**

## What this gives you over the v0.3.0 side-channel

The v0.3.0 `bt.fetchWithTls()` only handled gating requests the caller made explicitly. Page subresources, XHR, `fetch()` from page JS — all of those went through Chrome's own TLS, meaning the host OS's Chrome fingerprint reached the wire on every subresource. With the v0.5.0 rewriter installed, **every** subresource also goes through Go.

What changes:
- **Cross-platform UA spoofing is restored.** v0.2.0's L016 fix removed the broken context-level UA override because it caused User-Agent / Sec-Ch-Ua mismatch. With the rewriter, the daemon controls every header on the wire — spoof to your heart's content.
- **JA4 / GREASE / H2 fingerprint of every request matches real Chrome 133** (or whatever profile you select), regardless of what Chrome the host OS has installed. Useful when you need to impersonate a specific Chrome version that doesn't ship for your platform.
- **One source of truth for TLS.** No more "the gating request matched but the subresource didn't" inconsistency that anti-bot vendors can fingerprint at the session level.

## Validated end-to-end

Run `npx vitest run tests/tls-rewriter.integration.test.ts` (requires the Go daemon binary). The load-bearing assertion is:

```
JA4: t13d1516h2_8daaf6152771_d8a2da3f94cd       (textbook Chrome 133)
First cipher: TLS_GREASE (0x3A3A)               (rotated each connection)
HTTP/2 fingerprint: 1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p
```

This is the JA4 reaching tls.peet.ws **via the browser navigation** (not via a direct daemon call). The browser navigated to `tls.peet.ws/api/all`, the JSON it received back came from an upstream connection that the Go daemon opened, not Chrome.

## Usage

```typescript
import { BlackTip } from '@rester159/blacktip';

const bt = new BlackTip({
  logLevel: 'info',
  timeout: 30_000,
  // The headline knob — when set to 'all', every request the browser
  // issues is intercepted via CDP Fetch and forwarded through the Go
  // daemon for upstream execution.
  tlsRewriting: 'all',
});

await bt.launch();
await bt.navigate('https://www.opentable.com/');

// Verify the rewriter is doing what you expect
console.log(bt.getTlsRewriterStats());
// {
//   intercepted: 47,
//   fulfilled: 45,
//   fellThrough: 0,
//   webSocketLeaks: 0,
//   avgDurationMs: 73
// }

await bt.close();
```

The daemon binary must be built first. Go is the only build dependency:

```bash
cd native/tls-client
go build -o blacktip-tls .       # Linux / macOS
go build -o blacktip-tls.exe .   # Windows
```

If the daemon binary is missing when `tlsRewriting: 'all'` is set, `bt.launch()` throws rather than silently falling back to native Chrome TLS that the caller didn't ask for.

## Architecture

The rewriter is installed as a Patchright/Playwright `context.route('**/*', handler)` hook, which is the high-level wrapper around CDP `Fetch.enable`. We use the route handler so we don't need to manage CDP sessions ourselves.

For each intercepted request, the handler:

1. Reads URL, method, headers, body via Playwright's `Request` API.
2. Strips request headers Chrome's lifecycle owns: `Host`, `Content-Length`, `Connection`, `Keep-Alive`, `Transfer-Encoding`, etc.
3. Calls `TlsSideChannel.fetch()` with the cleaned-up request — the daemon makes the upstream call with real Chrome TLS.
4. Strips response headers Chrome re-computes: `Content-Length`, `Content-Encoding`, `Transfer-Encoding`, `Connection`, `Keep-Alive`.
5. Multi-valued headers are joined: `Set-Cookie` with `\n` (so each cookie stays separate), everything else with `, `.
6. Calls `route.fulfill({ status, headers, body })` with the daemon's response — the browser receives it as if Chrome had made the request itself.

The daemon stays alive for the lifetime of the browser context. On `bt.close()`, the rewriter is uninstalled and the daemon is shut down via its existing `TlsSideChannel.close()` path.

## Chrome flags

When `tlsRewriting: 'all'` is set, BlackTip automatically launches Chrome with `--disable-quic` to force HTTP/1.1 and HTTP/2 only. This is required because Chrome handles QUIC at a layer below CDP Fetch — QUIC requests would bypass the rewriter entirely and present Chrome's native TLS to the wire. With QUIC disabled, every HTTP request flows through Fetch and through us.

Real Chrome users disable QUIC routinely (corporate network policies, debugging) so this isn't a fingerprinting tell on its own. If you need QUIC for some reason (rare), set `tlsRewriting: 'off'` and use the v0.3.0 side-channel for the requests that matter most.

## Limitations

### WebSocket leaks

Chrome handles WebSocket frames at a layer below CDP `Fetch.enable`. The initial HTTP `Upgrade: websocket` request can be intercepted, but the actual WebSocket frames after the upgrade go straight through Chrome's native TLS. The rewriter detects WebSocket upgrades, logs a warning, and falls through to `route.continue()` so the upgrade succeeds (and the WebSocket works) — but those frames present Chrome's host-OS TLS, not the daemon's.

Mitigation: if your target uses WebSockets and you need full TLS rewriting on them, the only honest answer today is "use a proxy that handles WebSocket framing" (which is back to TCP-level MITM). The rewriter's `webSocketLeaks` stat counts how many you saw so you can decide whether to care.

### Streaming responses

CDP `Fetch.fulfillRequest` requires a complete body. The rewriter buffers each response fully before fulfilling, which is fine for HTML, JSON, CSS, JS, fonts, images, and typical web pages — but bad for video streams, large file downloads, and Server-Sent Events. For those, set `tlsRewriting: 'off'` and use the v0.3.0 side-channel selectively for the gating requests.

### HTTP/3 / QUIC

Disabled via `--disable-quic` automatically when the rewriter is on (see above). If a server only serves HTTP/3, the rewriter can't reach it.

### Per-request overhead

Each intercepted request adds 5–10ms of round-trip overhead through the daemon (measured: `avgDurationMs ≈ 70-100ms` for typical small responses, dominated by the actual upstream network latency). On a typical page with 50 subresources that's 250–500ms added to the total page load. Acceptable for stealth-critical use cases; not acceptable for high-throughput crawling.

### Stats accounting

`intercepted` may be slightly higher than `fulfilled + fellThrough + webSocketLeaks` (off by 1–5 on a typical page) when requests are aborted by Chrome's navigation lifecycle before the route handler completes. The functional behavior is correct — the page renders properly — but the counter doesn't perfectly account for the cancelled-in-flight cases. Don't use the stats for billing.

## When to use which

| Need | Use |
|---|---|
| Make a single gating request before launching the browser | `bt.fetchWithTls()` (v0.3.0 side-channel) |
| Make sure every subresource also presents real Chrome TLS | `tlsRewriting: 'all'` (v0.5.0 rewriter) |
| Cross-platform UA spoofing (Linux pretending to be Mac) | `tlsRewriting: 'all'` |
| WebSocket-heavy app (chat, real-time stocks) | `tlsRewriting: 'off'` + selective side-channel |
| Video streaming or large downloads | `tlsRewriting: 'off'` |
| Maximum throughput crawling | `tlsRewriting: 'off'` |
| Stealth-critical, throughput-flexible | `tlsRewriting: 'all'` |
