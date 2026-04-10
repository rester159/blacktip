# AGENTS.md — BlackTip for AI agents

**Read this before driving BlackTip.** This file is shipped with every BlackTip install and is designed to be auto-loaded by agent frameworks (Claude Code, Cursor, aider, etc.) as context for the consuming project. If you are an LLM-backed agent, treat this as the user manual.

BlackTip is a browser instrument. YOU are the agent. BlackTip provides the hands; you provide the brain.

---

## The core loop

1. **Read the source documents first.** If the user gave you a PDF, image, or file to submit, read it BEFORE touching the browser. Extract names, dates, amounts, IDs. Never guess.
2. **Start the server.** `npx blacktip serve` (or create a `BlackTip` instance and call `await bt.serve(port)`).
3. **Send one command at a time.** After each command, read the returned bundle: `{ok, result, url, title, screenshotPath, screenshotB64, durationMs}`.
4. **Look at the screenshot.** The returned `screenshotB64` (or the saved file at `screenshotPath`) is the ground truth for what the page currently looks like. Do NOT pre-script a sequence of steps — look, decide, act, repeat.
5. **Ask when uncertain.** Don't guess credentials, form values, patient names, account types, or confirmation decisions. Ask the user.

---

## Rules (always follow)

### 1. Read input documents before opening the browser

If the user provides a bill, form, or screenshot, extract all relevant data first. Every minute spent understanding the source saves ten minutes of corrections in the browser. This rule is non-negotiable.

### 2. Screenshot between every decision

BlackTip's `send` response includes a base64 screenshot of the page after each command. Look at it before deciding the next step. The page may have changed, loaded slowly, or shown an error you didn't expect. Do NOT assume the next step works because the last one did.

### 3. Use `clickText()` for visible text, `click()` for selectors

- `bt.clickText("Sign in", { nth: 0 })` — uses Playwright's locator API. Correctly handles React, Angular, Okta, and other framework-driven components. Prefer this over CSS selectors when the text is visible on the page.
- `bt.click("#submit-btn")` — use when you have a reliable CSS or XPath selector.
- `bt.clickRole("button", { name: "Submit" })` — use for ARIA-role-based matches.

All three auto-detect high-importance actions (submit, pay, confirm, place order, delete, etc.) and apply longer pre-action hesitation. You can override with `importance: 'low' | 'normal' | 'high'`.

### 4. Use `paste: true` for form filling

`bt.type(selector, text, { paste: true })` uses Playwright's `fill()` which correctly triggers React/Angular synthetic events. This is the fast path and should be your default for form fields.

Without `paste: true`, BlackTip simulates keystroke-by-keystroke typing with digraph-aware timing and occasional typos. Slower but looks more human. Use when a site profiles typing dynamics.

### 5. Use `inspect()` to diagnose selectors

When a click or type fails, use `bt.inspect(selector)` before retrying. It returns `{exists, visible, tagName, text, attributes, boundingBox}` — one call replaces several hand-written `executeJS` queries.

### 6. Use `listOptions()` for Angular/React custom dropdowns

Custom dropdowns are NOT `<select>` elements. Pattern:

```js
await bt.click("#state-dropdown_button");               // Open the combobox
const options = await bt.listOptions("#state-dropdown"); // List options
// options: [{id: "state-dropdown_option-0", text: "Alabama"}, ...]
await bt.click(options.find(o => o.text === "California").id);
```

### 7. Use `waitForStable()` instead of fixed sleeps

Don't write `await new Promise(r => setTimeout(r, 3000))`. That's always wrong — either too short (you miss the event) or too long (you waste time). Use:

- `await bt.waitForStable({ networkIdleMs: 500, domIdleMs: 500 })` — page has settled
- `await bt.waitForText("Success", { timeout: 10000 })` — wait for a specific string
- `await bt.waitFor("#some-selector", { timeout: 10000 })` — wait for an element

### 8. Check `didRequestFireSince` before retrying risky clicks

If a click might have burned a rate-limited or lockout-protected attempt (password, 2FA, payment), check whether the submit actually reached the server:

```js
await bt.click(".submit-password");
const submitted = await bt.didRequestFireSince(/idp\/idx\/challenge\/answer/, 3000);
if (!submitted) {
  // The click didn't fire. Safe to retry.
} else {
  // It DID fire. Check if it succeeded before retrying.
}
```

This is how you avoid locking an account after a "did my click work?" moment.

### 9. Use `dismissOverlays()` proactively on sites with chat widgets

Chat widgets, cookie banners, and "we value your feedback" modals intercept clicks. `bt.dismissOverlays()` hides known overlay patterns (Intercom, Drift, Zendesk, OneTrust, Medallia, generic cookie consent) and returns the count hidden. Call it once after navigation on sites that have these, then proceed normally.

BlackTip's `click` / `clickText` / `clickRole` also auto-detect interception and auto-dismiss overlays before retrying, so in most cases you don't need to call it explicitly.

### 10. MFA: use `pauseForInput`

When you hit an MFA / OTP / verification code prompt:

```js
await bt.click(".send-sms-button");
const code = await bt.pauseForInput({
  prompt: 'Enter the SMS code sent to your phone',
  validate: /^\d{6}$/,
  timeoutMs: 300_000,
});
await bt.type('input[name="code"]', code, { paste: true });
await bt.click(".verify");
```

The BlackTip server sends a `{paused:true, pauseId, prompt}` frame to the client. The client (you) relays the prompt to the user, collects their answer, and resumes with:

```bash
npx blacktip resume <pauseId> "<value>"
```

### 11. Fail fast

Use `timeout: 10000` and `retryAttempts: 2` as defaults. If an action fails, inspect the page with `bt.inspect()` and a screenshot rather than retrying blindly. Blind retries on lockout-protected forms burn attempts you cannot get back.

### 12. Ask before destructive or irreversible actions

Before clicking Submit on a form that can't be unsent (insurance claim, payment, purchase, account deletion, account creation with verified email), **stop and ask the user to confirm**. Show them the filled-in state from the screenshot. Wait for an explicit "confirmed" / "submit" / "go" before proceeding.

### 13. Never guess secrets

Passwords, MFA codes, payment details, SSNs, routing numbers, patient information — if the user didn't give it to you explicitly, ask. Don't infer from memory, don't infer from session state, don't pattern-match from other accounts.

---

## Common mistakes (don't repeat these)

- **Pre-scripting an entire flow.** Breaks on the first unexpected page state. Always look at the screenshot after each step.
- **Using `executeJS("el.click()")` for React/Okta buttons.** DOM clicks don't trigger framework event handlers. Use `clickText()` or `click()` which dispatch real pointer events.
- **Not reading screenshots between actions.** The most common failure mode. If you're not looking at the screenshot, you're flying blind.
- **Guessing form values instead of reading source documents.** Led to submitting the wrong patient name on an Anthem claim during development.
- **Long timeouts (30s+).** You're waiting on a page that's already broken. Fail fast, inspect, adapt.
- **Treating data: URLs as fully functional.** `patchright` blocks inline `<script>` execution on `data:` URLs as a stealth measure. Use `bt.executeJS()` after navigate to set up page state, or use a real HTTP server for fixtures.
- **Retrying a failed login without checking `didRequestFireSince`.** You might have already burned an attempt without realizing it.
- **Calling `.removeAllListeners()` with no argument.** It removes BlackTip's default `error` handler and Node's EventEmitter will crash on the next emitted error. Use `.removeAllListeners('action')` per-event instead.
- **Not clearing prior drafts on form-heavy sites.** Some sites (Anthem, insurance portals) save drafts automatically. Check for and delete stale drafts before starting a new submission if the site supports it.
- **Assuming BlackTip handles headless.** It doesn't. Every profile is headful. `headless: true` in config is ignored.

---

## Decision tree: common situations

**"I clicked Next but the page didn't change."**

1. Take a new screenshot via `bt.screenshot({path:'shot.png'})`. Look carefully — sometimes the page DID change and the error is a banner on top of the same layout.
2. Check the URL: `bt.executeJS('location.href')`.
3. Check if a request fired: `bt.didRequestFireSince(/your-endpoint/, 5000)`.
4. If no request fired, the click was swallowed. Try `bt.dismissOverlays()` then click again, or use a direct CSS selector.
5. If a request DID fire and the URL didn't change, there's an error on the page. `bt.extractText('body')` or look at the screenshot for error messaging.

**"I can't find the selector I need."**

1. `bt.inspect('#my-guess')` — verify what you think exists actually does.
2. `bt.executeJS("[...document.querySelectorAll('button')].map(b => ({id: b.id, text: b.textContent.trim().slice(0,40)}))")` — enumerate candidates.
3. For dropdowns, `bt.listOptions('#dropdown-id')` gets the Angular-style option ids.
4. Try `bt.clickText("visible text")` as a fallback — often easier than finding the right CSS.

**"There's a chat widget blocking my click."**

1. `bt.dismissOverlays()` — returns `{hidden: N, selectors: [...]}`.
2. Retry the click. BlackTip's click functions also auto-dismiss before falling back to force-click, so you usually don't need step 1.

**"I'm about to click Submit on something important."**

1. Take a screenshot first. Read it carefully.
2. Summarize to the user what's about to happen (which patient, which amount, which destination).
3. Wait for explicit confirmation.
4. Only then click. Use `importance: 'high'` is auto-applied for buttons labeled Submit/Pay/Confirm, so you don't need to pass it manually.

**"The flow hits MFA."**

1. Click the "send code" button.
2. Call `bt.pauseForInput({prompt: 'Enter SMS code', validate: /^\d{6}$/})`.
3. The BlackTip server forwards the prompt to your client. You relay it to the user.
4. When the user provides the code, call `npx blacktip resume <pauseId> "<code>"` (or send `RESUME <id>\n<value>` to the TCP socket).
5. The paused command resumes with the code and you proceed.

**"I'm uncertain whether a previous step succeeded."**

Don't retry blindly. Use:
- `bt.didRequestFireSince(pattern, ms)` for network-level confirmation
- `bt.waitForText(expectedText, {timeout})` for content-level confirmation
- `bt.inspect(selector).attributes` for state-level confirmation

---

## Server mode protocol

Every `send` returns a JSON bundle (one line, DELIMITER `\n__END__\n`):

```json
{
  "ok": true,
  "result": <return value of the JS command, if any>,
  "url": "https://current.page/",
  "title": "Current Page Title",
  "screenshotPath": "shot.png",
  "screenshotB64": "<base64 PNG>",
  "screenshotBytes": 41234,
  "durationMs": 432
}
```

On error:

```json
{
  "ok": false,
  "error": "Error message",
  "url": "https://where.it.failed/",
  "screenshotPath": "shot.png",
  "screenshotB64": "<base64 PNG>",
  "durationMs": 1234
}
```

On pause:

```json
{
  "ok": true,
  "paused": true,
  "pauseId": "pause-1712345678-12345",
  "prompt": "Enter the SMS code"
}
```

You respond with a `RESUME <pauseId>\n<value>` frame (ended with `\n__END__\n`) and the paused command continues.

Batch mode accepts a `BATCH\n<json array of commands>` frame and returns `{ok, bundles: [bundle, bundle, ...]}` — useful for pipelining linear flows without per-command round trips.

---

## Behavioral knobs

- `behaviorProfile: 'human'` — realistic timings (default for agent use)
- `behaviorProfile: 'scraper'` — faster, less human, used in tests
- `importance: 'high'` on `click` / `clickText` / `type` — longer pre-action hesitation. Auto-applied when button text matches common submit/pay/confirm patterns.
- `bt.waitForStable({networkIdleMs: 500, domIdleMs: 500})` — better than fixed sleeps
- `bt.generateReadingPause(textLength)` — estimate how long a human would take to read a block of text, returned as milliseconds

---

## Things BlackTip will not do for you

- **It will not log you in.** You tell it the username and password.
- **It will not read your SMS.** It pauses and asks you via `pauseForInput`.
- **It will not solve captchas.** You integrate a solver if needed.
- **It will not write tests for your flow.** That's still your job.
- **It will not understand intent.** `bt.clickText("Submit")` clicks "Submit" — it doesn't verify that clicking "Submit" is the right thing to do in your context.

If you want an opinion from the tool, you're asking the wrong tool. BlackTip provides primitives; the agent is the planner.
