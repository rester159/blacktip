/**
 * Detector evaluation suite.
 *
 * Runs BlackTip against every free public fingerprint/bot detector we know
 * about, collects a pass/fail score per check, and writes the full result
 * set as a timestamped JSON baseline under planning/baselines/.
 *
 * This suite does NOT assert on specific pass counts — it's a data
 * collector. Regressions are caught by diffing consecutive baselines.
 * Each detector is in its own `it` so one site being down doesn't mask
 * results from the others.
 *
 * Run with:   npm run eval
 */

import { describe, it, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BlackTip } from '../../src/blacktip.js';

type DetectorResult = {
  detector: string;
  ok: boolean;
  durationMs: number;
  summary: Record<string, unknown>;
  error?: string;
};

const results: DetectorResult[] = [];

function record(r: DetectorResult): void {
  results.push(r);
  // Immediate console feedback so a long run shows progress.
  const status = r.ok ? 'OK ' : 'ERR';
  // eslint-disable-next-line no-console
  console.log(`[${status}] ${r.detector} (${r.durationMs}ms) ${JSON.stringify(r.summary).slice(0, 120)}`);
}

describe('Detector evaluation suite', () => {
  let bt: BlackTip;

  beforeAll(async () => {
    bt = new BlackTip({
      logLevel: 'error',
      timeout: 45_000,
      retryAttempts: 1,
      deviceProfile: 'desktop-windows',
    });
    await bt.launch();
  });

  afterAll(async () => {
    if (bt) await bt.close();

    // Persist baseline to disk. Filename is the build phase + timestamp so
    // we can diff runs over the course of the roadmap.
    const phase = process.env.BLACKTIP_BASELINE_PHASE ?? 'adhoc';
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `baseline-${phase}-${iso}.json`;
    const dir = join(process.cwd(), 'planning', 'baselines');
    mkdirSync(dir, { recursive: true });
    const outPath = join(dir, filename);
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          phase,
          timestamp: new Date().toISOString(),
          deviceProfile: 'desktop-windows',
          patchright: true,
          results,
        },
        null,
        2,
      ),
    );
    // eslint-disable-next-line no-console
    console.log(`\nBaseline written to ${outPath}`);

    // Also write a human-readable summary.
    const okCount = results.filter((r) => r.ok).length;
    // eslint-disable-next-line no-console
    console.log(`\nDetectors passed: ${okCount}/${results.length}`);
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.detector}`);
    }
  });

  // ── bot.sannysoft.com ──

  it('bot.sannysoft.com — table of detection results', async () => {
    const start = Date.now();
    try {
      await bt.navigate('https://bot.sannysoft.com/');
      await new Promise((r) => setTimeout(r, 2500));

      const rows = (await bt.executeJS(`(() => {
        var out = [];
        document.querySelectorAll('table tr').forEach(function(tr) {
          var cells = tr.querySelectorAll('td');
          if (cells.length >= 2) {
            out.push({
              label: cells[0].textContent.trim(),
              result: cells[1].textContent.trim().slice(0, 80),
              cls: cells[1].className,
            });
          }
        });
        return out;
      })()`)) as { label: string; result: string; cls: string }[];

      const failed = rows.filter((r) => /\bfailed\b/.test(r.cls) || /\(failed\)/i.test(r.result));
      const passed = rows.filter((r) => /\bpassed\b/.test(r.cls) || /\(passed\)/i.test(r.result));

      record({
        detector: 'bot.sannysoft.com',
        ok: failed.length === 0 && rows.length > 5,
        durationMs: Date.now() - start,
        summary: {
          totalRows: rows.length,
          passedRows: passed.length,
          failedRows: failed.length,
          failures: failed.slice(0, 5).map((r) => `${r.label}: ${r.result}`),
        },
      });
    } catch (err) {
      record({
        detector: 'bot.sannysoft.com',
        ok: false,
        durationMs: Date.now() - start,
        summary: {},
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── tls.peet.ws/api/all — JA3/JA4/HTTP2 fingerprint ──

  it('tls.peet.ws/api/all — JA3/JA4 fingerprint vs declared UA', async () => {
    const start = Date.now();
    try {
      await bt.navigate('https://tls.peet.ws/api/all');
      const raw = (await bt.executeJS('document.body.innerText')) as string;
      const parsed = JSON.parse(raw) as {
        http_version?: string;
        user_agent?: string;
        tls?: {
          ciphers?: string[];
          ja3?: string;
          ja3_hash?: string;
          ja4?: string;
          peetprint?: string;
          peetprint_hash?: string;
        };
        http2?: { akamai_fingerprint?: string; akamai_fingerprint_hash?: string };
      };

      const tls = parsed.tls ?? {};
      const ja4 = tls.ja4 ?? '';
      const ja3_hash = tls.ja3_hash ?? '';
      const http2fp = parsed.http2?.akamai_fingerprint ?? '';
      const ua = parsed.user_agent ?? '';
      const ciphers = tls.ciphers ?? [];

      // KEY SIGNAL: real Chrome sends TLS GREASE values (RFC 8701) in its
      // ClientHello as the first cipher and first extension. Playwright's
      // bundled Chromium does NOT emit GREASE. If we see GREASE, we're
      // running real Chrome's TLS stack (via channel: 'chrome').
      const hasGREASE = ciphers.length > 0 && /GREASE/i.test(ciphers[0] ?? '');

      // JA4 format: t{version}{tls_ext}{cipher}_{sig}_{ext_hash}. Chrome on
      // TLS 1.3 starts with 't13d' (d = destination=TCP, TLS 1.3).
      const isChromeLikeJA4 = /^t13d/.test(ja4);

      record({
        detector: 'tls.peet.ws',
        ok: hasGREASE && isChromeLikeJA4 && ua.includes('Chrome'),
        durationMs: Date.now() - start,
        summary: {
          ja4,
          ja3_hash,
          http2_akamai: http2fp,
          user_agent: ua.slice(0, 100),
          hasGREASE,
          isChromeLikeJA4,
          firstCipher: ciphers[0],
        },
      });
    } catch (err) {
      record({
        detector: 'tls.peet.ws',
        ok: false,
        durationMs: Date.now() - start,
        summary: {},
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── CreepJS ──

  it('CreepJS — trust grade, headless/stealth ratings, lie count', async () => {
    const start = Date.now();
    try {
      await bt.navigate('https://abrahamjuliot.github.io/creepjs/');
      // CreepJS takes several seconds to compute its full fingerprint.
      await new Promise((r) => setTimeout(r, 9000));

      const info = (await bt.executeJS(`(() => {
        // Pull grade letter from the 'grade-X' class on the scale-up element.
        var gradeEl = document.querySelector('[class*="grade-"]');
        var grade = null;
        if (gradeEl) {
          var m = gradeEl.className.match(/grade-([A-F])/);
          if (m) grade = m[1];
        }

        // Headless and stealth rating panels.
        var headlessEl = document.querySelector('.headless-rating');
        var stealthEl = document.querySelector('.stealth-rating');
        var likeHeadlessEl = document.querySelector('.like-headless-rating');

        // "Lies" in CreepJS terminology = inconsistencies detected where
        // a value was clearly spoofed. Count them from the body text.
        var body = document.body.innerText;
        var liesMatch = body.match(/(\\d+)\\s*lies?/i);
        var lies = liesMatch ? parseInt(liesMatch[1], 10) : null;

        // Trust score appears after "trust score" label or inside a specific
        // container; fall back to searching the body text.
        var trustMatch = body.match(/trust score[^\\n]{0,80}/i);

        return {
          grade: grade,
          headlessRating: headlessEl ? headlessEl.textContent.trim().slice(0, 60) : null,
          stealthRating: stealthEl ? stealthEl.textContent.trim().slice(0, 60) : null,
          likeHeadlessRating: likeHeadlessEl ? likeHeadlessEl.textContent.trim().slice(0, 60) : null,
          lies: lies,
          trustLine: trustMatch ? trustMatch[0].slice(0, 100) : null,
          fpIdMatch: /FP ID:\\s*([a-f0-9]+)/.exec(body),
        };
      })()`)) as {
        grade: string | null;
        headlessRating: string | null;
        stealthRating: string | null;
        likeHeadlessRating: string | null;
        lies: number | null;
        trustLine: string | null;
        fpIdMatch: string[] | null;
      };

      // Pass criteria: grade A or B, headless rating should say 0% or low,
      // stealth rating should say 0% or low.
      const gradeOk = info.grade === 'A' || info.grade === 'B';
      const headlessOk = info.headlessRating
        ? /0(%|\.00%|\s*\/)/.test(info.headlessRating) || !/100|high/i.test(info.headlessRating)
        : false;

      record({
        detector: 'creepjs',
        ok: gradeOk && headlessOk,
        durationMs: Date.now() - start,
        summary: {
          grade: info.grade,
          headlessRating: info.headlessRating,
          stealthRating: info.stealthRating,
          likeHeadlessRating: info.likeHeadlessRating,
          lies: info.lies,
          trustLine: info.trustLine,
        },
      });
    } catch (err) {
      record({
        detector: 'creepjs',
        ok: false,
        durationMs: Date.now() - start,
        summary: {},
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── browserleaks.com/canvas ──
  //
  // browserleaks renders its results in tables with classes "wball nxmrg"
  // and similar. The signature and uniqueness appear as tab-separated
  // text in the body. Parse via regex on body innerText — more resilient
  // to DOM reshuffles than nested selector chains.

  it('browserleaks.com/canvas — canvas fingerprint hash and uniqueness', async () => {
    const start = Date.now();
    try {
      await bt.navigate('https://browserleaks.com/canvas');
      await new Promise((r) => setTimeout(r, 3500));

      const info = (await bt.executeJS(`(() => {
        var body = document.body.innerText;
        // Signature looks like "Signature\\t<HEX>" in the text view.
        var sigMatch = body.match(/Signature\\s+([A-F0-9]{16,})/);
        var uniqMatch = body.match(/Uniqueness\\s+([^\\n]+)/);
        return {
          signature: sigMatch ? sigMatch[1] : null,
          uniqueness: uniqMatch ? uniqMatch[1].slice(0, 120) : null,
        };
      })()`)) as { signature: string | null; uniqueness: string | null };

      record({
        detector: 'browserleaks.com/canvas',
        ok: info.signature != null,
        durationMs: Date.now() - start,
        summary: info,
      });
    } catch (err) {
      record({
        detector: 'browserleaks.com/canvas',
        ok: false,
        durationMs: Date.now() - start,
        summary: {},
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── browserleaks.com/webgl ──

  it('browserleaks.com/webgl — vendor/renderer spoof verification', async () => {
    const start = Date.now();
    try {
      await bt.navigate('https://browserleaks.com/webgl');
      await new Promise((r) => setTimeout(r, 3500));

      const info = (await bt.executeJS(`(() => {
        var body = document.body.innerText;
        // "Unmasked Vendor\\t<value>" / "Unmasked Renderer\\t<value>"
        var vMatch = body.match(/Unmasked Vendor\\s+([^\\n]+)/i);
        var rMatch = body.match(/Unmasked Renderer\\s+([^\\n]+)/i);
        var imgHashMatch = body.match(/Image Hash\\s+([A-F0-9]+)/i);
        return {
          unmaskedVendor: vMatch ? vMatch[1].slice(0, 120) : null,
          unmaskedRenderer: rMatch ? rMatch[1].slice(0, 120) : null,
          imageHash: imgHashMatch ? imgHashMatch[1] : null,
        };
      })()`)) as { unmaskedVendor: string | null; unmaskedRenderer: string | null; imageHash: string | null };

      const noSwiftShader = !/swiftshader|llvmpipe/i.test(info.unmaskedRenderer ?? '');
      const hasRealGpu = (info.unmaskedRenderer ?? '').length > 0 && (info.unmaskedVendor ?? '').length > 0;

      record({
        detector: 'browserleaks.com/webgl',
        ok: noSwiftShader && hasRealGpu,
        durationMs: Date.now() - start,
        summary: { ...info, noSwiftShader },
      });
    } catch (err) {
      record({
        detector: 'browserleaks.com/webgl',
        ok: false,
        durationMs: Date.now() - start,
        summary: {},
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── browserleaks.com/webrtc ──

  it('browserleaks.com/webrtc — WebRTC IP leak check', async () => {
    const start = Date.now();
    try {
      await bt.navigate('https://browserleaks.com/webrtc');
      await new Promise((r) => setTimeout(r, 4000));

      const info = (await bt.executeJS(`(() => {
        var body = document.body.innerText;
        // Local network ranges (RFC 1918) in the body indicate a local-IP leak.
        var localLeakMatch = body.match(/\\b(192\\.168\\.\\d+\\.\\d+|10\\.\\d+\\.\\d+\\.\\d+|172\\.(1[6-9]|2\\d|3[0-1])\\.\\d+\\.\\d+)\\b/);
        // Public IP from their "Public IP Address" row.
        var pubIpMatch = body.match(/Public IP Address\\s+([0-9a-fA-F:.]+)/);
        // mDNS-style obfuscated local candidate (which is fine — Chrome's default).
        var mdnsMatch = body.match(/([a-f0-9-]{30,}\\.local)/);
        return {
          localLeak: localLeakMatch ? localLeakMatch[1] : null,
          publicIP: pubIpMatch ? pubIpMatch[1] : null,
          hasMdnsCandidate: !!mdnsMatch,
        };
      })()`)) as { localLeak: string | null; publicIP: string | null; hasMdnsCandidate: boolean };

      record({
        detector: 'browserleaks.com/webrtc',
        ok: info.localLeak == null,
        durationMs: Date.now() - start,
        summary: info,
      });
    } catch (err) {
      record({
        detector: 'browserleaks.com/webrtc',
        ok: false,
        durationMs: Date.now() - start,
        summary: {},
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── browserleaks.com/javascript ──

  it('browserleaks.com/javascript — JS environment consistency', async () => {
    const start = Date.now();
    try {
      await bt.navigate('https://browserleaks.com/javascript');
      await new Promise((r) => setTimeout(r, 3500));

      const info = (await bt.executeJS(`(() => {
        var body = document.body.innerText;
        // browserleaks uses the JS property names as labels, tab-separated.
        var uaMatch = body.match(/userAgent\\s+([^\\n]+)/);
        var platMatch = body.match(/platform\\s+([^\\n]+)/);
        var langMatch = body.match(/language\\s+([^\\n]+)/);
        var tzMatch = body.match(/timeZone\\s+([^\\n]+)/);
        var resMatch = body.match(/Screen Resolution\\s+([^\\n]+)/);
        return {
          userAgent: uaMatch ? uaMatch[1].slice(0, 120) : null,
          platform: platMatch ? platMatch[1].slice(0, 40) : null,
          language: langMatch ? langMatch[1].slice(0, 40) : null,
          timeZone: tzMatch ? tzMatch[1].slice(0, 40) : null,
          screenResolution: resMatch ? resMatch[1].slice(0, 80) : null,
        };
      })()`)) as {
        userAgent: string | null;
        platform: string | null;
        language: string | null;
        timeZone: string | null;
        screenResolution: string | null;
      };

      const consistent =
        (info.userAgent ?? '').includes('Chrome') &&
        (info.userAgent ?? '').includes('Windows');

      record({
        detector: 'browserleaks.com/javascript',
        ok: consistent,
        durationMs: Date.now() - start,
        summary: info,
      });
    } catch (err) {
      record({
        detector: 'browserleaks.com/javascript',
        ok: false,
        durationMs: Date.now() - start,
        summary: {},
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── fingerprint.com/demo — commercial fingerprint vendor's own test page ──

  it('fingerprint.com/demo — extracts visitorId and reports incognito/VPN', async () => {
    const start = Date.now();
    try {
      await bt.navigate('https://fingerprint.com/demo/');
      // fingerprint.com loads an async module that computes the visitor ID.
      // 6 seconds is typically enough for it to settle.
      await new Promise((r) => setTimeout(r, 6000));

      const info = (await bt.executeJS(`(() => {
        var body = document.body.innerText;
        // The demo page renders the computed visitorId in a box near the top.
        // Search for a 16+ char lowercase hex that's labeled with "visitor ID" or similar.
        var visitorMatch = body.match(/[Vv]isitor\\s*ID[:\\s]*([a-f0-9]{16,40})/);
        var incognitoMatch = body.match(/[Ii]ncognito[^\\n]{0,40}/);
        var botMatch = body.match(/[Bb]ot\\s*[Dd]etected?[^\\n]{0,40}|bad\\s*bot|good\\s*bot/);
        var countryMatch = body.match(/[Cc]ountry[^\\n]{0,40}/);
        return {
          visitorId: visitorMatch ? visitorMatch[1] : null,
          incognitoLine: incognitoMatch ? incognitoMatch[0].slice(0, 80) : null,
          botLine: botMatch ? botMatch[0].slice(0, 80) : null,
          countryLine: countryMatch ? countryMatch[0].slice(0, 80) : null,
          bodyLen: body.length,
        };
      })()`)) as {
        visitorId: string | null;
        incognitoLine: string | null;
        botLine: string | null;
        countryLine: string | null;
        bodyLen: number;
      };

      // Pass criteria: page loaded fully (body length big), and if there's
      // a bot line it does NOT say "bad bot" or "bot detected".
      const noBotDetection = !info.botLine || !/bad|detected/i.test(info.botLine);

      record({
        detector: 'fingerprint.com/demo',
        ok: info.bodyLen > 1000 && noBotDetection,
        durationMs: Date.now() - start,
        summary: info,
      });
    } catch (err) {
      record({
        detector: 'fingerprint.com/demo',
        ok: false,
        durationMs: Date.now() - start,
        summary: {},
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── pixelscan.net — fingerprint audit
  //
  // Note: pixelscan.net's actual fingerprint results are rendered by a
  // React SPA into a component that doesn't show up in innerText for us
  // to scrape easily. For this check we just verify the page loads
  // without a hard block / bot-detection banner. Extracting the actual
  // fingerprint score would require clicking through their "Start Check"
  // flow and waiting for their async checks to resolve — worth adding
  // once we have a proxy layer so we can compare scores across IPs.

  it('pixelscan.net — site loads without hard block', async () => {
    const start = Date.now();
    try {
      await bt.navigate('https://pixelscan.net/fingerprint-check');
      await new Promise((r) => setTimeout(r, 5000));

      const info = (await bt.executeJS(`(() => {
        var body = document.body.innerText;
        return {
          title: document.title,
          bodyLen: body.length,
          // Hard-block indicators. "Bot Verification" is their nav menu item,
          // so we match only explicit block/denial language.
          hardBlock: /you\\s+(are|have\\s+been)\\s+blocked|access\\s+denied|forbidden|too\\s+many\\s+requests|just\\s+a\\s+moment/i.test(body),
          // Sanity check that the React app mounted (not a Cloudflare stub).
          hasAppContent: /fingerprint|checker|browser|pixelscan/i.test(body),
        };
      })()`)) as {
        title: string;
        bodyLen: number;
        hardBlock: boolean;
        hasAppContent: boolean;
      };

      record({
        detector: 'pixelscan.net',
        ok: info.hasAppContent && !info.hardBlock && info.bodyLen > 500,
        durationMs: Date.now() - start,
        summary: info,
      });
    } catch (err) {
      record({
        detector: 'pixelscan.net',
        ok: false,
        durationMs: Date.now() - start,
        summary: {},
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── browserscan.net — bot detection + fingerprint scanner ──

  it('browserscan.net — bot detection verdict', async () => {
    const start = Date.now();
    try {
      await bt.navigate('https://www.browserscan.net/');
      // browserscan takes a beat to run its checks.
      await new Promise((r) => setTimeout(r, 6000));

      const info = (await bt.executeJS(`(() => {
        var body = document.body.innerText;
        // browserscan.net shows a "Bot" row with either "Normal" or "Bot detected".
        // Also shows "Browser:", "Platform:", "IP:" fields.
        var botMatch = body.match(/Bot[:\\s]+([^\\n]{0,80})/);
        var browserMatch = body.match(/Browser[:\\s]+([^\\n]{0,80})/);
        var platformMatch = body.match(/Platform[:\\s]+([^\\n]{0,80})/);
        return {
          botLine: botMatch ? botMatch[1].trim().slice(0, 60) : null,
          browserLine: browserMatch ? browserMatch[1].trim().slice(0, 80) : null,
          platformLine: platformMatch ? platformMatch[1].trim().slice(0, 60) : null,
          bodyLen: body.length,
        };
      })()`)) as {
        botLine: string | null;
        browserLine: string | null;
        platformLine: string | null;
        bodyLen: number;
      };

      // Pass criteria: page rendered substantial content AND the bot line
      // doesn't say "detected" or "bot" or similar flag.
      const notFlagged = !info.botLine || !/detected|bot\b.*true|automated/i.test(info.botLine);
      const pageRendered = info.bodyLen > 1000;

      record({
        detector: 'browserscan.net',
        ok: pageRendered && notFlagged,
        durationMs: Date.now() - start,
        summary: info,
      });
    } catch (err) {
      record({
        detector: 'browserscan.net',
        ok: false,
        durationMs: Date.now() - start,
        summary: {},
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── Direct self-assertion on navigator — doesn't need a detector site ──

  it('self-check — navigator, WebGL, Permissions look right', async () => {
    const start = Date.now();
    try {
      // Use any realistic origin so we're not on a data: URL where some APIs
      // behave differently.
      await bt.navigate('https://example.com/');

      const nav = (await bt.executeJS(`(() => {
        var gl = document.createElement('canvas').getContext('webgl');
        var dbg = gl ? gl.getExtension('WEBGL_debug_renderer_info') : null;
        return {
          webdriver: navigator.webdriver,
          platform: navigator.platform,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory,
          pluginsLength: navigator.plugins.length,
          mimeTypesLength: navigator.mimeTypes.length,
          languages: navigator.languages,
          userAgent: navigator.userAgent,
          hasChrome: typeof window.chrome === 'object',
          webglVendor: gl && dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
          webglRenderer: gl && dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        };
      })()`)) as {
        webdriver: unknown;
        platform: string;
        hardwareConcurrency: number;
        deviceMemory: number;
        pluginsLength: number;
        mimeTypesLength: number;
        languages: string[];
        userAgent: string;
        hasChrome: boolean;
        webglVendor: string | null;
        webglRenderer: string | null;
      };

      const ok =
        nav.webdriver !== true &&
        nav.hasChrome === true &&
        nav.pluginsLength > 0 &&
        nav.languages.length > 0 &&
        nav.platform === 'Win32' &&
        /Chrome/.test(nav.userAgent) &&
        !/HeadlessChrome/.test(nav.userAgent) &&
        !/SwiftShader/i.test(nav.webglRenderer ?? '');

      record({
        detector: 'self-check',
        ok,
        durationMs: Date.now() - start,
        summary: nav as unknown as Record<string, unknown>,
      });
    } catch (err) {
      record({
        detector: 'self-check',
        ok: false,
        durationMs: Date.now() - start,
        summary: {},
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
});
