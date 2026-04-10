/**
 * Real-target smoke tests.
 *
 * Exercises BlackTip against three public, legal, free targets:
 *
 *   1. nowsecure.nl — a public Cloudflare bot-fight test target maintained
 *      by the author of nodriver/undetected-chromedriver. The test is
 *      "does the page load at all" — if Cloudflare challenges us, the
 *      body will say "Just a moment..." and we fail. If we pass, we see
 *      "NOWSECURE BY NODRIVER". This is the closest we can get to a real
 *      commercial anti-bot without a paid account.
 *
 *   2. antoinevastel.com/bots — Antoine Vastel is an academic anti-bot
 *      researcher, formerly VP of Research at DataDome. His public page
 *      hosts fingerprint-detection demos. If his site challenges us, we
 *      fail; if it serves the research content, we pass.
 *
 *   3. Hacker News — no anti-bot. Used as a behavioral-baseline and
 *      interaction test: navigate to the front page, extract story
 *      titles, click through to a story, verify content loads.
 *
 * Network-dependent. Run as part of the eval suite (`npm run eval`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BlackTip } from '../../src/blacktip.js';

type TargetResult = {
  target: string;
  ok: boolean;
  durationMs: number;
  summary: Record<string, unknown>;
  error?: string;
};

const targetResults: TargetResult[] = [];

function record(r: TargetResult): void {
  targetResults.push(r);
  // eslint-disable-next-line no-console
  console.log(`[${r.ok ? 'OK ' : 'ERR'}] ${r.target} (${r.durationMs}ms) ${JSON.stringify(r.summary).slice(0, 150)}`);
}

describe('Real-target flows', () => {
  let bt: BlackTip;

  beforeAll(async () => {
    bt = new BlackTip({
      logLevel: 'error',
      timeout: 30_000,
      retryAttempts: 1,
      deviceProfile: 'desktop-windows',
      behaviorProfile: 'human',
    });
    await bt.launch();
  });

  afterAll(async () => {
    if (bt) await bt.close();

    // Persist results alongside the detector baselines.
    const phase = process.env.BLACKTIP_BASELINE_PHASE ?? 'adhoc';
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `real-targets-${phase}-${iso}.json`;
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
          targets: targetResults,
        },
        null,
        2,
      ),
    );
    // eslint-disable-next-line no-console
    console.log(`\nReal-target results written to ${outPath}`);
    const okCount = targetResults.filter((r) => r.ok).length;
    // eslint-disable-next-line no-console
    console.log(`Targets passed: ${okCount}/${targetResults.length}`);
  });

  // ── nowsecure.nl (Cloudflare bot-fight test) ──

  it('nowsecure.nl passes without Cloudflare challenge', async () => {
    const start = Date.now();
    try {
      const nav = await bt.navigate('https://nowsecure.nl/');
      expect(nav.success).toBe(true);
      // Give Cloudflare's potential challenge page time to either show up
      // or to complete its passive checks.
      await new Promise((r) => setTimeout(r, 4000));

      const info = (await bt.executeJS(`(() => {
        var body = document.body ? document.body.innerText : '';
        return {
          title: document.title,
          bodyPreview: body.slice(0, 300),
          hasCfChallenge: /Just a moment|Checking your browser|cf-browser-verification|Attention Required|Access denied/i.test(body) ||
                          !!document.querySelector('[class*="cf-challenge"], [id*="cf-challenge"]'),
          hasSuccess: /nowsecure/i.test(body),
          url: location.href,
        };
      })()`)) as { title: string; bodyPreview: string; hasCfChallenge: boolean; hasSuccess: boolean; url: string };

      const passed = info.hasSuccess && !info.hasCfChallenge;
      record({
        target: 'nowsecure.nl',
        ok: passed,
        durationMs: Date.now() - start,
        summary: info,
      });

      expect(info.hasCfChallenge).toBe(false);
      expect(info.hasSuccess).toBe(true);
    } catch (err) {
      record({
        target: 'nowsecure.nl',
        ok: false,
        durationMs: Date.now() - start,
        summary: {},
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });

  // ── antoinevastel.com/bots (academic researcher) ──

  it('antoinevastel.com/bots loads without detection banner', async () => {
    const start = Date.now();
    try {
      const nav = await bt.navigate('https://antoinevastel.com/bots');
      expect(nav.success).toBe(true);
      await new Promise((r) => setTimeout(r, 2500));

      const info = (await bt.executeJS(`(() => {
        var body = document.body ? document.body.innerText : '';
        return {
          title: document.title,
          bodyPreview: body.slice(0, 300),
          // Antoine's page shows his bio when you land on it. If we were
          // flagged, we'd see a different content block (or a 403).
          hasResearcherContent: /bot|fraud|fingerprint|detection/i.test(body),
          hasBlock: /blocked|denied|forbidden|403/i.test(body),
          url: location.href,
        };
      })()`)) as { title: string; bodyPreview: string; hasResearcherContent: boolean; hasBlock: boolean; url: string };

      record({
        target: 'antoinevastel.com/bots',
        ok: info.hasResearcherContent && !info.hasBlock,
        durationMs: Date.now() - start,
        summary: info,
      });

      expect(info.hasResearcherContent).toBe(true);
      expect(info.hasBlock).toBe(false);
    } catch (err) {
      record({
        target: 'antoinevastel.com/bots',
        ok: false,
        durationMs: Date.now() - start,
        summary: {},
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });

  // ── Hacker News: multi-step behavioral flow ──

  it('Hacker News: navigate front page, read story titles, click first story', async () => {
    const start = Date.now();
    try {
      const nav = await bt.navigate('https://news.ycombinator.com/');
      expect(nav.success).toBe(true);
      await bt.waitFor('.athing');

      // Extract the first five story titles.
      const titles = (await bt.executeJS(`(() => {
        var rows = document.querySelectorAll('.athing');
        var out = [];
        for (var i = 0; i < Math.min(5, rows.length); i++) {
          var titleEl = rows[i].querySelector('.titleline a');
          if (titleEl) out.push(titleEl.textContent.trim().slice(0, 80));
        }
        return out;
      })()`)) as string[];

      expect(Array.isArray(titles)).toBe(true);
      expect(titles.length).toBeGreaterThan(0);

      // Click the first story's comments link. HN nav bar also has a
      // "comments" link at nth:0 that goes to /newcomments, so we use a
      // CSS selector to target the first story's subtext comments link
      // specifically (the last <a> inside the first .subtext cell).
      const clickResult = await bt.click('td.subtext span.subline > a:last-of-type');
      expect(clickResult.success).toBe(true);

      // Verify we're on an item page (URL has /item?id=...).
      await new Promise((r) => setTimeout(r, 2000));
      const onItem = (await bt.executeJS('/\\/item\\?id=/.test(location.href)')) as boolean;

      record({
        target: 'news.ycombinator.com',
        ok: titles.length >= 3 && onItem,
        durationMs: Date.now() - start,
        summary: {
          firstThreeTitles: titles.slice(0, 3),
          reachedItemPage: onItem,
        },
      });

      expect(onItem).toBe(true);
    } catch (err) {
      record({
        target: 'news.ycombinator.com',
        ok: false,
        durationMs: Date.now() - start,
        summary: {},
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });
});
