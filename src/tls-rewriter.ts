/**
 * TLS rewriting via CDP Fetch interception.
 *
 * The v0.5.0 answer to "every wire request should present a real Chrome
 * TLS fingerprint, not just the gating ones." Without a TCP-level MITM
 * proxy (and the OS-specific cert installation hell that entails), we
 * use Chrome DevTools Protocol's `Fetch.enable` to pause every HTTP
 * request the browser issues, hand it to the Go `bogdanfinn/tls-client`
 * daemon for upstream execution, and fulfill the response back through
 * CDP. The browser never opens an upstream TCP connection — all its
 * HTTP is fulfilled by us.
 *
 * Patchright/Playwright expose this as `context.route('**', handler)`,
 * which is the high-level wrapper around CDP Fetch. We use the route
 * handler so we don't need to manage CDP sessions ourselves.
 *
 * What this fixes vs the v0.3.0 side-channel (`bt.fetchWithTls`):
 *   - The side-channel only handled gating requests the caller made
 *     explicitly. Page subresources, XHR, fetch() from page JS, all
 *     went through Chrome's own TLS — meaning the host OS's Chrome
 *     fingerprint reached the wire. With this rewriter installed, every
 *     subresource also goes through Go.
 *   - Cross-platform UA spoofing is restored. The daemon controls every
 *     header on the wire; spoof to your heart's content.
 *
 * Known limitations:
 *   - WebSocket upgrades can't be intercepted by Fetch.enable. They
 *     bypass the rewriter and present Chrome's native TLS. The rewriter
 *     logs WS leaks for awareness.
 *   - Streaming responses are buffered fully. Bad for video, fine for
 *     HTML/JSON/typical web pages.
 *   - HTTP/3 (QUIC) requests bypass Fetch.enable entirely because Chrome
 *     short-circuits them. We launch with `--disable-quic` so this never
 *     fires in practice.
 */

import type { BrowserContext, Route, Request as PlaywrightRequest } from 'patchright';
import type { TlsSideChannel } from './tls-side-channel.js';
import type { Logger } from './logging.js';

/**
 * Headers that Chrome's request lifecycle manages itself and that we
 * MUST NOT pass through verbatim — re-sending them through the daemon
 * either breaks the request (Content-Length) or duplicates state
 * (Cookie, which the daemon will set automatically from the upstream's
 * Set-Cookie response, while the browser's own cookie jar handles the
 * reverse direction). The browser cookie jar IS the source of truth;
 * we forward Cookie verbatim and let Set-Cookie come back via fulfill.
 */
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'proxy-authorization',
  'proxy-connection',
  'upgrade',
  'expect',
]);

/**
 * Headers Chrome's response lifecycle re-computes and that we should
 * NOT pass back via fulfill — letting them through breaks framing.
 */
const STRIP_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding', // upstream returns gzip; we hand fulfill the decoded body
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

export interface TlsRewriterOptions {
  /** TLS daemon spawned by `TlsSideChannel.spawn()`. The rewriter does
   *  not own its lifecycle — caller is responsible for `close()`. */
  channel: TlsSideChannel;
  logger: Logger;
  /** Hard timeout per request to the daemon. Default 30s. */
  perRequestTimeoutMs?: number;
  /** Profile name passed to the daemon for every request. Defaults to
   *  `chrome_133`. Cross-platform spoofing happens by overriding this
   *  per-launch (e.g. `chrome_124`) plus the User-Agent header. */
  profile?: string;
}

export interface TlsRewriterStats {
  /** Total requests intercepted. */
  intercepted: number;
  /** Requests fulfilled successfully via the daemon. */
  fulfilled: number;
  /** Requests that fell through to `route.continue()` because of an
   *  error in the daemon path (e.g. daemon crashed, upstream timeout). */
  fellThrough: number;
  /** WebSocket upgrade requests we saw but couldn't intercept. */
  webSocketLeaks: number;
  /** Average daemon round-trip in ms. */
  avgDurationMs: number;
}

/**
 * Install the TLS rewriter on a Playwright BrowserContext. After this
 * call, every HTTP/HTTPS request the browser issues is intercepted and
 * forwarded through the TLS daemon. Returns a `stats()` accessor and an
 * `uninstall()` callback.
 */
export async function installTlsRewriter(
  context: BrowserContext,
  options: TlsRewriterOptions,
): Promise<{
  stats: () => TlsRewriterStats;
  uninstall: () => Promise<void>;
}> {
  const { channel, logger } = options;
  const profile = options.profile ?? 'chrome_133';
  const perRequestTimeoutMs = options.perRequestTimeoutMs ?? 30_000;

  let intercepted = 0;
  let fulfilled = 0;
  let fellThrough = 0;
  let webSocketLeaks = 0;
  let totalDurationMs = 0;

  const handler = async (route: Route, request: PlaywrightRequest): Promise<void> => {
    intercepted++;
    const url = request.url();
    const method = request.method();

    // WebSocket upgrades come through `route` but Fetch can't intercept
    // the upgrade itself — Chrome handles WS frames at a layer we can't
    // see from here. Let them pass through and log a warning.
    if (request.isNavigationRequest() && (url.startsWith('ws://') || url.startsWith('wss://'))) {
      webSocketLeaks++;
      logger.warn('TLS rewriter: WebSocket leak — upgrade bypasses the rewriter', { url });
      await route.continue();
      return;
    }
    const upgradeHeader = request.headers()['upgrade'];
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      webSocketLeaks++;
      logger.warn('TLS rewriter: WebSocket leak — upgrade bypasses the rewriter', { url });
      await route.continue();
      return;
    }

    // Build the daemon request from the browser-side request.
    const reqHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers())) {
      if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
      reqHeaders[key] = value;
    }

    const postBuffer = request.postDataBuffer();
    const body = postBuffer ?? undefined;

    try {
      const resp = await Promise.race([
        channel.fetch({
          url,
          method,
          headers: reqHeaders,
          body,
          profile,
          timeoutMs: perRequestTimeoutMs,
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`TLS rewriter: per-request timeout ${perRequestTimeoutMs}ms`)), perRequestTimeoutMs + 1000).unref();
        }),
      ]);

      totalDurationMs += resp.durationMs;

      // Flatten response headers. Multi-valued headers (e.g. Set-Cookie)
      // need special handling: Playwright's fulfill takes a single string
      // per key, but lets you pass an array via the headers parameter
      // since 1.50 — we use the comma-join fallback for older versions.
      // For Set-Cookie specifically, we use the multi-value extension
      // because cookies must not be merged.
      const respHeaders: Record<string, string> = {};
      for (const [key, values] of Object.entries(resp.headers)) {
        if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
        if (values.length === 1) {
          respHeaders[key] = values[0]!;
        } else {
          // For Set-Cookie, joining with comma is wrong (cookies have
          // their own commas in Expires). Playwright's `fulfill` accepts
          // multiValueHeaders via the headers field as Record<string, string>
          // by joining with `\n` for some headers. Safest fallback: pass
          // each Set-Cookie as a separate header by using the array form
          // if available, otherwise the last cookie wins.
          //
          // Since we can't pass arrays directly to Playwright's fulfill
          // headers, we encode the multi-value as `\n`-separated for
          // Set-Cookie (Chrome accepts this) and comma-join for everything
          // else.
          if (key.toLowerCase() === 'set-cookie') {
            respHeaders[key] = values.join('\n');
          } else {
            respHeaders[key] = values.join(', ');
          }
        }
      }

      await route.fulfill({
        status: resp.status,
        headers: respHeaders,
        body: resp.bodyBuffer,
      });
      fulfilled++;
    } catch (err) {
      fellThrough++;
      logger.warn('TLS rewriter: daemon path failed, falling through to native fetch', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through to the browser's native request. Less stealthy but
      // doesn't break the page.
      try {
        await route.continue();
      } catch {
        // Route may already be fulfilled/aborted in race conditions; ignore.
      }
    }
  };

  // Install the route handler for all URLs. Patchright/Playwright accept
  // a glob ('**/*') or RegExp; we use the glob for clarity.
  await context.route('**/*', handler);

  return {
    stats: (): TlsRewriterStats => ({
      intercepted,
      fulfilled,
      fellThrough,
      webSocketLeaks,
      avgDurationMs: fulfilled > 0 ? Math.round(totalDurationMs / fulfilled) : 0,
    }),
    uninstall: async (): Promise<void> => {
      try {
        await context.unroute('**/*', handler);
      } catch {
        // Context may be closing; ignore.
      }
    },
  };
}
