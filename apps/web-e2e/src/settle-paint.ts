import type { Page } from '@playwright/test';

/** Wait until no CSS animation or transition is still running. */
export async function waitForSettledPaint(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState !== 'running'),
    null,
    { timeout: 5_000 },
  );
}
