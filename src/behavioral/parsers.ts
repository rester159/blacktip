/**
 * Dataset parsers for behavioral calibration.
 *
 * The calibration scaffold (`./calibration.ts`) defines normalized
 * `MouseMovement` and `TypingSession` shapes plus distribution fitters.
 * What was missing through v0.2.0 was the bridge from real public datasets
 * into those shapes — without parsers, the scaffold required every user
 * to write their own ETL, which kept "Tier 2 behavioral calibration" on
 * the deferred list.
 *
 * This module ships parsers for the two datasets we point users at
 * most often:
 *
 *   1. **CMU Keystroke Dynamics** (Killourhy & Maxion, 2009).
 *      Free for research. CSV format with columns `subject`, `sessionIndex`,
 *      `rep`, then for the fixed phrase `.tie5Roanl` a tuple of
 *      `H.<key>` (hold), `DD.<k1>.<k2>` (down-down latency), and
 *      `UD.<k1>.<k2>` (up-down = flight time). 51 subjects × 8 sessions
 *      × 50 repetitions = 20,400 phrases.
 *
 *   2. **Balabit Mouse Dynamics Challenge** (Antal & Egyed-Zsigmond, 2014).
 *      Free for research. Per-session CSV with columns
 *      `record_timestamp`, `client_timestamp`, `button`, `state`, `x`, `y`.
 *      Each row is a single mouse event; consecutive `Mouse` rows
 *      followed by a `Pressed` row form one movement.
 *
 * Plus a generic JSON loader for users with their own telemetry exported
 * in the `MouseMovement` / `TypingSession` shapes directly.
 *
 * The parsers do NOT download the datasets — both have ToS that say "do
 * not redistribute". Users acquire the data themselves and feed the file
 * contents in as a string. We just turn raw text into normalized samples.
 */

import type { KeystrokeSample, MouseMovement, MouseSample, TypingSession } from './calibration.js';

// ── CMU Keystroke Dynamics ──

/** The fixed phrase typed by every CMU subject. Used to map column index → key. */
export const CMU_PHRASE = '.tie5Roanl';

/**
 * Parse the CMU Keystroke Dynamics CSV (DSL-StrongPasswordData.csv).
 *
 * Each row is one repetition of the phrase `.tie5Roanl` plus Return,
 * yielding 11 keys, 11 hold-times, 10 down-down and 10 up-down latencies.
 * We normalize each row into one `TypingSession` of 11 keystrokes.
 *
 * The CSV looks like:
 *   subject,sessionIndex,rep,H.period,DD.period.t,UD.period.t,H.t,DD.t.i,UD.t.i,H.i,...
 *   s002,1,1,0.1491,0.3979,0.2488,0.1069,0.1674,0.0605,...
 *
 * All time values are in **seconds** in the source file; we convert to
 * milliseconds.
 *
 * Returns one `TypingSession` per CSV row. Pass these straight into
 * `fitTypingDynamics()`.
 */
export function parseCmuKeystrokeCsv(csvText: string): TypingSession[] {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0]!.split(',').map((h) => h.trim());
  // Build column index maps for the H.<key> (hold) and UD.<k1>.<k2> (flight) columns.
  // We use UD (up-down) as flight time: time from previous key release to next key down.
  const holdIdx = new Map<number, number>(); // keyIndex → column
  const flightIdx = new Map<number, number>(); // keyIndex (1..n-1) → column

  // The phrase keys, in order. The CMU dataset includes Return at the
  // end, so the full key sequence is `.tie5Roanl` plus Enter (column
  // labeled `Return` in the source).
  const keys = [...CMU_PHRASE.split(''), 'Return'];
  for (let i = 0; i < keys.length; i++) {
    const key = cmuKeyLabel(keys[i]!);
    const colName = `H.${key}`;
    const idx = header.indexOf(colName);
    if (idx >= 0) holdIdx.set(i, idx);
  }
  for (let i = 1; i < keys.length; i++) {
    const prev = cmuKeyLabel(keys[i - 1]!);
    const cur = cmuKeyLabel(keys[i]!);
    const colName = `UD.${prev}.${cur}`;
    const idx = header.indexOf(colName);
    if (idx >= 0) flightIdx.set(i, idx);
  }

  const sessions: TypingSession[] = [];
  for (let rowIdx = 1; rowIdx < lines.length; rowIdx++) {
    const cells = lines[rowIdx]!.split(',');
    if (cells.length < 4) continue;

    const keystrokes: KeystrokeSample[] = [];
    for (let i = 0; i < keys.length; i++) {
      const holdCol = holdIdx.get(i);
      const flightCol = flightIdx.get(i);
      const holdSec = holdCol != null ? parseFloat(cells[holdCol] ?? '') : NaN;
      const flightSec = i === 0 ? 0 : flightCol != null ? parseFloat(cells[flightCol] ?? '') : NaN;
      if (!Number.isFinite(holdSec)) continue;

      keystrokes.push({
        key: keys[i]!,
        flightTimeMs: Number.isFinite(flightSec) ? Math.max(0, flightSec * 1000) : 0,
        holdTimeMs: Math.max(0, holdSec * 1000),
      });
    }
    if (keystrokes.length > 0) {
      sessions.push({ keystrokes, phrase: CMU_PHRASE });
    }
  }
  return sessions;
}

/**
 * CMU's CSV uses specific labels for non-letter keys:
 *   - `.` → `period`
 *   - `5` → `five` (the dataset spells digits out)
 *   - `R` (capital, requires Shift) → `Shift.r`
 *   - Return → `Return`
 *   - lowercase letters are bare
 */
function cmuKeyLabel(ch: string): string {
  if (ch === '.') return 'period';
  if (ch === '5') return 'five';
  if (ch === 'Return') return 'Return';
  if (ch === 'R') return 'Shift.r';
  return ch;
}

// ── Balabit Mouse Dynamics ──

/**
 * Parse a single Balabit Mouse Dynamics session CSV.
 *
 * Each row is one mouse event:
 *   record_timestamp,client_timestamp,button,state,x,y
 *   1424866316.93,0.000,NoButton,Move,1192,529
 *   1424866316.99,0.064,NoButton,Move,1183,532
 *   ...
 *   1424866317.84,0.911,Left,Pressed,820,440
 *
 * We segment into movements: each contiguous run of `Move`/`Drag` rows
 * followed by a `Pressed` row becomes one `MouseMovement`. The press row
 * is the click target. Movements that don't end in a press are also
 * recorded but with `endedWithClick: false` — these are navigation moves.
 *
 * Time is normalized to milliseconds since the first sample of the
 * movement.
 */
export function parseBalabitMouseCsv(csvText: string): MouseMovement[] {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  // Header detection — Balabit ships either with or without a header row.
  let startIdx = 0;
  if (/[A-Za-z]/.test(lines[0]!.split(',')[0] ?? '')) startIdx = 1;

  const movements: MouseMovement[] = [];
  let current: MouseSample[] = [];
  let currentStart: number | null = null;

  const flush = (endedWithClick: boolean): void => {
    if (current.length >= 2) {
      movements.push({ samples: current, endedWithClick });
    }
    current = [];
    currentStart = null;
  };

  for (let i = startIdx; i < lines.length; i++) {
    const cells = lines[i]!.split(',');
    if (cells.length < 6) continue;

    const clientTs = parseFloat(cells[1] ?? '');
    const state = (cells[3] ?? '').trim();
    const x = parseFloat(cells[4] ?? '');
    const y = parseFloat(cells[5] ?? '');
    if (!Number.isFinite(clientTs) || !Number.isFinite(x) || !Number.isFinite(y)) continue;

    const tMs = clientTs * 1000;
    if (currentStart == null) currentStart = tMs;

    if (state === 'Move' || state === 'Drag') {
      current.push({ timestampMs: tMs - currentStart, x, y });
    } else if (state === 'Pressed') {
      // Treat the press location as the target.
      current.push({
        timestampMs: tMs - currentStart,
        x,
        y,
        targetX: x,
        targetY: y,
        // Balabit doesn't ship target widths — leave undefined so the
        // Fitts' Law fitter skips these and falls back to canonical values.
      });
      flush(true);
    } else if (state === 'Released') {
      // End-of-click; ignore.
    } else {
      // Scroll, etc. — terminate any in-flight movement.
      flush(false);
    }
  }
  // Flush trailing movement if any
  flush(false);

  return movements;
}

// ── Generic JSON loader ──

/**
 * Generic loader for users who already export their telemetry in the
 * normalized shapes. Accepts JSON of the form:
 *
 *   { "movements": MouseMovement[], "sessions": TypingSession[] }
 *
 * Either field may be absent. Returns the parsed object with empty
 * defaults filled in. This is the "bring your own data" path — most
 * production users will write a tiny exporter on their own telemetry
 * pipeline that emits this shape, then feed it through `fitFromSamples()`.
 */
export function parseGenericTelemetryJson(jsonText: string): {
  movements: MouseMovement[];
  sessions: TypingSession[];
} {
  const parsed = JSON.parse(jsonText) as {
    movements?: MouseMovement[];
    sessions?: TypingSession[];
  };
  return {
    movements: Array.isArray(parsed.movements) ? parsed.movements : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
  };
}
