#!/usr/bin/env node

/**
 * BlackTip CLI
 *
 * Server mode:     npx blacktip serve [--port 9779]
 * Send command:    npx blacktip send "<js>" [--port 9779] [--pretty]
 * Send from file:  npx blacktip send --file <path> [--port 9779] [--pretty]
 * Send from stdin: echo "<js>" | npx blacktip send --stdin [--pretty]
 * Batch commands:  npx blacktip batch <file.json> [--port 9779]
 * Resume pause:    npx blacktip resume <pauseId> "<value>" [--port 9779]
 * Exec (one-shot): npx blacktip exec "<js>"
 *
 * The server returns a JSON bundle for each command:
 *   { ok, result?, url?, title?, screenshotPath?, screenshotB64?, durationMs, error? }
 *
 * --pretty formats the bundle but omits the screenshot payload so the
 * console output is readable. The screenshot is still saved to disk.
 */

import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { BlackTip } from './blacktip.js';

const args = process.argv.slice(2);
const command = args[0];

const portIdx = args.indexOf('--port');
const port = portIdx !== -1 ? parseInt(args[portIdx + 1]!, 10) : 9779;
const pretty = args.includes('--pretty');

function argValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const DELIM = '\n__END__\n';

/**
 * Send a raw payload to the server and print the response(s).
 * Returns when the connection closes or the final frame is received.
 */
async function sendAndPrint(payload: string, expectMultiple = false): Promise<void> {
  return new Promise<void>((resolve) => {
    const client = createConnection({ port, host: '127.0.0.1' });
    let buf = '';
    let lastPrinted = false;

    client.on('data', (chunk) => {
      buf += chunk.toString();
      while (buf.includes(DELIM)) {
        const idx = buf.indexOf(DELIM);
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + DELIM.length);
        printFrame(frame);
        lastPrinted = true;
        if (!expectMultiple) {
          client.destroy();
          resolve();
          return;
        }
      }
    });

    client.on('close', () => {
      if (!lastPrinted && buf.length > 0) printFrame(buf);
      resolve();
    });

    client.on('error', () => {
      console.error('Server not running. Start with: npx blacktip serve');
      process.exit(1);
    });

    client.write(payload + DELIM);
  });
}

function printFrame(frame: string): void {
  // Try to parse as JSON; if it parses, pretty-print (optionally
  // stripping the huge base64 screenshot). Fall back to raw output.
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    process.stdout.write(frame + '\n');
    return;
  }

  if (pretty && parsed && typeof parsed === 'object') {
    const clone = { ...(parsed as Record<string, unknown>) };
    if ('screenshotB64' in clone) {
      const bytes = typeof clone.screenshotBytes === 'number' ? clone.screenshotBytes : (clone.screenshotB64 as string).length;
      clone.screenshotB64 = `<${bytes} bytes, saved to ${clone.screenshotPath ?? 'disk'}>`;
    }
    process.stdout.write(JSON.stringify(clone, null, 2) + '\n');
  } else {
    process.stdout.write(JSON.stringify(parsed) + '\n');
  }
}

if (command === 'serve') {
  const bt = new BlackTip({
    headless: false,
    logLevel: 'info',
    deviceProfile: 'desktop-windows',
    behaviorProfile: 'scraper',
    timeout: 10000,
    retryAttempts: 2,
    screenResolution: { width: 1440, height: 900 },
  });

  bt.on('action', (e) => {
    console.log(`[${e.action}] ${e.target} → ${e.outcome} (${e.duration}ms)`);
  });

  await bt.serve(port);
  console.log(`BlackTip server ready on port ${port}`);
  console.log(`Send commands: npx blacktip send "await bt.navigate('...')" --port ${port}`);

} else if (command === 'send') {
  // Three input sources:
  //   1. Positional argument:   npx blacktip send "..."
  //   2. --file <path>:          npx blacktip send --file cmd.js
  //   3. --stdin:                echo "..." | npx blacktip send --stdin
  let cmd: string | undefined;

  const fileArg = argValue('--file');
  const stdinFlag = args.includes('--stdin');

  if (fileArg) {
    cmd = readFileSync(fileArg, 'utf-8');
  } else if (stdinFlag) {
    cmd = readFileSync(0, 'utf-8'); // read from stdin
  } else {
    // Positional argument (everything after "send" that isn't a flag).
    cmd = args.slice(1)
      .filter((a, i, arr) => {
        if (a === '--port' || a === '--file' || a === '--stdin' || a === '--pretty') return false;
        if (i > 0 && (arr[i - 1] === '--port' || arr[i - 1] === '--file')) return false;
        return true;
      })
      .join(' ');
  }

  if (!cmd || !cmd.trim()) {
    console.error('Usage: npx blacktip send "<js>" | --file <path> | --stdin');
    process.exit(1);
  }

  await sendAndPrint(cmd);

} else if (command === 'batch') {
  // Batch mode: read a JSON array of commands from a file and send them
  // as a single BATCH request. Server runs them sequentially.
  const filePath = args[1];
  if (!filePath) {
    console.error('Usage: npx blacktip batch <file.json>');
    process.exit(1);
  }
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as string[];
  if (!Array.isArray(parsed)) {
    console.error('batch file must contain a JSON array of command strings');
    process.exit(1);
  }
  await sendAndPrint('BATCH\n' + JSON.stringify(parsed));

} else if (command === 'resume') {
  // Resume a paused command: npx blacktip resume <id> "<value>"
  const id = args[1];
  const value = args[2] ?? '';
  if (!id) {
    console.error('Usage: npx blacktip resume <pauseId> "<value>"');
    process.exit(1);
  }
  await sendAndPrint(`RESUME ${id}\n${value}`);

} else if (command === 'pending') {
  // List currently-paused commands: npx blacktip pending
  await sendAndPrint('LIST_PENDING');

} else if (command === 'exec') {
  // One-shot: launch browser, run command, close.
  const cmd = args.slice(1).filter((a) => a !== '--port' && a !== String(port)).join(' ');
  if (!cmd) {
    console.error('Usage: npx blacktip exec "<js>"');
    process.exit(1);
  }
  const bt = new BlackTip({ headless: false, timeout: 10000, retryAttempts: 2 });
  await bt.launch();
  try {
    const fn = new Function('bt', `return (async () => { ${cmd} })();`);
    const result = await fn(bt);
    if (result !== undefined) console.log(JSON.stringify(result));
  } catch (e) {
    console.error('Error:', e instanceof Error ? e.message : e);
  }
  await bt.close();

} else {
  console.log(`BlackTip CLI

Usage:
  npx blacktip serve [--port 9779]
    Start the TCP command server. Leaves a browser running.

  npx blacktip send "<js>" [--port N] [--pretty]
  npx blacktip send --file <path> [--pretty]
  echo "<js>" | npx blacktip send --stdin [--pretty]
    Send a single JS command to the running server. Returns a bundle:
    { ok, result, url, title, screenshotPath, durationMs, ... }
    Use --pretty for human-readable output with screenshot payload
    replaced by a placeholder.

  npx blacktip batch <file.json>
    Run an array of commands sequentially. Server returns all bundles
    in one response, stopping on first failure.

  npx blacktip resume <pauseId> "<value>"
    Resume a command that called bt.pauseForInput().

  npx blacktip pending
    List currently-paused commands with their prompts.

  npx blacktip exec "<js>"
    One-shot: launch a fresh browser, run the command, close.

Examples:
  npx blacktip serve
  npx blacktip send "await bt.navigate('https://example.com')" --pretty
  npx blacktip send --file login-flow.js --pretty
  npx blacktip batch anthem-claim.json
  npx blacktip resume pause-123456-78901 "116170"
`);
}
