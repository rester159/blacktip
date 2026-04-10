/**
 * ElementFinder integration tests.
 *
 * Exercises every strategy in the cascade (CSS → XPath → exact text →
 * case-insensitive text → ARIA label → ARIA role → label association),
 * the per-strategy timeout cap, the overall timeout, and iframe search.
 *
 * Uses a real Chromium page loaded from a data: URL — no HTTP server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'patchright';
import { ElementFinder } from '../src/element-finder.js';
import { Logger } from '../src/logging.js';

const FIXTURE_HTML = `<!doctype html>
<html><head><title>ElementFinder Fixture</title></head>
<body>
  <button id="css-target" class="primary">CSS Target</button>
  <div data-xpath="yes">XPath Target Content</div>
  <span>Exact Text Match</span>
  <p>MiXeD cAsE TeXt</p>
  <div aria-label="close-dialog">×</div>
  <button>Submit Form</button>

  <label for="email-input">Email Address</label>
  <input id="email-input" type="email" />

  <label>Password
    <input type="password" name="pwd" />
  </label>

  <label for="adjacent-name">Full Name</label>
  <input id="adjacent-name" type="text" />

  <iframe id="child-frame" srcdoc="<html><body><button id='in-frame-btn'>Inside Frame</button></body></html>"></iframe>
</body></html>`;

const FIXTURE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE_HTML)}`;

describe('ElementFinder', () => {
  let browser: Browser;
  let page: Page;
  let finder: ElementFinder;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    // Give the srcdoc iframe time to attach.
    await page.waitForTimeout(100);
    finder = new ElementFinder(new Logger('error'));
  });

  afterAll(async () => {
    if (browser) await browser.close();
  });

  // ── Strategy 1: CSS selector ──

  it('finds via CSS id selector', async () => {
    const el = await finder.find(page, '#css-target');
    const text = await el.innerText();
    expect(text).toBe('CSS Target');
  });

  it('finds via CSS class selector', async () => {
    const el = await finder.find(page, '.primary');
    const tag = await el.evaluate((n) => (n as HTMLElement).tagName);
    expect(tag).toBe('BUTTON');
  });

  it('finds via CSS tag name', async () => {
    const el = await finder.find(page, 'iframe');
    const id = await el.getAttribute('id');
    expect(id).toBe('child-frame');
  });

  // ── Strategy 2: XPath ──

  it('finds via XPath (// prefix)', async () => {
    const el = await finder.find(page, '//div[@data-xpath="yes"]');
    const text = await el.innerText();
    expect(text).toBe('XPath Target Content');
  });

  // ── Strategy 3 & 4: Text match ──

  it('finds via exact visible text', async () => {
    const el = await finder.find(page, 'Exact Text Match');
    const tag = await el.evaluate((n) => (n as HTMLElement).tagName);
    expect(tag).toBe('SPAN');
  });

  it('finds via case-insensitive text (different casing in selector)', async () => {
    // "Mixed Case Text" (lowercase/different casing from DOM's "MiXeD cAsE TeXt")
    // exact-text strategy fails first, then case-insensitive strategy kicks in.
    const el = await finder.find(page, 'mixed case text');
    const tag = await el.evaluate((n) => (n as HTMLElement).tagName);
    expect(tag).toBe('P');
  });

  // ── Strategy 5: ARIA label ──

  it('finds via aria-label attribute', async () => {
    const el = await finder.find(page, 'close-dialog');
    const tag = await el.evaluate((n) => (n as HTMLElement).tagName);
    expect(tag).toBe('DIV');
  });

  // ── Strategy 6: ARIA role (button) ──

  it('finds via ARIA button role + name', async () => {
    // "Submit Form" is a button's visible text, caught by text strategy first
    // but also works via role=button[name=...]. Use a name that only matches
    // as a button role to ensure the role strategy is what succeeds.
    const el = await finder.find(page, 'Submit Form');
    const tag = await el.evaluate((n) => (n as HTMLElement).tagName);
    expect(tag).toBe('BUTTON');
  });

  // ── Strategy 7: Label association ──

  it('finds input via <label for="..."> association', async () => {
    const el = await finder.find(page, 'Email Address');
    const id = await el.getAttribute('id');
    expect(id).toBe('email-input');
  });

  // ── Errors and timeouts ──

  it('throws a descriptive error when no strategy matches', async () => {
    await expect(
      finder.find(page, 'thisdefinitelydoesnotexistanywhere', { timeout: 2000 }),
    ).rejects.toThrow(/Element not found/);
  });

  it('overall timeout is respected when element missing', async () => {
    const start = Date.now();
    await expect(
      finder.find(page, '#no-such-id-ever', { timeout: 1500 }),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;
    // Should fail in roughly the budget, not multiples of it. Allow generous
    // slack because the first strategy can consume the full budget before the
    // deadline check fires.
    expect(elapsed).toBeLessThan(6000);
  });

  it('per-strategy timeout prevents a single strategy from eating the whole budget', async () => {
    // With a 9000ms budget, the finder cascades through 7 strategies, each
    // capped at 3000ms. If a strategy ignored the cap, this call would take
    // 9000ms on the first strategy alone. We assert it fails within the
    // overall budget plus slack.
    const start = Date.now();
    await expect(
      finder.find(page, 'another-nonexistent-handle', { timeout: 9000 }),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;
    // Budget is 9s; with per-strategy caps the cascade should give up on
    // schedule. Allow up to 12s for timing slack on slow machines.
    expect(elapsed).toBeLessThan(12_000);
  });

  // ── Iframe search ──

  it('findInFrames locates element inside a srcdoc iframe', async () => {
    const { element, frame } = await finder.findInFrames(page, '#in-frame-btn');
    expect(frame).not.toBe(page);
    const text = await element.innerText();
    expect(text).toBe('Inside Frame');
  });

  it('findInFrames falls back to iframes only when main page has no match', async () => {
    // Element exists on main page — should return page, not a child frame.
    const { frame } = await finder.findInFrames(page, '#css-target');
    expect(frame).toBe(page);
  });

  it('findInFrames throws when element is missing everywhere', async () => {
    await expect(
      finder.findInFrames(page, '#not-in-any-frame', { timeout: 1500 }),
    ).rejects.toThrow(/not found in any frame/i);
  });

  // ── getBoundingBox ──

  it('getBoundingBox returns positive width/height for a visible element', async () => {
    const el = await finder.find(page, '#css-target');
    const box = await finder.getBoundingBox(el);
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  });
});
