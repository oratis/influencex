/**
 * Shared environment contract for the Playwright suite.
 *
 * Loaded by playwright.config.js (main process *and* every worker process,
 * because Playwright re-requires the config in each worker), by
 * global-setup.js, and by the specs. Everything here must therefore be
 * deterministic — no random paths, no side effects outside the guarded
 * `resetDatabaseFile()` call.
 *
 * The single most important job of this file: make absolutely sure the suite
 * never touches the developer's `influencex.db` at the repo root.
 *   - SQLITE_DB_PATH points the server at a throwaway file under os.tmpdir()
 *     (see server/database.js — it falls back to the historical repo-root
 *     path when the variable is unset, so nothing else changes).
 *   - DATABASE_URL is pinned to '' so the SQLite branch is taken even if a
 *     developer has a Postgres URL in their .env (server/index.js and
 *     server/seed-demo.js both call dotenv, and dotenv never overwrites a
 *     key that already exists in process.env — an empty string counts).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Deterministic so the main process, global setup and every worker agree.
const TMP_DIR = path.join(os.tmpdir(), 'influencex-e2e');
const DB_PATH = path.join(TMP_DIR, 'e2e.db');

const PORT = parseInt(process.env.E2E_PORT, 10) || 8080;
const BASE_URL = `http://localhost:${PORT}`;
const STORAGE_STATE = path.join(TMP_DIR, 'admin-storage-state.json');

const ADMIN = { email: 'demo@influencex.dev', password: 'demo1234' };

/**
 * Env handed to `node server/index.js` (webServer) and to the demo seeder.
 * Every third-party integration is explicitly blanked so a stray key in the
 * developer's shell can't turn a test run into real network traffic — no LLM
 * calls, no mail, no scraping, no telemetry, no Redis.
 */
function serverEnv(extra = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(PORT),
    SQLITE_DB_PATH: DB_PATH,
    DATABASE_URL: '',
    LOG_LEVEL: 'warn',

    // Mail: no provider => email-jobs takes its documented dry-run branch.
    RESEND_API_KEY: '',
    RESEND_FROM_EMAIL: '',
    SMTP_HOST: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    GMAIL_OAUTH_CLIENT_ID: '',
    GMAIL_OAUTH_CLIENT_SECRET: '',

    // LLM: force the deterministic template fallback in generateOutreachEmail.
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    GOOGLE_AI_API_KEY: '',
    ARK_API_KEY: '',
    VOLC_API_KEY: '',

    // Discovery / scraping providers.
    YOUTUBE_API_KEY: '',
    APIFY_TOKEN: '',
    APIFY_API_TOKEN: '',
    MODASH_API_KEY: '',
    HUNTER_API_KEY: '',
    TWITCH_CLIENT_ID: '',
    TWITCH_CLIENT_SECRET: '',

    // Auth providers / telemetry / queue backends.
    GOOGLE_OAUTH_CLIENT_ID: '',
    GOOGLE_OAUTH_CLIENT_SECRET: '',
    // Bootstrap admin: blanked so initializeDefaultData creates exactly the
    // users seed-demo.js creates and nothing else.
    ADMIN_EMAIL: '',
    ADMIN_PASSWORD: '',
    SENTRY_DSN: '',
    OTEL_EXPORTER_OTLP_ENDPOINT: '',
    REDIS_URL: '',

    ...extra,
  };
}

/**
 * Delete the throwaway DB (and its WAL sidecars) so every run starts clean.
 *
 * Guarded by an env flag rather than a Playwright internal: the config module
 * is evaluated again inside each worker process, and workers inherit the
 * parent's environment — so only the first (root) evaluation wipes the file.
 * This matters because Playwright starts the `webServer` *before* globalSetup
 * runs; if the reset happened in globalSetup it would yank the database out
 * from under an already-booted server.
 */
function resetDatabaseFile() {
  if (process.env.INFLUENCEX_E2E_ROOT === '1') return false;
  process.env.INFLUENCEX_E2E_ROOT = '1';
  fs.mkdirSync(TMP_DIR, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }
  fs.rmSync(STORAGE_STATE, { force: true });
  return true;
}

module.exports = {
  ADMIN,
  BASE_URL,
  DB_PATH,
  PORT,
  REPO_ROOT,
  STORAGE_STATE,
  TMP_DIR,
  resetDatabaseFile,
  serverEnv,
};
