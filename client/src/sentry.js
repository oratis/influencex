/**
 * Client-side Sentry wrapper.
 *
 * - VITE_SENTRY_DSN unset → every export is a no-op
 * - VITE_SENTRY_DSN set   → init at module load with sane defaults:
 *     - 10% replay (override with VITE_SENTRY_REPLAY_RATE)
 *     - browser tracing turned on
 *     - releases tagged with VITE_SENTRY_RELEASE if provided
 *
 * Usage:
 *   import * as sentry from './sentry';
 *   sentry.captureException(err);                 // anywhere
 *   sentry.setUser({ id, email });                // on auth
 *   const Boundary = sentry.makeErrorBoundary(); // optional Sentry boundary
 */

import * as Sentry from '@sentry/react';

const DSN = import.meta.env.VITE_SENTRY_DSN || '';
const ENV = import.meta.env.VITE_SENTRY_ENVIRONMENT || (import.meta.env.PROD ? 'production' : 'development');
const RELEASE = import.meta.env.VITE_SENTRY_RELEASE || 'unknown';
const TRACES = parseFloat(import.meta.env.VITE_SENTRY_TRACES_RATE) || 0.1;
const REPLAY = parseFloat(import.meta.env.VITE_SENTRY_REPLAY_RATE) || 0;

let initialized = false;

export function isConfigured() {
  return !!DSN;
}

export function init() {
  if (initialized || !isConfigured()) return;
  try {
    Sentry.init({
      dsn: DSN,
      environment: ENV,
      release: RELEASE,
      tracesSampleRate: TRACES,
      replaysSessionSampleRate: REPLAY,
      replaysOnErrorSampleRate: REPLAY > 0 ? 1.0 : 0,
      sendDefaultPii: false,
    });
    initialized = true;
    // eslint-disable-next-line no-console
    console.log('[sentry] client initialized');
  } catch (e) {
    // Last thing we want is the SDK breaking the app on boot.
    // eslint-disable-next-line no-console
    console.warn('[sentry] init failed:', e?.message || e);
  }
}

export function captureException(err, ctx = {}) {
  if (!initialized) return;
  try {
    Sentry.withScope(scope => {
      if (ctx.workspace_id) scope.setTag('workspace_id', ctx.workspace_id);
      if (ctx.tags) for (const [k, v] of Object.entries(ctx.tags)) scope.setTag(k, v);
      if (ctx.extra) for (const [k, v] of Object.entries(ctx.extra)) scope.setExtra(k, v);
      Sentry.captureException(err);
    });
  } catch {}
}

export function setUser(user) {
  if (!initialized) return;
  try { Sentry.setUser(user ? { id: user.id, email: user.email } : null); } catch {}
}

// Wraps a React component in a Sentry-aware ErrorBoundary. Falls back to a
// pass-through (children) when Sentry is unconfigured so the existing manual
// ErrorBoundary keeps doing its job.
export function withErrorBoundary(Component, fallback) {
  if (!initialized) return Component;
  try {
    return Sentry.withErrorBoundary(Component, { fallback });
  } catch {
    return Component;
  }
}
