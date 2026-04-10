import { chromium, type Browser, type BrowserContext, type Page, type Frame } from 'patchright';
import { EventEmitter } from 'node:events';
import type {
  BlackTipConfig,
  DeviceProfile,
  TabInfo,
  TabChangeEvent,
  FrameInfo,
  NavigateOptions,
  NavigateResult,
  ScreenshotOptions,
  ScreenshotResult,
  PageContentOptions,
} from './types.js';
import { DeviceProfileManager } from './fingerprint.js';
import { generateEvasionScripts } from './evasion.js';
import { Logger } from './logging.js';

export class BrowserCore extends EventEmitter {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Page[] = [];
  private activePageIndex = 0;
  private deviceProfile: DeviceProfile;
  private config: Required<Pick<BlackTipConfig, 'headless' | 'timeout' | 'locale' | 'timezone' | 'persistent'>> & BlackTipConfig;
  private logger: Logger;
  private profileManager: DeviceProfileManager;

  constructor(config: BlackTipConfig, logger: Logger) {
    super();
    this.logger = logger;
    this.profileManager = new DeviceProfileManager();

    this.config = {
      headless: false,
      timeout: 15000,
      locale: 'en-US',
      timezone: 'America/New_York',
      persistent: true,
      screenResolution: { width: 1920, height: 1080 },
      ...config,
    };

    const profileName = this.config.deviceProfile ?? 'desktop-windows';
    this.deviceProfile = this.profileManager.randomizeProfile(profileName);
  }

  async launch(): Promise<void> {
    this.logger.info('Launching browser', { deviceProfile: this.deviceProfile.name });

    // Minimal launch args. We deliberately do NOT set
    // --disable-blink-features=AutomationControlled, nor do we remove
    // --enable-automation via ignoreDefaultArgs. patchright handles both
    // of those at the CDP level without the tell-tale command line
    // flag. Setting them ourselves (a) is a signal in its own right
    // because real Chrome never launches with those args and (b)
    // conflicts with patchright's native hiding.
    const launchArgs = [
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${this.config.screenResolution!.width},${this.config.screenResolution!.height}`,
    ];

    if (this.config.proxy) {
      launchArgs.push(`--proxy-server=${this.config.proxy}`);
    }

    // Try system Chrome first, fall back to Playwright's bundled Chromium.
    // Using real Chrome via `channel: 'chrome'` gives us the real Chrome
    // TLS ClientHello (with GREASE), the real GPU through ANGLE, and the
    // real navigator surface — all things we can't fake as well with JS.
    const execPath = this.config.chromiumPath ?? process.env.BLACKTIP_CHROMIUM_PATH;
    try {
      this.browser = await chromium.launch({
        headless: false,
        channel: execPath ? undefined : 'chrome',
        args: launchArgs,
        executablePath: execPath,
      });
    } catch {
      this.logger.warn('System Chrome not found, falling back to Playwright Chromium');
      this.browser = await chromium.launch({
        headless: false,
        args: launchArgs,
      });
    }

    this.context = await this.browser.newContext({
      viewport: {
        width: this.config.screenResolution!.width,
        height: this.config.screenResolution!.height,
      },
      userAgent: this.deviceProfile.userAgent,
      locale: this.config.locale,
      timezoneId: this.config.timezone,
      deviceScaleFactor: this.deviceProfile.devicePixelRatio,
      colorScheme: 'light',
      javaScriptEnabled: true,
      bypassCSP: false,
      ignoreHTTPSErrors: false,
    });

    // Inject evasion scripts into every new page/frame
    const evasionScripts = generateEvasionScripts(this.deviceProfile);
    for (const script of evasionScripts) {
      await this.context.addInitScript(script);
    }

    // Set default timeout
    this.context.setDefaultTimeout(this.config.timeout);

    // Listen for new pages (popups, new tabs). Dedupe: the handler fires for
    // every page Chromium creates, including ones we just pushed ourselves —
    // without this guard we'd double-count every tab.
    this.context.on('page', (page) => {
      if (this.pages.includes(page)) return;
      this.pages.push(page);
      const index = this.pages.length - 1;
      this.attachPageCloseHandler(page, index);
      this.logger.info('New tab opened', { index, url: page.url() });
      this.emit('tabChange', {
        timestamp: new Date().toISOString(),
        tabIndex: index,
        url: page.url(),
        action: 'opened',
      } satisfies TabChangeEvent);
    });

    // Open initial page — the 'page' event handler pushes + attaches close
    // handler + emits tabChange for us, so we just set the active index.
    await this.context.newPage();
    this.activePageIndex = 0;

    this.logger.info('Browser launched successfully');
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.pages = [];
    this.activePageIndex = 0;
    this.logger.info('Browser closed');
  }

  isActive(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  // ── Page Access ──

  getActivePage(): Page {
    this.ensureLaunched();

    // Sync with context's live pages — remove any that were closed externally
    if (this.context) {
      const live = this.context.pages();
      this.pages = this.pages.filter(p => live.includes(p) && !p.isClosed());
      if (this.activePageIndex >= this.pages.length) {
        this.activePageIndex = Math.max(0, this.pages.length - 1);
      }
    }

    const page = this.pages[this.activePageIndex];
    if (!page) {
      throw new Error('No active page available. All pages may have been closed.');
    }
    return page;
  }

  // ── Navigation ──

  async navigate(url: string, options?: NavigateOptions): Promise<NavigateResult> {
    const page = this.getActivePage();
    const start = Date.now();

    try {
      const response = await page.goto(url, {
        waitUntil: options?.waitUntil ?? 'domcontentloaded',
        timeout: options?.timeout ?? this.config.timeout,
      });

      const result: NavigateResult = {
        success: true,
        url: page.url(),
        status: response?.status() ?? 0,
        duration: Date.now() - start,
      };

      this.logger.info('Navigated', { url: result.url, status: result.status, duration: result.duration });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('Navigation failed', { url, error: message });
      return {
        success: false,
        url,
        status: 0,
        duration: Date.now() - start,
        error: message,
      };
    }
  }

  // ── Tab Management ──

  async getTabs(): Promise<TabInfo[]> {
    this.ensureLaunched();
    return this.pages.map((page, index) => ({
      index,
      url: page.url(),
      title: '', // Title requires async, populated lazily
      active: index === this.activePageIndex,
    }));
  }

  async newTab(url?: string): Promise<number> {
    this.ensureLaunched();
    // The 'page' event handler pushes the new page, attaches the close
    // handler, and emits 'tabChange'. We just need to look up the index.
    const page = await this.context!.newPage();
    const index = this.pages.indexOf(page);

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    return index;
  }

  async switchTab(index: number): Promise<void> {
    this.ensureLaunched();
    if (index < 0 || index >= this.pages.length) {
      throw new Error(`Tab index ${index} out of range (0-${this.pages.length - 1})`);
    }

    this.activePageIndex = index;
    await this.pages[index]!.bringToFront();

    this.emit('tabChange', {
      timestamp: new Date().toISOString(),
      tabIndex: index,
      url: this.pages[index]!.url(),
      action: 'switched',
    } satisfies TabChangeEvent);

    this.logger.debug('Switched tab', { index });
  }

  async closeTab(index?: number): Promise<void> {
    this.ensureLaunched();
    const targetIndex = index ?? this.activePageIndex;

    if (targetIndex < 0 || targetIndex >= this.pages.length) {
      throw new Error(`Tab index ${targetIndex} out of range`);
    }

    if (this.pages.length === 1) {
      throw new Error('Cannot close the last tab');
    }

    const page = this.pages[targetIndex]!;
    const url = page.url();
    await page.close();
    this.pages.splice(targetIndex, 1);

    // Adjust active page index
    if (this.activePageIndex >= this.pages.length) {
      this.activePageIndex = this.pages.length - 1;
    }

    this.emit('tabChange', {
      timestamp: new Date().toISOString(),
      tabIndex: targetIndex,
      url,
      action: 'closed',
    } satisfies TabChangeEvent);

    this.logger.info('Closed tab', { index: targetIndex });
  }

  // ── Frame Access ──

  async getFrames(): Promise<FrameInfo[]> {
    const page = this.getActivePage();
    const frames = page.frames();
    return frames.map((frame, index) => ({
      name: frame.name(),
      url: frame.url(),
      index,
    }));
  }

  async getFrame(selector: string): Promise<Frame> {
    const page = this.getActivePage();

    // Try by name
    const byName = page.frame(selector);
    if (byName) return byName;

    // Try by URL substring
    const byUrl = page.frames().find(f => f.url().includes(selector));
    if (byUrl) return byUrl;

    // Try by CSS selector (iframe element)
    const elementHandle = await page.$(selector);
    if (elementHandle) {
      const frame = await elementHandle.contentFrame();
      if (frame) return frame;
    }

    throw new Error(`Frame not found: ${selector}`);
  }

  // ── Screenshot ──

  async screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
    const page = this.getActivePage();

    const buffer = await page.screenshot({
      fullPage: options?.fullPage ?? false,
      type: options?.format ?? 'png',
      quality: options?.format === 'jpeg' ? (options?.quality ?? 80) : undefined,
      path: options?.path,
    });

    const viewport = page.viewportSize() ?? { width: 0, height: 0 };

    return {
      data: buffer,
      format: options?.format ?? 'png',
      width: viewport.width,
      height: viewport.height,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Page Content ──

  async getPageContent(options?: PageContentOptions): Promise<string> {
    const page = this.getActivePage();
    if (options?.format === 'html') {
      return page.content();
    }
    return page.innerText('body');
  }

  // ── JavaScript Execution ──

  async executeJS(script: string): Promise<unknown> {
    const page = this.getActivePage();
    return page.evaluate(script);
  }

  // ── Session Management ──

  async newContext(): Promise<void> {
    this.ensureLaunched();
    // Close existing pages
    for (const page of this.pages) {
      await page.close();
    }

    // Close old context
    if (this.context) {
      await this.context.close();
    }

    // Create fresh context with same settings
    this.context = await this.browser!.newContext({
      viewport: {
        width: this.config.screenResolution!.width,
        height: this.config.screenResolution!.height,
      },
      userAgent: this.deviceProfile.userAgent,
      locale: this.config.locale,
      timezoneId: this.config.timezone,
      deviceScaleFactor: this.deviceProfile.devicePixelRatio,
    });

    // Re-inject evasion scripts
    const evasionScripts = generateEvasionScripts(this.deviceProfile);
    for (const script of evasionScripts) {
      await this.context.addInitScript(script);
    }

    this.context.setDefaultTimeout(this.config.timeout);

    const page = await this.context.newPage();
    this.pages = [page];
    this.activePageIndex = 0;

    this.logger.info('New browser context created');
  }

  async cookies(): Promise<{ name: string; value: string; domain: string; path: string }[]> {
    this.ensureLaunched();
    return this.context!.cookies();
  }

  async setCookies(cookies: { name: string; value: string; domain: string; path: string; url?: string }[]): Promise<void> {
    this.ensureLaunched();
    // Playwright accepts url OR domain+path, not both. Pick one form.
    const prepared = cookies.map(c => {
      if (c.url) {
        return { name: c.name, value: c.value, url: c.url };
      }
      return { name: c.name, value: c.value, domain: c.domain, path: c.path };
    });
    await this.context!.addCookies(prepared);
  }

  async clearCookies(): Promise<void> {
    this.ensureLaunched();
    await this.context!.clearCookies();
  }

  // ── Internal ──

  private attachPageCloseHandler(page: Page, initialIndex: number): void {
    page.on('close', () => {
      const idx = this.pages.indexOf(page);
      if (idx !== -1) {
        this.pages.splice(idx, 1);
        this.logger.info('Tab closed', { index: idx });

        if (this.activePageIndex >= this.pages.length) {
          this.activePageIndex = Math.max(0, this.pages.length - 1);
        } else if (this.activePageIndex > idx) {
          this.activePageIndex--;
        }

        this.emit('tabChange', {
          timestamp: new Date().toISOString(),
          tabIndex: idx,
          url: '',
          action: 'closed',
        } satisfies TabChangeEvent);
      }
    });
  }

  private ensureLaunched(): void {
    if (!this.browser || !this.context) {
      throw new Error('Browser not launched. Call launch() first.');
    }
  }
}
