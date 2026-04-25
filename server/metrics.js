/**
 * Prometheus-format metrics endpoint.
 *
 * Exposed at GET /metrics. Gated by METRICS_TOKEN env var: callers must
 * present it as `?token=...` or `Authorization: Bearer ...`. If no token is
 * configured, the endpoint returns 503 (intentional — refuse rather than
 * leak in dev). For Cloud Monitoring scrape, set METRICS_TOKEN to a long
 * random string and configure the scrape job with the same token.
 *
 * Metrics types:
 *   - counter — monotonically increasing (e.g. http_requests_total)
 *   - gauge   — point-in-time value (e.g. job_queue_pending)
 *
 * No external dependency (prom-client) — the format is simple enough to
 * hand-render and we avoid adding 500KB to the bundle for one endpoint.
 */

// In-process counter store. Keys are metric_name + labels combined.
const counters = new Map();

function counterKey(name, labels) {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`);
  return `${name}{${parts.join(',')}}`;
}

function inc(name, labels = {}, by = 1) {
  const k = counterKey(name, labels);
  counters.set(k, (counters.get(k) || 0) + by);
}

/**
 * Express middleware that records http_requests_total{method, route, status}.
 * Uses the matched route pattern (/api/contacts/:id) rather than the actual
 * URL so cardinality stays bounded. Mount before route handlers.
 */
function httpMetricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.once('finish', () => {
    const route = req.route?.path || req.baseUrl || req.path || 'unknown';
    const labels = {
      method: req.method,
      route: route.length > 100 ? route.slice(0, 100) : route,
      status: String(res.statusCode),
    };
    inc('influencex_http_requests_total', labels);
    const durMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    // Bucket histogram: simple latency buckets in seconds (le).
    // We approximate as cumulative buckets so PromQL's histogram_quantile
    // works on the rate of these counters.
    const dur = durMs / 1000;
    for (const le of [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]) {
      if (dur <= le) inc('influencex_http_request_duration_seconds_bucket', { ...labels, le: String(le) });
    }
    inc('influencex_http_request_duration_seconds_bucket', { ...labels, le: '+Inf' });
    inc('influencex_http_request_duration_seconds_sum', labels, dur);
    inc('influencex_http_request_duration_seconds_count', labels);
  });
  next();
}

/**
 * Render the full Prometheus exposition. Pulls live snapshots from job
 * queue + llm stats; merges with the in-process counter store.
 */
function render({ jobQueueStats, llmStats }) {
  const lines = [];

  // --- HTTP counters from middleware ---
  lines.push('# HELP influencex_http_requests_total Total HTTP requests handled, by method/route/status.');
  lines.push('# TYPE influencex_http_requests_total counter');
  for (const [k, v] of counters) {
    if (k.startsWith('influencex_http_requests_total')) lines.push(`${k} ${v}`);
  }

  lines.push('# HELP influencex_http_request_duration_seconds Request latency.');
  lines.push('# TYPE influencex_http_request_duration_seconds histogram');
  for (const [k, v] of counters) {
    if (k.startsWith('influencex_http_request_duration_seconds')) lines.push(`${k} ${v}`);
  }

  // --- Job queue gauges ---
  if (jobQueueStats) {
    lines.push('# HELP influencex_job_queue_pending Jobs waiting to be picked up.');
    lines.push('# TYPE influencex_job_queue_pending gauge');
    lines.push(`influencex_job_queue_pending ${jobQueueStats.pending ?? 0}`);

    lines.push('# HELP influencex_job_queue_running Jobs currently executing.');
    lines.push('# TYPE influencex_job_queue_running gauge');
    lines.push(`influencex_job_queue_running ${jobQueueStats.running ?? 0}`);

    lines.push('# HELP influencex_job_queue_completed_total Jobs completed since process start.');
    lines.push('# TYPE influencex_job_queue_completed_total counter');
    lines.push(`influencex_job_queue_completed_total ${jobQueueStats.completed ?? 0}`);

    lines.push('# HELP influencex_job_queue_failed_total Jobs that exhausted retries since process start.');
    lines.push('# TYPE influencex_job_queue_failed_total counter');
    lines.push(`influencex_job_queue_failed_total ${jobQueueStats.failed ?? 0}`);
  }

  // --- LLM cost + call counts ---
  if (llmStats) {
    lines.push('# HELP influencex_llm_total_usd_cents Cumulative LLM spend across all providers.');
    lines.push('# TYPE influencex_llm_total_usd_cents counter');
    lines.push(`influencex_llm_total_usd_cents ${llmStats.totalUsdCents ?? 0}`);

    lines.push('# HELP influencex_llm_calls_total LLM calls by provider/model.');
    lines.push('# TYPE influencex_llm_calls_total counter');
    for (const [provider, p] of Object.entries(llmStats.byProvider || {})) {
      lines.push(`influencex_llm_calls_total{provider="${provider}"} ${p.calls || 0}`);
    }

    lines.push('# HELP influencex_llm_tokens_total Tokens consumed by provider, by direction.');
    lines.push('# TYPE influencex_llm_tokens_total counter');
    for (const [provider, p] of Object.entries(llmStats.byProvider || {})) {
      lines.push(`influencex_llm_tokens_total{provider="${provider}",direction="input"} ${p.inputTokens || 0}`);
      lines.push(`influencex_llm_tokens_total{provider="${provider}",direction="output"} ${p.outputTokens || 0}`);
    }
  }

  // --- Process info ---
  lines.push('# HELP influencex_process_uptime_seconds Process uptime.');
  lines.push('# TYPE influencex_process_uptime_seconds gauge');
  lines.push(`influencex_process_uptime_seconds ${process.uptime()}`);

  return lines.join('\n') + '\n';
}

/**
 * Express route handler. Validates the bearer/query token and renders the
 * exposition. Returns 503 if METRICS_TOKEN env var is not set (dev safety).
 */
function metricsHandler({ jobQueue, llm }) {
  return (req, res) => {
    const expected = process.env.METRICS_TOKEN;
    if (!expected) return res.status(503).json({ error: 'Metrics not configured. Set METRICS_TOKEN env.' });

    const provided = req.query.token
      || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (provided !== expected) return res.status(401).json({ error: 'Invalid token' });

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(render({
      jobQueueStats: jobQueue?.getStats?.() || null,
      llmStats: llm?.getStats?.() || null,
    }));
  };
}

/**
 * Helper for app code that wants to bump a custom counter (e.g. email send
 * outcomes). Not used by the middleware; just exposed for callers.
 */
function counter(name, labels = {}, by = 1) {
  inc(name, labels, by);
}

module.exports = {
  httpMetricsMiddleware,
  metricsHandler,
  counter,
  // For testing
  _counters: counters,
};
