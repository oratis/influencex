/**
 * Sentry instrumentation wrapper.
 *
 * - When SENTRY_DSN is unset, every export is a no-op so nothing crashes
 *   in dev / sandbox / CI.
 * - When SENTRY_DSN is set, we initialize the v9 SDK with sane defaults:
 *     - 10% performance tracing (override with SENTRY_TRACES_SAMPLE_RATE)
 *     - workspace_id added as a tag on every captured event so we can
 *       slice errors by tenant
 *     - secrets stripped from request bodies (default Sentry filter)
 *
 * Usage:
 *   const sentry = require('./sentry');
 *   sentry.init();                                  // call once at boot
 *   sentry.setupExpressRequestHandler(app);         // before routes
 *   sentry.setupExpressErrorHandler(app);           // after routes
 *   sentry.captureException(err, { workspace_id }); // anywhere
 *   sentry.setUser({ id, email });                  // on auth
 */

const DSN = process.env.SENTRY_DSN || '';
const ENV = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development';
const TRACES_SAMPLE_RATE = parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0.1;
const RELEASE = process.env.SENTRY_RELEASE || process.env.K_REVISION || 'unknown';

let Sentry = null;
let initialized = false;

function isConfigured() {
  return !!DSN;
}

function init() {
  if (initialized) return;
  if (!isConfigured()) return;
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: DSN,
      environment: ENV,
      release: RELEASE,
      tracesSampleRate: TRACES_SAMPLE_RATE,
      // Keep PII out by default — capture user id/email only via setUser().
      sendDefaultPii: false,
    });
    initialized = true;
    console.log(`[sentry] Initialized (env=${ENV}, release=${RELEASE}, traces=${TRACES_SAMPLE_RATE})`);
  } catch (e) {
    console.warn('[sentry] init failed:', e.message);
  }
}

function setupExpressRequestHandler(app) {
  if (!initialized || !Sentry) return;
  // v9: Sentry.setupExpressErrorHandler(app) handles both. Request handler
  // is auto-installed by the OTel-based integration when init() runs.
  // We keep this fn as a no-op for forward compatibility.
}

function setupExpressErrorHandler(app) {
  if (!initialized || !Sentry) return;
  try { Sentry.setupExpressErrorHandler(app); }
  catch (e) { console.warn('[sentry] errorHandler attach failed:', e.message); }
}

function captureException(err, context = {}) {
  if (!initialized || !Sentry) return;
  try {
    Sentry.captureException(err, scope => {
      if (context.workspace_id) scope.setTag('workspace_id', context.workspace_id);
      if (context.user_id) scope.setUser({ id: context.user_id });
      if (context.tags) for (const [k, v] of Object.entries(context.tags)) scope.setTag(k, v);
      if (context.extra) for (const [k, v] of Object.entries(context.extra)) scope.setExtra(k, v);
      return scope;
    });
  } catch (e) {
    console.warn('[sentry] captureException failed:', e.message);
  }
}

function captureMessage(msg, level = 'info') {
  if (!initialized || !Sentry) return;
  try { Sentry.captureMessage(msg, level); }
  catch (e) { console.warn('[sentry] captureMessage failed:', e.message); }
}

function setUser(user) {
  if (!initialized || !Sentry) return;
  try {
    Sentry.setUser(user ? { id: user.id, email: user.email } : null);
  } catch (e) {
    console.warn('[sentry] setUser failed:', e.message);
  }
}

// Test hook so we can stub the SDK in unit tests.
function _injectSdkForTest(stub) {
  Sentry = stub;
  initialized = !!stub;
}

module.exports = {
  init,
  isConfigured,
  setupExpressRequestHandler,
  setupExpressErrorHandler,
  captureException,
  captureMessage,
  setUser,
  _injectSdkForTest,
};
