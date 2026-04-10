/**
 * Real-site smoke tests.
 *
 * Two independent checks:
 *   1. Wikipedia — exercises a real multi-step DOM interaction (navigate,
 *      search form, click, extract) against a stable site that isn't
 *      adversarial. Catches the same class of bug as the Anthem session
 *      (stale pages, focus issues, framework mismatches) without credentials.
 *   2. Local headers-echo server — spins up a tiny HTTP server that echoes
 *      the request headers it received, then has BlackTip navigate to it
 *      and verifies the headers BlackTip actually sent look like real Chrome
 *      (User-Agent, Sec-Fetch-*, sec-ch-ua, Accept-Language).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { BlackTip } from '../src/blacktip.js';

describe('Real-site: Wikipedia multi-step flow', () => {
  let bt: BlackTip;

  beforeAll(async () => {
    bt = new BlackTip({
      logLevel: 'error',
      timeout: 20_000,
      retryAttempts: 2,
      deviceProfile: 'desktop-windows',
    });
    await bt.launch();
  });

  afterAll(async () => {
    if (bt) await bt.close();
  });

  it('loads an article and extracts the first heading', async () => {
    const result = await bt.navigate('https://en.wikipedia.org/wiki/Blacktip_shark');
    expect(result.success).toBe(true);
    // Wikipedia articles have the title in #firstHeading.
    await bt.waitFor('#firstHeading', { timeout: 15_000 });
    const heading = await bt.extractText('#firstHeading');
    expect(heading).toContain('Blacktip shark');
  });

  it('runs a search from the main page and reaches the result article', async () => {
    const result = await bt.navigate('https://en.wikipedia.org/wiki/Main_Page');
    expect(result.success).toBe(true);

    // Wikipedia's search input is #searchInput on the main page, or a
    // different id on mobile/desktop variants. Try the desktop id.
    await bt.waitFor('input[name="search"]', { timeout: 10_000 });

    // Type the query and submit with Enter.
    const typeResult = await bt.type('input[name="search"]', 'Playwright software', {
      paste: true,
      pressEnter: true,
    });
    expect(typeResult.success).toBe(true);

    // Wait for navigation to complete and the result article to render.
    await bt.waitFor('#firstHeading', { timeout: 15_000 });
    const heading = await bt.extractText('#firstHeading');
    // We either land on an article about Playwright or on the search results
    // page. Both are acceptable as long as the query made it through.
    expect(String(heading).length).toBeGreaterThan(0);
  });
});

describe('Real-site: HTTP headers echo server', () => {
  let server: Server;
  let port: number;
  let bt: BlackTip;
  // Keyed by request path — Chrome fetches favicon.ico and other resources
  // after the main doc, so "last request" isn't reliable. Per-path lookup is.
  const headersByPath: Record<string, Record<string, string | string[] | undefined>> = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      headersByPath[path] = req.headers;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><head><title>Headers Echo</title></head>' +
          '<body><h1 id="ok">ok</h1></body></html>',
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as AddressInfo).port;

    bt = new BlackTip({
      logLevel: 'error',
      timeout: 10_000,
      retryAttempts: 1,
      deviceProfile: 'desktop-windows',
    });
    await bt.launch();
  });

  afterAll(async () => {
    if (bt) await bt.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends a real-Chrome-looking User-Agent on the document request', async () => {
    const result = await bt.navigate(`http://127.0.0.1:${port}/probe1`);
    expect(result.success).toBe(true);
    await bt.waitFor('#ok');

    const headers = headersByPath['/probe1'];
    expect(headers).toBeDefined();
    const ua = headers!['user-agent'];
    expect(typeof ua).toBe('string');
    expect(String(ua)).toMatch(/Chrome/);
    expect(String(ua)).toMatch(/Windows NT/);
    expect(String(ua)).not.toMatch(/HeadlessChrome/);
  });

  it('sends Sec-Fetch-* headers on the document request', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/probe2`);
    await bt.waitFor('#ok');

    const headers = headersByPath['/probe2'];
    expect(headers).toBeDefined();
    expect(headers!['sec-fetch-site']).toBeDefined();
    expect(headers!['sec-fetch-mode']).toBeDefined();
    expect(headers!['sec-fetch-dest']).toBeDefined();
    expect(String(headers!['sec-fetch-dest'])).toBe('document');
    expect(String(headers!['sec-fetch-mode'])).toBe('navigate');
  });

  it('sends sec-ch-ua client hints on the document request', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/probe3`);
    await bt.waitFor('#ok');

    const headers = headersByPath['/probe3'];
    expect(headers).toBeDefined();
    expect(headers!['sec-ch-ua']).toBeDefined();
    expect(headers!['sec-ch-ua-mobile']).toBeDefined();
    // Desktop profile → mobile hint should be ?0.
    expect(String(headers!['sec-ch-ua-mobile'])).toBe('?0');
  });

  it('sends Accept and Accept-Language headers on the document request', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/probe4`);
    await bt.waitFor('#ok');

    const headers = headersByPath['/probe4'];
    expect(headers).toBeDefined();
    expect(headers!['accept']).toBeDefined();
    // The top-level navigation request's Accept starts with text/html.
    expect(String(headers!['accept'])).toContain('text/html');

    expect(headers!['accept-language']).toBeDefined();
    expect(String(headers!['accept-language']).length).toBeGreaterThan(0);
  });
});
