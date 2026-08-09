/**
 * Playwright smoke suite (roadmap C1 / MASTER_PLAN_2026-08 PR-E).
 *
 * Run from the repo root:
 *   cd client && npx vite build     # the server serves client/dist
 *   npm run test:e2e
 *
 * This config never builds anything itself — it only boots
 * `node server/index.js` against a throwaway SQLite file in os.tmpdir()
 * (see e2e/env.js) and waits for /healthz. `global-setup.js` then seeds demo
 * data with server/seed-demo.js and stores an admin session.
 */

const fs = require('fs');
const path = require('path');
const { defineConfig, devices } = require('@playwright/test');
const { BASE_URL, PORT, REPO_ROOT, resetDatabaseFile, serverEnv } = require('./env');

// The suite drives the built SPA that Express serves out of client/dist.
// Building it here would hide staleness and slow every run, so instead fail
// fast with the command to run.
const distIndex = path.join(REPO_ROOT, 'client', 'dist', 'index.html');
if (!fs.existsSync(distIndex)) {
  throw new Error(
    `client/dist is missing — the e2e suite tests the built SPA.\n` +
    `Build it first:  cd client && npx vite build`
  );
}

// Wipe the throwaway DB before the webServer boots. No-op in worker
// processes (see env.js) so a run can never lose its database mid-flight.
resetDatabaseFile();

module.exports = defineConfig({
  testDir: './tests',
  // One worker, no intra-file parallelism: the suite shares a single server
  // process and a single SQLite file, and the pipeline spec asserts on
  // workspace-wide counters.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Paths are relative to this file, so both land under e2e/ (gitignored,
  // and uploaded as an artifact by the CI job when the suite fails).
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',

  use: {
    baseURL: BASE_URL,
    // client/src/i18n.jsx picks zh from navigator.language when no preference
    // is stored, so pin the locale — otherwise the specs' English selectors
    // depend on the machine running them.
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  globalSetup: require.resolve('./global-setup.js'),

  webServer: {
    command: 'node server/index.js',
    cwd: REPO_ROOT,
    url: `${BASE_URL}/healthz`,
    // Never reuse a server we didn't start: a developer's `npm run dev` on
    // 8080 is pointed at the real influencex.db, and silently testing against
    // it would write demo rows into their working database.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: serverEnv({ PORT: String(PORT) }),
  },
});
