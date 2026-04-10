# Changelog

All notable changes to **BlackTip** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-04-10

### First public release

BlackTip is a stealth browser instrument for AI agents. Real Chrome via `patchright` with CDP-level stealth patches, human-calibrated behavioral simulation, and an agent-friendly TCP serve protocol with bundled JSON responses. Passes every free fingerprint detector tested and known public Cloudflare bot-fight test targets.

### Added — core architecture

- **Real Chrome via `channel: 'chrome'`** — uses the installed Chrome Stable binary for an authentic TLS ClientHello with rotating GREASE values and a native HTTP/2 frame order. No TLS proxy required for most use cases.
- **`patchright`-based CDP stealth** — drop-in Playwright replacement with patches that neutralize `Runtime.Enable` detection, automation string artifacts, and Error-stack hooks that vanilla Playwright leaks.
- **Device profiles** — `desktop-windows`, `desktop-macos`, `desktop-linux` with matching user agents, hardware concurrency, plugins, fonts, and WebGL vendor/renderer strings.
- **Behavioral engine** — Bézier mouse paths with Fitts' Law movement time, digraph-aware typing with realistic typo-and-correction patterns, scroll deceleration curves, normal-distribution sampling via Box-Muller, and reading pause estimation tied to the profile's WPM range.
- **Retry engine** — six-strategy cascade (`standard`, `wait`, `reload`, `altSelector`, `scroll`, `clearOverlays`) with event emission on each retry.
- **Seeded noise layers** — canvas and audio fingerprints receive profile-seeded noise via Mulberry32 PRNG so they're stable cross-session but unique per profile, matching how real hardware variance looks.

### Added — agent primitives

- **`bt.waitForStable({networkIdleMs, domIdleMs, maxMs})`** — waits until no network requests and no DOM mutations for a window. Replaces fixed `setTimeout` sleeps with a real page-settled signal.
- **`bt.waitForText(text, {timeout})`** — polls body `innerText` for a target string. For server-rendered confirmations, OCR completion, and async content.
- **`bt.inspect(selector)`** — returns `{exists, visible, tagName, text, attributes, boundingBox}` in one call. Replaces multiple hand-written `executeJS` queries for diagnostics.
- **`bt.listOptions(selectorOrBaseId)`** — enumerates Angular/React-style custom dropdown options via the `{baseId}_option-{n}` pattern.
- **`bt.networkSince(ms, pattern?)`** and **`bt.didRequestFireSince(pattern, ms)`** — filtered Performance API resource entries and a boolean convenience for "did my submit actually reach the server?" diagnostics. Critical for avoiding burned retries on lockout-protected forms.
- **`bt.dismissOverlays()`** — proactively hides fixed/sticky overlays matching known patterns (Intercom, Drift, Zendesk, OneTrust, Medallia, cookie banners).
- **`bt.pauseForInput({prompt, validate?, timeoutMs?})`** — first-class MFA / user-in-the-loop support. Emits a `paused` frame to the client via the serve protocol; resumes when the client sends `RESUME <id>\n<value>`.
- **`bt.findInShadowDom(cssSelector, {timeout?})`** — recursive walker over open shadow roots. Supports modern component libraries (Lit, Stencil, Material Web Components).
- **`bt.download(selector, {saveTo})`** — click-to-download with returned `{path, size, suggestedFilename, url}` metadata.

### Added — click robustness

- **Live bounding-box re-read before `mouse.click()`** — re-captures the target's current box immediately before the click. If the element moved more than ~5 pixels during the mouse-movement phase (DOM reflow, async scripts, layout shifts), performs a short correction move so the click lands on the right place. Fixes the L011 coordinate-reflow issue.
- **Pre-click hit verification** — uses `document.elementFromPoint` to verify the click coordinates actually land on the intended interactive element. If an overlay is covering the target, dismisses it and falls back to `locator.click({force: true})`.
- **Auto-importance detection on click/clickText/clickRole** — buttons whose visible text matches `Submit`, `Pay`, `Confirm`, `Place Order`, `Delete`, `Remove`, `Checkout`, `Purchase`, etc. automatically receive `importance: 'high'` which triggers longer pre-action hesitation (2–3× base pause plus a hesitation spike). Matches the long-tail distribution behavioral biometrics systems expect on consequential actions. Callers can override with explicit `importance`.
- **`BlackTipFrame.type()` iframe hardening** — ported the `Control+A + Backspace + keyboard.type + inputValue` verification pattern from the main `type()` method to the iframe variant. Ready for Stripe Elements, Braintree Hosted Fields, and other framework-driven iframes.

### Added — serve mode and CLI

- **Bundled JSON responses** — every `send` command returns `{ok, result, url, title, screenshotPath, screenshotB64, screenshotBytes, durationMs, error?}` in one frame. Cuts round-trips by ~60% for linear flows.
- **Batched commands** — `BATCH\n<json array>` runs multiple commands sequentially and returns an array of bundles, stopping on first failure.
- **CLI flags** — `--file <path>`, `--stdin`, `--pretty`, `--port` eliminate shell-escape hell for complex JavaScript commands.
- **`npx blacktip` subcommands** — `serve`, `send`, `batch`, `resume`, `pending`, `exec` with per-command help.

### Added — infrastructure

- **`ProxyPool`** — round-robin / random / least-used strategies, per-domain ban tracking with decay window, reputation snapshot for observability, URL formatters for BrightData / Oxylabs / Smartproxy.
- **`SnapshotManager`** — `capture()` and `restore()` for session migration across proxies or machines. Serializes cookies, localStorage, sessionStorage, and active URL into a JSON blob.
- **Observability** — `attachObservability(bt, exporters)` wires BlackTip's EventEmitter events into a `StructuredEvent` shape compatible with OpenTelemetry attribute data model. Ships `JsonlFileExporter` and `ConsoleExporter` as reference implementations. No OTel SDK dependency.
- **Behavioral calibration scaffold** — `src/behavioral/calibration.ts` with `fitDistribution`, `fitFittsLaw` (OLS), `fitMouseDynamics`, `fitTypingDynamics`, `fitFromSamples`, `deriveProfileConfig`. Ready to ingest real mouse-dynamics and keystroke-dynamics datasets (Balabit Mouse Dynamics Challenge, CMU Keystroke Dynamics, GREYC-NISLAB) via user-supplied parser wrappers.

### Detector results

Captured against free public detectors as of the release:

- **bot.sannysoft.com** — 31 passed / 0 failed across 57 rows
- **tls.peet.ws** — JA4 `t13d1516h2_...`, first cipher rotates `TLS_GREASE (0x...)` matching real Chrome 122/124
- **CreepJS** — Grade A, 0% headless, 0% stealth, 31% like-headless (unavoidable desktop false-positive)
- **browserleaks.com/canvas** — signature shared with 100 of 298,939 browsers (blending in, not unique)
- **browserleaks.com/webgl** — real GPU via ANGLE, not SwiftShader
- **browserleaks.com/webrtc** — no RFC1918 local IP leak
- **browserleaks.com/javascript** — Chrome 122 on Win32, en-US, America/New_York, 1920×1080 all consistent
- **fingerprint.com/demo** — passes
- **pixelscan.net** — passes
- **browserscan.net** — identified as "Chrome on Windows 10", not flagged

Real-target validation:

- **nowsecure.nl** (Cloudflare bot-fight test, nodriver author's public benchmark) — passes without challenge
- **antoinevastel.com/bots** (ex-DataDome VP of Research) — loads without block
- **Anthem.com** (Okta MFA, Angular SPA, real medical claim submission) — full end-to-end flow successful

### Notes

- Always runs headful. `headless: true` in config is silently ignored — there is no real-headless path that passes serious detectors.
- Real Chrome must be installed on the host for the preferred `channel: 'chrome'` path. patchright's bundled Chromium is the fallback.
- Scoped-name fix: the initial planned unscoped name `blacktip` was blocked by npm's anti-typosquatting policy (too similar to the pre-existing `black-tip` package). Released as `@rester159/blacktip` instead.

[Unreleased]: https://github.com/rester159/blacktip/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rester159/blacktip/releases/tag/v0.1.0
