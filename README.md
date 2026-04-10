<p align="center">
  <img src="assets/logo.svg" alt="BlackTip" width="360">
</p>

# BlackTip

[![npm version](https://img.shields.io/npm/v/%40rester159%2Fblacktip.svg?color=cb3837&label=npm)](https://www.npmjs.com/package/@rester159/blacktip)
[![npm downloads](https://img.shields.io/npm/dm/%40rester159%2Fblacktip.svg?color=cb3837)](https://www.npmjs.com/package/@rester159/blacktip)
[![CI](https://github.com/rester159/blacktip/actions/workflows/ci.yml/badge.svg)](https://github.com/rester159/blacktip/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40rester159%2Fblacktip.svg?color=blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/rester159/blacktip?style=social)](https://github.com/rester159/blacktip/stargazers)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/node/v/%40rester159%2Fblacktip.svg?color=5fa04e&logo=node.js&logoColor=white)](https://nodejs.org/)

**Stealth browser instrument for AI agents.** Real Chrome + patchright CDP stealth + human-calibrated behavioral simulation. BlackTip is the hands, you (or your agent) are the brain.

BlackTip is not an agent. It does not parse natural language, does not plan, and does not decide what to click. It exposes primitives — `navigate`, `click`, `type`, `scroll`, `screenshot`, `waitForStable` — and wraps every action in human behavior that defeats bot detection.

**If you are an AI agent reading this, load `AGENTS.md` next.** It contains the rules, patterns, and common mistakes you need to know before driving BlackTip. The `README.md` is for humans evaluating the tool; `AGENTS.md` is for agents using it.

---

## What's different about BlackTip

Most open-source "stealth browser" projects are Playwright plus a JavaScript shim that overrides `navigator.webdriver`. That's table stakes and it's 2018-era thinking. Modern bot detection fingerprints the TLS ClientHello, the HTTP/2 frame order, the GPU through ANGLE, the canvas shader output, and — increasingly — your mouse dynamics and keystroke timing.

BlackTip's architecture:

| Layer | Approach | What it defeats |
|---|---|---|
| TLS / HTTP/2 fingerprint | Uses real Chrome Stable via Playwright `channel: 'chrome'`. ClientHello is genuine Chrome's, including rotating GREASE. | JA3 / JA4 / Akamai HTTP/2 fingerprinting |
| CDP / webdriver detection | `patchright` drop-in replacement for Playwright. Patches `Runtime.Enable` leak, Error stack hooks, `console.debug` hooks, automation string artifacts. | CreepJS headless/stealth panels, bot.sannysoft.com's webdriver check |
| GPU / canvas / audio | Real GPU rendered through ANGLE (no SwiftShader). Seeded canvas noise and audio noise tied to profile name for cross-session stability. | Canvas fingerprinting, audio fingerprinting, WebGL identification |
| Behavioral fidelity | Bézier mouse paths with Fitts' Law movement time, digraph-aware typing with typos/corrections, scroll deceleration, importance-scaled hesitation on submit/pay/confirm buttons, reading pause estimation. Calibratable against real mouse-dynamics datasets. | Behavioral biometrics (BioCatch, NuData, SecuredTouch) |
| Click robustness | Live bounding-box re-read before click (DOM reflow resistance), pre-click overlay detection, automatic overlay dismissal, force-click fallback. | Dynamic pages, chat widgets, cookie banners |
| Agent interface | TCP serve mode with bundled JSON responses (URL, title, screenshot, result in one frame). Batch command support. pause/resume for MFA. `--file` / `--stdin` inputs to eliminate shell-escape hell. | Orchestration overhead that makes agents slow |

**Detector scoreboard** (live as of last run; see `planning/baselines/` for timestamped artifacts):

- bot.sannysoft.com — 31 pass / 0 fail
- CreepJS — Grade A, 0% headless, 0% stealth
- tls.peet.ws — JA4 matches real Chrome with rotating GREASE
- browserleaks.com (canvas / webgl / webrtc / javascript) — all pass
- fingerprint.com/demo — passes
- pixelscan.net — passes
- browserscan.net — passes

**Real-target scoreboard:**
- nowsecure.nl (Cloudflare bot-fight test, nodriver author's public benchmark) — passes without challenge
- antoinevastel.com/bots (ex-DataDome VP of Research) — loads without block
- Anthem.com (Okta MFA, Angular SPA, real insurance claim submission) — end-to-end flow successful
- Walmart.com (Akamai + PerimeterX simultaneously) — passes both layers
- BestBuy.com (Akamai) — passes
- Vinted.com (DataDome) — real catalog renders, datadome cookie present
- Crunchbase.com (Cloudflare) — passes, cf_clearance issued silently
- ChatGPT.com (Cloudflare) — passes, cf_clearance issued silently
- Twitch.tv (Kasada) — passes, kasada client script detected on the page
- Ticketmaster.com — passes
- OpenTable.com Gjelina deep link (Akamai Bot Manager) — passes; full booking endpoint with real time slots

**v0.4.0 also ships:**
- **`IdentityPool`** — long-running session and identity rotation. An identity is the union of cookies, localStorage, proxy, device profile, behavior profile, locale, and timezone. Persists to a JSON file so identities survive restarts. Per-domain burn list — an identity blocked on one site is still eligible for others. Composes `SnapshotManager` and `ProxyPool` with a feedback loop that auto-bans burned identities' proxies in the pool. See **[docs/identity-pool.md](docs/identity-pool.md)**.
- **`BlackTipConfig.requireResidentialIp`** — `'throw'` / `'warn'` / `false`. Runs `bt.checkIpReputation()` on launch and refuses (or warns) if the egress IP is on a known datacenter ASN. The launch-time defensive companion to `IdentityPool`'s outbound proxy selection.
- **Go-based TLS side-channel daemon (`bt.fetchWithTls`)** that performs HTTP requests with a real Chrome TLS ClientHello, H2 frame settings, and frame order via `bogdanfinn/tls-client`. Use to make gating requests the browser can't make through itself, then inject the resulting cookies into the browser session before navigating. JA4 `t13d1516h2_8daaf6152771_d8a2da3f94cd`, GREASE first cipher, exact Chrome H2 fingerprint. See **[docs/tls-side-channel.md](docs/tls-side-channel.md)**.
- **Behavioral profile calibrated against the real CMU Keystroke Dynamics dataset.** **53% closer to real human hold-time distribution** than the canonical defaults on a held-out subject set (51 subjects, 80/20 split). See **[docs/calibration-validation.md](docs/calibration-validation.md)** for methodology and reproduction.

See **[docs/anti-bot-validation.md](docs/anti-bot-validation.md)** for the live multi-vendor scoreboard with vendor-signal verification (proves each target is actually protected, not a false negative on an unprotected URL).

---

## Install

```bash
npm install @rester159/blacktip
npx patchright install chrome   # install the Chromium backend patchright uses
```

Or pin to a local checkout during development:

```json
{
  "dependencies": {
    "@rester159/blacktip": "link:../blacktip"
  }
}
```

Run `npm install` once, then any change you make to BlackTip's compiled `dist/` is instantly visible to the consuming app (see *Local development* below).

---

## Quick start

```typescript
import { BlackTip } from '@rester159/blacktip';

const bt = new BlackTip({
  logLevel: 'info',
  timeout: 10_000,
  retryAttempts: 2,
  deviceProfile: 'desktop-windows',
  behaviorProfile: 'human',
});

await bt.launch();
await bt.navigate('https://example.com');
await bt.waitForStable();
await bt.type('input[name="email"]', 'you@example.com', { paste: true });
await bt.click('button[type="submit"]');   // importance auto-detected as high
await bt.waitForText('Welcome');
await bt.close();
```

## Agent mode (recommended)

For LLM-driven flows, use the TCP serve mode. Start the server once and send commands to it. Each response is a JSON bundle with the result, current URL, page title, and a base64 screenshot.

```bash
# Terminal 1: start the server
npx blacktip serve

# Terminal 2: drive it
npx blacktip send "await bt.navigate('https://example.com')" --pretty
npx blacktip send "await bt.clickText('Sign in')" --pretty
npx blacktip send --file login.js --pretty
```

MFA handling:

```typescript
// Inside a command sent to the server:
const code = await bt.pauseForInput({ prompt: 'Enter SMS code', validate: /^\d{6}$/ });
await bt.type('input[name="credentials.passcode"]', code, { paste: true });
```

When BlackTip hits `pauseForInput`, it sends a `{paused:true, pauseId, prompt}` frame to your client and waits. You relay the prompt to the user, get their answer, then resume:

```bash
npx blacktip resume pause-1712345678-12345 "116170"
```

See `AGENTS.md` for the full agent-facing reference, including the decision tree for common situations and the list of mistakes to avoid.

---

## Core API

| Method | Purpose |
|---|---|
| `bt.launch()` / `bt.close()` | Lifecycle |
| `bt.navigate(url, opts?)` | Go to URL |
| `bt.click(selector, opts?)` | Click by CSS/XPath. Auto-dismisses overlays, verifies interactive hit, applies importance hesitation. |
| `bt.clickText(text, {nth?, exact?, importance?})` | Click by visible text. Auto-detects "Submit"/"Pay"/"Confirm" as high importance. |
| `bt.clickRole(role, {name?})` | Click by ARIA role |
| `bt.type(selector, text, {paste?, importance?})` | Type into input. Uses `keyboard.type` for React/Angular compat, falls back to `fill()` if framework didn't register. |
| `bt.select(selector, value)` | Select `<option>` by value OR label |
| `bt.scroll({direction, amount})` | Scroll with natural deceleration |
| `bt.screenshot({path?})` | PNG or JPEG |
| `bt.waitForStable({networkIdleMs, domIdleMs, maxMs})` | Wait for page to settle — replaces fixed sleeps |
| `bt.waitForText(text, {timeout})` | Wait for text to appear in body innerText |
| `bt.waitFor(selector, {timeout, visible?})` | Wait for element |
| `bt.inspect(selector)` | `{exists, visible, tagName, text, attributes, boundingBox}` in one call |
| `bt.listOptions(buttonIdOrSelector)` | Enumerate Angular-style custom dropdowns |
| `bt.networkSince(ms, pattern?)` | Recent network requests filtered by URL pattern |
| `bt.didRequestFireSince(pattern, ms)` | Boolean: did a matching request fire? |
| `bt.dismissOverlays()` | Hide fixed/sticky overlays (chat widgets, cookie banners, Medallia, etc.) |
| `bt.extractText(selector, {multiple?})` | Get innerText |
| `bt.extractAttribute(selector, attr)` | Get attribute value |
| `bt.extractTable(selector)` | Parse `<table>` into row objects |
| `bt.findInShadowDom(cssSelector, {timeout?})` | Pierce open shadow roots |
| `bt.uploadFile(selector, path)` | File upload |
| `bt.download(selector, {saveTo})` | Click-to-download with metadata |
| `bt.frame(selector)` / `bt.frames()` | Iframe context (Stripe Elements, Braintree Hosted Fields) |
| `bt.getTabs()` / `bt.newTab()` / `bt.switchTab(i)` / `bt.closeTab(i?)` | Tab management |
| `bt.cookies()` / `bt.setCookies()` / `bt.clearCookies()` | Cookie jar |
| `bt.executeJS(script)` | Raw JS evaluation |
| `bt.pauseForInput({prompt, validate?, timeoutMs?})` | User-in-the-loop (MFA) |
| `bt.captureFingerprint()` | TLS / HTTP2 / header snapshot via tls.peet.ws + httpbin (v0.2.0) |
| `bt.checkIpReputation()` | Egress IP, ASN, datacenter/residential heuristic (v0.2.0) |
| `bt.testAgainstAkamai(url)` | Akamai-protected target probe with diagnosis (v0.2.0) |
| `bt.testAgainstAntiBot(url)` | Multi-vendor probe — detects Akamai, DataDome, Cloudflare, PerimeterX, Imperva, Kasada, Arkose, plus vendor signals on a passing page (v0.2.0) |
| `bt.fetchWithTls(req)` | Perform an HTTP request via a Go-based `bogdanfinn/tls-client` daemon with a real Chrome TLS ClientHello, H2 frame settings, and frame order. Use for first-request edge gating and cross-platform UA spoofing. Requires the daemon binary at `native/tls-client/` (build with `go build .`) (v0.3.0) |
| `bt.injectTlsCookies(resp, targetUrl?)` | Inject cookies returned by `fetchWithTls()` into the browser session, filtered by target eTLD+1 (v0.3.0) |
| `bt.solveAkamaiChallenge(url)` | Solve Akamai's sensor challenge in the browser once, return cookies + recommended headers ready for replay via `fetchWithTls()`. ~5x speedup over per-call browser usage on protected APIs. (v0.5.0) |
| `bt.getTlsRewriterStats()` | Stats for the TLS rewriter when `tlsRewriting: 'all'` is set — intercepted/fulfilled/fell-through counts, WebSocket leaks, average daemon round-trip. (v0.5.0) |

Plus `IdentityPool` (v0.4.0) for long-running session and identity rotation across many flows. See **[docs/identity-pool.md](docs/identity-pool.md)**.

**`BlackTipConfig.tlsRewriting: 'all'`** (v0.5.0) — when set, every browser request is intercepted via CDP `Fetch.enable` and forwarded through the Go-based `bogdanfinn/tls-client` daemon. The browser never opens an upstream TCP connection — every wire request, including subresources, presents real Chrome TLS via Go. Cross-platform UA spoofing is restored. See **[docs/tls-rewriting.md](docs/tls-rewriting.md)**.
| `bt.warmSession({sites?, dwellMsRange?})` | Pre-target warm-up — visit normal sites first (v0.2.0) |
| `bt.serve(port?)` | Start TCP command server |

Plus `SnapshotManager`, `ProxyPool`, `attachObservability`, and the calibration module — see the TypeScript types for details.

### Akamai Bot Manager

As of v0.2.0, BlackTip passes Akamai Bot Manager on validated targets including OpenTable. The headline fix (L016) was a User-Agent / Sec-Ch-Ua client hint consistency bug that had been silently undermining stealth against top-tier commercial detectors since v0.1.0. See **[docs/akamai-bypass.md](docs/akamai-bypass.md)** for the full plan, methodology, current status by detection layer, and a troubleshooting checklist for users who hit blocks.

Quick verification that you're on a fixed build:

```typescript
const fp = await bt.captureFingerprint();
if (!fp.headers.uaConsistent) {
  throw new Error('UA / Sec-Ch-Ua mismatch — upgrade BlackTip to v0.2.0+');
}
```

---

## Configuration

```typescript
new BlackTip({
  logLevel: 'info' | 'debug' | 'warn' | 'error',
  timeout: 10_000,
  retryAttempts: 2,
  deviceProfile: 'desktop-windows' | 'desktop-macos' | 'desktop-linux',
  behaviorProfile: 'human' | 'scraper' | ProfileConfig,
  headless: false,  // Always runs headful via channel:'chrome'
  locale: 'en-US',
  timezone: 'America/New_York',
  screenResolution: { width: 1920, height: 1080 },
  proxy: 'http://user:pass@host:port',
  chromiumPath: '/custom/chrome',
  // v0.2.0 — persistent Chrome profile for cookies/history continuity
  // across BlackTip runs. Critical for sites with "first request from
  // unknown session" challenges (Akamai, DataDome, PerimeterX).
  userDataDir: './.bt-profile',
});
```

---

## Local development

If you're iterating on BlackTip alongside a consuming app:

```bash
# In the BlackTip directory — leave this running
npm run dev   # alias for tsc --watch

# In the consuming app's package.json
{
  "dependencies": {
    "@rester159/blacktip": "link:../blacktip"
  }
}

# Install once
npm install
```

Changes to BlackTip's `.ts` files recompile to `dist/` on save, and the consuming app sees them instantly via the symlink.

---

## Server deployment

BlackTip runs real Chrome in headful mode — on servers you use **Xvfb** (virtual X framebuffer) so Chrome renders to a virtual display instead of a physical monitor. This is the standard approach used by every serious stealth tool; running Chrome with `--headless` is NOT supported because headless mode is detectable at many fingerprint levels.

The repo ships production-ready deployment artifacts:

- **`Dockerfile`** — production image with Chrome Stable, Xvfb, Node 20, and all runtime dependencies. Build with `docker build -t blacktip:latest .`.
- **`docker-compose.yml`** — one-command local / dev environment. `docker compose up --build`.
- **`deploy/systemd/xvfb.service`** and **`deploy/systemd/blacktip.service`** — systemd unit files for bare-metal VPS deployments.
- **`deploy/README.md`** — full deployment guide covering Docker, systemd, AWS / GCP / DigitalOcean / Hetzner / Fly.io, sizing, cost, monitoring, and troubleshooting.

**Quick Docker start:**

```bash
docker build -t blacktip:latest .
docker run --rm -it \
  --shm-size=2gb \
  --cap-add=SYS_ADMIN \
  -p 9779:9779 \
  blacktip:latest
```

**Quick bare-metal start (Ubuntu 22.04):**

```bash
# System deps + Chrome + Node
sudo apt-get update && sudo apt-get install -y xvfb libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libxss1 libasound2 fonts-liberation libvulkan1
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install -y /tmp/chrome.deb

# Run under Xvfb
export DISPLAY=:99
Xvfb :99 -screen 0 1920x1080x24 &
node your-app.js
```

See **[deploy/README.md](deploy/README.md)** for the full guide including systemd setup, cloud provider specifics, resource sizing, and troubleshooting.

---

## What BlackTip is NOT

- **Not an agent.** It doesn't plan or decide. A human or an LLM drives it.
- **Not a headless mode tool.** Always runs headful via real Chrome. There is no `headless: true` path that passes serious detectors.
- **Not a captcha solver.** It doesn't solve captchas. You can integrate a solver service (2captcha, CapSolver, Anti-Captcha) on top.
- **Not a scraper framework.** No URL queues, no robots.txt compliance built in, no rate limiting — those are the caller's responsibility.
- **Not a guarantee.** No stealth tool is. It passes every free detector and matches commercial tools on ~85-90% of checks, but the detection landscape updates constantly.

---

## Acceptable use

BlackTip is dual-use. It is appropriate for:

- **Authorized penetration testing** (under formal scope agreements)
- **Security research** (browser fingerprinting, anti-bot research, academic work)
- **Your own accounts** on services whose Terms of Service you have accepted
- **Legitimate automation** where the site's ToS permits automated access
- **Defensive work** (bot detection development — running BlackTip against your own site to see what slips through)

It is NOT appropriate for:

- Unauthorized access to any system
- Circumventing paywalls or subscription limits
- Scraping sites that explicitly forbid automation in their ToS
- Fraud, impersonation, or identity-related offenses
- Harassment or spam automation
- Any activity that would violate the Computer Fraud and Abuse Act or equivalent laws in your jurisdiction

The authors disclaim responsibility for misuse. If you're unsure whether your use case is legitimate, it probably isn't.

---

## License

MIT. See `LICENSE`.
