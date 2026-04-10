/**
 * Akamai Bot Manager sensor challenge solver.
 *
 * The v0.5.0 answer to "I want to call Akamai-protected APIs from a
 * sessionless TLS daemon, but the first request always 403s because
 * Akamai gates everything behind a sensor data POST."
 *
 * Why this isn't pure Go: Akamai's bm.js is heavily obfuscated, the
 * sensor data POST it generates is encrypted with a runtime-derived
 * key that lives inside the obfuscated code, and the obfuscation rotates
 * monthly. A pure-Go reimplementation would be a 1-2 week reverse
 * engineering project and the result would rot in ~6 weeks. Bad ROI.
 *
 * What we do instead: launch a real BlackTip browser, navigate to the
 * URL, let Akamai's bm.js execute naturally (real Chrome runs the JS,
 * generates the sensor payload, POSTs it back), poll for the `_abck`
 * cookie to transition from `~-1~` (unvalidated) to `~0~` (validated),
 * and return the validated cookies. The caller can then inject those
 * cookies into thousands of sessionless TLS-daemon API calls until
 * they expire (Akamai sessions are valid for ~1 hour typically).
 *
 * This is NOT "no browser needed for Akamai." It IS "amortize browser
 * cost across many subsequent API calls instead of paying it per
 * request." For most use cases that's the same thing — you pay one
 * browser session per hour and run hundreds of API calls in between.
 */

import type { BlackTip } from './blacktip.js';

export interface AkamaiChallengeResult {
  /**
   * Whether the session is usable. True when EITHER:
   *   - `_abck` cookie reached the validated state (`~0~`), OR
   *   - The page rendered successfully without an Akamai block.
   *
   * Akamai's sensor validation is only enforced when other signals
   * (TLS, IP, behavior) look suspicious. For real-Chrome sessions on
   * residential connections, Akamai often admits the request without
   * ever requiring the JS-layer sensor POST. In those cases `abckState`
   * stays at `-1` but the page works fine — that's still a successful
   * solve from the caller's perspective.
   */
  validated: boolean;
  /**
   * The actual `_abck` validation state at the end of the wait window:
   *   - `0`  → sensor data validated as human (gold standard)
   *   - `-1` → sensor not enforced (page admitted without it)
   *   - `1`+ → sensor data flagged as bot
   *   - `null` → no `_abck` cookie set (target may not be Akamai-protected)
   */
  abckState: -1 | 0 | 1 | null;
  /** The full `_abck` cookie value at the end of the wait window. */
  abckValue: string | null;
  /**
   * Whether the rendered page looks like an Akamai block page (title
   * `Access Denied`, body matches the standard error template).
   */
  blocked: boolean;
  /** All Akamai-related cookies on the target session, ready to inject. */
  cookies: Array<{ name: string; value: string; domain: string; path: string }>;
  /** Final URL after any redirects. */
  finalUrl: string;
  /** Page title (useful for verifying we're not on an Access Denied page). */
  title: string;
  /** How long the solve took, ms. */
  durationMs: number;
  /** Free-form diagnostic notes. */
  notes: string[];
  /**
   * Pre-built header set ready to pass to `bt.fetchWithTls({ url, headers })`
   * for replay calls. Includes the Cookie header (joined from `cookies`)
   * plus the Sec-Ch-Ua / Sec-Fetch-* / Accept-Language headers Akamai
   * binds the session to. **Replays without these headers will 403** even
   * with valid cookies — Akamai validates the full request shape, not
   * just the cookie jar.
   *
   * Empirically validated against OpenTable: 5 consecutive replays via
   * the TLS daemon all returned 200 with real content. Replay cost is
   * ~600ms per call vs ~4s per browser launch.
   */
  recommendedHeaders: Record<string, string>;
}

/**
 * Parse the Akamai sensor validation state from a `_abck` cookie value.
 * Akamai encodes the state in the second `~`-delimited field:
 *   - `-1` means "sensor data not yet submitted/validated" (the value
 *     Akamai sets on the very first response).
 *   - `0`  means "sensor data submitted and validated as human."
 *   - `1`+ means "sensor data submitted but flagged as bot."
 *
 * The validated state is what unlocks the rest of the protected paths.
 */
export function parseAbckState(abckValue: string | null): -1 | 0 | 1 | null {
  if (!abckValue) return null;
  const parts = abckValue.split('~');
  if (parts.length < 2) return null;
  const stateStr = parts[1] ?? '';
  const n = parseInt(stateStr, 10);
  if (n === -1) return -1;
  if (n === 0) return 0;
  if (n >= 1) return 1;
  return null;
}

/** Cookie names we treat as "Akamai session state" for the result bundle. */
const AKAMAI_COOKIE_NAMES = new Set([
  '_abck',
  'bm_sz',
  'bm_sv',
  'ak_bmsc',
  'bm_mi',
  'bm_so',
  'bm_s',
  'bm_ss',
]);

/**
 * Drive a BlackTip session through Akamai's sensor challenge for `url`,
 * waiting until `_abck` reaches a validated state.
 *
 * The caller passes a launched BlackTip instance — the function does NOT
 * launch its own. This is so the caller controls the surrounding context
 * (TLS rewriting, IdentityPool identity, persistent profile, etc.).
 *
 * After this returns with `validated: true`, you can:
 *   - Inject `result.cookies` into another BlackTip session via `bt.setCookies()`
 *   - Inject them into a TLS daemon flow by setting them on the `Cookie:`
 *     header of subsequent `bt.fetchWithTls()` calls
 *   - Persist them in an IdentityPool snapshot
 *
 * Polls every 250ms with a default 15-second wait window. Most Akamai
 * targets validate within 2-5 seconds; the wait is generous enough for
 * slow targets but bounded so we don't hang on a permanently-blocked URL.
 */
export async function solveAkamaiChallenge(
  bt: BlackTip,
  url: string,
  options: {
    /** Maximum time to wait for `_abck` to validate. Default 15s. */
    timeoutMs?: number;
    /** Poll interval for the cookie state. Default 250ms. */
    pollIntervalMs?: number;
    /**
     * Optional human-like dwell after navigation finishes but before we
     * start polling. Akamai's sensor data is more convincing if there's
     * actual mouse movement / scrolling on the page. Default 1500ms; set
     * to 0 to skip.
     */
    dwellMsBeforePolling?: number;
  } = {},
): Promise<AkamaiChallengeResult> {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const dwellMsBeforePolling = options.dwellMsBeforePolling ?? 1500;

  const notes: string[] = [];

  // 1. Navigate to the target. Akamai sets `_abck` on the response and
  //    schedules its bm.js to run.
  await bt.navigate(url);

  // 2. Brief dwell so Chrome can run bm.js and POST the sensor data.
  //    On most sites, the sensor POST happens within 100-500ms of DOM ready.
  if (dwellMsBeforePolling > 0) {
    await new Promise((r) => setTimeout(r, dwellMsBeforePolling));
  }

  // 3. Poll the cookie jar until `_abck` reaches a definitive state
  //    (validated or flagged), or the timeout window expires.
  let lastAbck: string | null = null;
  let lastState: ReturnType<typeof parseAbckState> = null;
  const deadline = start + timeoutMs;

  while (Date.now() < deadline) {
    const allCookies = await bt.cookies();
    const abck = allCookies.find((c) => c.name === '_abck');
    lastAbck = abck?.value ?? null;
    lastState = parseAbckState(lastAbck);

    if (lastState === 0) {
      notes.push('_abck reached validated state (0) — sensor POST accepted');
      break;
    }
    if (lastState === 1) {
      notes.push('_abck reached flagged state (1) — sensor POST was rejected as bot');
      break;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // 4. Collect the full Akamai cookie set for the caller.
  const allCookies = await bt.cookies();
  const akamaiCookies = allCookies
    .filter((c) => AKAMAI_COOKIE_NAMES.has(c.name))
    .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));

  // 5. Capture the final page state for diagnosis. We check for the
  //    Akamai Access Denied page format here so we can distinguish
  //    "page rendered fine, sensor not enforced" from "page blocked".
  const pageState = (await bt.executeJS(`(() => ({
    url: location.href,
    title: document.title,
    bodyPreview: (document.body ? document.body.innerText : '').slice(0, 600),
  }))()`)) as { url: string; title: string; bodyPreview: string };

  const blocked =
    pageState.title === 'Access Denied' ||
    /You don't have permission to access/i.test(pageState.bodyPreview) ||
    /errors\.edgesuite\.net/i.test(pageState.bodyPreview);

  if (blocked) {
    notes.push('Akamai served the Access Denied block page');
  } else if (lastState === null) {
    notes.push('_abck cookie was never set — target may not be Akamai-protected');
  } else if (lastState === -1) {
    notes.push(
      '_abck stayed at -1 (sensor not enforced). Page rendered successfully — Akamai admitted the request based on TLS/IP/behavior signals without requiring JS sensor validation. Cookies are still usable for the session window.',
    );
  }

  // The session is usable when the page rendered without a block,
  // regardless of whether _abck reached the validated state. Akamai
  // only enforces sensor validation when other signals look bad.
  const validated = !blocked && (lastState === 0 || lastState === -1);

  // 6. Build the recommended replay headers. These are the headers that
  //    Akamai validates alongside the cookie jar — without them, replays
  //    via the TLS daemon will 403 even with valid cookies. We include
  //    every cookie from the session in the Cookie header (not just the
  //    Akamai ones), since some sites bind to non-Akamai cookies too.
  const cookieHeader = allCookies
    .filter((c) => {
      const cd = c.domain.replace(/^\./, '');
      try {
        const host = new URL(pageState.url).hostname;
        return host === cd || host.endsWith('.' + cd);
      } catch {
        return true;
      }
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const recommendedHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Ch-Ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cookie': cookieHeader,
  };

  return {
    validated,
    abckState: lastState,
    abckValue: lastAbck,
    blocked,
    cookies: akamaiCookies,
    finalUrl: pageState.url,
    title: pageState.title,
    durationMs: Date.now() - start,
    notes,
    recommendedHeaders,
  };
}
