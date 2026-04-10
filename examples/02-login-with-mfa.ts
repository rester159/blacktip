/**
 * Login flow with MFA — demonstrates pauseForInput.
 *
 * This runs BlackTip in serve mode, then sends commands from the same
 * file for simplicity. In a real agent setup, the driving logic lives
 * in your agent framework and sends commands over the TCP protocol.
 *
 * Run with: npx tsx examples/02-login-with-mfa.ts
 */

import { BlackTip } from 'blacktip';
import * as readline from 'node:readline/promises';

async function main(): Promise<void> {
  const bt = new BlackTip({
    logLevel: 'info',
    timeout: 15_000,
    retryAttempts: 2,
    behaviorProfile: 'human',
  });

  await bt.launch();

  // Listen for pause events and prompt the user via stdin.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  bt.on('btPause', async (info: { id: string; prompt: string }) => {
    const answer = await rl.question(`\n[BlackTip] ${info.prompt}\n> `);
    // Resume by directly resolving the pending entry.
    const registry = (bt as unknown as { _pauseRegistry?: Map<string, { resolve: (v: string) => void }> })._pauseRegistry;
    registry?.get(info.id)?.resolve(answer);
    registry?.delete(info.id);
  });

  // Set up the pause registry without going through serve mode.
  (bt as unknown as { _pauseRegistry: Map<string, unknown> })._pauseRegistry = new Map();

  try {
    await bt.navigate('https://example-site-with-mfa.com/login');

    await bt.type('input[name="email"]', 'you@example.com', { paste: true });
    await bt.type('input[name="password"]', process.env.DEMO_PASSWORD ?? '', { paste: true });
    await bt.click('button[type="submit"]');  // auto-importance applies

    await bt.waitForText('Enter verification code', { timeout: 10_000 });

    // Pause and ask the user for the MFA code. The 'btPause' listener
    // above prompts via readline and resumes.
    const code = await bt.pauseForInput({
      prompt: 'Enter the 6-digit code sent to your phone',
      validate: /^\d{6}$/,
      timeoutMs: 300_000,
    });

    await bt.type('input[name="code"]', code, { paste: true });
    await bt.click('button[type="submit"]');

    await bt.waitForStable();
    console.log('Logged in, current URL:', (await bt.screenshot()).timestamp, '/', await bt.executeJS('location.href'));
  } finally {
    rl.close();
    await bt.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
