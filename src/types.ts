// ── Configuration ──

export interface BlackTipConfig {
  behaviorProfile?: string | ProfileConfig;
  logLevel?: LogLevel;
  timeout?: number;
  retryAttempts?: number;
  headless?: boolean;
  proxy?: string;
  deviceProfile?: string;
  locale?: string;
  timezone?: string;
  screenResolution?: { width: number; height: number };
  persistent?: boolean;
  chromiumPath?: string;
  /**
   * Path to a Chrome user data directory for persistent profiles.
   * When set, Chrome carries cookies, localStorage, history, and visited
   * sites across BlackTip sessions, which makes Akamai's "first request
   * from unknown session" challenge less likely to fire.
   *
   * Example: `'./.bt-profile'` (relative to cwd) or `'/var/lib/blacktip/profile'`.
   *
   * If unset, Chrome runs with a fresh profile each launch (default).
   */
  userDataDir?: string;
  /**
   * IP reputation gate. When set, BlackTip queries `bt.checkIpReputation()`
   * immediately after `launch()` and acts based on the verdict:
   *
   *   - `false` / unset (default): no check.
   *   - `'warn'`: log a warning if the egress IP is on a known datacenter
   *     ASN, but allow the launch to proceed.
   *   - `'throw'` / `true`: throw on launch if the egress IP is datacenter.
   *     This is the safest setting for high-stakes flows where a flagged
   *     IP would burn a real account.
   *
   * Use `'throw'` in CI / production. Use `'warn'` for local dev. Leave
   * unset for offline / air-gapped use.
   */
  requireResidentialIp?: boolean | 'warn' | 'throw';
  /**
   * TLS rewriting (v0.5.0). When set to `'all'`, every browser request is
   * intercepted via Chrome DevTools Protocol's `Fetch.enable` and forwarded
   * through the Go-based `bogdanfinn/tls-client` daemon, which makes the
   * upstream call with a real Chrome TLS ClientHello, real H2 frame
   * settings, and real H2 frame order. The browser never opens an upstream
   * TCP connection — all its HTTP is fulfilled by the daemon.
   *
   * This restores cross-platform UA spoofing (run on Linux, present as
   * Windows or macOS — the daemon controls every header on the wire) and
   * gives total fingerprint control without the cert-installation hell of
   * a TCP-level MITM proxy.
   *
   * Tradeoffs:
   *   - WebSocket upgrades cannot be intercepted via Fetch and leak
   *     Chrome's native TLS. Mitigation: BlackTip auto-disables QUIC/HTTP3
   *     (`--disable-quic`) and the rewriter logs WS leaks for awareness.
   *   - Streaming/large response bodies are fully buffered (Fetch.fulfill
   *     takes a complete body). Bad for video; fine for HTML pages.
   *   - 5–10ms round-trip overhead per request. ~250–500ms added on a
   *     typical page with 50 subresources.
   *
   * Requires the Go daemon binary at `native/tls-client/blacktip-tls[.exe]`
   * — see `docs/tls-side-channel.md` for build instructions. If the daemon
   * binary is missing, launch will throw rather than silently falling back.
   *
   * Set to `'off'` (default) for normal operation, `'all'` for full
   * rewriting. Future versions may add `'selective:<domain-glob>'` for
   * per-domain rewriting.
   */
  tlsRewriting?: 'off' | 'all';
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ── Behavioral Profiles ──

export interface ProfileConfig {
  typingSpeedMs: [number, number];
  pauseBetweenActionsMs: [number, number];
  scrollSpeedMs: [number, number];
  mouseMovementCurve: 'bezier' | 'linear';
  clickDwellMs: [number, number];
  readingWpm: [number, number];
  mistakeRate: number;
  recoveryBehavior: 'natural' | 'fast';
  pasteThreshold: number;
}

// ── Device Profiles ──

export interface DeviceProfile {
  name: string;
  userAgent: string;
  platform: string;
  oscpu?: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  colorDepth: number;
  vendor: string;
  renderer: string;
  webglVendor: string;
  webglRenderer: string;
  languages: string[];
  plugins: PluginData[];
  fonts: string[];
}

export interface PluginData {
  name: string;
  description: string;
  filename: string;
  mimeTypes: { type: string; suffixes: string; description: string }[];
}

// ── Action Results ──

export interface ActionResult {
  success: boolean;
  duration: number;
  retries: number;
  error?: string;
  errorCode?: string;
}

export interface NavigateResult {
  success: boolean;
  url: string;
  status: number;
  duration: number;
  error?: string;
}

export interface ScreenshotResult {
  data: Buffer;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  timestamp: string;
}

export interface WaitResult {
  success: boolean;
  duration: number;
  error?: string;
}

// ── Action Options ──

export interface NavigateOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
}

/**
 * Action importance hint. Drives pre-action hesitation length and
 * behavioral intensity. Pass `'high'` on consequential clicks like
 * submit/pay/confirm buttons so BlackTip hesitates like a real user
 * would before committing.
 */
export type ActionImportance = 'low' | 'normal' | 'high';

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  count?: number;
  timeout?: number;
  importance?: ActionImportance;
}

export interface TypeOptions {
  clearFirst?: boolean;
  pressEnter?: boolean;
  paste?: boolean;
  timeout?: number;
  importance?: ActionImportance;
}

export interface ScrollOptions {
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  selector?: string;
  smooth?: boolean;
}

export interface HoverOptions {
  timeout?: number;
}

export interface SelectOptions {
  timeout?: number;
}

export interface PressKeyOptions {
  timeout?: number;
}

export interface UploadFileOptions {
  method?: 'auto' | 'input' | 'dragdrop';
  timeout?: number;
}

export interface ExtractTextOptions {
  multiple?: boolean;
}

export interface WaitForOptions {
  timeout?: number;
  visible?: boolean;
  hidden?: boolean;
}

export interface WaitForNavigationOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  format?: 'png' | 'jpeg';
  quality?: number;
  path?: string;
}

export interface PageContentOptions {
  format?: 'text' | 'html';
}

// ── Tab & Frame ──

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface FrameInfo {
  name: string;
  url: string;
  index: number;
}

// ── Events ──

export interface ActionEvent {
  timestamp: string;
  action: string;
  target: string;
  value?: string;
  outcome: 'success' | 'failure';
  duration: number;
  retries: number;
  behavioral?: BehavioralMetadata;
  error?: string;
  tabIndex?: number;
}

export interface BehavioralMetadata {
  mousePathLength?: number;
  mouseMoveDuration?: number;
  clickDwell?: number;
  preActionPause?: number;
  postActionPause?: number;
  typingDuration?: number;
}

export interface ErrorEvent {
  timestamp: string;
  code: string;
  message: string;
  url: string;
  action: string;
  attempts: number;
  screenshot?: Buffer;
  stack?: string;
}

export interface RetryEvent {
  timestamp: string;
  action: string;
  target: string;
  attempt: number;
  maxAttempts: number;
  strategy: RetryStrategy;
  error: string;
}

export type RetryStrategy = 'standard' | 'wait' | 'reload' | 'altSelector' | 'scroll' | 'clearOverlays';

export interface TabChangeEvent {
  timestamp: string;
  tabIndex: number;
  url: string;
  action: 'opened' | 'closed' | 'switched';
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

// ── Error Codes ──

export const ErrorCodes = {
  TIMEOUT: 'TIMEOUT',
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  JS_ERROR: 'JS_ERROR',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  BROWSER_CRASHED: 'BROWSER_CRASHED',
  PROXY_ERROR: 'PROXY_ERROR',
  FRAME_NOT_FOUND: 'FRAME_NOT_FOUND',
  NOT_LAUNCHED: 'NOT_LAUNCHED',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

// ── Internal Types ──

export interface Point {
  x: number;
  y: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementHandle {
  selector: string;
  boundingBox: BoundingBox;
  tagName: string;
  isVisible: boolean;
  frameIndex?: number;
}
