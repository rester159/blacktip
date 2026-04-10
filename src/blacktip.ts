import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:net';
import type { Frame, ElementHandle as PlaywrightElementHandle } from 'patchright';
import { BrowserCore } from './browser-core.js';
import { BehavioralEngine, HUMAN_PROFILE, SCRAPER_PROFILE } from './behavioral-engine.js';
import type { MouseStep } from './behavioral-engine.js';
import { ElementFinder } from './element-finder.js';
import { Logger } from './logging.js';
import {
  captureFingerprint as diagnosticsCaptureFingerprint,
  checkIpReputation as diagnosticsCheckIpReputation,
  testAgainstAkamai as diagnosticsTestAgainstAkamai,
  type FingerprintSnapshot,
  type IpReputationResult,
  type AkamaiTestResult,
} from './diagnostics.js';
import type {
  BlackTipConfig,
  ProfileConfig,
  ActionResult,
  NavigateResult,
  ScreenshotResult,
  WaitResult,
  ActionEvent,
  ErrorEvent,
  RetryEvent,
  BehavioralMetadata,
  TabInfo,
  FrameInfo,
  LogLevel,
  ClickOptions,
  TypeOptions,
  ScrollOptions,
  HoverOptions,
  SelectOptions,
  PressKeyOptions,
  UploadFileOptions,
  NavigateOptions,
  ScreenshotOptions,
  WaitForOptions,
  WaitForNavigationOptions,
  ExtractTextOptions,
  PageContentOptions,
  BoundingBox,
  ErrorCodes,
  RetryStrategy,
} from './types.js';

const RETRY_STRATEGIES: RetryStrategy[] = ['standard', 'wait', 'reload', 'altSelector', 'scroll', 'clearOverlays'];

/**
 * Text patterns that suggest an action is high-importance — submit,
 * payment, confirmation, destructive actions. When clickText or clickRole
 * matches a button whose label matches one of these, the behavioral
 * engine automatically applies importance:'high' so the pre-action
 * hesitation matches a real human's pause before committing.
 *
 * Caller can still override by passing importance explicitly.
 */
const HIGH_IMPORTANCE_PATTERNS: RegExp[] = [
  /^\s*submit\b/i,
  /^\s*pay\b/i,
  /^\s*confirm\b/i,
  /^\s*place\s*order\b/i,
  /^\s*checkout\b/i,
  /^\s*purchase\b/i,
  /^\s*buy\b/i,
  /^\s*delete\b/i,
  /^\s*remove\b/i,
  /^\s*agree\b/i,
  /^\s*accept\b/i,
  /send\s*money/i,
  /submit\s*payment/i,
  /confirm\s*payment/i,
  /place\s*order/i,
  /^\s*sign\s*(up|in|out)?\s*$/i,
  /^\s*log\s*out\b/i,
  /^\s*finish\b/i,
  /^\s*complete\b/i,
];

function inferImportance(
  text: string | undefined,
  explicit?: import('./behavioral-engine.js').ActionImportance,
): import('./behavioral-engine.js').ActionImportance {
  if (explicit) return explicit;
  if (!text) return 'normal';
  return HIGH_IMPORTANCE_PATTERNS.some((re) => re.test(text)) ? 'high' : 'normal';
}

/**
 * BlackTip — Stealth browser instrument for AI agents.
 *
 * BlackTip is NOT an agent. It is a tool that an agent drives.
 * Every action (click, type, scroll) is wrapped in human-like behavioral
 * simulation that defeats bot detection.
 *
 * ## Quick Start (for AI agents)
 *
 * ```typescript
 * const bt = new BlackTip();
 * await bt.launch();
 * await bt.navigate('https://example.com');
 * await bt.type('input[name="email"]', 'user@example.com', { paste: true });
 * await bt.click('.submit-btn');
 * await bt.close();
 * ```
 *
 * ## Agent Usage Guide
 *
 * Call `BlackTip.agentGuide()` to get detailed instructions for how an AI
 * agent should use BlackTip. This includes critical patterns for React/Angular
 * forms, Okta login pages, custom dropdowns, and common mistakes to avoid.
 *
 * ## Server Mode (recommended for agents)
 *
 * ```typescript
 * const bt = new BlackTip();
 * await bt.serve(9779); // TCP server, send commands as JS strings
 * ```
 *
 * ## Key Methods
 * - `navigate(url)` — go to URL
 * - `click(selector)` — click by CSS/XPath
 * - `clickText(text, {nth?})` — click by visible text (handles React/Okta)
 * - `type(selector, text, {paste?})` — type into input (React-compatible)
 * - `screenshot({path})` — capture page state
 * - `executeJS(script)` — run JS in page context
 * - `uploadFile(selector, path)` — upload a file
 * - `waitFor(selector)` — wait for element
 * - `extractText(selector)` — get text content
 * - `frame(selector)` — interact with iframes
 * - `serve(port)` — start TCP command server
 */
export class BlackTip extends EventEmitter {
  private core: BrowserCore;
  private engine: BehavioralEngine;
  private finder: ElementFinder;
  private logger: Logger;
  private config: BlackTipConfig;
  private customProfiles = new Map<string, ProfileConfig>();
  private launched = false;

  constructor(config: BlackTipConfig = {}) {
    super();
    this.config = config;

    const logLevel = (config.logLevel ?? process.env.BLACKTIP_LOG_LEVEL ?? 'info') as LogLevel;
    this.logger = new Logger(logLevel);

    // Forward log events
    this.logger.on('log', (entry) => this.emit('log', entry));

    // Resolve behavioral profile
    const profile = this.resolveProfile(config.behaviorProfile ?? 'human');
    this.engine = new BehavioralEngine(profile);

    this.core = new BrowserCore(config, this.logger);
    this.finder = new ElementFinder(this.logger);

    // Forward tab events from core
    this.core.on('tabChange', (event) => this.emit('tabChange', event));

    // Default 'error' listener so Node's EventEmitter doesn't crash the
    // process when an action fails and no user listener is attached. The
    // action result already carries the error; this event is supplemental.
    // Users can still add their own 'error' listeners alongside this one.
    this.on('error', (errorEvent) => {
      this.logger.debug('BlackTip action error (no external listener)', {
        code: (errorEvent as { code?: string })?.code,
        action: (errorEvent as { action?: string })?.action,
      });
    });
  }

  // ── Lifecycle ──

  /**
   * Launch the browser. Returns the agent usage guide — read it before
   * driving BlackTip to avoid common mistakes.
   */
  async launch(): Promise<string> {
    await this.core.launch();
    this.launched = true;
    return BlackTip.agentGuide();
  }

  async close(): Promise<void> {
    await this.core.close();
    this.launched = false;
  }

  isActive(): boolean {
    return this.launched && this.core.isActive();
  }

  // ── Navigation ──

  async navigate(url: string, options?: NavigateOptions): Promise<NavigateResult> {
    this.ensureLaunched();
    // Pre-navigation pause
    await this.sleep(this.engine.generatePreActionPause());
    return this.core.navigate(url, options);
  }

  // ── Actions ──

  async click(selector: string, options?: ClickOptions): Promise<ActionResult> {
    return this.executeAction('click', selector, async () => {
      const page = this.core.getActivePage();
      const element = await this.finder.find(page, selector, {
        timeout: options?.timeout ?? this.config.timeout,
        visible: true,
      });

      const box = await this.finder.getBoundingBox(element);
      if (!box) throw new Error('Element has no bounding box');

      // Generate human-like mouse movement toward the originally-captured box.
      const currentPos = await this.getMousePosition();
      const targetPos = this.engine.generateClickPosition(box);
      const behavioral = await this.performMouseMove(currentPos, targetPos);

      // Hover dwell
      const dwell = this.engine.generateClickDwell();
      await this.sleep(dwell);
      behavioral.clickDwell = dwell;

      // L011 fix: the DOM may have reflowed during our ~200ms mouse path
      // (async scripts, layout shifts, animations). Re-read the element's
      // live bounding box immediately before the click and, if it moved
      // more than a few pixels, do a short correction move to the new
      // center. Real humans do the same thing when a target shifts.
      const liveBox = await this.finder.getBoundingBox(element);
      if (liveBox) {
        const liveCenter = {
          x: liveBox.x + liveBox.width / 2,
          y: liveBox.y + liveBox.height / 2,
        };
        const drift = Math.hypot(liveCenter.x - targetPos.x, liveCenter.y - targetPos.y);
        if (drift > 5) {
          this.logger.debug('Click target reflow detected, correcting', {
            drift: Math.round(drift),
            from: targetPos,
            to: liveCenter,
          });
          await this.performMouseMove(targetPos, liveCenter);
          targetPos.x = liveCenter.x;
          targetPos.y = liveCenter.y;
          // A small post-correction dwell — humans take a brief beat
          // between a correction and the click.
          await this.sleep(80 + Math.random() * 120);
        }
      }

      // Pre-click verification: if the click coordinates are covered by
      // an overlay, dismiss the overlay and fall back to Playwright's
      // element.click() with force:true.
      const hitCheck = await page.evaluate(
        `((x, y) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return { ok: false, reason: 'no-element' };
          let cur = el;
          while (cur) {
            if (cur.tagName === 'BUTTON' || cur.tagName === 'A' || cur.tagName === 'INPUT' || cur.getAttribute('role') === 'button') {
              return { ok: true };
            }
            cur = cur.parentElement;
          }
          return { ok: false, reason: 'not-interactive', tag: el.tagName };
        })(${targetPos.x}, ${targetPos.y})`,
      ) as { ok: boolean; reason?: string; tag?: string };

      if (hitCheck.ok) {
        await page.mouse.click(targetPos.x, targetPos.y, {
          button: options?.button ?? 'left',
          clickCount: options?.count ?? 1,
        });
      } else {
        this.logger.warn('Click target covered by overlay; dismissing and retrying', {
          reason: hitCheck.reason,
          coveredBy: hitCheck.tag,
        });
        await this.dismissOverlays();
        await element.click({ force: true, timeout: 3000 });
      }

      // Try to auto-infer importance from the element text if the
      // caller didn't set it.
      let inferredImportance = options?.importance;
      if (!inferredImportance) {
        try {
          const elText = await element.innerText();
          inferredImportance = inferImportance(elText);
        } catch { /* element may have navigated away */ }
      }

      // Post-action pause
      const postPause = this.engine.generatePostActionPause();
      await this.sleep(postPause);
      behavioral.postActionPause = postPause;

      // Stash the inferred importance on the behavioral object so the
      // outer executeAction wrapper can read it. But the pre-action
      // pause already happened — importance inference only affects
      // future calls. Keeping the interface consistent anyway.
      void inferredImportance;

      return behavioral;
    }, undefined, options?.importance);
  }

  async clickText(text: string, options?: ClickOptions & { exact?: boolean; nth?: number }): Promise<ActionResult> {
    // Auto-infer importance from the text if caller didn't set it.
    const importance = inferImportance(text, options?.importance);
    return this.executeAction('click', `text="${text}"`, async () => {
      const page = this.core.getActivePage();
      let locator = page.getByText(text, { exact: options?.exact ?? true });
      if (options?.nth !== undefined) {
        locator = locator.nth(options.nth);
      } else {
        locator = locator.first(); // Avoid strict mode violation when multiple matches
      }

      await locator.waitFor({ state: 'visible', timeout: options?.timeout ?? this.config.timeout ?? 15000 });
      const box = await locator.boundingBox();
      if (!box) throw new Error('Element has no bounding box');

      const currentPos = await this.getMousePosition();
      const targetPos = this.engine.generateClickPosition(box);
      const behavioral = await this.performMouseMove(currentPos, targetPos);

      const dwell = this.engine.generateClickDwell();
      await this.sleep(dwell);
      behavioral.clickDwell = dwell;

      // Pre-click verification: check if the click coordinates land on
      // an interactive element. If they don't (e.g. a chat widget or
      // cookie banner is covering the button), dismiss overlays and
      // fall back to locator.click() which bypasses the coordinate
      // issue entirely.
      const hitCheck = await page.evaluate(
        `((x, y) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return { ok: false, reason: 'no-element' };
          let cur = el;
          while (cur) {
            if (cur.tagName === 'BUTTON' || cur.tagName === 'A' || cur.getAttribute('role') === 'button') {
              return { ok: true };
            }
            cur = cur.parentElement;
          }
          return { ok: false, reason: 'not-interactive', tag: el.tagName };
        })(${targetPos.x}, ${targetPos.y})`,
      ) as { ok: boolean; reason?: string; tag?: string };

      if (hitCheck.ok) {
        await page.mouse.click(targetPos.x, targetPos.y, {
          button: options?.button ?? 'left',
          clickCount: options?.count ?? 1,
        });
      } else {
        // Click would be intercepted. Dismiss overlays and use
        // locator.click({force:true}) which does its own visibility
        // handling.
        this.logger.warn('Click target covered by overlay; dismissing and retrying via locator', {
          reason: hitCheck.reason,
          coveredBy: hitCheck.tag,
        });
        await this.dismissOverlays();
        await locator.click({ force: true, timeout: 3000 });
      }

      const postPause = this.engine.generatePostActionPause();
      await this.sleep(postPause);
      behavioral.postActionPause = postPause;

      return behavioral;
    }, undefined, importance);
  }

  async clickRole(role: string, options?: ClickOptions & { name?: string; nth?: number }): Promise<ActionResult> {
    const label = `role=${role}${options?.name ? `[name="${options.name}"]` : ''}`;
    // Auto-infer importance from the role name if provided.
    const importance = inferImportance(options?.name, options?.importance);
    return this.executeAction('click', label, async () => {
      const page = this.core.getActivePage();
      let locator = page.getByRole(role as any, options?.name ? { name: options.name } : undefined);
      if (options?.nth !== undefined) {
        locator = locator.nth(options.nth);
      } else {
        locator = locator.first();
      }

      await locator.waitFor({ state: 'visible', timeout: options?.timeout ?? this.config.timeout ?? 15000 });
      const box = await locator.boundingBox();
      if (!box) throw new Error('Element has no bounding box');

      const currentPos = await this.getMousePosition();
      const targetPos = this.engine.generateClickPosition(box);
      const behavioral = await this.performMouseMove(currentPos, targetPos);

      const dwell = this.engine.generateClickDwell();
      await this.sleep(dwell);
      behavioral.clickDwell = dwell;

      // Pre-click verification — same pattern as clickText.
      const hitCheck = await page.evaluate(
        `((x, y) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return { ok: false, reason: 'no-element' };
          let cur = el;
          while (cur) {
            if (cur.tagName === 'BUTTON' || cur.tagName === 'A' || cur.tagName === 'INPUT' || cur.getAttribute('role') === 'button') {
              return { ok: true };
            }
            cur = cur.parentElement;
          }
          return { ok: false, reason: 'not-interactive', tag: el.tagName };
        })(${targetPos.x}, ${targetPos.y})`,
      ) as { ok: boolean; reason?: string; tag?: string };

      if (hitCheck.ok) {
        await page.mouse.click(targetPos.x, targetPos.y, {
          button: options?.button ?? 'left',
          clickCount: options?.count ?? 1,
        });
      } else {
        this.logger.warn('Click target covered by overlay; dismissing and retrying via locator', {
          reason: hitCheck.reason,
          coveredBy: hitCheck.tag,
        });
        await this.dismissOverlays();
        await locator.click({ force: true, timeout: 3000 });
      }

      const postPause = this.engine.generatePostActionPause();
      await this.sleep(postPause);
      behavioral.postActionPause = postPause;

      return behavioral;
    }, undefined, importance);
  }

  async type(selector: string, text: string, options?: TypeOptions): Promise<ActionResult> {
    return this.executeAction('type', selector, async () => {
      const page = this.core.getActivePage();
      const element = await this.finder.find(page, selector, {
        timeout: options?.timeout ?? this.config.timeout,
        visible: true,
      });

      // Click on the element first (human-like)
      const box = await this.finder.getBoundingBox(element);
      if (!box) throw new Error('Element has no bounding box');

      const currentPos = await this.getMousePosition();
      const targetPos = this.engine.generateClickPosition(box);
      const behavioral = await this.performMouseMove(currentPos, targetPos);

      const dwell = this.engine.generateClickDwell();
      await this.sleep(dwell);
      await page.mouse.click(targetPos.x, targetPos.y);

      // Clear existing content if requested
      if (options?.clearFirst) {
        await page.keyboard.press('Control+a');
        await this.sleep(50);
        await page.keyboard.press('Backspace');
        await this.sleep(this.engine.generatePreActionPause() * 0.3);
      }

      // Use Playwright's fill() to set value — this correctly triggers React/Angular
      // change events, input events, and form validation. Then optionally simulate
      // typing cadence with page.type() for keystroke-level behavioral fidelity.
      const shouldPaste = options?.paste ?? this.engine.shouldPaste(text);

      if (shouldPaste) {
        // Fast path: fill directly (like a paste) — triggers React/Angular events correctly
        await element.fill(text);
        await this.sleep(100 + Math.random() * 200);
      } else {
        // Human typing path: use page.keyboard.type() which dispatches the full
        // keydown/keypress/input/keyup event cycle per character. This triggers
        // React/Angular synthetic event handlers correctly, unlike keyboard.press().

        // Clear field with Select-all + Backspace (works with all frameworks)
        await page.keyboard.press('Control+a');
        await this.sleep(30 + Math.random() * 50);
        await page.keyboard.press('Backspace');
        await this.sleep(50);

        const sequence = this.engine.generateTypingSequence(text);
        for (const keystroke of sequence) {
          if (keystroke.isTypo && keystroke.correctionSequence) {
            // Type wrong character via keyboard.type() (triggers input events)
            await page.keyboard.type(keystroke.key, { delay: keystroke.holdDuration });
            // Apply corrections (backspace + correct char)
            for (const correction of keystroke.correctionSequence) {
              await this.sleep(correction.delay);
              if (correction.key === 'Backspace') {
                await page.keyboard.press('Backspace');
              } else {
                await page.keyboard.type(correction.key, { delay: correction.holdDuration });
              }
            }
          } else {
            await this.sleep(keystroke.delay);
            await page.keyboard.type(keystroke.key, { delay: keystroke.holdDuration });
          }
        }
        behavioral.typingDuration = sequence.reduce((sum, k) => sum + k.delay + k.holdDuration, 0);

        // Verify the field value — if the framework didn't register keystrokes, fall back to fill()
        try {
          const currentValue = await element.inputValue();
          if (currentValue !== text) {
            this.logger.warn('Typing mismatch, falling back to fill()', {
              expected: text.length,
              got: currentValue.length,
            });
            await element.fill(text);
          }
        } catch {
          // inputValue() may fail on non-input elements — that's OK
        }
      }

      // Press Enter if requested
      if (options?.pressEnter) {
        await this.sleep(200 + Math.random() * 300);
        await page.keyboard.press('Enter');
      }

      // Post-action pause
      const postPause = this.engine.generatePostActionPause();
      await this.sleep(postPause);
      behavioral.postActionPause = postPause;

      return behavioral;
    }, text, options?.importance);
  }

  async scroll(options?: ScrollOptions): Promise<ActionResult> {
    const direction = options?.direction ?? 'down';
    const amount = options?.amount ?? 300;

    return this.executeAction('scroll', options?.selector ?? 'page', async () => {
      const page = this.core.getActivePage();

      if (options?.selector) {
        const element = await this.finder.find(page, options.selector);
        await element.scrollIntoViewIfNeeded();
      }

      const scrollDir: 'up' | 'down' = (direction === 'left' || direction === 'up') ? 'up' : 'down';
      const steps = this.engine.generateScrollSteps(amount, scrollDir);
      for (const step of steps) {
        await this.sleep(step.delay);
        const deltaX = (direction === 'left' ? -step.deltaY : direction === 'right' ? step.deltaY : 0);
        const deltaY = (direction === 'up' ? -step.deltaY : direction === 'down' ? step.deltaY : 0);
        await page.mouse.wheel(deltaX, deltaY);
      }

      const postPause = this.engine.generatePostActionPause();
      await this.sleep(postPause);

      return { postActionPause: postPause } as BehavioralMetadata;
    });
  }

  async hover(selector: string, options?: HoverOptions): Promise<ActionResult> {
    return this.executeAction('hover', selector, async () => {
      const page = this.core.getActivePage();
      const element = await this.finder.find(page, selector, {
        timeout: options?.timeout ?? this.config.timeout,
        visible: true,
      });

      const box = await this.finder.getBoundingBox(element);
      if (!box) throw new Error('Element has no bounding box');

      const currentPos = await this.getMousePosition();
      const targetPos = this.engine.generateClickPosition(box);
      const behavioral = await this.performMouseMove(currentPos, targetPos);

      // Hover dwell (longer than click dwell)
      const dwell = this.engine.generateClickDwell() * 1.5;
      await this.sleep(dwell);

      return behavioral;
    });
  }

  async select(selector: string, value: string, options?: SelectOptions): Promise<ActionResult> {
    return this.executeAction('select', selector, async () => {
      const page = this.core.getActivePage();
      const element = await this.finder.find(page, selector, {
        timeout: options?.timeout ?? this.config.timeout,
      });

      // Click the select element first
      const box = await this.finder.getBoundingBox(element);
      if (!box) throw new Error('Element has no bounding box');

      const currentPos = await this.getMousePosition();
      const targetPos = this.engine.generateClickPosition(box);
      const behavioral = await this.performMouseMove(currentPos, targetPos);
      await this.sleep(this.engine.generateClickDwell());
      await page.mouse.click(targetPos.x, targetPos.y);

      // Small delay before selecting
      await this.sleep(200 + Math.random() * 300);

      // Playwright's selectOption requires ONE matcher; passing both value
      // and label means the option must match both. Try value first, fall
      // back to label for callers who pass the visible label text.
      try {
        await page.selectOption(selector, { value });
      } catch {
        await page.selectOption(selector, { label: value });
      }

      const postPause = this.engine.generatePostActionPause();
      await this.sleep(postPause);
      behavioral.postActionPause = postPause;

      return behavioral;
    }, value);
  }

  async pressKey(key: string, options?: PressKeyOptions): Promise<ActionResult> {
    return this.executeAction('pressKey', key, async () => {
      const page = this.core.getActivePage();
      await this.sleep(this.engine.generatePreActionPause() * 0.5);
      await page.keyboard.press(key);
      const postPause = this.engine.generatePostActionPause();
      await this.sleep(postPause);
      return { postActionPause: postPause } as BehavioralMetadata;
    });
  }

  async uploadFile(selector: string, filePath: string, options?: UploadFileOptions): Promise<ActionResult> {
    return this.executeAction('uploadFile', selector, async () => {
      const page = this.core.getActivePage();
      const element = await this.finder.find(page, selector, {
        timeout: options?.timeout ?? this.config.timeout,
      });

      await element.setInputFiles(filePath);

      const postPause = this.engine.generatePostActionPause();
      await this.sleep(postPause);

      return { postActionPause: postPause } as BehavioralMetadata;
    }, filePath);
  }

  /**
   * Click an element that triggers a download, wait for the download to
   * complete, save it to `saveTo`, and return metadata about the file.
   *
   * Usage:
   *   const info = await bt.download('a.invoice-link', { saveTo: './invoice.pdf' });
   *   // info.path, info.size, info.suggestedFilename, info.url
   */
  async download(
    selector: string,
    options: { saveTo: string; timeout?: number },
  ): Promise<{ path: string; size: number; suggestedFilename: string; url: string }> {
    this.ensureLaunched();
    const page = this.core.getActivePage();
    const timeout = options.timeout ?? 30_000;

    // Start waiting for the download BEFORE we click, so Playwright
    // catches the event regardless of click-to-dialog timing.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout }),
      this.click(selector, { timeout }),
    ]);

    await download.saveAs(options.saveTo);
    const path = options.saveTo;

    // Get the file size from Node's fs module.
    const fs = await import('node:fs/promises');
    const stat = await fs.stat(path);

    return {
      path,
      size: stat.size,
      suggestedFilename: download.suggestedFilename(),
      url: download.url(),
    };
  }

  // ── Data Extraction ──

  async extractText(selector: string, options?: ExtractTextOptions): Promise<string | string[]> {
    this.ensureLaunched();
    const page = this.core.getActivePage();

    if (options?.multiple) {
      const elements = await page.$$(selector);
      const texts: string[] = [];
      for (const el of elements) {
        const text = await el.innerText();
        texts.push(text);
      }
      return texts;
    }

    const element = await this.finder.find(page, selector);
    return element.innerText();
  }

  async extractAttribute(selector: string, attribute: string): Promise<string | null> {
    this.ensureLaunched();
    const page = this.core.getActivePage();
    const element = await this.finder.find(page, selector);
    return element.getAttribute(attribute);
  }

  /**
   * Find an element inside an open shadow root reachable from the page.
   * Useful for modern web component libraries (Lit, Stencil, Material Web,
   * Ionic). See `ElementFinder.findInShadowDom` for limitations on closed
   * shadow roots.
   */
  async findInShadowDom(cssSelector: string, options?: { timeout?: number }): Promise<PlaywrightElementHandle> {
    this.ensureLaunched();
    const page = this.core.getActivePage();
    return this.finder.findInShadowDom(page, cssSelector, options);
  }

  async extractTable(selector: string): Promise<Record<string, string>[]> {
    this.ensureLaunched();
    const page = this.core.getActivePage();

    return page.evaluate(`((sel) => {
      const table = document.querySelector(sel);
      if (!table) return [];

      const headers = [];
      const headerCells = table.querySelectorAll('thead th, tr:first-child th');
      headerCells.forEach((th) => headers.push(th.textContent?.trim() ?? ''));

      const rows = [];
      const bodyRows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
      bodyRows.forEach((tr) => {
        const cells = tr.querySelectorAll('td');
        if (cells.length === 0) return;
        const row = {};
        cells.forEach((td, i) => {
          const key = headers[i] ?? ('col' + i);
          row[key] = td.textContent?.trim() ?? '';
        });
        rows.push(row);
      });

      return rows;
    })(${JSON.stringify(selector)})`) as Promise<Record<string, string>[]>;
  }

  async getPageContent(options?: PageContentOptions): Promise<string> {
    this.ensureLaunched();
    return this.core.getPageContent(options);
  }

  // ── Waiting ──

  async waitFor(selector: string, options?: WaitForOptions): Promise<WaitResult> {
    this.ensureLaunched();
    const page = this.core.getActivePage();
    const start = Date.now();

    try {
      const state = options?.hidden ? 'hidden' : (options?.visible !== false ? 'visible' : 'attached');
      await page.waitForSelector(selector, {
        timeout: options?.timeout ?? 30000,
        state,
      });
      return { success: true, duration: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        duration: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async waitForNavigation(options?: WaitForNavigationOptions): Promise<void> {
    this.ensureLaunched();
    const page = this.core.getActivePage();
    await page.waitForLoadState(options?.waitUntil ?? 'domcontentloaded', {
      timeout: options?.timeout ?? 30000,
    });
  }

  // ── Screenshots ──

  async screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
    this.ensureLaunched();
    return this.core.screenshot(options);
  }

  // ── Wait primitives (v0.3) ──

  /**
   * Wait until the page has been "stable" for a configurable window.
   * Stability means: no network requests fired for `networkIdleMs`, and
   * no DOM mutations observed for `domIdleMs`. Replaces fixed sleep
   * waits with a real signal, so you don't wait longer than necessary.
   *
   * Returns an object describing how long the wait took and why it
   * completed (both-idle / network-only / dom-only / timeout).
   */
  async waitForStable(options: {
    networkIdleMs?: number;
    domIdleMs?: number;
    maxMs?: number;
    pollMs?: number;
  } = {}): Promise<{ durationMs: number; reason: string }> {
    this.ensureLaunched();
    const networkIdleMs = options.networkIdleMs ?? 500;
    const domIdleMs = options.domIdleMs ?? 500;
    const maxMs = options.maxMs ?? 10_000;
    const pollMs = options.pollMs ?? 100;
    const page = this.core.getActivePage();
    const startedAt = Date.now();

    // Set up tracking in-page. We attach a MutationObserver that records
    // the time of the last DOM mutation, and we use the Performance API
    // to find the time of the most recent network response.
    await page.evaluate(`(() => {
      if (window.__btStableTracker) return;
      const tracker = { lastDomMutation: Date.now(), observer: null };
      tracker.observer = new MutationObserver(() => { tracker.lastDomMutation = Date.now(); });
      tracker.observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true,
      });
      window.__btStableTracker = tracker;
    })()`);

    try {
      while (Date.now() - startedAt < maxMs) {
        const state = await page.evaluate(`(() => {
          const now = Date.now();
          const tracker = window.__btStableTracker;
          const domIdle = tracker ? now - tracker.lastDomMutation : 0;
          const entries = performance.getEntriesByType('resource');
          let lastNetwork = 0;
          for (let i = entries.length - 1; i >= 0 && i >= entries.length - 20; i--) {
            const e = entries[i];
            const end = e.responseEnd || e.startTime + e.duration;
            if (end > lastNetwork) lastNetwork = end;
          }
          const perfNow = performance.now();
          const networkIdle = lastNetwork === 0 ? 999999 : perfNow - lastNetwork;
          return { domIdle, networkIdle };
        })()`) as { domIdle: number; networkIdle: number };

        if (state.domIdle >= domIdleMs && state.networkIdle >= networkIdleMs) {
          return { durationMs: Date.now() - startedAt, reason: 'both-idle' };
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      return { durationMs: Date.now() - startedAt, reason: 'timeout' };
    } finally {
      await page.evaluate(`(() => {
        if (window.__btStableTracker && window.__btStableTracker.observer) {
          window.__btStableTracker.observer.disconnect();
          delete window.__btStableTracker;
        }
      })()`).catch(() => { /* page may have navigated */ });
    }
  }

  /**
   * Wait for a text string to appear in the body innerText. Case-sensitive
   * substring match by default. Use for server-rendered confirmations,
   * OCR completion messages, and similar async content.
   */
  async waitForText(text: string, options: { timeout?: number; pollMs?: number } = {}): Promise<{ durationMs: number; found: boolean }> {
    this.ensureLaunched();
    const timeout = options.timeout ?? 15_000;
    const pollMs = options.pollMs ?? 250;
    const page = this.core.getActivePage();
    const startedAt = Date.now();
    const escaped = text.replace(/\\/g, '\\\\').replace(/`/g, '\\`');

    while (Date.now() - startedAt < timeout) {
      const present = await page.evaluate(
        `(document.body ? document.body.innerText : '').includes(\`${escaped}\`)`,
      );
      if (present) return { durationMs: Date.now() - startedAt, found: true };
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { durationMs: Date.now() - startedAt, found: false };
  }

  // ── Diagnostic primitives (v0.3) ──

  /**
   * Inspect an element: exists, visible, text, tag, key attributes,
   * bounding box. One call replaces several hand-written executeJS
   * queries.
   */
  async inspect(selector: string): Promise<{
    exists: boolean;
    visible: boolean;
    tagName?: string;
    text?: string;
    attributes?: Record<string, string>;
    boundingBox?: { x: number; y: number; width: number; height: number };
  }> {
    this.ensureLaunched();
    const page = this.core.getActivePage();
    const result = await page.evaluate(
      `((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { exists: false, visible: false };
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        // Fixed/sticky elements have offsetParent === null but can still
        // be visible. The correct visibility check is: display !== none,
        // visibility !== hidden, opacity > 0, and bounding box has size.
        const visible = !!(
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          parseFloat(style.opacity || '1') > 0
        );
        const attrs = {};
        for (const a of el.attributes || []) {
          attrs[a.name] = a.value.slice(0, 200);
        }
        return {
          exists: true,
          visible: visible,
          tagName: el.tagName,
          text: (el.textContent || '').trim().slice(0, 300),
          attributes: attrs,
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      })(${JSON.stringify(selector)})`,
    );
    return result as Awaited<ReturnType<BlackTip['inspect']>>;
  }

  /**
   * List options in an Angular/React-style custom dropdown that uses
   * the `{baseId}_option-{n}` pattern. Returns `[{id, text}]`. Used
   * heavily in Anthem/Okta forms.
   *
   * If `baseId` is given, matches options whose id starts with
   * `${baseId}_option-`. Otherwise, tries to infer from the provided
   * button selector by looking for `_button` suffix.
   */
  async listOptions(buttonSelectorOrBaseId: string): Promise<{ id: string; text: string }[]> {
    this.ensureLaunched();
    const page = this.core.getActivePage();
    // Derive base id: "#foo_button" → "foo"
    let baseId = buttonSelectorOrBaseId;
    if (baseId.startsWith('#')) baseId = baseId.slice(1);
    if (baseId.endsWith('_button')) baseId = baseId.slice(0, -7);

    const list = await page.evaluate(
      `((base) => {
        const prefix = base + '_option-';
        const els = document.querySelectorAll('[id^="' + prefix + '"]');
        const out = [];
        for (const el of els) {
          const id = el.id;
          if (id.endsWith('_text')) continue;
          out.push({ id, text: (el.textContent || '').trim().slice(0, 200) });
        }
        return out;
      })(${JSON.stringify(baseId)})`,
    );
    return list as { id: string; text: string }[];
  }

  /**
   * Return Performance API resource entries since `sinceMs` milliseconds
   * ago, optionally filtered by a substring or regex match on the URL.
   */
  async networkSince(sinceMs: number, pattern?: string | RegExp): Promise<{ name: string; startTime: number; durationMs: number }[]> {
    this.ensureLaunched();
    const page = this.core.getActivePage();
    const patternSource = pattern instanceof RegExp ? pattern.source : pattern ?? '';
    const isRegex = pattern instanceof RegExp;
    const results = await page.evaluate(
      `((sinceMs, patternSource, isRegex) => {
        const re = patternSource ? (isRegex ? new RegExp(patternSource) : null) : null;
        const entries = performance.getEntriesByType('resource');
        const cutoff = performance.now() - sinceMs;
        const out = [];
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (e.startTime < cutoff) break;
          if (patternSource) {
            const match = re ? re.test(e.name) : e.name.includes(patternSource);
            if (!match) continue;
          }
          out.push({
            name: e.name,
            startTime: Math.round(e.startTime),
            durationMs: Math.round(e.duration),
          });
        }
        return out.reverse();
      })(${JSON.stringify(sinceMs)}, ${JSON.stringify(patternSource)}, ${JSON.stringify(isRegex)})`,
    );
    return results as { name: string; startTime: number; durationMs: number }[];
  }

  /**
   * Boolean convenience: did a network request matching `pattern` fire
   * in the last `sinceMs` milliseconds? Critical for "did my submit
   * actually reach the server?" diagnostics.
   */
  async didRequestFireSince(pattern: string | RegExp, sinceMs: number): Promise<boolean> {
    const matches = await this.networkSince(sinceMs, pattern);
    return matches.length > 0;
  }

  /**
   * Proactively hide fixed/sticky overlays that commonly block clicks:
   * chat widgets, cookie banners, "we value your feedback" modals,
   * cookie consent, newsletter signups. Returns the count of hidden
   * elements and a list of CSS selectors that were affected.
   */
  async dismissOverlays(): Promise<{ hidden: number; selectors: string[] }> {
    this.ensureLaunched();
    const page = this.core.getActivePage();
    return page.evaluate(`(() => {
      const PATTERNS = [
        '[class*="chat-widget"]', '[class*="ChatWidget"]', '[class*="chat-bubble"]',
        '[class*="intercom"]', '[id*="intercom"]',
        '[class*="drift-frame"]', '[class*="zendesk"]', '[class*="zopim"]',
        '[class*="cookie-banner"]', '[class*="cookie-consent"]', '[class*="cookieBanner"]',
        '[class*="consent-banner"]', '[id*="cookie"]',
        '[class*="onetrust"]', '[id*="onetrust"]',
        '[class*="newsletter-modal"]', '[class*="newsletter-popup"]',
        '[class*="feedback-widget"]', '[id*="medallia"]', '[class*="medallia"]',
        '[class*="notification-banner"]',
      ];
      const hiddenSelectors = [];
      let count = 0;
      for (const sel of PATTERNS) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const style = window.getComputedStyle(el);
          if (style.position === 'fixed' || style.position === 'sticky' || style.position === 'absolute') {
            el.style.setProperty('display', 'none', 'important');
            count++;
          }
        }
        if (count > 0) hiddenSelectors.push(sel);
      }
      return { hidden: count, selectors: hiddenSelectors };
    })()`) as Promise<{ hidden: number; selectors: string[] }>;
  }

  // ── Stealth diagnostics (v0.2.0) ──

  /**
   * Capture the active session's TLS, HTTP/2, and HTTP header fingerprint
   * by navigating to tls.peet.ws/api/all and httpbin.org/headers.
   *
   * The most important field in the result is `headers.uaConsistent`. If
   * that's `false`, you're emitting a User-Agent / Sec-Ch-Ua mismatch
   * which Akamai / DataDome / PerimeterX will flag as a textbook spoofing
   * tell. v0.2.0 fixed this for the default config; if you see it, your
   * code is overriding the User-Agent in a way that doesn't update the
   * client hint headers in lockstep.
   */
  async captureFingerprint(): Promise<FingerprintSnapshot> {
    this.ensureLaunched();
    return diagnosticsCaptureFingerprint(this);
  }

  /**
   * Query the active session's egress IP and ASN, score it against
   * known datacenter / residential ASN patterns, and return a structured
   * result. Uses the free ipinfo.io endpoint.
   *
   * If `isDatacenter: true`, your IP is on a known cloud provider's
   * range and Akamai will almost certainly flag it. Use a residential
   * proxy or a different network.
   */
  async checkIpReputation(): Promise<IpReputationResult> {
    this.ensureLaunched();
    return diagnosticsCheckIpReputation(this);
  }

  /**
   * Visit an Akamai-protected URL and report the result with diagnosis.
   * Recognizes the Akamai Access Denied error page format and extracts
   * the reference number for triage.
   *
   * Use this in CI as a regression check, or interactively when you're
   * trying to figure out why a specific target is blocking you.
   */
  async testAgainstAkamai(url: string): Promise<AkamaiTestResult> {
    this.ensureLaunched();
    return diagnosticsTestAgainstAkamai(this, url);
  }

  // ── Session warming (v0.2.0) ──

  /**
   * Visit a sequence of "normal" sites with realistic dwell times before
   * the target navigation. Accumulates cookies, populates History API,
   * and triggers the natural behavioral signals Akamai's profiler
   * expects to see from a real user.
   *
   * Default sites are a small list of safe, fast-loading targets that
   * don't run heavy detection themselves. Override `sites` to use your
   * own list, e.g. industry-specific sites for the target you're warming
   * up against.
   *
   * Pass an empty `sites: []` array to skip warming and just dwell on
   * the current page (useful as a "let the page settle" pause).
   */
  async warmSession(options: {
    sites?: string[];
    dwellMsRange?: [number, number];
  } = {}): Promise<{ visited: string[]; durationMs: number }> {
    this.ensureLaunched();
    const sites = options.sites ?? [
      'https://www.google.com/',
      'https://en.wikipedia.org/wiki/Special:Random',
      'https://news.ycombinator.com/',
    ];
    const [dwellMin, dwellMax] = options.dwellMsRange ?? [3000, 7000];
    const startedAt = Date.now();
    const visited: string[] = [];

    for (const url of sites) {
      try {
        await this.navigate(url);
        // Random dwell to mimic human reading time
        const dwell = Math.floor(dwellMin + Math.random() * (dwellMax - dwellMin));
        // Simulate a small scroll during dwell — humans don't sit still
        try {
          await this.scroll({ direction: 'down', amount: 200 + Math.floor(Math.random() * 400) });
        } catch { /* scroll may fail on some pages, harmless */ }
        await this.sleep(dwell);
        visited.push(url);
      } catch (err) {
        this.logger.warn('warmSession site failed, continuing', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { visited, durationMs: Date.now() - startedAt };
  }

  // ── Iframe Support ──

  async frame(selector: string): Promise<BlackTipFrame> {
    this.ensureLaunched();
    const frame = await this.core.getFrame(selector);
    return new BlackTipFrame(frame, this.engine, this.finder, this.logger);
  }

  async frames(): Promise<FrameInfo[]> {
    this.ensureLaunched();
    return this.core.getFrames();
  }

  // ── Tab Management ──

  async getTabs(): Promise<TabInfo[]> {
    return this.core.getTabs();
  }

  async newTab(url?: string): Promise<number> {
    return this.core.newTab(url);
  }

  async switchTab(index: number): Promise<void> {
    return this.core.switchTab(index);
  }

  async closeTab(index?: number): Promise<void> {
    return this.core.closeTab(index);
  }

  // ── Session Management ──

  async newContext(): Promise<void> {
    return this.core.newContext();
  }

  async cookies() {
    return this.core.cookies();
  }

  async setCookies(cookies: { name: string; value: string; domain: string; path: string; url?: string }[]) {
    return this.core.setCookies(cookies);
  }

  async clearCookies() {
    return this.core.clearCookies();
  }

  // ── JavaScript Execution ──

  async executeJS(script: string): Promise<unknown> {
    this.ensureLaunched();
    return this.core.executeJS(script);
  }

  // ── Profile Management ──

  createProfile(name: string, config: Partial<ProfileConfig>): void {
    const base = HUMAN_PROFILE;
    this.customProfiles.set(name, { ...base, ...config });
  }

  getProfile(name: string): ProfileConfig {
    return this.resolveProfile(name);
  }

  listProfiles(): string[] {
    return ['human', 'scraper', ...this.customProfiles.keys()];
  }

  deleteProfile(name: string): void {
    if (name === 'human' || name === 'scraper') {
      throw new Error('Cannot delete built-in profiles');
    }
    this.customProfiles.delete(name);
  }

  // ── Pool Factory ──

  /**
   * Returns detailed usage instructions for AI agents.
   * Call this on first use to understand how to drive BlackTip correctly.
   */
  static agentGuide(): string {
    return `
BlackTip Agent Guide
====================

BlackTip is a stealth browser instrument. YOU are the agent — BlackTip provides
the hands, you provide the brain. Every action is wrapped in human-like behavior
that defeats bot detection.

CRITICAL RULES:

1. READ INPUT DOCUMENTS FIRST — If the user gives you a PDF/file to submit,
   read it BEFORE starting the browser. Extract names, dates, codes. Never guess.

2. SCREENSHOT BEFORE EVERY DECISION — After each action, take a screenshot
   (bt.screenshot({path:'shot.png'})) and examine it before deciding the next
   step. Do NOT pre-script sequences.

3. USE clickText() FOR VISIBLE TEXT — bt.clickText("Submit", {nth: 0}) uses
   Playwright's locator API. Works with React, Angular, Okta, and custom
   components. Prefer this over bt.click() with CSS selectors when the text
   is visible on the page.

4. USE paste:true FOR FORMS — bt.type(selector, text, {paste: true}) is fast
   and works with React/Angular synthetic events. Use this for form filling.

5. USE executeJS() TO INSPECT — When selectors are unclear, inspect the DOM:
   await bt.executeJS("JSON.stringify([...document.querySelectorAll('button')].map(b=>b.textContent.trim()))")

6. ANGULAR/CUSTOM DROPDOWNS — These are NOT <select> elements. Pattern:
   - Click the combobox button: bt.click("#dropdown_button")
   - Inspect options via executeJS
   - Click the option: bt.click("#dropdown_option-0")

7. FAIL FAST — Use timeout: 10000 and retryAttempts: 2. If an action fails,
   inspect the page rather than retrying for minutes.

8. ASK THE USER WHEN UNCERTAIN — Don't guess patient names, account types, or
   form selections. Ask.

SERVER MODE (recommended):
  const bt = new BlackTip({ timeout: 10000, retryAttempts: 2 });
  await bt.serve(9779);
  // Then send commands via TCP: bt.send("await bt.navigate('...')")

AVAILABLE METHODS:
  bt.navigate(url)                    — Go to URL
  bt.click(selector)                  — Click by CSS/XPath
  bt.clickText(text, {nth?, exact?})  — Click by visible text
  bt.clickRole(role, {name?})         — Click by ARIA role
  bt.type(selector, text, {paste?})   — Type into input
  bt.scroll({direction, amount})      — Scroll page
  bt.screenshot({path})               — Capture page
  bt.waitFor(selector, {timeout})     — Wait for element
  bt.extractText(selector)            — Get text content
  bt.executeJS(script)                — Run JS in page
  bt.uploadFile(selector, path)       — Upload file
  bt.frame(selector)                  — Iframe context
  bt.serve(port)                      — Start TCP server

COMMON MISTAKES (don't repeat):
  - Pre-scripting entire flows (breaks on first unexpected state)
  - Using executeJS("el.click()") for React/Okta buttons (use clickText)
  - Not reading screenshots between actions
  - Guessing form values instead of reading source documents
  - Long timeouts (30s+) — fail fast, inspect, adapt
`.trim();
  }

  static async pool(count: number, config?: BlackTipConfig): Promise<BlackTip[]> {
    const instances: BlackTip[] = [];
    for (let i = 0; i < count; i++) {
      const bt = new BlackTip(config);
      await bt.launch();
      instances.push(bt);
    }
    return instances;
  }

  // ── Server Mode ──

  /**
   * Start a TCP command server. Agents connect and send JS commands that
   * execute with `bt` in scope. Each command returns a result and saves
   * a screenshot to `screenshotPath`.
   *
   * Usage from CLI: node -e "net.createConnection(port).write('await bt.click(\"#btn\")\n__END__\n')"
   * Or use the built-in CLI: npx blacktip serve
   */
  async serve(port = 9779, screenshotPath = 'shot.png'): Promise<Server> {
    if (!this.launched) await this.launch();

    const DELIM = '\n__END__\n';
    const bt = this;

    // Pause registry: when a command inside fn() calls bt.pauseForInput(),
    // it registers a pending entry and returns a promise that resolves
    // when a subsequent RESUME command provides the value. The serve
    // handler listens for 'btPause' events (emitted by pauseForInput)
    // and forwards them to the socket so the client knows to prompt the
    // user.
    const pending = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void; prompt: string }>();
    (bt as unknown as { _pauseRegistry: typeof pending })._pauseRegistry = pending;

    const server = createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString();
        while (buf.includes(DELIM)) {
          const idx = buf.indexOf(DELIM);
          const cmd = buf.slice(0, idx);
          buf = buf.slice(idx + DELIM.length);
          void handleCommand(cmd, socket);
        }
      });
    });

    async function buildBundle(result: unknown, startedAt: number, includeScreenshot: boolean): Promise<Record<string, unknown>> {
      const bundle: Record<string, unknown> = {
        ok: true,
        durationMs: Date.now() - startedAt,
      };
      if (result !== undefined) bundle.result = result;
      try {
        const page = bt.core.getActivePage();
        bundle.url = page.url();
        try {
          bundle.title = await page.title();
        } catch { /* title may fail on about:blank */ }
      } catch { /* browser may be closed */ }
      if (includeScreenshot) {
        try {
          const shot = await bt.screenshot({ path: screenshotPath });
          bundle.screenshotPath = screenshotPath;
          bundle.screenshotB64 = shot.data.toString('base64');
          bundle.screenshotBytes = shot.data.length;
        } catch { /* screenshot may fail */ }
      }
      return bundle;
    }

    async function handleCommand(cmd: string, socket: import('node:net').Socket) {
      const startedAt = Date.now();
      try {
        if (cmd === 'QUIT') {
          socket.write('bye' + DELIM);
          await bt.close();
          server.close();
          return;
        }

        // RESUME protocol: "RESUME <id>\n<value>" resolves a pending pause.
        if (cmd.startsWith('RESUME ')) {
          const rest = cmd.slice(7);
          const newlineIdx = rest.indexOf('\n');
          const id = newlineIdx === -1 ? rest.trim() : rest.slice(0, newlineIdx).trim();
          const value = newlineIdx === -1 ? '' : rest.slice(newlineIdx + 1);
          const entry = pending.get(id);
          if (entry) {
            pending.delete(id);
            entry.resolve(value);
            socket.write(JSON.stringify({ ok: true, resumed: id }) + DELIM);
          } else {
            socket.write(JSON.stringify({ ok: false, error: `No pending pause with id ${id}` }) + DELIM);
          }
          return;
        }

        // LIST_PENDING protocol: returns current paused commands.
        if (cmd === 'LIST_PENDING') {
          const list = [...pending.entries()].map(([id, e]) => ({ id, prompt: e.prompt }));
          socket.write(JSON.stringify({ ok: true, pending: list }) + DELIM);
          return;
        }

        // BATCH protocol: "BATCH\n<json array of command strings>" runs
        // each command sequentially and returns an array of bundles.
        if (cmd.startsWith('BATCH\n')) {
          const jsonPart = cmd.slice(6);
          let commands: string[];
          try {
            commands = JSON.parse(jsonPart) as string[];
          } catch {
            socket.write(JSON.stringify({ ok: false, error: 'BATCH payload must be a JSON array of command strings' }) + DELIM);
            return;
          }
          const bundles: Record<string, unknown>[] = [];
          for (const c of commands) {
            const perStart = Date.now();
            try {
              const fn = new Function('bt', `return (async () => { ${c} })();`);
              const result = await fn(bt);
              bundles.push(await buildBundle(result, perStart, true));
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              const errBundle = await buildBundle(undefined, perStart, true);
              errBundle.ok = false;
              errBundle.error = msg;
              bundles.push(errBundle);
              // Stop on first failure — caller can see what failed.
              break;
            }
          }
          socket.write(JSON.stringify({ ok: true, bundles }) + DELIM);
          return;
        }

        // Listen for pause events emitted by pauseForInput during the
        // command's execution. Forward them to the client as separate
        // JSON frames; the client sends RESUME to continue.
        const pauseListener = (info: { id: string; prompt: string }): void => {
          socket.write(JSON.stringify({
            ok: true,
            paused: true,
            pauseId: info.id,
            prompt: info.prompt,
          }) + DELIM);
        };
        bt.on('btPause', pauseListener);

        try {
          const fn = new Function('bt', `return (async () => { ${cmd} })();`);
          const result = await fn(bt);
          const bundle = await buildBundle(result, startedAt, true);
          socket.write(JSON.stringify(bundle) + DELIM);
        } finally {
          bt.off('btPause', pauseListener);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const errBundle: Record<string, unknown> = await buildBundle(undefined, startedAt, true)
          .catch(() => ({ ok: false } as Record<string, unknown>));
        errBundle.ok = false;
        errBundle.error = msg;
        socket.write(JSON.stringify(errBundle) + DELIM);
      }
    }

    return new Promise((resolve) => {
      server.listen(port, '127.0.0.1', () => {
        this.logger.info(`BlackTip server listening on port ${port}`);
        resolve(server);
      });
    });
  }

  /**
   * Pause execution inside a command and wait for a value to be sent via
   * the RESUME protocol. Only usable when running under serve mode.
   *
   * Usage (from agent side):
   *   const value = await bt.pauseForInput({ prompt: "Enter SMS code" });
   *   await bt.type('input[name="credentials.passcode"]', value, { paste: true });
   *
   * The serve mode forwards a `{paused:true, pauseId, prompt}` frame to
   * the client. When the client sends `RESUME <id>\n<value>`, this call
   * resolves with the value. If `validate` is provided and the value
   * doesn't match, the call rejects with a validation error.
   */
  async pauseForInput(options: {
    prompt: string;
    validate?: RegExp | ((v: string) => boolean);
    timeoutMs?: number;
  }): Promise<string> {
    type RegistryEntry = { resolve: (v: string) => void; reject: (e: Error) => void; prompt: string };
    const registry = (this as unknown as { _pauseRegistry?: Map<string, RegistryEntry> })._pauseRegistry;
    if (!registry) {
      throw new Error('pauseForInput can only be called while running under serve mode');
    }
    const id = `pause-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const waitPromise = new Promise<string>((resolve, reject) => {
      registry.set(id, { resolve, reject, prompt: options.prompt });

      if (options.timeoutMs) {
        setTimeout(() => {
          if (registry.has(id)) {
            registry.delete(id);
            reject(new Error(`pauseForInput timed out after ${options.timeoutMs}ms`));
          }
        }, options.timeoutMs);
      }
    });

    // Signal the serve handler to forward a pause frame to the client.
    this.emit('btPause', { id, prompt: options.prompt });

    const value = await waitPromise;

    // Validate if requested.
    if (options.validate) {
      const valid = typeof options.validate === 'function'
        ? options.validate(value)
        : options.validate.test(value);
      if (!valid) {
        throw new Error(`pauseForInput received invalid value: ${value}`);
      }
    }

    return value;
  }

  // ── Internal: Action Execution with Retry ──

  private async executeAction(
    actionName: string,
    target: string,
    fn: () => Promise<BehavioralMetadata>,
    value?: string,
    importance?: import('./behavioral-engine.js').ActionImportance,
  ): Promise<ActionResult> {
    this.ensureLaunched();

    const maxAttempts = this.config.retryAttempts ?? 5;
    const start = Date.now();
    let lastError = '';

    // Pre-action pause — scaled by the caller's importance hint so
    // submit/payment/confirm actions get the long-tail hesitation that
    // behavioral biometrics systems expect to see.
    const preActionPause = this.engine.generatePreActionPause(importance ?? 'normal');
    await this.sleep(preActionPause);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const strategy = RETRY_STRATEGIES[Math.min(attempt - 1, RETRY_STRATEGIES.length - 1)]!;

      try {
        // Apply retry strategy
        if (attempt > 1) {
          await this.applyRetryStrategy(strategy);

          this.emit('retry', {
            timestamp: new Date().toISOString(),
            action: actionName,
            target,
            attempt,
            maxAttempts,
            strategy,
            error: lastError,
          } satisfies RetryEvent);
        }

        const behavioral = await fn();
        const duration = Date.now() - start;

        const event: ActionEvent = {
          timestamp: new Date().toISOString(),
          action: actionName,
          target,
          value,
          outcome: 'success',
          duration,
          retries: attempt - 1,
          behavioral: {
            preActionPause,
            ...behavioral,
          },
        };
        this.emit('action', event);

        return {
          success: true,
          duration,
          retries: attempt - 1,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Action ${actionName} failed (attempt ${attempt}/${maxAttempts})`, {
          target,
          error: lastError,
          strategy,
        });
      }
    }

    // All retries exhausted
    const duration = Date.now() - start;
    const page = this.core.getActivePage();
    let screenshot: Buffer | undefined;
    try {
      screenshot = await page.screenshot();
    } catch { /* screenshot may fail if browser crashed */ }

    const errorEvent: ErrorEvent = {
      timestamp: new Date().toISOString(),
      code: 'ELEMENT_NOT_FOUND',
      message: lastError,
      url: page.url(),
      action: actionName,
      attempts: maxAttempts,
      screenshot,
    };
    this.emit('error', errorEvent);

    const event: ActionEvent = {
      timestamp: new Date().toISOString(),
      action: actionName,
      target,
      value,
      outcome: 'failure',
      duration,
      retries: maxAttempts - 1,
      error: lastError,
    };
    this.emit('action', event);

    return {
      success: false,
      duration,
      retries: maxAttempts - 1,
      error: lastError,
      errorCode: 'ELEMENT_NOT_FOUND',
    };
  }

  private async applyRetryStrategy(strategy: RetryStrategy): Promise<void> {
    const page = this.core.getActivePage();

    switch (strategy) {
      case 'standard':
        // Just retry
        break;
      case 'wait':
        await this.sleep(2000 + Math.random() * 3000);
        break;
      case 'reload':
        await page.reload({ waitUntil: 'domcontentloaded' });
        await this.sleep(1000);
        break;
      case 'altSelector':
        // The element finder will try alternative strategies on next attempt
        break;
      case 'scroll':
        await page.mouse.wheel(0, 300);
        await this.sleep(500);
        break;
      case 'clearOverlays':
        // Try to dismiss common overlays
        await page.evaluate(`(() => {
          const overlays = document.querySelectorAll('[class*="overlay"], [class*="modal"], [class*="popup"], [class*="cookie"], [class*="banner"]');
          overlays.forEach((el) => {
            const style = window.getComputedStyle(el);
            if (style.position === 'fixed' || style.position === 'sticky') {
              el.style.display = 'none';
            }
          });
        })()`);
        await this.sleep(500);
        break;
    }
  }

  // ── Internal: Mouse Movement ──

  private mouseX = 0;
  private mouseY = 0;

  private async getMousePosition(): Promise<{ x: number; y: number }> {
    return { x: this.mouseX, y: this.mouseY };
  }

  private async performMouseMove(from: { x: number; y: number }, to: { x: number; y: number }): Promise<BehavioralMetadata> {
    const page = this.core.getActivePage();
    const steps = this.engine.generateMousePath(from, to);
    const moveStart = Date.now();

    let pathLength = 0;
    let prevPoint = from;

    for (const step of steps) {
      await this.sleep(step.delay);
      await page.mouse.move(step.x, step.y);

      // Calculate path length
      const dx = step.x - prevPoint.x;
      const dy = step.y - prevPoint.y;
      pathLength += Math.sqrt(dx * dx + dy * dy);
      prevPoint = step;
    }

    this.mouseX = to.x;
    this.mouseY = to.y;

    return {
      mousePathLength: Math.round(pathLength),
      mouseMoveDuration: Date.now() - moveStart,
    };
  }

  // ── Internal: Utilities ──

  private resolveProfile(nameOrConfig: string | ProfileConfig): ProfileConfig {
    if (typeof nameOrConfig === 'object') return nameOrConfig;

    switch (nameOrConfig) {
      case 'human': return HUMAN_PROFILE;
      case 'scraper': return SCRAPER_PROFILE;
      default: {
        const custom = this.customProfiles.get(nameOrConfig);
        if (custom) return custom;
        this.logger.warn(`Unknown profile "${nameOrConfig}", falling back to "human"`);
        return HUMAN_PROFILE;
      }
    }
  }

  private ensureLaunched(): void {
    if (!this.launched) {
      throw new Error('Browser not launched. Call launch() first.');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms))));
  }
}

/**
 * Frame context — same action methods as BlackTip, scoped to an iframe.
 */
export class BlackTipFrame {
  constructor(
    private frame: Frame,
    private engine: BehavioralEngine,
    private finder: ElementFinder,
    private logger: Logger,
  ) {}

  async click(selector: string, options?: ClickOptions): Promise<ActionResult> {
    const start = Date.now();
    const element = await this.finder.find(this.frame, selector, { visible: true });
    const box = await this.finder.getBoundingBox(element);
    if (!box) throw new Error('Element has no bounding box');

    const targetPos = this.engine.generateClickPosition(box);

    // Human-like pause before click
    await this.sleep(this.engine.generatePreActionPause());
    const dwell = this.engine.generateClickDwell();
    await this.sleep(dwell);

    await element.click({
      button: options?.button ?? 'left',
      clickCount: options?.count ?? 1,
    });

    await this.sleep(this.engine.generatePostActionPause());

    return { success: true, duration: Date.now() - start, retries: 0 };
  }

  async type(selector: string, text: string, options?: TypeOptions): Promise<ActionResult> {
    const start = Date.now();
    const element = await this.finder.find(this.frame, selector, { visible: true });

    // Click element first to give it focus
    await element.click();
    await this.sleep(this.engine.generatePreActionPause() * 0.3);

    // Ported L001 fix from BlackTip.type(): use Control+A+Backspace via the
    // page-level keyboard (rather than element.fill('') which can fire a
    // premature change event in some frameworks), and use the frame's
    // native keyboard.type which dispatches the full keydown/keypress/
    // input/keyup cycle — the input event is what React/Angular listen
    // for inside iframes like Stripe Elements and Braintree Hosted Fields.
    const pageForKeyboard = this.frame.page();

    if (options?.clearFirst) {
      await pageForKeyboard.keyboard.press('Control+a');
      await this.sleep(30 + Math.random() * 50);
      await pageForKeyboard.keyboard.press('Backspace');
      await this.sleep(50);
    }

    const shouldPaste = options?.paste ?? this.engine.shouldPaste(text);

    if (shouldPaste) {
      // Fill path: Playwright's fill correctly dispatches input events on
      // form controls, even inside cross-origin iframes. Fast path for
      // paste-threshold text.
      await element.fill(text);
      await this.sleep(100 + Math.random() * 200);
    } else {
      // Keystroke path: clear via Control+A+Backspace (framework-safe) then
      // use page.keyboard.type which fires the full event cycle per char.
      await pageForKeyboard.keyboard.press('Control+a');
      await this.sleep(30 + Math.random() * 50);
      await pageForKeyboard.keyboard.press('Backspace');
      await this.sleep(50);

      const sequence = this.engine.generateTypingSequence(text);
      for (const keystroke of sequence) {
        if (keystroke.isTypo && keystroke.correctionSequence) {
          await pageForKeyboard.keyboard.type(keystroke.key, { delay: keystroke.holdDuration });
          for (const correction of keystroke.correctionSequence) {
            await this.sleep(correction.delay);
            if (correction.key === 'Backspace') {
              await pageForKeyboard.keyboard.press('Backspace');
            } else {
              await pageForKeyboard.keyboard.type(correction.key, { delay: correction.holdDuration });
            }
          }
        } else {
          await this.sleep(keystroke.delay);
          await pageForKeyboard.keyboard.type(keystroke.key, { delay: keystroke.holdDuration });
        }
      }

      // Verify value — fall back to fill() if framework didn't register.
      // Same safety net as BlackTip.type(): if Stripe's element.js intercepts
      // keyboard events and doesn't update the underlying input, fill()
      // forces the value through via the DOM setter.
      try {
        const val = await element.inputValue();
        if (val !== text) await element.fill(text);
      } catch { /* non-input elements */ }
    }

    if (options?.pressEnter) {
      await this.sleep(200 + Math.random() * 300);
      await element.press('Enter');
    }

    return { success: true, duration: Date.now() - start, retries: 0 };
  }

  async extractText(selector: string): Promise<string> {
    const element = await this.finder.find(this.frame, selector);
    return element.innerText();
  }

  async hover(selector: string): Promise<ActionResult> {
    const start = Date.now();
    const element = await this.finder.find(this.frame, selector, { visible: true });
    await this.sleep(this.engine.generatePreActionPause());
    await element.hover();
    await this.sleep(this.engine.generateClickDwell());
    return { success: true, duration: Date.now() - start, retries: 0 };
  }

  async select(selector: string, value: string): Promise<ActionResult> {
    const start = Date.now();
    await this.frame.selectOption(selector, { value, label: value });
    return { success: true, duration: Date.now() - start, retries: 0 };
  }

  async waitFor(selector: string, options?: WaitForOptions): Promise<WaitResult> {
    const start = Date.now();
    try {
      await this.frame.waitForSelector(selector, {
        timeout: options?.timeout ?? 30000,
        state: options?.visible !== false ? 'visible' : 'attached',
      });
      return { success: true, duration: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        duration: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms))));
  }
}
