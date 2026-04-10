/**
 * Basic navigation + extraction example.
 *
 * Run with: npx tsx examples/01-basic-navigate.ts
 */

import { BlackTip } from 'blacktip';

async function main(): Promise<void> {
  const bt = new BlackTip({
    logLevel: 'info',
    timeout: 10_000,
    retryAttempts: 2,
  });

  await bt.launch();

  try {
    // Navigate and wait for the page to settle.
    await bt.navigate('https://en.wikipedia.org/wiki/Playwright_(software)');
    await bt.waitForStable({ networkIdleMs: 500, domIdleMs: 500 });

    // Extract the article title and first paragraph.
    const title = await bt.extractText('#firstHeading');
    const firstParagraph = await bt.extractText('#mw-content-text .mw-parser-output > p');

    console.log('Title:', title);
    console.log('First paragraph:', String(firstParagraph).slice(0, 200), '...');

    // Take a screenshot for the record.
    await bt.screenshot({ path: 'wikipedia-playwright.png' });
  } finally {
    await bt.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
