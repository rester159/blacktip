# Contributing to BlackTip

Thanks for considering a contribution. BlackTip is a small project and contributions move fast — I generally read issues and PRs within a day or two.

## Ways to contribute

- **Report a regression.** If a detector that used to pass now flags BlackTip, or a real target that used to work is now challenged, open an issue with the detector name (or target URL) and the specific signal that changed. Attach a screenshot if possible.
- **Report a bug.** If an API method does the wrong thing, open an issue with a minimal reproduction.
- **Submit a detector adapter.** If you're testing BlackTip against a free fingerprint detector I don't cover yet (fingerprint.com, pixelscan, browserscan, iphey, amiunique, etc.), a PR that adds a new test in `tests/evaluation/detector-suite.test.ts` is welcome.
- **Calibrate the behavioral engine.** The `src/behavioral/calibration.ts` module accepts real mouse-dynamics and keystroke-dynamics datasets and produces a `ProfileConfig`. If you have access to a relevant dataset (Balabit, CMU Keystroke, GREYC-NISLAB) and can produce a calibrated profile, a PR that adds it as a pre-calibrated profile option is welcome. Include the source of your data in the PR description.
- **Port to a new browser engine.** BlackTip is Chromium-based. If you want to add a Firefox path alongside the existing Chrome path (via patched Firefox or Camoufox), let's discuss in an issue first — it's a significant architectural change.

## Ways NOT to contribute

- **Do not submit patches that expand stealth in ways specifically designed to defeat legitimate anti-abuse systems** on platforms where the user has no legitimate access. BlackTip's acceptable use is documented in `LICENSE` and `README.md`.
- **Do not submit credential stuffers, CAPTCHA bypass for reCAPTCHA/hCaptcha/Turnstile, or targeted evasions for specific commercial anti-bot vendors' detection logic.** The distinction between legitimate research and targeted bypass is subjective; my rule of thumb is "would the anti-bot vendor consider this a legitimate research finding they'd want to know about, or an exploit they'd want to suppress." If the latter, it doesn't belong here.
- **Do not submit real-site-specific scraping code** (e.g., a prebuilt Amazon scraper using BlackTip). Site-specific code belongs in your own project, not in BlackTip's repo.

## Running the tests locally

```bash
git clone https://github.com/rester159/blacktip.git
cd blacktip
npm install
npx patchright install chrome   # one-time, downloads the Chromium backend

# Fast unit tests only (behavioral engine, calibration, logger)
npm run test:unit

# Full integration suite (spins up real Chrome — slower)
npm run test:integration

# Detector eval suite against public targets (requires network)
npm run eval

# All tests
npm test
```

Expect ~50s for the full non-eval suite. The detector eval takes another ~90s and is network-dependent.

## Local development with a consuming app

If you're iterating on BlackTip alongside an application that imports it:

```bash
# In BlackTip's directory, leave this running in its own terminal
npm run dev   # alias for tsc --watch, auto-recompiles dist/ on save

# In your consuming app's package.json
{
  "dependencies": {
    "@rester159/blacktip": "link:../blacktip"
  }
}

# One-time install
npm install
```

Changes to BlackTip's `src/*.ts` recompile to `dist/` on save, and the consuming app sees them instantly via the `link:` symlink.

## Code style

- TypeScript strict mode. No `any` without a comment explaining why.
- ESM imports only (`import { x } from './y.js'`). Note the `.js` extension even in source `.ts` files — this is required for Node ESM resolution.
- No external dependencies added without a discussion in an issue first. BlackTip's dependency tree is deliberately small (currently just `patchright`); every added dep is a maintenance cost and a supply-chain risk.
- Tests live alongside what they test. Unit tests are `tests/*.test.ts`; integration tests are `tests/**/*.integration.test.ts`; evaluation runs are `tests/evaluation/*.test.ts`.
- Every new feature should ship with tests. The scaffold is in place and test coverage is already decent — match the existing patterns.

## Opening a pull request

1. Fork the repo and create a feature branch (`git checkout -b feature/my-thing`).
2. Write the change.
3. Write or update tests. If you're fixing a bug, add a test that reproduces the bug first, then fix it — this prevents regressions.
4. Run `npm test`. All tests must pass.
5. Run `npx tsc --noEmit` to confirm the type check is clean.
6. Commit with a descriptive message.
7. Push your branch and open a PR against `main`.
8. In the PR description, explain (a) what the change does, (b) why it's needed, and (c) how you tested it.

I generally prefer small, focused PRs over large ones that do multiple things at once.

## Issue triage

When opening an issue, please include:

- **BlackTip version** (`npm list @rester159/blacktip` or the version from `package.json` if you're working from a local checkout)
- **Node version** (`node --version`)
- **OS** (Windows / macOS / Linux — patchright sometimes behaves differently across platforms)
- **A minimal reproduction** — ideally a standalone `.ts` file that shows the problem
- **What you expected to happen**
- **What actually happened** (include error messages, stack traces, or screenshots)

For stealth regressions specifically: please include the detector URL and the specific check that's failing. Just "it's flagged" is hard to act on; "the CreepJS `webDriverIsOn` check now returns `true`" is actionable.

## Security disclosures

If you find a vulnerability that could be used to harm BlackTip users (e.g., a shipped version that leaks credentials, a supply-chain issue with a dependency), **please do not open a public issue**. Email the maintainer directly via the address in `package.json`, or open a private security advisory on GitHub. I'll respond within a few days.

## Code of conduct

Be kind. This is a small project and a small community. I'll moderate if necessary, but the bar is low: don't be abusive, don't harass, don't spam, don't make it hostile for contributors who are newer or less experienced than you are. If someone's behavior makes the repo less welcoming, I'll ask them to stop, and if they don't, I'll remove them.

## License

By submitting a contribution, you agree that your contribution is licensed under the same MIT license as the rest of the project (see `LICENSE`).
