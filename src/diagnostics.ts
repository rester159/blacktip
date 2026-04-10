/**
 * Diagnostic primitives for stealth validation.
 *
 * Captures the actual TLS / HTTP2 / HTTP header fingerprint that BlackTip
 * is sending, and queries free IP reputation services to score the
 * current network. Used to diagnose why a specific anti-bot target is
 * blocking us — see docs/akamai-bypass.md for the full methodology.
 *
 * The primitives here run via the active BlackTip browser session — they
 * don't make HTTP requests directly from Node, because the whole point
 * is to capture what the browser actually sends, not what Node would send.
 */

import type { BlackTip } from './blacktip.js';

// ── Types ──

export interface FingerprintSnapshot {
  capturedAt: string;
  ip: string | null;
  tls: {
    ja3: string | null;
    ja3Hash: string | null;
    ja4: string | null;
    firstCipher: string | null;
    cipherCount: number | null;
    firstExtension: string | null;
    extensionCount: number | null;
    tlsVersion: string | null;
    /** True if first cipher is GREASE — Chrome's signature */
    hasGreaseCipher: boolean;
    /** True if first extension is GREASE — Chrome's signature */
    hasGreaseExtension: boolean;
    /** True if JA4 starts with t13d — TLS 1.3 with Chrome's count signature */
    isChromeLikeJa4: boolean;
  };
  http2: {
    akamaiFingerprint: string | null;
    akamaiFingerprintHash: string | null;
    /** Sequence of frame types sent by the client (Chrome: SETTINGS, WINDOW_UPDATE, HEADERS) */
    sentFrames: string[] | null;
  };
  headers: {
    userAgent: string | null;
    secChUa: string | null;
    secChUaMobile: string | null;
    secChUaPlatform: string | null;
    acceptLanguage: string | null;
    acceptEncoding: string | null;
    secFetchSite: string | null;
    secFetchMode: string | null;
    secFetchDest: string | null;
    secFetchUser: string | null;
    upgradeInsecureRequests: string | null;
    /** Chrome version parsed from User-Agent (e.g. 125 from "Chrome/125.0.0.0") */
    uaChromeVersion: number | null;
    /** Chrome version parsed from Sec-Ch-Ua (e.g. 146 from `"Google Chrome";v="146"`) */
    secChUaChromeVersion: number | null;
    /**
     * THE CRITICAL CHECK: do User-Agent and Sec-Ch-Ua report the same Chrome
     * version? If false, Akamai / DataDome / PerimeterX will catch you. This
     * is the L016 fingerprint consistency signal.
     */
    uaConsistent: boolean;
  };
}

export interface IpReputationResult {
  ip: string | null;
  hostname: string | null;
  asn: string | null;
  org: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  loc: string | null;
  timezone: string | null;
  /** Heuristic: ASN matches a well-known datacenter / cloud provider */
  isDatacenter: boolean;
  /** Heuristic: ASN matches a residential ISP */
  isResidential: boolean;
  /** Free-form notes from the heuristic checks */
  notes: string[];
}

export interface AkamaiTestResult {
  url: string;
  /** True if the page loaded normally (not the Akamai Access Denied error) */
  passed: boolean;
  finalUrl: string;
  title: string;
  /** Akamai's reference number from the block page (null if not blocked) */
  akamaiReference: string | null;
  /** First 300 chars of body — useful for diagnosis */
  bodyPreview: string;
  /** Suggested next step based on what we observed */
  suggestion: string;
  durationMs: number;
}

/** Anti-bot vendors that BlackTip's diagnostics can recognize. */
export type AntiBotVendor =
  | 'akamai'
  | 'datadome'
  | 'cloudflare'
  | 'perimeterx'
  | 'imperva'
  | 'kasada'
  | 'arkose'
  | 'unknown';

export interface AntiBotTestResult {
  url: string;
  /** True if the page loaded normally (no recognised challenge or block) */
  passed: boolean;
  finalUrl: string;
  title: string;
  /** Vendors that left a tell on the rendered page (block OR challenge interstitial) */
  detectedVendors: AntiBotVendor[];
  /** Vendor signatures observed even on a passing page (cookies, scripts, headers) */
  vendorSignals: { vendor: AntiBotVendor; signal: string }[];
  /** Akamai reference number, if a block from Akamai */
  akamaiReference: string | null;
  /** First 300 chars of body — useful for diagnosis */
  bodyPreview: string;
  /** Suggested next step based on what we observed */
  suggestion: string;
  durationMs: number;
}

// ── Datacenter ASN heuristics ──
//
// Not exhaustive — just covers the major cloud providers and known
// datacenter ranges. If your IP is on one of these, Akamai will almost
// certainly flag it. Add to this list as new providers come up.

const DATACENTER_ASN_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /AS16509|AS14618/, name: 'Amazon AWS' },
  { pattern: /AS15169/, name: 'Google Cloud' },
  { pattern: /AS8075/, name: 'Microsoft Azure' },
  { pattern: /AS16276/, name: 'OVH' },
  { pattern: /AS14061/, name: 'DigitalOcean' },
  { pattern: /AS20473/, name: 'Choopa / Vultr' },
  { pattern: /AS24940/, name: 'Hetzner' },
  { pattern: /AS63949/, name: 'Linode / Akamai (compute)' },
  { pattern: /AS133752/, name: 'Leaseweb' },
  { pattern: /AS54641|AS19551/, name: 'Cloudflare (compute)' },
  { pattern: /AS396982/, name: 'Google Cloud Platform (compute)' },
  { pattern: /AS200600/, name: 'Aeza Group (cheap VPS)' },
];

const RESIDENTIAL_ASN_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /AS5650|AS22773/, name: 'Frontier Communications / Cox (residential US)' },
  { pattern: /AS7922/, name: 'Comcast (residential US)' },
  { pattern: /AS7018/, name: 'AT&T (residential US)' },
  { pattern: /AS20057|AS20115/, name: 'Charter / Spectrum (residential US)' },
  { pattern: /AS6128/, name: 'Optimum / Cablevision (residential US)' },
  { pattern: /AS33363/, name: 'BHN / Spectrum (residential US)' },
  { pattern: /AS5089/, name: 'Virgin Media (residential UK)' },
  { pattern: /AS3320/, name: 'Deutsche Telekom (residential DE)' },
  { pattern: /AS9121/, name: 'Türk Telekom (residential TR)' },
];

// ── captureFingerprint ──

/**
 * Capture the active session's TLS, HTTP/2, and HTTP header fingerprint
 * by navigating to tls.peet.ws/api/all and httpbin.org/headers.
 *
 * Returns a structured snapshot you can use to verify your stealth state
 * before hitting a real target. The most important field is
 * `headers.uaConsistent` — if that's false, you're on a pre-v0.2.0 build
 * with the L016 bug.
 */
export async function captureFingerprint(bt: BlackTip): Promise<FingerprintSnapshot> {
  // Step 1: TLS + HTTP/2 fingerprint via tls.peet.ws
  await bt.navigate('https://tls.peet.ws/api/all');
  const peetRaw = (await bt.executeJS('document.body.innerText')) as string;
  const peet = JSON.parse(peetRaw) as {
    ip?: string;
    user_agent?: string;
    tls?: {
      ja3?: string;
      ja3_hash?: string;
      ja4?: string;
      ciphers?: string[];
      extensions?: { name?: string }[];
      tls_version_negotiated?: string;
    };
    http2?: {
      akamai_fingerprint?: string;
      akamai_fingerprint_hash?: string;
      sent_frames?: { frame_type?: string }[];
    };
  };

  // Step 2: HTTP headers via httpbin.org/headers
  await bt.navigate('https://httpbin.org/headers');
  const hbRaw = (await bt.executeJS('document.body.innerText')) as string;
  const hb = JSON.parse(hbRaw) as { headers?: Record<string, string> };
  const headers = hb.headers ?? {};

  const userAgent = headers['User-Agent'] ?? null;
  const secChUa = headers['Sec-Ch-Ua'] ?? null;

  // Parse Chrome version from User-Agent: "...Chrome/125.0.0.0..."
  const uaMatch = userAgent ? userAgent.match(/Chrome\/(\d+)/) : null;
  const uaChromeVersion = uaMatch ? parseInt(uaMatch[1]!, 10) : null;

  // Parse Chrome version from Sec-Ch-Ua: `"Google Chrome";v="146"`
  const chuaMatch = secChUa ? secChUa.match(/"Google Chrome";v="(\d+)/) : null;
  const secChUaChromeVersion = chuaMatch ? parseInt(chuaMatch[1]!, 10) : null;

  const uaConsistent =
    uaChromeVersion != null &&
    secChUaChromeVersion != null &&
    uaChromeVersion === secChUaChromeVersion;

  const tlsBlock = peet.tls ?? {};
  const ciphers = tlsBlock.ciphers ?? [];
  const extensions = tlsBlock.extensions ?? [];
  const ja4 = tlsBlock.ja4 ?? null;

  return {
    capturedAt: new Date().toISOString(),
    ip: peet.ip ? peet.ip.split(':')[0] ?? null : null,
    tls: {
      ja3: tlsBlock.ja3 ?? null,
      ja3Hash: tlsBlock.ja3_hash ?? null,
      ja4,
      firstCipher: ciphers[0] ?? null,
      cipherCount: ciphers.length || null,
      firstExtension: extensions[0]?.name ?? null,
      extensionCount: extensions.length || null,
      tlsVersion: tlsBlock.tls_version_negotiated ?? null,
      hasGreaseCipher: !!(ciphers[0] && /GREASE/i.test(ciphers[0])),
      hasGreaseExtension: !!(extensions[0]?.name && /GREASE/i.test(extensions[0].name)),
      isChromeLikeJa4: !!(ja4 && /^t13d/.test(ja4)),
    },
    http2: {
      akamaiFingerprint: peet.http2?.akamai_fingerprint ?? null,
      akamaiFingerprintHash: peet.http2?.akamai_fingerprint_hash ?? null,
      sentFrames: peet.http2?.sent_frames?.map((f) => f.frame_type ?? '') ?? null,
    },
    headers: {
      userAgent,
      secChUa,
      secChUaMobile: headers['Sec-Ch-Ua-Mobile'] ?? null,
      secChUaPlatform: headers['Sec-Ch-Ua-Platform'] ?? null,
      acceptLanguage: headers['Accept-Language'] ?? null,
      acceptEncoding: headers['Accept-Encoding'] ?? null,
      secFetchSite: headers['Sec-Fetch-Site'] ?? null,
      secFetchMode: headers['Sec-Fetch-Mode'] ?? null,
      secFetchDest: headers['Sec-Fetch-Dest'] ?? null,
      secFetchUser: headers['Sec-Fetch-User'] ?? null,
      upgradeInsecureRequests: headers['Upgrade-Insecure-Requests'] ?? null,
      uaChromeVersion,
      secChUaChromeVersion,
      uaConsistent,
    },
  };
}

// ── checkIpReputation ──

/**
 * Query the active session's egress IP and ASN, score it against known
 * datacenter / residential patterns, and return a structured result.
 *
 * Uses the free ipinfo.io endpoint which doesn't require an API key for
 * basic queries. Doesn't query commercial reputation services (those
 * require API keys); for those, integrate at the caller's level.
 */
export async function checkIpReputation(bt: BlackTip): Promise<IpReputationResult> {
  await bt.navigate('https://ipinfo.io/json');
  const raw = (await bt.executeJS('document.body.innerText')) as string;
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw) as Record<string, string>;
  } catch {
    parsed = {};
  }

  const org = parsed.org ?? null;
  const notes: string[] = [];

  let isDatacenter = false;
  let isResidential = false;

  if (org) {
    for (const { pattern, name } of DATACENTER_ASN_PATTERNS) {
      if (pattern.test(org)) {
        isDatacenter = true;
        notes.push(`Matches datacenter ASN: ${name}`);
        break;
      }
    }
    if (!isDatacenter) {
      for (const { pattern, name } of RESIDENTIAL_ASN_PATTERNS) {
        if (pattern.test(org)) {
          isResidential = true;
          notes.push(`Matches residential ISP: ${name}`);
          break;
        }
      }
    }
    if (!isDatacenter && !isResidential) {
      notes.push('ASN not in known datacenter or residential lists — could be either');
    }
  } else {
    notes.push('Could not determine ASN');
  }

  return {
    ip: parsed.ip ?? null,
    hostname: parsed.hostname ?? null,
    asn: org ? (org.match(/AS\d+/) ?? [])[0] ?? null : null,
    org,
    city: parsed.city ?? null,
    region: parsed.region ?? null,
    country: parsed.country ?? null,
    loc: parsed.loc ?? null,
    timezone: parsed.timezone ?? null,
    isDatacenter,
    isResidential,
    notes,
  };
}

// ── testAgainstAkamai ──

/**
 * Visit an Akamai-protected URL and report the result with diagnosis.
 * Recognizes the Akamai Access Denied error page format and extracts
 * the reference number for triage.
 */
export async function testAgainstAkamai(bt: BlackTip, url: string): Promise<AkamaiTestResult> {
  const start = Date.now();
  try {
    await bt.navigate(url);
    // Wait for the page to settle a moment so Akamai can render its block
    // page if it's going to.
    await new Promise((r) => setTimeout(r, 1500));

    const info = (await bt.executeJS(`(() => ({
      url: location.href,
      title: document.title,
      bodyPreview: (document.body ? document.body.innerText : '').slice(0, 600),
    }))()`)) as { url: string; title: string; bodyPreview: string };

    // Akamai Access Denied detection
    const isBlocked =
      info.title === 'Access Denied' ||
      /You don't have permission to access/i.test(info.bodyPreview) ||
      /errors\.edgesuite\.net/i.test(info.bodyPreview);

    // Extract Akamai reference number if present
    const refMatch = info.bodyPreview.match(/Reference\s*#([0-9a-f.]+)/);
    const akamaiReference = refMatch ? refMatch[1] ?? null : null;

    let suggestion: string;
    if (!isBlocked) {
      suggestion = 'Page loaded successfully. No Akamai block detected.';
    } else {
      suggestion = [
        'Akamai blocked the request at the edge. Diagnosis steps:',
        '1. Run `bt.captureFingerprint()` and check `headers.uaConsistent`. If false, upgrade BlackTip to v0.2.0+.',
        '2. Run `bt.checkIpReputation()`. If `isDatacenter: true`, switch to a residential network or proxy.',
        '3. Test the same URL in your normal Chrome from the same machine. If that ALSO blocks, your IP is flagged — switch networks.',
        '4. Try `bt.warmSession({sites: [...]})` before the target navigation.',
        '5. Try with `userDataDir` set in BlackTipConfig for a persistent profile.',
        `Akamai reference: ${akamaiReference ?? 'unknown'}`,
      ].join('\n');
    }

    return {
      url,
      passed: !isBlocked,
      finalUrl: info.url,
      title: info.title,
      akamaiReference,
      bodyPreview: info.bodyPreview.slice(0, 300),
      suggestion,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      url,
      passed: false,
      finalUrl: url,
      title: '',
      akamaiReference: null,
      bodyPreview: '',
      suggestion: `Navigation threw: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

// ── testAgainstAntiBot ──
//
// Generic anti-bot probe that recognises Akamai, DataDome, Cloudflare,
// PerimeterX/HUMAN, Imperva, Kasada and Arkose. Validated against the
// scoreboard in docs/anti-bot-validation.md.

const VENDOR_BLOCK_PATTERNS: { vendor: AntiBotVendor; titleRe?: RegExp; bodyRe?: RegExp }[] = [
  { vendor: 'akamai', titleRe: /^Access Denied$/, bodyRe: /You don't have permission to access|errors\.edgesuite\.net/i },
  { vendor: 'datadome', bodyRe: /geo\.captcha-delivery\.com|captcha-delivery\.com|please enable javascript and cookies to continue|datado\.me/i },
  { vendor: 'cloudflare', titleRe: /^Just a moment\.\.\.$|^Attention Required! \| Cloudflare$/, bodyRe: /Checking your browser before accessing|cf-browser-verification|challenges\.cloudflare\.com|Sorry, you have been blocked/i },
  { vendor: 'perimeterx', titleRe: /^Access to this page has been denied/, bodyRe: /Press (?:&|and) Hold to confirm you (?:are|are not) a human|px-captcha|perimeterx\.net|human\.com/i },
  { vendor: 'imperva', bodyRe: /Request unsuccessful\. Incapsula incident ID|_Incapsula_Resource|Incapsula incident/i },
  { vendor: 'kasada', bodyRe: /kpsdk|ips\.js\?|kasada/i },
  { vendor: 'arkose', bodyRe: /client-api\.arkoselabs\.com|funcaptcha/i },
];

const VENDOR_SCRIPT_SIGNAL_QUERY = `(() => {
  const out = [];
  const html = document.documentElement.outerHTML;
  if (/datado\\.me|js\\.datadome\\.co/i.test(html)) out.push({vendor:'datadome', signal:'script'});
  if (/perimeterx|px-cdn|px-captcha|human-security/i.test(html)) out.push({vendor:'perimeterx', signal:'script'});
  if (/challenges\\.cloudflare\\.com|cdn-cgi\\/challenge-platform/i.test(html)) out.push({vendor:'cloudflare', signal:'script'});
  if (/akam\\/|ak\\.bmpsdk|akamaihd\\.net\\/sensor/i.test(html)) out.push({vendor:'akamai', signal:'script'});
  if (/x-kpsdk-/i.test(html)) out.push({vendor:'kasada', signal:'script'});
  return JSON.stringify(out);
})()`;

// Cookie-name patterns for the vendor cookie checks. Run against the
// full cookie jar from BlackTip's cookies API (which includes httpOnly
// cookies that document.cookie can't see — cf_clearance, __cf_bm,
// _abck, datadome, etc. are all httpOnly).
const VENDOR_COOKIE_PATTERNS: { vendor: AntiBotVendor; nameRe: RegExp }[] = [
  { vendor: 'datadome', nameRe: /^(datadome|dd_cookie_test_|dd_s)/i },
  { vendor: 'perimeterx', nameRe: /^_px[a-z0-9]*$|^_pxhd$/i },
  { vendor: 'cloudflare', nameRe: /^(cf_clearance|__cf_bm|__cflb|_cfuvid)$/i },
  { vendor: 'akamai', nameRe: /^(_abck|bm_sz|ak_bmsc|bm_sv|bm_mi|bm_so)$/i },
  { vendor: 'imperva', nameRe: /^(visid_incap_|incap_ses_)/i },
];

/**
 * Visit a URL and report whether any major anti-bot vendor served a
 * challenge or block. Recognises Akamai, DataDome, Cloudflare, PerimeterX/HUMAN,
 * Imperva, Kasada and Arkose. Captures vendor signals (cookies, scripts) even
 * on a passing page so you can verify a target is actually protected and
 * BlackTip is sliding past it — not a false negative on an unprotected URL.
 */
export async function testAgainstAntiBot(bt: BlackTip, url: string): Promise<AntiBotTestResult> {
  const start = Date.now();
  try {
    await bt.navigate(url);
    await new Promise((r) => setTimeout(r, 2500));

    const info = (await bt.executeJS(`(() => ({
      url: location.href,
      title: document.title,
      bodyPreview: (document.body ? document.body.innerText : '').slice(0, 800),
    }))()`)) as { url: string; title: string; bodyPreview: string };

    const detectedVendors: AntiBotVendor[] = [];
    for (const { vendor, titleRe, bodyRe } of VENDOR_BLOCK_PATTERNS) {
      if ((titleRe && titleRe.test(info.title)) || (bodyRe && bodyRe.test(info.bodyPreview))) {
        if (!detectedVendors.includes(vendor)) detectedVendors.push(vendor);
      }
    }

    const scriptSignalsRaw = (await bt.executeJS(VENDOR_SCRIPT_SIGNAL_QUERY)) as string;
    const vendorSignals: { vendor: AntiBotVendor; signal: string }[] = [];
    try {
      const scriptSignals = JSON.parse(scriptSignalsRaw) as { vendor: AntiBotVendor; signal: string }[];
      vendorSignals.push(...scriptSignals);
    } catch { /* leave empty */ }

    // Cookie signals — read via the cookies API so we see httpOnly cookies
    // (cf_clearance, __cf_bm, _abck, datadome, etc. are all httpOnly and
    // invisible to document.cookie). The current page's eTLD+1 is what we
    // care about — we don't want to leak signals from prior navigations
    // in the same session.
    try {
      const allCookies = await bt.cookies();
      const currentHost = (() => {
        try { return new URL(info.url).hostname; } catch { return null; }
      })();
      const seen = new Set<string>();
      for (const c of allCookies) {
        if (currentHost) {
          // Match cookies whose domain is a parent or equal of the current host.
          const cookieDomain = c.domain.replace(/^\./, '');
          if (currentHost !== cookieDomain && !currentHost.endsWith('.' + cookieDomain)) continue;
        }
        for (const { vendor, nameRe } of VENDOR_COOKIE_PATTERNS) {
          if (nameRe.test(c.name)) {
            const key = vendor + ':cookie';
            if (!seen.has(key)) {
              vendorSignals.push({ vendor, signal: 'cookie' });
              seen.add(key);
            }
          }
        }
      }
    } catch { /* cookies API may fail in edge cases — leave script signals */ }

    const refMatch = info.bodyPreview.match(/Reference\s*#([0-9a-f.]+)/);
    const akamaiReference = detectedVendors.includes('akamai') && refMatch ? refMatch[1] ?? null : null;

    const passed = detectedVendors.length === 0;
    const suggestion = passed
      ? vendorSignals.length > 0
        ? `Page loaded successfully. Vendor signals present (${vendorSignals.map((s) => s.vendor).join(', ')}) — target is protected and BlackTip is passing.`
        : 'Page loaded successfully. No anti-bot vendor signals detected — the target may not be protected.'
      : [
          `Blocked by: ${detectedVendors.join(', ')}.`,
          'Diagnosis steps:',
          '1. `bt.captureFingerprint()` — verify `headers.uaConsistent` is true.',
          '2. `bt.checkIpReputation()` — if `isDatacenter: true`, switch to a residential proxy.',
          '3. Test the same URL in your normal Chrome from this machine. If that also blocks, the IP is flagged.',
          '4. `bt.warmSession({sites: [...]})` before retrying.',
          '5. Set `userDataDir` in BlackTipConfig for a persistent profile.',
          akamaiReference ? `Akamai reference: ${akamaiReference}` : '',
        ].filter(Boolean).join('\n');

    return {
      url,
      passed,
      finalUrl: info.url,
      title: info.title,
      detectedVendors,
      vendorSignals,
      akamaiReference,
      bodyPreview: info.bodyPreview.slice(0, 300),
      suggestion,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      url,
      passed: false,
      finalUrl: url,
      title: '',
      detectedVendors: [],
      vendorSignals: [],
      akamaiReference: null,
      bodyPreview: '',
      suggestion: `Navigation threw: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}
