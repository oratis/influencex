/**
 * OpenTelemetry tracing wrapper.
 *
 * - When OTEL_EXPORTER_OTLP_ENDPOINT (or _TRACES_ENDPOINT) is unset, every
 *   call here is a no-op and no SDK is loaded. Dev / sandbox unchanged.
 * - When set, registers SDK with auto-instrumentations (HTTP, Express,
 *   pg, fetch, ...) and ships traces to the configured OTLP endpoint.
 *
 * Companion to ./sentry.js. Sentry handles errors, OTel handles latency
 * traces. Both run side-by-side without conflict; Sentry v9's tracing is
 * actually built on @opentelemetry/api so they share spans automatically.
 *
 * Sprint Q2 task A2.
 */

const ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  || '';
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'influencex';
const ENV = process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || 'development';

let sdk = null;
let initialized = false;

function isConfigured() {
  return !!ENDPOINT;
}

function init() {
  if (initialized) return;
  if (!isConfigured()) return;
  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

    const exporter = new OTLPTraceExporter({
      url: ENDPOINT.endsWith('/v1/traces') ? ENDPOINT : `${ENDPOINT.replace(/\/$/, '')}/v1/traces`,
      // Allow extra headers for auth (Honeycomb x-honeycomb-team, etc).
      headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    });

    sdk = new NodeSDK({
      serviceName: SERVICE_NAME,
      traceExporter: exporter,
      instrumentations: [getNodeAutoInstrumentations({
        // pino auto-instr is noisy and we already have our own logger.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      })],
      resource: {
        attributes: {
          'deployment.environment': ENV,
          'service.version': process.env.OTEL_SERVICE_VERSION || process.env.K_REVISION || 'unknown',
        },
      },
    });
    sdk.start();
    initialized = true;
    console.log(`[otel] Initialized (service=${SERVICE_NAME}, env=${ENV}, endpoint=${ENDPOINT})`);

    // Graceful shutdown so in-flight spans flush before Cloud Run kills us.
    const shutdown = () => {
      if (!sdk) return;
      sdk.shutdown()
        .then(() => console.log('[otel] shutdown complete'))
        .catch(e => console.warn('[otel] shutdown failed:', e.message));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (e) {
    console.warn('[otel] init failed:', e.message);
  }
}

// "key1=val1,key2=val2" → { key1: 'val1', key2: 'val2' }. Tolerates
// missing/empty values. Used for Honeycomb / Grafana Cloud auth headers.
function parseHeaders(str) {
  if (!str) return {};
  const out = {};
  for (const piece of str.split(',')) {
    const idx = piece.indexOf('=');
    if (idx <= 0) continue;
    out[piece.slice(0, idx).trim()] = piece.slice(idx + 1).trim();
  }
  return out;
}

// Test hook
function _resetForTest() {
  initialized = false;
  sdk = null;
}

module.exports = { init, isConfigured, _resetForTest, parseHeaders };
