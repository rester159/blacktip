export { BlackTip, BlackTipFrame } from './blacktip.js';
export { BehavioralEngine, HUMAN_PROFILE, SCRAPER_PROFILE } from './behavioral-engine.js';
export type { MouseStep, KeystrokeStep, ScrollStep, ActionImportance } from './behavioral-engine.js';
export { DeviceProfileManager } from './fingerprint.js';
export { generateEvasionScripts } from './evasion.js';
export { ElementFinder } from './element-finder.js';
export { Logger } from './logging.js';
export { BrowserCore } from './browser-core.js';

// v2 additions — Tier 2 calibration, Tier 3 infrastructure, observability.
export {
  fitDistribution,
  fitFittsLaw,
  fitMouseDynamics,
  fitTypingDynamics,
  fitFromSamples,
  deriveProfileConfig,
} from './behavioral/calibration.js';
export type {
  MouseSample,
  MouseMovement,
  KeystrokeSample,
  TypingSession,
  DistributionFit,
  MouseFit,
  TypingFit,
  CalibratedProfile,
} from './behavioral/calibration.js';

// v0.3.0 — dataset parsers for end-to-end calibration
export {
  parseCmuKeystrokeCsv,
  parseBalabitMouseCsv,
  parseGenericTelemetryJson,
  CMU_PHRASE,
} from './behavioral/parsers.js';

// v0.3.0 — TLS side-channel via bogdanfinn/tls-client
export { TlsSideChannel } from './tls-side-channel.js';
export type { TlsRequest, TlsResponse, ParsedCookie } from './tls-side-channel.js';

// v0.4.0 — IdentityPool: long-running session and identity rotation
export { IdentityPool } from './identity-pool.js';
export type {
  Identity,
  IdentityPoolOptions,
  RotationPolicy,
  DeviceProfileName,
} from './identity-pool.js';

export { ProxyPool, ProxyProviders, proxyToUrl } from './proxy-pool.js';
export type { ProxyDescriptor, ProxyProtocol, PoolOptions } from './proxy-pool.js';

export { SnapshotManager } from './snapshot.js';
export type { SessionSnapshot } from './snapshot.js';

export {
  attachObservability,
  JsonlFileExporter,
  ConsoleExporter,
  newTraceId,
} from './observability.js';
export type { StructuredEvent, EventExporter } from './observability.js';

// v0.2.0 — stealth diagnostics
export {
  captureFingerprint,
  checkIpReputation,
  testAgainstAkamai,
  testAgainstAntiBot,
} from './diagnostics.js';
export type {
  FingerprintSnapshot,
  IpReputationResult,
  AkamaiTestResult,
  AntiBotTestResult,
  AntiBotVendor,
} from './diagnostics.js';

export type {
  BlackTipConfig,
  ProfileConfig,
  DeviceProfile,
  PluginData,
  ActionResult,
  NavigateResult,
  ScreenshotResult,
  WaitResult,
  ActionEvent,
  BehavioralMetadata,
  ErrorEvent,
  RetryEvent,
  TabChangeEvent,
  LogEntry,
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
  ErrorCode,
  RetryStrategy,
  Point,
  BoundingBox,
} from './types.js';

export { ErrorCodes } from './types.js';
