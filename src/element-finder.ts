import type { Page, Frame, ElementHandle as PlaywrightElement } from 'patchright';
import type { Logger } from './logging.js';
import type { BoundingBox } from './types.js';

const CSS_TAG_NAMES = new Set([
  // Structural
  'div', 'span', 'section', 'article', 'aside', 'nav', 'header', 'footer',
  'main', 'body', 'html', 'details', 'summary', 'dialog',
  // Text
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
  'em', 'strong', 'small', 'mark', 'time',
  // Lists & tables
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  // Forms
  'form', 'input', 'textarea', 'select', 'option', 'optgroup', 'button', 'label',
  'fieldset', 'legend', 'datalist', 'output', 'meter', 'progress',
  // Media & embeds
  'img', 'picture', 'video', 'audio', 'canvas', 'svg', 'iframe', 'embed',
  'object', 'source', 'track', 'map', 'area',
  // Interactive
  'a',
]);

const CSS_INDICATOR_CHARS = ['.', '#', '[', '>', ':', '+', '~', '=', '*'];

/**
 * Per-strategy timeout — short so we fail fast and try the next strategy.
 * The overall timeout is the caller's budget; individual strategies get a slice.
 */
const STRATEGY_TIMEOUT_MS = 3000;

export class ElementFinder {
  constructor(private logger: Logger) {}

  async find(
    pageOrFrame: Page | Frame,
    selector: string,
    options?: { timeout?: number; visible?: boolean },
  ): Promise<PlaywrightElement> {
    const overallTimeout = options?.timeout ?? 15_000;
    const visible = options?.visible ?? false;
    const state = visible ? 'visible' : 'attached';
    const triedStrategies: string[] = [];
    const deadline = Date.now() + overallTimeout;

    // Helper: time remaining, capped to per-strategy max
    const strategyTimeout = () => Math.min(STRATEGY_TIMEOUT_MS, Math.max(500, deadline - Date.now()));

    // 1. CSS selector — if input looks like one
    if (this.looksLikeSelector(selector)) {
      try {
        const el = await pageOrFrame.waitForSelector(selector, { timeout: strategyTimeout(), state });
        if (el) {
          this.logger.info('Element found via CSS selector', { selector });
          return el;
        }
      } catch {
        triedStrategies.push('CSS');
        this.logger.debug('CSS strategy failed', { selector });
      }
      if (Date.now() >= deadline) throw this.notFound(selector, triedStrategies);
    }

    // 2. XPath
    if (this.looksLikeXPath(selector)) {
      try {
        const el = await pageOrFrame.waitForSelector(`xpath=${selector}`, { timeout: strategyTimeout(), state });
        if (el) {
          this.logger.info('Element found via XPath', { selector });
          return el;
        }
      } catch {
        triedStrategies.push('XPath');
        this.logger.debug('XPath strategy failed', { selector });
      }
      if (Date.now() >= deadline) throw this.notFound(selector, triedStrategies);
    }

    // 3. Label association — runs BEFORE text match so that searching by
    //    a label's visible text returns the associated input, not the label
    //    element itself. Uses Playwright's getByLabel which handles for=,
    //    nested inputs, and aria-labelledby uniformly.
    try {
      const locator = (pageOrFrame as Page).getByLabel(selector, { exact: true }).first();
      await locator.waitFor({ state, timeout: strategyTimeout() });
      const handle = await locator.elementHandle();
      if (handle) {
        this.logger.info('Element found via label association', { selector });
        return handle;
      }
    } catch {
      triedStrategies.push('label');
    }
    if (Date.now() >= deadline) throw this.notFound(selector, triedStrategies);

    // 4. Exact text match
    try {
      const el = await pageOrFrame.waitForSelector(`text="${selector}"`, { timeout: strategyTimeout(), state });
      if (el) {
        this.logger.info('Element found via exact text', { selector });
        return el;
      }
    } catch {
      triedStrategies.push('exact text');
    }
    if (Date.now() >= deadline) throw this.notFound(selector, triedStrategies);

    // 5. Case-insensitive text match
    try {
      const el = await pageOrFrame.waitForSelector(`text=${selector}`, { timeout: strategyTimeout(), state });
      if (el) {
        this.logger.info('Element found via text (case-insensitive)', { selector });
        return el;
      }
    } catch {
      triedStrategies.push('text (case-insensitive)');
    }
    if (Date.now() >= deadline) throw this.notFound(selector, triedStrategies);

    // 6. ARIA label
    try {
      const el = await pageOrFrame.waitForSelector(`[aria-label="${selector}"]`, { timeout: strategyTimeout(), state });
      if (el) {
        this.logger.info('Element found via ARIA label', { selector });
        return el;
      }
    } catch {
      triedStrategies.push('ARIA label');
    }
    if (Date.now() >= deadline) throw this.notFound(selector, triedStrategies);

    // 7. ARIA role (button)
    try {
      const el = await pageOrFrame.waitForSelector(`role=button[name="${selector}"]`, { timeout: strategyTimeout(), state });
      if (el) {
        this.logger.info('Element found via ARIA role', { selector });
        return el;
      }
    } catch {
      triedStrategies.push('ARIA role');
    }

    throw this.notFound(selector, triedStrategies);
  }

  async findInFrames(
    page: Page,
    selector: string,
    options?: { timeout?: number; visible?: boolean },
  ): Promise<{ element: PlaywrightElement; frame: Page | Frame }> {
    try {
      const element = await this.find(page, selector, options);
      return { element, frame: page };
    } catch {
      this.logger.debug('Not found on main page, searching iframes...', { selector });
    }

    const frames = page.frames();
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      try {
        const element = await this.find(frame, selector, { ...options, timeout: 3000 });
        this.logger.info('Element found in iframe', { selector, frameUrl: frame.url() });
        return { element, frame };
      } catch {
        // continue to next iframe
      }
    }

    throw new Error(
      `Element not found in any frame: "${selector}". Searched main page and ${frames.length - 1} iframe(s).`,
    );
  }

  private looksLikeSelector(input: string): boolean {
    const trimmed = input.trim();
    if (!trimmed) return false;
    if (CSS_INDICATOR_CHARS.some((ch) => trimmed.includes(ch))) return true;
    const firstWord = trimmed.split(/[\s.[#:>+~]/, 1)[0]!.toLowerCase();
    return CSS_TAG_NAMES.has(firstWord);
  }

  private looksLikeXPath(input: string): boolean {
    const trimmed = input.trim();
    return trimmed.startsWith('/') || trimmed.startsWith('//');
  }

  async getBoundingBox(element: PlaywrightElement): Promise<BoundingBox | null> {
    await element.scrollIntoViewIfNeeded().catch(() => {});
    const box = await element.boundingBox();
    return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
  }

  /**
   * Find an element inside any open shadow root reachable from the document.
   *
   * Recursively walks the DOM and each encountered `shadowRoot`, testing
   * CSS selector matches at every level. Modern component libraries
   * (Lit, Stencil, Material Web Components, Ionic) wrap everything in
   * shadow DOM, and Playwright's default CSS engine sometimes misses
   * deeply-nested selectors. This walker is explicit and predictable.
   *
   * LIMITATION: closed shadow roots are opaque to JavaScript by design.
   * Elements inside `attachShadow({mode: 'closed'})` are not reachable
   * by any JS-only method; reaching them requires CDP `DOM.describeNode`
   * with `pierce: true`, which is outside this method's scope. Open
   * shadow roots (the overwhelming majority in practice) are fully
   * supported.
   */
  async findInShadowDom(
    pageOrFrame: Page | Frame,
    cssSelector: string,
    options?: { timeout?: number },
  ): Promise<PlaywrightElement> {
    const timeout = options?.timeout ?? 5000;
    const deadline = Date.now() + timeout;

    // Poll until the element appears or the deadline passes. The walker
    // runs in browser context via evaluateHandle; we pass the function
    // body as a string so TypeScript doesn't typecheck it against Node
    // globals (the DOM lib isn't in tsconfig).
    const walkerScript = `((selector) => {
      function walk(root) {
        if (!root) return null;
        if (root.matches && root.matches(selector)) return root;
        if (typeof root.querySelector === 'function') {
          const direct = root.querySelector(selector);
          if (direct) return direct;
        }
        const all = typeof root.querySelectorAll === 'function' ? root.querySelectorAll('*') : [];
        for (const el of all) {
          if (el.shadowRoot) {
            const found = walk(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }
      return walk(document);
    })(${JSON.stringify(cssSelector)})`;

    while (Date.now() < deadline) {
      const handle = await pageOrFrame.evaluateHandle(walkerScript);
      const element = handle.asElement();
      if (element) {
        this.logger.info('Element found via shadow DOM walker', { cssSelector });
        return element as PlaywrightElement;
      }
      await handle.dispose();
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    throw new Error(`Element not found in shadow DOM: "${cssSelector}"`);
  }

  private notFound(selector: string, tried: string[]): Error {
    return new Error(`Element not found: "${selector}". Tried: ${tried.join(', ')}`);
  }
}
