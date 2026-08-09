/**
 * Smoke 2 — invite-code closed loop.
 *
 *   admin → /#/invite-codes → generate a code
 *        → fresh browser context (no session) → /#/signup?code=…
 *        → register → lands signed in, inside the code's workspace
 *
 * This is the only supported way to create an account (POST /api/auth/register
 * is 410 Gone), so it is the highest-value flow in the suite.
 */

const crypto = require('crypto');
const { test, expect } = require('@playwright/test');

const { STORAGE_STATE } = require('../env');
const { withDb } = require('../helpers/db');

test.use({ storageState: STORAGE_STATE });

const pinLocale = () => {
  localStorage.setItem('influencex_onboarding_done_v1', '1');
  localStorage.setItem('influencex_lang', 'en');
};

test('admin generates an invite code and a new user redeems it', async ({ page, browser }) => {
  await page.addInitScript(pinLocale);
  await page.goto('/#/invite-codes');

  await expect(page.getByRole('heading', { name: 'Invite Codes', exact: true })).toBeVisible();

  // The workspace select is pre-filled with the demo workspace; only pick the
  // role explicitly so the assertion below has something to check.
  await page.locator('#ic-role').selectOption('editor');
  await page.locator('#ic-maxuses').fill('5');
  await page.locator('#ic-note').fill('playwright smoke');
  await page.getByRole('button', { name: 'Generate code' }).click();

  // The freshly created code appears in the highlighted share panel.
  const sharePanel = page.locator('.card', { hasText: 'Invite code ready to share' });
  await expect(sharePanel).toBeVisible();
  const code = (await sharePanel.locator('code').first().innerText()).trim();
  expect(code).toMatch(/^INFLX-[A-Z0-9]{8}$/);

  // …and in the list below, still unused.
  const listRow = page.locator('tbody tr', { hasText: code });
  await expect(listRow).toBeVisible();
  await expect(listRow).toContainText('0 / 5');
  await expect(listRow).toContainText('Active');

  // ---- fresh context: a visitor with no session at all ----
  const newUser = {
    // Unique per attempt so a retry can't trip over EMAIL_EXISTS.
    email: `e2e-invitee-${crypto.randomUUID().slice(0, 8)}@influencex.test`,
    password: 'e2e-pass-1234',
    name: 'E2E Invitee',
  };

  const guestContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const guest = await guestContext.newPage();
    await guest.addInitScript(pinLocale);
    await guest.goto(`/#/signup?code=${encodeURIComponent(code)}`);

    // The code from the query string is looked up automatically.
    await expect(guest.getByText('Invite code accepted')).toBeVisible();

    await guest.getByLabel('Name', { exact: true }).fill(newUser.name);
    await guest.getByLabel('Email', { exact: true }).fill(newUser.email);
    await guest.getByLabel('Password', { exact: true }).fill(newUser.password);
    await guest.getByRole('button', { name: 'Create account' }).click();

    // register-with-code auto-logs-in, then the page hard-reloads into the app.
    await expect(guest).toHaveURL(/#\/(pipeline|conductor)$/);
    const sidebar = guest.locator('aside.sidebar');
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByText(newUser.email)).toBeVisible();
    // Redeemers join as members, not platform admins — no Invite Codes entry.
    await expect(sidebar.getByRole('link', { name: 'Invite Codes', exact: true })).toHaveCount(0);
  } finally {
    await guestContext.close();
  }

  // The admin's list reflects the redemption once refreshed.
  await page.reload();
  await expect(page.locator('tbody tr', { hasText: code })).toContainText('1 / 5');

  // Row-level truth: the new user landed in the code's workspace as an editor.
  const membership = withDb(db => db.prepare(
    `SELECT wm.role, ic.workspace_id AS code_workspace, wm.workspace_id AS member_workspace
       FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
       JOIN invite_codes ic ON ic.code = ?
      WHERE u.email = ? AND wm.workspace_id = ic.workspace_id`
  ).get(code, newUser.email));
  expect(membership, 'new user must be a member of the invite code workspace').toBeTruthy();
  expect(membership.role).toBe('editor');
});
