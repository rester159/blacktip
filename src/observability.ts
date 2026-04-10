/**
 * Observability — structured event schema and reference exporters.
 *
 * Design goals:
 *   1. Every BlackTip event (action, retry, error, tabChange, log) must
 *      be serializable into a shape that maps 1:1 onto OpenTelemetry
 *      span attributes, without requiring the OTel SDK as a dependency.
 *   2. Callers who want OTel can bridge these events into their own
 *      SDK in ~20 lines.
 *   3. Callers who just want tail-a-file observability can use the
 *      built-in JSONL file sink.
 *
 * We do NOT ship the OTel SDK because pulling it in would roughly
 * double the install footprint and most users of BlackTip don't need
 * it. Instead we define the event schema so bridging is trivial.
 */

import type { BlackTip } from './blacktip.js';
import type { ActionEvent, RetryEvent, ErrorEvent, TabChangeEvent, LogEntry } from './types.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Structured event — the canonical shape every BlackTip event reduces
 * to when exported. Mirrors OpenTelemetry's span data model loosely:
 *
 *   - timestamp: ISO-8601, the event time
 *   - name: short event name, e.g. "action.click", "retry.strategy"
 *   - severity: info/warn/error for filtering
 *   - attributes: flat key-value pairs (values are strings, numbers,
 *     or booleans — no nested objects, matching OTel's attribute model)
 *   - traceId: stable per BlackTip session (useful for grouping events
 *     belonging to one agent flow)
 *   - spanId: stable per action (groups pre-action, retries, post-action)
 */
export interface StructuredEvent {
  timestamp: string;
  name: string;
  severity: 'debug' | 'info' | 'warn' | 'error';
  attributes: Record<string, string | number | boolean>;
  traceId: string;
  spanId?: string;
}

// ── Trace ID generator ──

/**
 * 16-char hex trace ID (same format as OpenTelemetry trace IDs, half
 * the width — enough entropy for a session without a crypto dep).
 */
export function newTraceId(): string {
  let s = '';
  for (let i = 0; i < 16; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
}

// ── Normalizers: BlackTip event → StructuredEvent ──

function actionToStructured(ev: ActionEvent, traceId: string): StructuredEvent {
  return {
    timestamp: ev.timestamp,
    name: `action.${ev.action}`,
    severity: ev.outcome === 'success' ? 'info' : 'error',
    traceId,
    attributes: {
      'bt.action': ev.action,
      'bt.target': ev.target,
      'bt.outcome': ev.outcome,
      'bt.duration_ms': ev.duration,
      'bt.retries': ev.retries,
      ...(ev.error ? { 'bt.error': ev.error } : {}),
      ...(ev.value ? { 'bt.value_length': ev.value.length } : {}),
      ...(ev.behavioral?.mousePathLength ? { 'bt.behavioral.path_length_px': ev.behavioral.mousePathLength } : {}),
      ...(ev.behavioral?.mouseMoveDuration ? { 'bt.behavioral.move_duration_ms': ev.behavioral.mouseMoveDuration } : {}),
      ...(ev.behavioral?.preActionPause ? { 'bt.behavioral.pre_pause_ms': ev.behavioral.preActionPause } : {}),
      ...(ev.behavioral?.postActionPause ? { 'bt.behavioral.post_pause_ms': ev.behavioral.postActionPause } : {}),
      ...(ev.behavioral?.clickDwell ? { 'bt.behavioral.click_dwell_ms': ev.behavioral.clickDwell } : {}),
      ...(ev.behavioral?.typingDuration ? { 'bt.behavioral.typing_duration_ms': ev.behavioral.typingDuration } : {}),
      ...(ev.tabIndex !== undefined ? { 'bt.tab_index': ev.tabIndex } : {}),
    },
  };
}

function retryToStructured(ev: RetryEvent, traceId: string): StructuredEvent {
  return {
    timestamp: ev.timestamp,
    name: 'retry.strategy',
    severity: 'warn',
    traceId,
    attributes: {
      'bt.action': ev.action,
      'bt.target': ev.target,
      'bt.retry.attempt': ev.attempt,
      'bt.retry.max_attempts': ev.maxAttempts,
      'bt.retry.strategy': ev.strategy,
      'bt.error': ev.error,
    },
  };
}

function errorToStructured(ev: ErrorEvent, traceId: string): StructuredEvent {
  return {
    timestamp: ev.timestamp,
    name: 'error.action',
    severity: 'error',
    traceId,
    attributes: {
      'bt.error.code': ev.code,
      'bt.error.message': ev.message,
      'bt.error.url': ev.url,
      'bt.action': ev.action,
      'bt.attempts': ev.attempts,
      ...(ev.screenshot ? { 'bt.error.has_screenshot': true, 'bt.error.screenshot_bytes': ev.screenshot.length } : {}),
    },
  };
}

function tabChangeToStructured(ev: TabChangeEvent, traceId: string): StructuredEvent {
  return {
    timestamp: ev.timestamp,
    name: `tab.${ev.action}`,
    severity: 'info',
    traceId,
    attributes: {
      'bt.tab.index': ev.tabIndex,
      'bt.tab.url': ev.url,
      'bt.tab.action': ev.action,
    },
  };
}

function logToStructured(entry: LogEntry, traceId: string): StructuredEvent {
  const attrs: Record<string, string | number | boolean> = {
    'bt.log.message': entry.message,
  };
  // Flatten data shallow (OTel attrs are flat).
  if (entry.data) {
    for (const [k, v] of Object.entries(entry.data)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        attrs[`bt.log.${k}`] = v;
      } else {
        attrs[`bt.log.${k}`] = JSON.stringify(v).slice(0, 200);
      }
    }
  }
  return {
    timestamp: entry.timestamp,
    name: 'log',
    severity: entry.level,
    traceId,
    attributes: attrs,
  };
}

// ── Exporter interface ──

export interface EventExporter {
  export(event: StructuredEvent): void;
}

// ── File sink (JSONL) ──

export class JsonlFileExporter implements EventExporter {
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  export(event: StructuredEvent): void {
    appendFileSync(this.path, JSON.stringify(event) + '\n');
  }
}

// ── Console exporter (for development) ──

export class ConsoleExporter implements EventExporter {
  export(event: StructuredEvent): void {
    // eslint-disable-next-line no-console
    console.log(`[${event.severity}] ${event.name}`, event.attributes);
  }
}

// ── Attach exporters to a BlackTip instance ──

/**
 * Wire a BlackTip instance up to one or more StructuredEvent exporters.
 * Returns an unsubscribe function that removes all listeners added by
 * this call.
 *
 * Usage:
 *   const stop = attachObservability(bt, [
 *     new JsonlFileExporter('./events.jsonl'),
 *     new ConsoleExporter(),
 *   ]);
 *   // ... drive BlackTip ...
 *   stop();
 */
export function attachObservability(bt: BlackTip, exporters: EventExporter[]): () => void {
  const traceId = newTraceId();

  const fanOut = (event: StructuredEvent): void => {
    for (const exporter of exporters) {
      try {
        exporter.export(event);
      } catch {
        // Swallow exporter errors — observability must never crash the
        // primary flow.
      }
    }
  };

  const onAction = (ev: ActionEvent): void => fanOut(actionToStructured(ev, traceId));
  const onRetry = (ev: RetryEvent): void => fanOut(retryToStructured(ev, traceId));
  const onError = (ev: ErrorEvent): void => fanOut(errorToStructured(ev, traceId));
  const onTab = (ev: TabChangeEvent): void => fanOut(tabChangeToStructured(ev, traceId));
  const onLog = (entry: LogEntry): void => fanOut(logToStructured(entry, traceId));

  bt.on('action', onAction);
  bt.on('retry', onRetry);
  bt.on('error', onError);
  bt.on('tabChange', onTab);
  bt.on('log', onLog);

  return () => {
    bt.off('action', onAction);
    bt.off('retry', onRetry);
    bt.off('error', onError);
    bt.off('tabChange', onTab);
    bt.off('log', onLog);
  };
}
