'use strict';
// E2E for the plugin framework's reference implementation: install, review
// and enable the Investment Partner Hub from the Plugins settings UI, see
// its route render, and confirm the chat-side-panel slot actually becomes
// visible on a narrow viewport (it did not, until this suite: nothing ever
// added the CSS's own .open class, so the drawer stayed permanently
// off-screen: see the plugin-host.js fix alongside this file).
//
// This suite shares the ONE persistent server + workspace every other e2e
// spec in this run uses (playwright.config.js: workers: 1). Installing and
// enabling the plugin materializes three new agents into that shared
// workspace's roster, so the LAST thing this suite does is disable and
// uninstall it again, restoring the roster for every spec that runs after
// it (alphabetically, most of them).
const { test, expect } = require('@playwright/test');
const path = require('node:path');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'investment-dashboard');
const LEAD_PARTNER_ID = 'rundock-plugin-investment-dashboard-lead-partner';

async function openPluginsSettings(page) {
  await page.locator('.nav-item[data-nav="settings"]').click();
  await page.evaluate(() => showSettingsSection('plugins'));
  await expect(page.locator('.settings-nav-item[data-settings="plugins"]')).toHaveClass(/active/);
}

test('install, review, enable and use the Investment Partner Hub, then cleanly uninstall it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();

  const card = page.locator('.settings-card[data-plugin-id="investment-dashboard"]');

  // ---- Install ----
  await openPluginsSettings(page);
  await page.locator('#plugin-install-path').fill(FIXTURE_DIR);
  await page.locator('button', { hasText: 'Install' }).click();
  await expect(card).toBeVisible();

  // ---- Review disclosure: every spec-required field is present ----
  await card.locator('button', { hasText: 'Review & enable' }).click();
  await expect(card).toContainText('Author');
  await expect(card).toContainText('Package hash');
  await expect(card).toContainText('lead-partner');
  await expect(card).toContainText('investment-review');
  await expect(card).toContainText('portfolio-state');
  await expect(card).toContainText('Approved UI code runs on this page');

  // ---- Enable ----
  await card.locator('button', { hasText: 'Confirm enable' }).click();
  await expect(card).toContainText('Enabled');

  // ---- The route renders, materialized from the manifest, not hardcoded ----
  await page.locator('button[data-rundock-plugin="investment-dashboard"]').click();
  await expect(page.locator('.inv-root h1')).toHaveText('Investment Hub');
  await expect(page.locator('.inv-tab', { hasText: 'Positions' })).toBeVisible();
  await expect(page.locator('.inv-tab', { hasText: 'Risk Profile' })).toBeVisible();
  await expect(page.locator('.inv-tab', { hasText: 'Decision Journal' })).toBeVisible();

  // ---- chat-side-panel slot, on a narrow viewport ----
  // The panel is a fixed overlay translated off-screen by CSS until .open is
  // added; before the fix alongside this file, nothing ever added it.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.nav-item[data-nav="conversations"]').click();
  await page.evaluate((agentId) => createConversation(agentId), LEAD_PARTNER_ID);
  const panel = page.locator('#plugin-chat-side-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveClass(/open/);
  // The real proof, not just the class name: the drawer's box must actually
  // sit inside the 390px viewport, not off past its right edge (where
  // translateX(100%) parks it when .open is never added).
  const box = await panel.boundingBox();
  expect(box, 'the panel must report a real box').not.toBeNull();
  expect(box.x, 'the drawer must have translated on-screen, not sit past the viewport edge').toBeLessThan(390);
  expect(box.x + box.width, 'the drawer must not overshoot the viewport either').toBeLessThanOrEqual(390 + 1);

  // ---- Cleanup: restore the shared workspace roster for every later spec ----
  await openPluginsSettings(page);
  await card.locator('button', { hasText: 'Disable' }).click();
  await expect(card).toContainText('Disabled');
  await card.locator('button', { hasText: 'Uninstall' }).click();
  await expect(card).toHaveCount(0);
});
