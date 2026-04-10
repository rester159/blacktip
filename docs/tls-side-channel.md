# TLS side-channel (v0.3.0)

The v0.3.0 answer to "an edge gates the very first request before BlackTip's browser even has a session." BlackTip ships a Go-based daemon built on `bogdanfinn/tls-client` that performs HTTP requests with a real Chrome TLS ClientHello, real H2 frame settings, and real H2 frame order. You use it to make gating requests the browser can't make through itself, then inject the resulting cookies into the browser session before navigating.

## When you need this

Most BlackTip flows do not need the TLS side-channel. The browser's own TLS via `channel: 'chrome'` is real Chrome and passes every detector we've validated against. The side-channel is for the cases where it isn't enough:

1. **First-request edge gating.** Some Akamai-protected sites refuse to serve a session cookie to a navigation that doesn't already have one. You hit them via the side-channel first (which goes through `bm_s` → sensor data POST → `bm_sv` issuance), then inject the resulting cookies into the browser and navigate normally.
2. **Cross-platform User-Agent spoofing.** You're running on Linux but want the target to see Windows. The browser's TLS comes from the host OS Chrome, so you can't fake the platform without a TLS rewriter. The side-channel can. v0.2.0's L016 fix removed the broken UA-override path; this is the supported alternative.
3. **API-level operations.** You want to call a JSON API the site exposes, but the API edge enforces the same TLS profile as the browser. Use the side-channel to call the API without paying browser-render overhead per request.
4. **Pre-warming for proxy rotation.** You're rotating residential proxies and need to "warm" each new IP with a Chrome-TLS handshake before the browser session uses it.

## Build the daemon

The daemon is a small Go program in `native/tls-client/`. Go is the only build dependency. Install Go from https://go.dev/dl/ then:

```bash
cd native/tls-client
go build -o blacktip-tls .       # Linux / macOS
go build -o blacktip-tls.exe .   # Windows
```

The build produces a single ~14 MB statically-linked binary. BlackTip resolves it via `native/tls-client/blacktip-tls[.exe]` automatically; override with `BLACKTIP_TLS_BIN=/abs/path/to/binary` if you want to ship it elsewhere.

## Usage

```typescript
import { BlackTip } from '@rester159/blacktip';

const bt = new BlackTip({ logLevel: 'info' });
await bt.launch();

// 1. Make the gating request through the side-channel.
const resp = await bt.fetchWithTls({
  url: 'https://www.opentable.com/',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});
console.log('TLS fetch status:', resp.status);
console.log('Earned cookies:', resp.cookies.map(c => c.name));

// 2. Inject the cookies into the browser session.
const injected = await bt.injectTlsCookies(resp, 'https://www.opentable.com/');
console.log('Injected', injected, 'cookies');

// 3. Navigate normally — the browser carries the side-channel-earned tokens.
await bt.navigate('https://www.opentable.com/');
await bt.waitForStable();
// ... rest of flow

await bt.close();   // Closes the TLS daemon too
```

## Architecture

- **Wire protocol**: newline-delimited JSON over the daemon's stdin/stdout. Each request has a string `id`; responses match by id, so multiple in-flight `fetch()` calls don't interleave.
- **Daemon lifecycle**: spawned lazily on first `fetchWithTls()` call, kept alive until `bt.close()`. No subprocess startup cost per request.
- **Concurrency**: the daemon handles each request in its own Go goroutine. The Node side dispatches them in parallel and reassembles by id.
- **Profile selection**: defaults to `chrome_133`. Override per-request via `bt.fetchWithTls({ url, profile: 'chrome_124' })`. Available profiles are whatever `bogdanfinn/tls-client/profiles` ships — at the time of writing: `chrome_120`, `chrome_124`, `chrome_131`, `chrome_133`, `firefox_120`, `safari_ios_16_0`.
- **Body encoding**: bodies are base64 on the wire to avoid newline / Unicode issues with the line-delimited protocol. The wrapper handles encoding/decoding transparently.

## Validated TLS fingerprint

Run via the integration test (`tests/tls-side-channel.integration.test.ts`):

```
JA4: t13d1516h2_8daaf6152771_d8a2da3f94cd
First cipher: TLS_GREASE (0x5A5A)
HTTP/2 Akamai fingerprint: 1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p
```

This is byte-for-byte identical to real Chrome 133. The leading `t13d` JA4 prefix confirms TLS 1.3 with Chrome's count signature; the GREASE first cipher confirms proper GREASE rotation; the H2 fingerprint matches Chrome's frame settings and frame order (`m,a,s,p` = method/authority/scheme/path).

## Caveats

- **Not a Chrome browser.** The side-channel is HTTP-only — no JavaScript execution, no DOM, no Cookie JAR persistence beyond what you inject manually. You use it to acquire tokens, not to drive a flow.
- **Akamai sensor data is not bypassed.** A first request to an Akamai-protected URL through the side-channel returns 403 with `bm_s`/`bm_ss`/`bm_so` set — the same place a browser would be at after one request. Akamai expects a sensor data POST to follow before serving 200s. The side-channel collects the session cookies; the sensor POST is not yet automated. You can either (a) inject the bm_s cookies into the browser and let the browser do the sensor POST (this is what the OpenTable validation flow does), or (b) implement the sensor POST yourself.
- **Always set the User-Agent header.** The Go HTTP client defaults to `Go-http-client/2.0` if you don't override it. That's a textbook automation tell. The wrapper auto-sets `Accept-Language` to `en-US,en;q=0.9` if missing, but UA is your job.
- **Linux/macOS support is built but not validated in CI.** The `go build` command produces native binaries for whatever platform you run it on; the Node-side `resolveBinaryPath()` picks the right name based on `process.platform`. If you ship to a server, build the daemon in the same OS the server runs.
