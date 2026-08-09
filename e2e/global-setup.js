/**
 * Playwright global setup.
 *
 * Runs after the webServer plugin has booted `node server/index.js` (and
 * therefore after migrations + initializeDefaultData have run against the
 * throwaway DB). Two jobs:
 *
 *   1. Seed demo data by shelling out to the real `server/seed-demo.js`, with
 *      SQLITE_DB_PATH pointed at the same throwaway file. The seeder opens
 *      the DB itself and is idempotent, so re-running is safe.
 *   2. Log the demo admin in over the API once and persist the result as a
 *      Playwright storageState. Specs reuse it instead of driving the login
 *      form, which keeps them fast and keeps us well under the server's
 *      10-requests-per-minute auth rate limit.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { ADMIN, BASE_URL, DB_PATH, REPO_ROOT, STORAGE_STATE, TMP_DIR, serverEnv } = require('./env');

function runSeeder() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join('server', 'seed-demo.js')], {
      cwd: REPO_ROOT,
      env: serverEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`seed-demo.js exited ${code}:\n${out}`));
    });
  });
}

async function loginAdmin() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) {
    throw new Error(`admin login failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

module.exports = async () => {
  if (!fs.existsSync(DB_PATH)) {
    // The server creates the file on boot; if it isn't there, the webServer
    // is talking to a different database than we think it is.
    throw new Error(
      `E2E database ${DB_PATH} was not created by the server — check SQLITE_DB_PATH wiring`
    );
  }

  await runSeeder();
  const session = await loginAdmin();

  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(
    STORAGE_STATE,
    JSON.stringify({
      cookies: [],
      origins: [{
        origin: BASE_URL,
        localStorage: [
          { name: 'influencex_token', value: session.token },
          // Suppress the first-run product tour so its overlay can't sit on
          // top of the nav during a click.
          { name: 'influencex_onboarding_done_v1', value: '1' },
        ],
      }],
    }, null, 2)
  );

  // Handy for debugging a failed run.
  process.env.INFLUENCEX_E2E_ADMIN_TOKEN = session.token;
};
