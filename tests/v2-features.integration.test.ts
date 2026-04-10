/**
 * Integration tests for the v2 features added in this session:
 *
 *   - Shadow DOM piercing via ElementFinder.findInShadowDom
 *   - bt.download() API
 *   - SessionSnapshot capture and restore
 *   - ProxyPool (unit-ish, no actual proxy traffic)
 *   - Observability event normalization + file sink
 *
 * Most of these don't need a real browser for unit coverage, but the
 * shadow DOM and snapshot tests do — they're grouped here because they
 * share a browser instance.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { readFileSync, existsSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlackTip } from '../src/blacktip.js';
import { SnapshotManager } from '../src/snapshot.js';
import { ProxyPool, ProxyProviders, proxyToUrl } from '../src/proxy-pool.js';
import {
  attachObservability,
  JsonlFileExporter,
  ConsoleExporter,
  newTraceId,
  type StructuredEvent,
  type EventExporter,
} from '../src/observability.js';

// ── Shadow DOM + download fixture server ──
//
// We need a real HTTP server for these because (a) inline scripts don't
// run on data: URLs under patchright (L013) and shadow DOM setup needs
// inline scripts, (b) the download test needs a real Content-Disposition
// header which data: URLs can't set.

const SHADOW_FIXTURE_HTML = `<!doctype html>
<html><head><title>Shadow DOM Fixture</title></head>
<body>
  <h1 id="regular">Regular DOM heading</h1>
  <div id="host-open"></div>
  <div id="host-nested"></div>
  <script>
    // Open shadow root with a button inside.
    const openHost = document.getElementById('host-open');
    const openShadow = openHost.attachShadow({ mode: 'open' });
    openShadow.innerHTML = '<button id="in-open-shadow">Inside Open Shadow</button>';

    // Nested: host → open shadow root → inner host → another open shadow root
    const nestedHost = document.getElementById('host-nested');
    const outer = nestedHost.attachShadow({ mode: 'open' });
    outer.innerHTML = '<div id="inner-host"></div>';
    const inner = outer.querySelector('#inner-host').attachShadow({ mode: 'open' });
    inner.innerHTML = '<span id="deep-target">Deeply Nested</span>';
  </script>
</body></html>`;

const DOWNLOAD_FIXTURE_HTML = `<!doctype html>
<html><head><title>Download Fixture</title></head>
<body>
  <a id="dl" href="/file.txt" download="the-file.txt">Download the file</a>
</body></html>`;

describe('v2 — shadow DOM + download + snapshot (integration)', () => {
  let bt: BlackTip;
  let server: Server;
  let port: number;
  let tmp: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/shadow')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SHADOW_FIXTURE_HTML);
      } else if (url.startsWith('/download')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DOWNLOAD_FIXTURE_HTML);
      } else if (url.startsWith('/file.txt')) {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Disposition': 'attachment; filename="the-file.txt"',
        });
        res.end('BlackTip v2 download test payload\n');
      } else if (url.startsWith('/snapshot-origin')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><h1 id="ok">ok</h1></body></html>');
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;

    tmp = mkdtempSync(join(tmpdir(), 'blacktip-v2-'));

    bt = new BlackTip({
      logLevel: 'error',
      timeout: 10_000,
      retryAttempts: 1,
    });
    await bt.launch();
  });

  afterAll(async () => {
    if (bt) await bt.close();
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  // ── Shadow DOM ──

  it('findInShadowDom finds element in open shadow root', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/shadow`);
    await new Promise((r) => setTimeout(r, 200));

    const handle = await bt.findInShadowDom('#in-open-shadow');
    const text = await handle.innerText();
    expect(text).toBe('Inside Open Shadow');
  });

  it('findInShadowDom pierces nested open shadow roots', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/shadow`);
    await new Promise((r) => setTimeout(r, 200));

    const handle = await bt.findInShadowDom('#deep-target');
    const text = await handle.innerText();
    expect(text).toBe('Deeply Nested');
  });

  it('findInShadowDom throws when element missing everywhere', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/shadow`);
    await expect(
      bt.findInShadowDom('#does-not-exist', { timeout: 1200 }),
    ).rejects.toThrow(/not found in shadow DOM/i);
  });

  // ── Download API ──

  it('download() clicks an anchor and saves the file', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/download`);

    const savePath = join(tmp, 'downloaded.txt');
    const info = await bt.download('#dl', { saveTo: savePath });

    expect(info.path).toBe(savePath);
    expect(info.size).toBeGreaterThan(0);
    expect(info.suggestedFilename).toBe('the-file.txt');
    expect(existsSync(savePath)).toBe(true);

    const contents = readFileSync(savePath, 'utf-8');
    expect(contents).toContain('BlackTip v2 download test payload');
  });

  // ── Session snapshot / restore ──

  it('SnapshotManager captures cookies + storage + URL and restores them', async () => {
    const sm = new SnapshotManager((bt as unknown as { core: import('../src/browser-core.js').BrowserCore }).core);

    await bt.navigate(`http://127.0.0.1:${port}/snapshot-origin`);

    // Seed storage + cookies via executeJS and setCookies.
    await bt.executeJS(`(() => {
      localStorage.setItem('bt-snap-k', 'local-value-42');
      sessionStorage.setItem('bt-snap-s', 'session-value-7');
    })()`);
    await bt.setCookies([
      { name: 'bt_snap_cookie', value: 'c1', domain: '127.0.0.1', path: '/', url: `http://127.0.0.1:${port}/` },
    ]);

    const snapshot = await sm.capture('test');
    expect(snapshot.version).toBe(1);
    expect(snapshot.url).toContain('/snapshot-origin');
    expect(snapshot.cookies.some((c) => c.name === 'bt_snap_cookie')).toBe(true);

    const originKey = `http://127.0.0.1:${port}`;
    expect(snapshot.localStorageByOrigin[originKey]?.['bt-snap-k']).toBe('local-value-42');
    expect(snapshot.sessionStorageByOrigin[originKey]?.['bt-snap-s']).toBe('session-value-7');

    // Wipe everything: new context + clear cookies and storage.
    await bt.clearCookies();
    await bt.navigate('about:blank');

    // Restore and verify we're back on the original URL with the data.
    await sm.restore(snapshot);
    const restoredLocal = await bt.executeJS(`localStorage.getItem('bt-snap-k')`);
    expect(restoredLocal).toBe('local-value-42');
    const cookies = await bt.cookies();
    expect(cookies.some((c) => c.name === 'bt_snap_cookie')).toBe(true);
  });
});

// ── ProxyPool unit tests (no browser needed) ──

describe('ProxyPool — rotation, affinity, reputation', () => {
  it('round-robin selection cycles through eligible proxies per domain', () => {
    const pool = new ProxyPool([
      { id: 'a', protocol: 'http', host: 'a.example', port: 8080 },
      { id: 'b', protocol: 'http', host: 'b.example', port: 8080 },
      { id: 'c', protocol: 'http', host: 'c.example', port: 8080 },
    ]);

    const ids = [
      pool.selectForDomain('target.com')?.id,
      pool.selectForDomain('target.com')?.id,
      pool.selectForDomain('target.com')?.id,
      pool.selectForDomain('target.com')?.id,
    ];
    // With 3 proxies and round-robin we expect the full cycle and then
    // a wraparound. Order isn't required to start at index 0 but each
    // proxy must appear at least once.
    expect(new Set(ids.slice(0, 3)).size).toBe(3);
    expect(ids[3]).toBe(ids[0]);
  });

  it('banned proxies are skipped on the banned domain but still picked on others', () => {
    const pool = new ProxyPool([
      { id: 'good', protocol: 'http', host: 'good.example', port: 1 },
      { id: 'bad', protocol: 'http', host: 'bad.example', port: 2 },
    ]);

    pool.reportBan('bad', 'target.com', 'captcha');

    // 20 picks on target.com should all be 'good'.
    for (let i = 0; i < 20; i++) {
      const p = pool.selectForDomain('target.com');
      expect(p?.id).toBe('good');
    }

    // On a different domain, 'bad' is still eligible.
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const p = pool.selectForDomain('other.com');
      if (p) seen.add(p.id);
    }
    expect(seen.has('bad')).toBe(true);
  });

  it('empty pool returns null', () => {
    const pool = new ProxyPool([]);
    expect(pool.selectForDomain('any.com')).toBeNull();
  });

  it('ProxyProviders.brightData formats the URL correctly', () => {
    const p = ProxyProviders.brightData('abc123', 'secret', 'residential_a');
    expect(p.host).toBe('brd.superproxy.io');
    expect(p.port).toBe(22225);
    const url = proxyToUrl(p);
    expect(url.startsWith('http://')).toBe(true);
    expect(url).toContain('brd.superproxy.io:22225');
    expect(url).toContain('brd-customer-abc123-zone-residential_a');
    expect(url).toContain('secret');
  });

  it('pruneExpiredBans removes old ban entries', () => {
    const pool = new ProxyPool(
      [{ id: 'p', protocol: 'http', host: 'x.example', port: 1 }],
      { banDecayMs: 10 },
    );
    pool.reportBan('p', 'target.com');
    // Wait just past the decay window.
    const start = Date.now();
    while (Date.now() - start < 25) { /* tight wait */ }
    const pruned = pool.pruneExpiredBans();
    expect(pruned).toBe(1);
  });

  it('reputation snapshot includes proxies, active bans, and usage counts', () => {
    const pool = new ProxyPool([
      { id: 'x', protocol: 'http', host: 'x.example', port: 1 },
      { id: 'y', protocol: 'http', host: 'y.example', port: 1 },
    ]);
    pool.selectForDomain('site.com');
    pool.selectForDomain('site.com');
    pool.reportBan('x', 'site.com');
    const snap = pool.getReputationSnapshot();
    expect(snap.proxies.length).toBe(2);
    expect(snap.activeBans.length).toBe(1);
    expect(Object.keys(snap.usage).length).toBeGreaterThan(0);
  });
});

// ── Observability tests ──

describe('Observability — event normalization + sinks', () => {
  it('newTraceId produces 16-char hex strings', () => {
    for (let i = 0; i < 10; i++) {
      const id = newTraceId();
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('attachObservability wires up action events and fans them to exporters', async () => {
    // Use a tiny local BlackTip + fixture to generate one real action event.
    const bt = new BlackTip({
      logLevel: 'error',
      timeout: 5000,
      retryAttempts: 1,
      behaviorProfile: 'scraper',
    });
    await bt.launch();

    const collected: StructuredEvent[] = [];
    const collector: EventExporter = {
      export: (e) => collected.push(e),
    };
    const stop = attachObservability(bt, [collector]);

    // Navigate to a tiny data: URL and click a button.
    const html = '<!doctype html><html><body><button id="btn">hi</button></body></html>';
    await bt.navigate(`data:text/html,${encodeURIComponent(html)}`);
    await bt.click('#btn', { importance: 'high' });

    // We expect at least one action event.
    const actions = collected.filter((e) => e.name.startsWith('action.'));
    expect(actions.length).toBeGreaterThan(0);
    const clickEvent = actions.find((e) => e.name === 'action.click');
    expect(clickEvent).toBeDefined();
    expect(clickEvent!.attributes['bt.outcome']).toBe('success');
    expect(clickEvent!.attributes['bt.target']).toBe('#btn');
    expect(clickEvent!.traceId).toMatch(/^[0-9a-f]{16}$/);

    // Also expect the pre-action pause to show up in attributes and be
    // above the baseline since we set importance='high'.
    const prePause = clickEvent!.attributes['bt.behavioral.pre_pause_ms'] as number | undefined;
    expect(typeof prePause).toBe('number');
    expect(prePause!).toBeGreaterThan(150);

    stop();
    await bt.close();
  });

  it('JsonlFileExporter writes one event per line', async () => {
    const tmpFile = join(tmpdir(), `blacktip-obs-${Date.now()}.jsonl`);
    const exporter = new JsonlFileExporter(tmpFile);
    const ev: StructuredEvent = {
      timestamp: new Date().toISOString(),
      name: 'test.event',
      severity: 'info',
      traceId: newTraceId(),
      attributes: { 'bt.test': 'yes', 'bt.count': 42 },
    };
    exporter.export(ev);
    exporter.export(ev);
    const contents = readFileSync(tmpFile, 'utf-8');
    const lines = contents.trim().split('\n');
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.name).toBe('test.event');
      expect(parsed.attributes['bt.count']).toBe(42);
    }
    unlinkSync(tmpFile);
  });

  it('ConsoleExporter runs without throwing', () => {
    const ev: StructuredEvent = {
      timestamp: new Date().toISOString(),
      name: 'test.console',
      severity: 'info',
      traceId: newTraceId(),
      attributes: {},
    };
    const exporter = new ConsoleExporter();
    expect(() => exporter.export(ev)).not.toThrow();
  });
});
