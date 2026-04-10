# Behavioral calibration validation (v0.3.0)

This document records the result of fitting BlackTip's behavioral profile against the real CMU Keystroke Dynamics dataset (Killourhy & Maxion 2009) and validating the fit against held-out subjects.

## TL;DR

The calibrated profile measurably beats BlackTip's canonical `HUMAN_PROFILE` on a held-out subject set:

| Metric | Canonical KS distance | Calibrated KS distance | Improvement |
|---|---|---|---|
| **Hold time** | 0.4297 | 0.2018 | **53% closer to real humans** |
| **Flight time** | 0.4811 | 0.4152 | 13.7% closer to real humans |

This is the first time the BlackTip behavioral pipeline has been validated end-to-end against a real public dataset. Up through v0.2.0, the engine's parameters were sane defaults; v0.3.0 makes them empirically grounded.

## Methodology

1. **Dataset**: CMU Keystroke Dynamics (`DSL-StrongPasswordData.csv`) — 51 subjects each typing the fixed phrase `.tie5Roanl` 50 times across 8 sessions, for 20,400 total phrase reps.
2. **Split**: deterministic 80/20 by subject. 40 subjects (16,000 phrases) → training. 11 subjects (4,400 phrases) → held-out test.
3. **Fit**: training set → `fitTypingDynamics()` → empirical hold-time and flight-time distributions plus per-digraph latencies.
4. **Compare**: synthesized 5,000 samples from each of (a) BlackTip's canonical `HUMAN_PROFILE` ranges and (b) the fitted `[p5, p95]` ranges. Computed Kolmogorov–Smirnov distance (max empirical CDF gap) against the held-out test set.
5. **Report**: lower KS distance → closer to real human distribution.

The KS test is the standard non-parametric goodness-of-fit measure. It does not assume any particular distribution shape, which matters here because keystroke timings are right-skewed log-normal-ish, not Gaussian. The improvement ratio is `1 - calibrated / canonical`.

## Fitted parameters

```
Hold time:
  mean = 90.3 ms
  p5   = 48.3 ms
  p50  = 85.8 ms
  p95  = 148.8 ms

Flight time:
  mean = 151.4 ms
  p5   = 0.0   ms   (some adjacent keystrokes overlap — concurrent press/release)
  p50  = 91.3  ms
  p95  = 513.5 ms

Digraphs fit: 6 (the unique a–z transitions in the phrase)
```

The fitted profile is saved to `data/cmu-keystroke/calibrated-profile.json` and ready to load:

```typescript
import calibrated from './data/cmu-keystroke/calibrated-profile.json' with { type: 'json' };
import { BlackTip } from '@rester159/blacktip';

const bt = new BlackTip({
  behaviorProfile: calibrated.profileConfig,
  // ... rest of your config
});
```

## Why this matters

Behavioral biometrics services (BioCatch, NuData, SecuredTouch) profile users on dimensions like:

- Hold time mean and variance per key
- Flight time distributions per digraph
- Tap pressure (mobile only — n/a here)
- Mouse curvature, click dwell, scroll deceleration

A bot that types with uniform 100 ms holds and flat flight times stands out instantly because real humans have right-skewed log-normal distributions with subject-specific clustering. BlackTip's canonical `HUMAN_PROFILE` was already in the right ballpark, but the canonical hold-time range `[50, 200]` was 53% farther from the real distribution than the empirically-fitted `[48, 149]`. The fitted range is tighter and centered correctly, so BlackTip's keystroke output now sits inside the real human distribution rather than scattered across a too-wide canonical range.

## Reproducing the result

```bash
cd /path/to/blacktip
mkdir -p data/cmu-keystroke
curl -fsSL -o data/cmu-keystroke/DSL-StrongPasswordData.csv \
  https://www.cs.cmu.edu/~keystroke/DSL-StrongPasswordData.csv
npm run build
node scripts/fit-cmu-keystroke.mjs
```

The script writes its output to `data/cmu-keystroke/calibrated-profile.json` and prints the validation table to stdout. Re-runs are deterministic (the train/test split is sorted, not random) so the numbers match this document byte-for-byte.

## What this does NOT prove

- The KS test compares marginal distributions, not joint ones. A profile that matches the marginals perfectly could still have unrealistic correlation structure (e.g. correct hold times but uncorrelated with flight times). A real biometrics test against a commercial service would catch this; we don't have one.
- The CMU dataset is 50 reps of one fixed phrase from each of 51 American English typists. The fitted profile generalises best to American English long-form typing; non-Latin scripts and very short fields may need a different calibration.
- Flight time fit improvement (13.7%) is much smaller than hold time (53%). The CMU phrase is short and contains transitions that aren't representative of free-text typing — the held-out flights span a wide range that the canonical `[80, 150]` and fitted `[0, 514]` are both bad fits for. A larger free-text dataset (e.g. Buffalo or GREYC) would likely produce a better flight fit. Future work.

## Future calibration sources

Once a parser exists for each, the same pipeline applies:

- **Balabit Mouse Dynamics Challenge** — for `fitMouseDynamics()`. Parser exists in `parseBalabitMouseCsv()`; needs an actual fit run against the real dataset.
- **GREYC-NISLAB** — free-text keystroke dynamics from 110 subjects. Better representative coverage than CMU's fixed phrase.
- **Buffalo Free-Text** — multi-session keystroke data across 148 subjects. The canonical reference for keystroke behavioral biometrics literature.
- Your own telemetry — `parseGenericTelemetryJson()` accepts the normalized `MouseMovement` / `TypingSession` shapes directly. Bring your own data.
