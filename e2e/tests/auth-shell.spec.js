/**
 * Smoke 1 — login → app shell → sidebar navigation.
 *
 * The only spec that drives the real login form; every other spec reuses the
 * session minted in global-setup, which keeps the suite comfortably under the
 * server's auth rate limit (authLimiter: 10 requests/min per IP).
 */

const { test, expect } = require('@playwright/test');
const { ADMIN } = require('../env');

// Log in for real: start from a context with no stored session.
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ page }) => {
  // The first-run product tour only fires for workspaces with zero campaigns
  // (seed-demo creates two), but pinning the flag keeps the spec immune to
  // seeding changes — the tour overlay would swallow the nav clicks below.
  await page.addInitScript(() => {
    localStorage.setItem('influencex_onboarding_done_v1', '1');
    localStorage.setItem('influencex_lang', 'en');
  });
});

async function signIn(page) {
  await page.goto('/#/login');
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  // Anchored regexes: FormField appends a "*" to required labels (so an exact
  // "Password" match finds nothing), while a bare "Password" substring also
  // matches the field's "Show password" toggle button.
  await page.getByLabel(/^Email/).fill(ADMIN.email);
  await page.getByLabel(/^Password/).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  // HomeRedirect sends a user who has campaigns straight to the pipeline.
  await expect(page).toHaveURL(/#\/pipeline$/);
}

test('logs in and lands on the app shell', async ({ page }) => {
  await signIn(page);

  const sidebar = page.locator('aside.sidebar');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByText(ADMIN.email)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI Agent Pipeline' })).toBeVisible();

  // Platform-admin-only entries render for the demo admin.
  await expect(sidebar.getByRole('link', { name: 'Invite Codes', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Apify Runs', exact: true })).toBeVisible();
});

test('sidebar navigation moves between pages', async ({ page }) => {
  await signIn(page);
  const sidebar = page.locator('aside.sidebar');

  const hops = [
    { link: 'KOL Database', hash: /#\/kol-database$/, heading: 'KOL Database' },
    { link: 'Campaigns', hash: /#\/campaigns$/, heading: 'Campaigns' },
    { link: 'Contacts', hash: /#\/contacts$/, heading: 'Contact Center' },
    { link: 'Discovery', hash: /#\/discovery$/, heading: 'KOL Discovery' },
    { link: 'Pipeline', hash: /#\/pipeline$/, heading: 'AI Agent Pipeline' },
  ];

  for (const hop of hops) {
    const link = sidebar.getByRole('link', { name: hop.link, exact: true });
    await link.click();
    await expect(page).toHaveURL(hop.hash);
    await expect(page.getByRole('heading', { name: hop.heading })).toBeVisible();
    // The clicked entry becomes the active one — proves NavLink state changed,
    // not just the URL.
    await expect(link).toHaveClass(/active/);
  }
});
