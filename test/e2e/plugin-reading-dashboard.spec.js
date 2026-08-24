'use strict';
// Minimal e2e pass for the reading-dashboard fixture, promised in the Phase
// 5 decision log: the generic-framework proof (test/integration/plugin-
// reading-dashboard.test.js) already covers the server-side path end to
// end; this is the one thing that needs a real browser, that this fixture
// declares no chat-side-panel slot and only one plain route, so its e2e
// pass stays this short deliberately: plugin-investment-dashboard.spec.js
// alongside it is where the fuller (slot, disclosure fields) proof lives.
//
// Shares the one persistent server + workspace every e2e spec in this run
// uses; installing/enabling adds one "Librarian" agent to that shared
// roster, so cleanup at the end restores it for every later spec.
const { test, expect } = require('@playwright/test');
const path = require('node:path');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'reading-dashboard');

test('install, enable and view the Reading Dashboard, then cleanly uninstall it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();

  const card = page.locator('.settings-card[data-plugin-id="reading-dashboard"]');

  await page.locator('.nav-item[data-nav="settings"]').click();
  await page.evaluate(() => showSettingsSection('plugins'));
  await page.locator('#plugin-install-path').fill(FIXTURE_DIR);
  await page.locator('button', { hasText: 'Install' }).click();
  await expect(card).toBeVisible();

  await card.locator('button', { hasText: 'Review & enable' }).click();
  await expect(card).toContainText('librarian');
  await card.locator('button', { hasText: 'Confirm enable' }).click();
  await expect(card).toContainText('Enabled');

  await page.locator('button[data-rundock-plugin="reading-dashboard"]').click();
  await expect(page.locator('div.reading-dashboard')).toBeVisible();

  await page.locator('.nav-item[data-nav="settings"]').click();
  await page.evaluate(() => showSettingsSection('plugins'));
  await card.locator('button', { hasText: 'Disable' }).click();
  await expect(card).toContainText('Disabled');
  await card.locator('button', { hasText: 'Uninstall' }).click();
  await expect(card).toHaveCount(0);
});
