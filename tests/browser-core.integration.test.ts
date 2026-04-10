/**
 * BrowserCore integration tests.
 *
 * These tests launch a real Chromium and drive it through BrowserCore. They
 * do NOT mock Playwright — the whole point is to catch bugs in the live
 * launch/tab/session surface area that unit tests would miss.
 *
 * Runtime: ~15–30s depending on browser cold-start.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BrowserCore } from '../src/browser-core.js';
import { Logger } from '../src/logging.js';

// A tiny standalone HTML fixture served via data: URL — no HTTP server needed.
const FIXTURE_HTML = `<!doctype html>
<html><head><title>BlackTip Fixture A</title></head>
<body>
  <h1 id="heading">Hello BlackTip</h1>
  <button id="btn">Click Me</button>
  <iframe id="inner" srcdoc="<html><body><p id='frame-p'>inside frame</p></body></html>"></iframe>
</body></html>`;

const FIXTURE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE_HTML)}`;

const SECOND_HTML = `<!doctype html><html><head><title>Fixture B</title></head><body><p>second</p></body></html>`;
const SECOND_URL = `data:text/html;charset=utf-8,${encodeURIComponent(SECOND_HTML)}`;

describe('BrowserCore — launch & lifecycle', () => {
  it('launches, reports active, and closes cleanly', async () => {
    const logger = new Logger('error');
    const core = new BrowserCore({ timeout: 15_000 }, logger);

    expect(core.isActive()).toBe(false);
    await core.launch();
    expect(core.isActive()).toBe(true);

    await core.close();
    expect(core.isActive()).toBe(false);
  });

  it('throws on operations before launch()', async () => {
    const logger = new Logger('error');
    const core = new BrowserCore({}, logger);

    expect(() => core.getActivePage()).toThrow(/not launched/i);
    await expect(core.getTabs()).rejects.toThrow(/not launched/i);
  });
});

describe('BrowserCore — navigation, tabs, frames, session', () => {
  const logger = new Logger('error');
  let core: BrowserCore;

  beforeAll(async () => {
    core = new BrowserCore({ timeout: 15_000 }, logger);
    await core.launch();
  });

  afterAll(async () => {
    if (core && core.isActive()) await core.close();
  });

  it('starts with exactly one tab after launch (no duplicate from page event)', async () => {
    const tabs = await core.getTabs();
    expect(tabs.length).toBe(1);
    expect(tabs[0]!.active).toBe(true);
    expect(tabs[0]!.index).toBe(0);
  });

  it('navigates to a data: URL and reports success', async () => {
    const result = await core.navigate(FIXTURE_URL);
    expect(result.success).toBe(true);
    // data: URLs report status 200 on some Chromium builds and 0 on others,
    // so we don't pin the status — just that navigation completed.
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.url.startsWith('data:text/html')).toBe(true);
  });

  it('getActivePage() returns a live, non-closed Page', async () => {
    const page = core.getActivePage();
    expect(page.isClosed()).toBe(false);
    // Confirm the page reflects our last navigate.
    const title = await page.title();
    expect(title).toBe('BlackTip Fixture A');
  });

  it('opens a new tab and switches to it', async () => {
    const newIdx = await core.newTab(SECOND_URL);
    expect(newIdx).toBe(1);

    let tabs = await core.getTabs();
    expect(tabs.length).toBe(2);

    await core.switchTab(1);
    tabs = await core.getTabs();
    expect(tabs[1]!.active).toBe(true);
    expect(tabs[0]!.active).toBe(false);

    // Switch back so later tests start from tab 0.
    await core.switchTab(0);
  });

  it('closeTab() refuses to close the last remaining tab', async () => {
    // Sanity: we should have 2 tabs right now from the previous test.
    const before = await core.getTabs();
    expect(before.length).toBe(2);

    // Close tab 1, leaving tab 0 alone.
    await core.closeTab(1);
    const after = await core.getTabs();
    expect(after.length).toBe(1);

    // Now try to close the last one — must reject.
    await expect(core.closeTab(0)).rejects.toThrow(/last tab/i);
  });

  it('getActivePage() recovers after the active page is closed externally', async () => {
    // Open a second tab we can close under the core's feet.
    const newIdx = await core.newTab(SECOND_URL);
    await core.switchTab(newIdx);

    // Close the active page directly via Playwright, bypassing closeTab().
    const victim = core.getActivePage();
    await victim.close();

    // Give the close handler a tick to run.
    await new Promise((r) => setTimeout(r, 50));

    // getActivePage() must survive: it should fall back to the surviving tab.
    const recovered = core.getActivePage();
    expect(recovered.isClosed()).toBe(false);

    const tabs = await core.getTabs();
    expect(tabs.length).toBe(1);
  });

  it('navigates again on the recovered active page (session still usable)', async () => {
    const result = await core.navigate(FIXTURE_URL);
    expect(result.success).toBe(true);
  });

  it('getFrames() reports the main frame and the inline iframe', async () => {
    // Fixture A has an iframe with srcdoc — give it a moment to attach.
    await new Promise((r) => setTimeout(r, 200));

    const frames = await core.getFrames();
    // Main frame + srcdoc iframe = at least 2.
    expect(frames.length).toBeGreaterThanOrEqual(2);
  });

  it('getFrame() resolves the inline iframe by CSS selector', async () => {
    const frame = await core.getFrame('#inner');
    const text = await frame.$eval('#frame-p', (el) => (el as HTMLElement).innerText);
    expect(text).toBe('inside frame');
  });

  it('getFrame() throws for an unknown selector', async () => {
    await expect(core.getFrame('#no-such-frame')).rejects.toThrow(/frame not found/i);
  });

  it('screenshot() returns a PNG buffer with the viewport size', async () => {
    const shot = await core.screenshot();
    expect(shot.format).toBe('png');
    expect(shot.data).toBeInstanceOf(Buffer);
    expect(shot.data.length).toBeGreaterThan(500); // arbitrary floor for a rendered page
    expect(shot.width).toBeGreaterThan(0);
    expect(shot.height).toBeGreaterThan(0);
    expect(() => new Date(shot.timestamp)).not.toThrow();
  });

  it('getPageContent() returns HTML when format=html', async () => {
    const html = await core.getPageContent({ format: 'html' });
    expect(html).toContain('Hello BlackTip');
    expect(html).toContain('<button');
  });

  it('getPageContent() returns text when format=text (default)', async () => {
    const text = await core.getPageContent();
    expect(text).toContain('Hello BlackTip');
    expect(text).not.toContain('<button');
  });

  it('executeJS() evaluates a script and returns the value', async () => {
    const title = await core.executeJS('document.title');
    expect(title).toBe('BlackTip Fixture A');
  });

  it('cookies() / setCookies() / clearCookies() round-trip', async () => {
    // data: URLs cannot carry cookies, so we test against an https URL pattern
    // by setting cookies with an explicit url.
    await core.setCookies([
      { name: 'bt_test', value: '42', domain: 'example.com', path: '/', url: 'https://example.com/' },
    ]);

    const all = await core.cookies();
    const found = all.find((c) => c.name === 'bt_test');
    expect(found).toBeDefined();
    expect(found!.value).toBe('42');

    await core.clearCookies();
    const afterClear = await core.cookies();
    expect(afterClear.find((c) => c.name === 'bt_test')).toBeUndefined();
  });
});
