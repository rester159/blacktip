/**
 * BlackTip public API smoke tests.
 *
 * One integration test per public method against a local HTML fixture.
 * The `type()` tests include assertions that framework-style `input` events
 * actually fired — the exact regression that hit us on Anthem/Okta (L001).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BlackTip } from '../src/blacktip.js';

// A rich fixture with every element shape we need. Uses an inline script to
// record `input` events on the text input so we can verify React-style
// framework event dispatching works, not just keystroke-level events.
const FIXTURE_HTML = `<!doctype html>
<html><head><title>API Fixture</title></head>
<body>
  <h1 id="heading">BlackTip API Smoke</h1>
  <p class="text">First paragraph.</p>
  <p class="text">Second paragraph.</p>
  <p class="text">Third paragraph.</p>

  <button id="btn" data-count="0" onclick="this.dataset.count = Number(this.dataset.count)+1">Click Me</button>
  <button id="named" aria-label="named-action">Do Action</button>
  <button id="role-btn">Submit Order</button>

  <input id="react-input" type="text" />
  <div id="react-output">0</div>
  <!-- Event tracking wired up via executeJS after navigate: patchright
       blocks inline <script> execution on data: URLs as a stealth measure. -->


  <select id="select">
    <option value="a">Alpha</option>
    <option value="b">Bravo</option>
    <option value="c">Charlie</option>
  </select>

  <div id="hover-target" onmouseenter="this.dataset.hovered='yes'">Hover Me</div>

  <a id="link" href="https://example.com/page" data-tracking="abc123">A Link</a>

  <table id="data-table">
    <thead><tr><th>Name</th><th>Value</th></tr></thead>
    <tbody>
      <tr><td>one</td><td>1</td></tr>
      <tr><td>two</td><td>2</td></tr>
      <tr><td>three</td><td>3</td></tr>
    </tbody>
  </table>

  <input id="key-target" type="text" />

  <!-- delayed-host is positioned absolutely at the bottom so appending its
       child doesn't push earlier elements like key-target around. If it
       shifted other elements, coordinate-based clicks captured before the
       shift would miss. -->
  <div id="delayed-host" style="position:absolute;bottom:0;left:0;"></div>
  <!-- delayed div is injected via executeJS after navigate (see below). -->

</body></html>`;

const FIXTURE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE_HTML)}`;

describe('BlackTip — public API smoke tests', () => {
  let bt: BlackTip;

  beforeAll(async () => {
    bt = new BlackTip({
      logLevel: 'error',
      timeout: 5000,
      retryAttempts: 2,
      // Use the scraper profile so tests finish in reasonable time without
      // multi-second human pauses between actions.
      behaviorProfile: 'scraper',
    });
    await bt.launch();
  });

  afterAll(async () => {
    if (bt) await bt.close();
  });

  // Helper: reload the fixture AND wire up any window state that would have
  // lived in <script> tags. patchright blocks inline scripts on data: URLs
  // so we set up state via executeJS after navigate.
  const resetFixture = async () => {
    await bt.navigate(FIXTURE_URL);
    await bt.executeJS(`(() => {
      var ri = document.getElementById('react-input');
      var out = document.getElementById('react-output');
      var inputEventCount = 0;
      ri.addEventListener('input', function() {
        inputEventCount++;
        out.textContent = String(inputEventCount);
      });
      window.__getInputEventCount = function() { return inputEventCount; };
      window.__getInputValue = function() { return ri.value; };

      setTimeout(function() {
        var d = document.createElement('div');
        d.id = 'delayed';
        d.textContent = 'I am here';
        document.getElementById('delayed-host').appendChild(d);
      }, 300);
    })()`);
  };

  it('click(selector) — click increments the button counter', async () => {
    await resetFixture();
    const result = await bt.click('#btn');
    expect(result.success).toBe(true);

    const count = await bt.extractAttribute('#btn', 'data-count');
    expect(count).toBe('1');
  });

  it('clickText(text) — click by visible button text', async () => {
    await resetFixture();
    const result = await bt.clickText('Click Me');
    expect(result.success).toBe(true);
    const count = await bt.extractAttribute('#btn', 'data-count');
    expect(count).toBe('1');
  });

  it('clickRole(role, {name}) — click by ARIA button name', async () => {
    await resetFixture();
    const result = await bt.clickRole('button', { name: 'Submit Order' });
    expect(result.success).toBe(true);
  });

  it('type() with paste:true — fill dispatches an input event (React-compatible)', async () => {
    await resetFixture();
    const result = await bt.type('#react-input', 'hello world', { paste: true });
    expect(result.success).toBe(true);

    const value = await bt.executeJS('window.__getInputValue()');
    expect(value).toBe('hello world');

    // Most important assertion: an 'input' event actually fired. React/Angular
    // rely on this. If this is zero, L001 has regressed.
    const inputEventCount = await bt.executeJS('window.__getInputEventCount()');
    expect(Number(inputEventCount)).toBeGreaterThanOrEqual(1);
  });

  it('type() without paste — keystroke path still fires input events', async () => {
    await resetFixture();
    // Use a short string so the test doesn't take forever. 'hi' is under the
    // scraper profile's paste threshold for keystroke-level typing.
    const result = await bt.type('#react-input', 'hi', { paste: false });
    expect(result.success).toBe(true);

    const value = await bt.executeJS('window.__getInputValue()');
    expect(value).toBe('hi');

    // Each character must fire an input event.
    const inputEventCount = await bt.executeJS('window.__getInputEventCount()');
    expect(Number(inputEventCount)).toBeGreaterThanOrEqual(2);
  });

  it('select(selector, value) — selects a native <option>', async () => {
    await resetFixture();
    const result = await bt.select('#select', 'b');
    expect(result.success).toBe(true);

    const value = await bt.executeJS('document.getElementById("select").value');
    expect(value).toBe('b');
  });

  it('pressKey(key) — typed via keyboard API with correct key code', async () => {
    await resetFixture();
    // Focus the key-target input, then press a letter.
    await bt.click('#key-target');
    const result = await bt.pressKey('x');
    expect(result.success).toBe(true);

    const value = await bt.executeJS('document.getElementById("key-target").value');
    expect(value).toBe('x');
  });

  it('hover(selector) — fires mouseenter on target', async () => {
    await resetFixture();
    const result = await bt.hover('#hover-target');
    expect(result.success).toBe(true);

    const hovered = await bt.extractAttribute('#hover-target', 'data-hovered');
    expect(hovered).toBe('yes');
  });

  it('extractText(selector) — returns the text of a single element', async () => {
    await resetFixture();
    const text = await bt.extractText('#heading');
    expect(text).toBe('BlackTip API Smoke');
  });

  it('extractText(selector, {multiple}) — returns an array for multi-match', async () => {
    await resetFixture();
    const texts = await bt.extractText('.text', { multiple: true });
    expect(Array.isArray(texts)).toBe(true);
    expect(texts as string[]).toEqual(['First paragraph.', 'Second paragraph.', 'Third paragraph.']);
  });

  it('extractAttribute(selector, attr) — returns the attribute value', async () => {
    await resetFixture();
    const tracking = await bt.extractAttribute('#link', 'data-tracking');
    expect(tracking).toBe('abc123');
  });

  it('extractAttribute() returns null for a missing attribute', async () => {
    await resetFixture();
    const missing = await bt.extractAttribute('#link', 'data-nope');
    expect(missing).toBeNull();
  });

  it('extractTable(selector) — parses a <table> into row objects', async () => {
    await resetFixture();
    const rows = await bt.extractTable('#data-table');
    expect(rows).toEqual([
      { Name: 'one', Value: '1' },
      { Name: 'two', Value: '2' },
      { Name: 'three', Value: '3' },
    ]);
  });

  it('waitFor(selector) — resolves when an element appears after a delay', async () => {
    await resetFixture();
    const result = await bt.waitFor('#delayed', { timeout: 3000 });
    expect(result.success).toBe(true);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('waitFor(selector) — fails cleanly when element never appears', async () => {
    await resetFixture();
    const result = await bt.waitFor('#will-never-exist', { timeout: 1000 });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('screenshot() — returns a PNG buffer', async () => {
    await resetFixture();
    const shot = await bt.screenshot();
    expect(shot.format).toBe('png');
    expect(shot.data).toBeInstanceOf(Buffer);
    expect(shot.data.length).toBeGreaterThan(500);
  });

  it('screenshot({fullPage}) — full page version also succeeds', async () => {
    await resetFixture();
    const shot = await bt.screenshot({ fullPage: true });
    expect(shot.data.length).toBeGreaterThan(500);
  });

  it('executeJS(script) — returns the evaluated value', async () => {
    await resetFixture();
    const doc = await bt.executeJS('document.title');
    expect(doc).toBe('API Fixture');
  });

  it('getPageContent({format: html}) — returns raw HTML containing the fixture body', async () => {
    await resetFixture();
    const html = await bt.getPageContent({ format: 'html' });
    expect(html).toContain('BlackTip API Smoke');
    expect(html).toContain('<button id="btn"');
  });

  it('launch() returns the agent guide string', async () => {
    // launch() was already called in beforeAll; just verify the static guide
    // method returns something useful. (Second launch would double-start.)
    const guide = BlackTip.agentGuide();
    expect(guide).toContain('BlackTip Agent Guide');
    expect(guide).toContain('CRITICAL RULES');
    expect(guide).toContain('clickText');
  });
});
