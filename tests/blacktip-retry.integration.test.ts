/**
 * BlackTip retry engine tests.
 *
 * Exercises the six-strategy retry cascade in `BlackTip.executeAction()`:
 *   attempt 1: standard    (no strategy applied, first try)
 *   attempt 2: wait        (sleep 2–5s)
 *   attempt 3: reload      (reload page)
 *   attempt 4: altSelector (no op, just retry)
 *   attempt 5: scroll      (scroll page)
 *   attempt 6: clearOverlays (hide fixed/sticky overlays)
 *
 * We drive the engine via the public `click()` method and observe event
 * emissions. Pure "does the right event fire with the right shape?" tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BlackTip } from '../src/blacktip.js';
import type { ActionEvent, RetryEvent, ErrorEvent } from '../src/types.js';

const FIXTURE_HTML = `<!doctype html>
<html><head><title>Retry Fixture</title></head>
<body>
  <button id="always-there">Always There</button>
</body></html>`;
const FIXTURE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE_HTML)}`;

describe('BlackTip.executeAction() — retry engine', () => {
  let bt: BlackTip;

  beforeAll(async () => {
    bt = new BlackTip({
      logLevel: 'error',
      timeout: 2000, // Short timeout so failing tests don't stall.
      retryAttempts: 3,
    });
    await bt.launch();
    await bt.navigate(FIXTURE_URL);
  });

  afterAll(async () => {
    if (bt) await bt.close();
  });

  beforeEach(async () => {
    // Make sure the fixture is loaded before each test in case a previous
    // test (reload strategy, etc.) left the page in a different state.
    await bt.navigate(FIXTURE_URL);
  });

  it('success on first try: no retry events, action event with retries=0', async () => {
    const actions: ActionEvent[] = [];
    const retries: RetryEvent[] = [];
    const errors: ErrorEvent[] = [];
    bt.on('action', (e) => actions.push(e));
    bt.on('retry', (e) => retries.push(e));
    bt.on('error', (e) => errors.push(e));

    const result = await bt.click('#always-there');

    expect(result.success).toBe(true);
    expect(result.retries).toBe(0);
    expect(retries.length).toBe(0);
    expect(errors.length).toBe(0);
    expect(actions.length).toBe(1);
    expect(actions[0]!.outcome).toBe('success');
    expect(actions[0]!.action).toBe('click');
    expect(actions[0]!.target).toBe('#always-there');
    expect(actions[0]!.retries).toBe(0);

    bt.removeAllListeners('action');
    bt.removeAllListeners('retry');
  });

  it('full failure: retry events fire for attempts 2..N, error event has screenshot', async () => {
    const actions: ActionEvent[] = [];
    const retries: RetryEvent[] = [];
    const errors: ErrorEvent[] = [];
    bt.on('action', (e) => actions.push(e));
    bt.on('retry', (e) => retries.push(e));
    bt.on('error', (e) => errors.push(e));

    const result = await bt.click('#nonexistent-element', { timeout: 1000 });

    expect(result.success).toBe(false);
    expect(result.retries).toBe(2); // retryAttempts=3 → 1 initial + 2 retries
    expect(result.errorCode).toBe('ELEMENT_NOT_FOUND');

    // Exactly (retryAttempts - 1) retry events: one before each retry attempt.
    expect(retries.length).toBe(2);
    expect(retries[0]!.attempt).toBe(2);
    expect(retries[1]!.attempt).toBe(3);
    for (const r of retries) {
      expect(r.action).toBe('click');
      expect(r.target).toBe('#nonexistent-element');
      expect(r.maxAttempts).toBe(3);
      expect(r.error.length).toBeGreaterThan(0);
    }

    // Exactly one error event at the end.
    expect(errors.length).toBe(1);
    expect(errors[0]!.attempts).toBe(3);
    expect(errors[0]!.action).toBe('click');
    expect(errors[0]!.screenshot).toBeInstanceOf(Buffer);
    expect(errors[0]!.screenshot!.length).toBeGreaterThan(0);

    // Exactly one action event with outcome=failure.
    expect(actions.length).toBe(1);
    expect(actions[0]!.outcome).toBe('failure');
    expect(actions[0]!.error).toBeTruthy();

    bt.removeAllListeners('action');
    bt.removeAllListeners('retry');
  });

  it('retry events carry the right strategy name in order', async () => {
    const retries: RetryEvent[] = [];
    bt.on('retry', (e) => retries.push(e));

    // With retryAttempts=3, we expect strategies at attempts 2 and 3:
    //   attempt 2 → strategy 'wait'
    //   attempt 3 → strategy 'reload'
    await bt.click('#still-missing', { timeout: 800 });

    expect(retries.length).toBe(2);
    expect(retries[0]!.strategy).toBe('wait');
    expect(retries[1]!.strategy).toBe('reload');

    bt.removeAllListeners('action');
    bt.removeAllListeners('retry');
  });

  it('all six strategies surface when retryAttempts is large enough', async () => {
    // Temporarily bump retryAttempts to 6 on a fresh instance so we can see
    // every strategy in order.
    const bt6 = new BlackTip({
      logLevel: 'error',
      timeout: 500,
      retryAttempts: 6,
    });
    await bt6.launch();
    await bt6.navigate(FIXTURE_URL);

    const retries: RetryEvent[] = [];
    bt6.on('retry', (e) => retries.push(e));

    await bt6.click('#not-going-to-appear', { timeout: 500 });

    expect(retries.length).toBe(5);
    expect(retries.map((r) => r.strategy)).toEqual([
      'wait',
      'reload',
      'altSelector',
      'scroll',
      'clearOverlays',
    ]);

    await bt6.close();
  }, 180_000); // larger test timeout — 'wait' strategy sleeps 2–5s per retry

  it('retryAttempts=1 short-circuits — no retries, immediate failure', async () => {
    const bt1 = new BlackTip({ logLevel: 'error', timeout: 500, retryAttempts: 1 });
    await bt1.launch();
    await bt1.navigate(FIXTURE_URL);

    const retries: RetryEvent[] = [];
    const errors: ErrorEvent[] = [];
    bt1.on('retry', (e) => retries.push(e));
    bt1.on('error', (e) => errors.push(e));

    const result = await bt1.click('#wont-find', { timeout: 500 });

    expect(result.success).toBe(false);
    expect(result.retries).toBe(0);
    expect(retries.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]!.attempts).toBe(1);

    await bt1.close();
  });

  it('"wait" strategy actually gives the page time — a click succeeds against an element that appears after a delay', async () => {
    // Page starts with no target, then after 2.5s inserts it. With a 500ms
    // per-attempt timeout, attempt 1 fails fast, then the "wait" strategy
    // sleeps 2–5s, and attempt 2 finds the element. Proves the retry
    // strategy isn't a no-op.
    const delayedHtml = `<!doctype html><html><body>
      <div id="host"></div>
      <script>
        setTimeout(function() {
          var b = document.createElement('button');
          b.id = 'delayed-btn';
          b.textContent = 'Now Ready';
          document.getElementById('host').appendChild(b);
        }, 2500);
      </script>
    </body></html>`;
    const delayedUrl = `data:text/html;charset=utf-8,${encodeURIComponent(delayedHtml)}`;

    const btDelay = new BlackTip({ logLevel: 'error', timeout: 500, retryAttempts: 3 });
    await btDelay.launch();
    await btDelay.navigate(delayedUrl);

    const retries: RetryEvent[] = [];
    btDelay.on('retry', (e) => retries.push(e));

    const result = await btDelay.click('#delayed-btn', { timeout: 500 });

    expect(result.success).toBe(true);
    expect(result.retries).toBeGreaterThanOrEqual(1);
    // The first retry must use the 'wait' strategy.
    expect(retries.length).toBeGreaterThanOrEqual(1);
    expect(retries[0]!.strategy).toBe('wait');

    await btDelay.close();
  }, 60_000);
});
