/**
 * Fingerprint evasion test — the load-bearing test for a stealth library.
 *
 * Launches BlackTip against bot.sannysoft.com and asserts that all detection
 * rows pass. Also runs a parallel set of direct assertions against the page's
 * own `navigator`, `window.chrome`, WebGL getters, etc., so we get meaningful
 * output even if bot.sannysoft.com rearranges its table.
 *
 * Network-dependent: if the site is unreachable, the test fails loudly —
 * skipping would mask a real regression. To run offline, use `npm run test:unit`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BlackTip } from '../src/blacktip.js';

const TARGET = 'https://bot.sannysoft.com/';

// Failure labels bot.sannysoft.com uses for the detection rows we care about.
// Keys are detection names, values are substrings that appear in the result
// cell when the check FAILED (i.e. headless was detected).
const DETECTION_KEYWORDS = {
  webdriver: /webdriver \(new\)|webdriver \(old\)/i,
  chrome: /chrome \(new\)/i,
  permissions: /permissions/i,
  pluginsLength: /plugins length \(old\)/i,
  languages: /languages \(old\)/i,
  webglVendor: /webgl vendor/i,
  webglRenderer: /webgl renderer/i,
};

describe('Fingerprint evasion — bot.sannysoft.com', () => {
  let bt: BlackTip;

  beforeAll(async () => {
    bt = new BlackTip({
      logLevel: 'error',
      timeout: 30_000,
      retryAttempts: 1,
      deviceProfile: 'desktop-windows',
    });
    await bt.launch();
  });

  afterAll(async () => {
    if (bt) await bt.close();
  });

  it('all critical navigator / chrome / WebGL spoofs report the right values', async () => {
    const navResult = await bt.navigate(TARGET);
    expect(navResult.success).toBe(true);

    // Give the page a moment to run its fingerprinting scripts.
    await bt.waitFor('body', { timeout: 15_000 });
    await new Promise((r) => setTimeout(r, 1500));

    // Direct assertions against the page's own JS state — these reflect what
    // the detection scripts themselves observed, and don't depend on the
    // table layout.
    const navigatorChecks = await bt.executeJS(`({
      webdriver: navigator.webdriver,
      pluginsLength: navigator.plugins.length,
      mimeTypesLength: navigator.mimeTypes.length,
      languagesLength: navigator.languages.length,
      language: navigator.language,
      platform: navigator.platform,
      hasChrome: typeof window.chrome === 'object' && window.chrome !== null,
      hasChromeRuntime: typeof (window.chrome && window.chrome.runtime) === 'object',
      hardwareConcurrency: navigator.hardwareConcurrency,
      userAgent: navigator.userAgent,
    })`) as {
      webdriver: unknown;
      pluginsLength: number;
      mimeTypesLength: number;
      languagesLength: number;
      language: string;
      platform: string;
      hasChrome: boolean;
      hasChromeRuntime: boolean;
      hardwareConcurrency: number;
      userAgent: string;
    };

    // 1. The webdriver flag must not be true. Real Chrome stable returns
    //    false, older BlackTip shim returned undefined — both are acceptable
    //    stealth states (the signal we're defeating is === true).
    expect(navigatorChecks.webdriver).not.toBe(true);

    // 2. window.chrome must be a present object. Real Chrome Stable on a
    //    regular webpage has window.chrome with loadTimes/csi but NOT
    //    runtime — runtime is only present on extension-accessible pages.
    //    Headless Chromium lacks window.chrome entirely.
    expect(navigatorChecks.hasChrome).toBe(true);

    // 3. Plugins and mime types must be populated (headless returns empty).
    expect(navigatorChecks.pluginsLength).toBeGreaterThan(0);
    expect(navigatorChecks.mimeTypesLength).toBeGreaterThan(0);

    // 4. Languages must be populated.
    expect(navigatorChecks.languagesLength).toBeGreaterThan(0);
    expect(typeof navigatorChecks.language).toBe('string');
    expect(navigatorChecks.language.length).toBeGreaterThan(0);

    // 5. Platform must match the Windows profile we requested.
    expect(navigatorChecks.platform).toBe('Win32');

    // 6. User agent must look like real Chrome on Windows.
    expect(navigatorChecks.userAgent).toMatch(/Windows/);
    expect(navigatorChecks.userAgent).toMatch(/Chrome/);
    expect(navigatorChecks.userAgent).not.toMatch(/HeadlessChrome/);

    // 7. Hardware concurrency must be realistic.
    expect(navigatorChecks.hardwareConcurrency).toBeGreaterThan(0);
    expect(navigatorChecks.hardwareConcurrency).toBeLessThanOrEqual(64);
  });

  it('WebGL vendor/renderer are spoofed to declared GPU strings', async () => {
    // Navigate again in case a prior test left the page somewhere else.
    await bt.navigate(TARGET);
    await new Promise((r) => setTimeout(r, 800));

    const gl = await bt.executeJS(`(() => {
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!ctx) return { error: 'no WebGL context' };
      var debugInfo = ctx.getExtension('WEBGL_debug_renderer_info');
      var result = {
        vendor: ctx.getParameter(ctx.VENDOR),
        renderer: ctx.getParameter(ctx.RENDERER),
        unmaskedVendor: null,
        unmaskedRenderer: null,
      };
      if (debugInfo) {
        result.unmaskedVendor = ctx.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        result.unmaskedRenderer = ctx.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      }
      return result;
    })()`) as {
      vendor: string;
      renderer: string;
      unmaskedVendor: string | null;
      unmaskedRenderer: string | null;
    };

    expect(gl.vendor).toBeTruthy();
    expect(gl.renderer).toBeTruthy();
    // Must not leak the SwiftShader / Google SwiftShader / software renderer
    // strings that give away headless Chromium without GPU.
    expect(gl.renderer).not.toMatch(/SwiftShader/i);
    expect(gl.renderer).not.toMatch(/llvmpipe/i);

    // Unmasked values should match the spoofed profile values (realistic GPU).
    if (gl.unmaskedVendor) {
      expect(gl.unmaskedVendor).toMatch(/Google|NVIDIA|AMD|Intel|Apple/i);
    }
    if (gl.unmaskedRenderer) {
      expect(gl.unmaskedRenderer).not.toMatch(/SwiftShader|llvmpipe/i);
    }
  });

  it('Permissions API returns prompt for notifications (not denied)', async () => {
    await bt.navigate(TARGET);
    await new Promise((r) => setTimeout(r, 500));

    const state = await bt.executeJS(`
      navigator.permissions.query({ name: 'notifications' }).then(p => p.state)
    `);

    // Headless Chromium returns 'denied'; real Chrome returns 'prompt'. Our
    // evasion script forces 'prompt' to blend in.
    expect(state).toBe('prompt');
  });

  it('bot.sannysoft table: no row contains the headless-detection red flags', async () => {
    await bt.navigate(TARGET);
    // Give the page's own scripts time to populate the table.
    await new Promise((r) => setTimeout(r, 2000));

    // Extract every (label, result) pair from the page. The table cells
    // carry class "passed" or "failed" on bot.sannysoft — read both.
    const rows = (await bt.executeJS(`(() => {
      var rows = [];
      document.querySelectorAll('table tr').forEach(function(tr) {
        var cells = tr.querySelectorAll('td');
        if (cells.length >= 2) {
          var label = cells[0].textContent.trim();
          var resultCell = cells[1];
          var resultText = resultCell.textContent.trim();
          var cls = resultCell.className || '';
          rows.push({ label: label, result: resultText, cls: cls });
        }
      });
      return rows;
    })()`)) as { label: string; result: string; cls: string }[];

    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(5); // sanity: the table is populated

    // Find the rows we care about and check their pass/fail state.
    // bot.sannysoft labels rows as either "(passed)" or "(failed)" and sets
    // class="result passed" or class="result failed" on the result cell.
    // Note: "missing (passed)" means "the detectable thing is missing, which
    // is correct" — it is NOT a failure.
    const failures: string[] = [];
    for (const row of rows) {
      for (const [name, pattern] of Object.entries(DETECTION_KEYWORDS)) {
        if (pattern.test(row.label)) {
          const failedClass = /\bfailed\b/.test(row.cls);
          const failedText = /\(failed\)/i.test(row.result);
          if (failedClass || failedText) {
            failures.push(`${name} (${row.label}): "${row.result}" [class=${row.cls}]`);
          }
        }
      }
    }

    if (failures.length > 0) {
      console.error('bot.sannysoft detection failures:', failures);
      console.error('All rows:', rows);
    }
    expect(failures).toEqual([]);
  });
});
