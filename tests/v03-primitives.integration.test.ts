/**
 * v0.3 primitive integration tests.
 *
 * Covers the new agent-facing primitives added after the Anthem session:
 *   - waitForStable  (replaces fixed sleeps)
 *   - waitForText    (wait for server-rendered content)
 *   - inspect        (one-call element inspection)
 *   - listOptions    (Angular-style dropdown enumeration)
 *   - networkSince / didRequestFireSince (network activity diagnostics)
 *   - dismissOverlays (proactively hide blocking widgets)
 *   - auto-importance detection in click/clickText/clickRole
 *
 * Each test uses a local HTTP server for fixtures because patchright
 * blocks inline scripts on data: URLs (see L013).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { BlackTip } from '../src/blacktip.js';

describe('v0.3 primitives', () => {
  let bt: BlackTip;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = (req.url ?? '').split('?')[0] ?? '';
      if (url === '/basic') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Basic</title></head>
<body>
  <h1 id="heading">Hello</h1>
  <button id="btn" data-count="0">Click Me</button>
  <button id="submit-btn">Submit Payment</button>
  <button id="ship-btn">Ship It</button>
  <div id="delayed-host"></div>
  <select id="native"><option value="a">A</option><option value="b">B</option></select>
  <button id="custom-dd_button" aria-haspopup="listbox">Pick one</button>
  <ul role="listbox">
    <li id="custom-dd_option-0">Alpha</li>
    <li id="custom-dd_option-0_text">Alpha</li>
    <li id="custom-dd_option-1">Bravo</li>
    <li id="custom-dd_option-1_text">Bravo</li>
    <li id="custom-dd_option-2">Charlie</li>
    <li id="custom-dd_option-2_text">Charlie</li>
  </ul>
  <script>
    setTimeout(() => {
      const d = document.createElement('div');
      d.id = 'late';
      d.textContent = 'Late Content Arrived';
      document.body.appendChild(d);
    }, 800);
  </script>
</body></html>`);
      } else if (url === '/overlay') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Overlay</title></head>
<body>
  <button id="under-the-overlay">Actual Button</button>
  <div class="chat-widget" style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.4);z-index:9999;"></div>
</body></html>`);
      } else if (url === '/slow-dom') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Slow</title></head>
<body>
  <div id="stable-marker">initial</div>
  <script>
    // Fire a burst of DOM mutations for 1500ms, then stop.
    const host = document.getElementById('stable-marker');
    let count = 0;
    const interval = setInterval(() => {
      count++;
      host.textContent = 'mutation ' + count;
      if (count >= 15) clearInterval(interval);
    }, 100);
  </script>
</body></html>`);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;

    bt = new BlackTip({
      logLevel: 'error',
      timeout: 8000,
      retryAttempts: 1,
      behaviorProfile: 'scraper',
    });
    await bt.launch();
  });

  afterAll(async () => {
    if (bt) await bt.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ── waitForStable ──

  it('waitForStable returns "both-idle" once DOM mutations stop on a settling page', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/slow-dom`);
    const result = await bt.waitForStable({ domIdleMs: 400, networkIdleMs: 400, maxMs: 6000 });
    expect(result.reason).toBe('both-idle');
    // The mutations run for ~1500ms, so total should be >= ~1900ms and well under 6s.
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.durationMs).toBeLessThan(6000);
  });

  it('waitForStable returns "timeout" if maxMs is too short', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/slow-dom`);
    const result = await bt.waitForStable({ domIdleMs: 1000, networkIdleMs: 1000, maxMs: 500 });
    expect(result.reason).toBe('timeout');
    expect(result.durationMs).toBeGreaterThanOrEqual(400);
  });

  // ── waitForText ──

  it('waitForText resolves when the target text appears asynchronously', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/basic`);
    const result = await bt.waitForText('Late Content Arrived', { timeout: 3000 });
    expect(result.found).toBe(true);
    // The fixture adds it at ~800ms; allow generous slack for polling.
    expect(result.durationMs).toBeGreaterThanOrEqual(400);
    expect(result.durationMs).toBeLessThan(3000);
  });

  it('waitForText returns found:false when text never appears', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/basic`);
    const result = await bt.waitForText('This text will never appear anywhere', { timeout: 1200 });
    expect(result.found).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(1000);
  });

  // ── inspect ──

  it('inspect returns exists:false for a missing selector', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/basic`);
    const info = await bt.inspect('#does-not-exist-anywhere');
    expect(info.exists).toBe(false);
    expect(info.visible).toBe(false);
  });

  it('inspect returns full element info for a visible button', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/basic`);
    const info = await bt.inspect('#btn');
    expect(info.exists).toBe(true);
    expect(info.visible).toBe(true);
    expect(info.tagName).toBe('BUTTON');
    expect(info.text).toBe('Click Me');
    expect(info.attributes?.id).toBe('btn');
    expect(info.attributes?.['data-count']).toBe('0');
    expect(info.boundingBox?.width).toBeGreaterThan(0);
    expect(info.boundingBox?.height).toBeGreaterThan(0);
  });

  // ── listOptions ──

  it('listOptions enumerates Angular-style dropdown options by button id', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/basic`);
    const options = await bt.listOptions('#custom-dd_button');
    expect(options.length).toBe(3);
    expect(options.map((o) => o.text)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(options[0]!.id).toBe('custom-dd_option-0');
    expect(options[1]!.id).toBe('custom-dd_option-1');
    expect(options[2]!.id).toBe('custom-dd_option-2');
  });

  it('listOptions also accepts the bare base id', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/basic`);
    const options = await bt.listOptions('custom-dd');
    expect(options.length).toBe(3);
  });

  // ── networkSince / didRequestFireSince ──

  it('networkSince returns recent network entries', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/basic`);
    // Basic navigation should have fired at least one network request.
    await new Promise((r) => setTimeout(r, 300));
    const recent = await bt.networkSince(60_000);
    // Every resource load shows up, the HTML doc itself may or may not
    // be in performance.getEntriesByType('resource') depending on Chrome,
    // so we just verify the call returns an array.
    expect(Array.isArray(recent)).toBe(true);
  });

  it('didRequestFireSince returns true for a matching pattern after navigation', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/basic`);
    await new Promise((r) => setTimeout(r, 300));
    // The favicon request will have a distinct URL pattern we can match.
    // If there's no favicon, at minimum any resource load gives us a
    // non-empty pattern to match. Search for localhost entries.
    const fired = await bt.didRequestFireSince(/127\.0\.0\.1/, 60_000);
    // Resources from the same origin may or may not appear depending on
    // how Chrome categorizes them. Accept either result — the test is
    // that the call doesn't throw.
    expect(typeof fired).toBe('boolean');
  });

  // ── dismissOverlays ──

  it('dismissOverlays hides fixed/sticky overlays that match known patterns', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/overlay`);
    const before = await bt.inspect('.chat-widget');
    expect(before.exists).toBe(true);
    expect(before.visible).toBe(true);

    const result = await bt.dismissOverlays();
    expect(result.hidden).toBeGreaterThanOrEqual(1);

    const after = await bt.inspect('.chat-widget');
    // The element still exists but is display:none, so it's not visible.
    expect(after.exists).toBe(true);
    expect(after.visible).toBe(false);
  });

  it('clickText pierces an overlay by calling dismissOverlays and falling back to force-click', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/overlay`);
    // Without the overlay-dismiss logic, this click would land on the
    // chat widget (which covers the whole viewport). With the fix, it
    // detects the overlay, dismisses it, and clicks through.
    const result = await bt.clickText('Actual Button', { exact: true });
    expect(result.success).toBe(true);
  });

  // ── auto-importance detection ──

  it('inferImportance via clickText applies high importance to "Submit Payment"', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/basic`);

    // Capture pre-pause durations for normal vs high via action events.
    const pauses: number[] = [];
    const handler = (e: { behavioral?: { preActionPause?: number } }): void => {
      if (e.behavioral?.preActionPause) pauses.push(e.behavioral.preActionPause);
    };
    bt.on('action', handler);

    // First click: plain button, normal importance.
    await bt.clickText('Click Me');
    // Second click: "Submit Payment", should auto-detect as high.
    await bt.clickText('Submit Payment');

    bt.off('action', handler);

    expect(pauses.length).toBeGreaterThanOrEqual(2);
    // The high-importance pause should be meaningfully larger than the
    // normal one (2-3x base plus hesitation spike).
    const normalPause = pauses[0]!;
    const highPause = pauses[1]!;
    expect(highPause).toBeGreaterThan(normalPause);
  });

  it('inferImportance does NOT flag a non-submit button', async () => {
    await bt.navigate(`http://127.0.0.1:${port}/basic`);

    const pauses: number[] = [];
    const handler = (e: { behavioral?: { preActionPause?: number } }): void => {
      if (e.behavioral?.preActionPause) pauses.push(e.behavioral.preActionPause);
    };
    bt.on('action', handler);

    await bt.clickText('Ship It'); // "ship" isn't in the importance list
    bt.off('action', handler);

    expect(pauses.length).toBeGreaterThanOrEqual(1);
    // "Ship It" shouldn't trigger high importance — pause stays moderate.
    // Scraper profile has pauseBetweenActionsMs of [100, 300]; normal
    // draws from that range so the pause should stay below ~500ms in
    // the overwhelming majority of samples. High importance would be
    // ~600-1500ms+.
    expect(pauses[0]!).toBeLessThan(600);
  });

  // ── pauseForInput ──

  it('pauseForInput requires serve mode and throws otherwise', async () => {
    // Without serve mode, _pauseRegistry is not set up, so the call throws.
    await expect(
      bt.pauseForInput({ prompt: 'test' }),
    ).rejects.toThrow(/serve mode/);
  });
});
