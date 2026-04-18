/**
 * Health check and readiness endpoints.
 *
 * Common conventions:
 *   /healthz    - liveness: process is running (no DB check — fast)
 *   /readyz     - readiness: ready to serve traffic (DB reachable)
 *   /metrics    - runtime + app metrics (not Prometheus format — JSON for simplicity)
 */

const os = require('os');
const startTime = Date.now();

function registerHealthRoutes(app, basePath, deps) {
  const { query, usePostgres, youtubeQuota, notifications } = deps;

  // Liveness — always returns 200 if the process is responsive.
  // Note: Cloud Run's Google front-end intercepts /healthz in some configs,
  // returning a Google 404 before it reaches Express. We expose both /health
  // and /healthz so monitoring probes can use either.
  const liveness = (req, res) => {
    res.json({
      status: 'ok',
      uptime_s: Math.round((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    });
  };
  app.get(`${basePath}/health`, liveness);
  app.get(`${basePath}/healthz`, liveness);

  // Readiness — checks that we can reach dependencies
  app.get(`${basePath}/readyz`, async (req, res) => {
    const checks = {};
    let allOk = true;

    // DB
    try {
      await query('SELECT 1 as ok');
      checks.database = { ok: true, kind: usePostgres ? 'postgres' : 'sqlite' };
    } catch (e) {
      allOk = false;
      checks.database = { ok: false, error: e.message };
    }

    // Memory (fail if >90% heap used)
    const mem = process.memoryUsage();
    const heapPct = mem.heapUsed / mem.heapTotal;
    checks.memory = {
      ok: heapPct < 0.9,
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    };
    if (!checks.memory.ok) allOk = false;

    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ready' : 'unready',
      uptime_s: Math.round((Date.now() - startTime) / 1000),
      checks,
    });
  });

  // Runtime metrics — JSON format (not Prometheus)
  app.get(`${basePath}/metrics`, (req, res) => {
    const mem = process.memoryUsage();
    const load = os.loadavg();
    res.json({
      uptime_s: Math.round((Date.now() - startTime) / 1000),
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
        externalMB: Math.round(mem.external / 1024 / 1024),
      },
      cpu: {
        loadAvg1m: load[0],
        loadAvg5m: load[1],
        loadAvg15m: load[2],
        cores: os.cpus().length,
      },
      node: {
        version: process.version,
        platform: process.platform,
      },
      youtube_quota: youtubeQuota?.status?.() || null,
      notifications: {
        enabledSinks: notifications?.getEnabledSinks?.() || [],
      },
    });
  });
}

module.exports = { registerHealthRoutes, startTime };
