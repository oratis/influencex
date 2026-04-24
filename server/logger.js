/**
 * Minimal structured logger. Thin wrapper over console so we can:
 *   - filter by level via LOG_LEVEL env (debug|info|warn|error; default info)
 *   - emit JSON in production so Cloud Run log parsers pick up severity
 *   - keep call sites short (`log.warn(...)` replaces scattered `console.warn`)
 *
 * Deliberately no dependency — pino/winston can come later if we need
 * transports, serializers, or sampling.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveThreshold() {
  const configured = (process.env.LOG_LEVEL || '').toLowerCase();
  if (LEVELS[configured] !== undefined) return LEVELS[configured];
  return process.env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug;
}

const threshold = resolveThreshold();
const structured = process.env.NODE_ENV === 'production';

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  if (structured) {
    const payload = {
      severity: level.toUpperCase(),
      time: new Date().toISOString(),
      message: args.map(a => (typeof a === 'string' ? a : safeStringify(a))).join(' '),
    };
    const out = level === 'error' ? console.error : console.log;
    out(JSON.stringify(payload));
  } else {
    const fn = level === 'error' ? console.error
      : level === 'warn' ? console.warn
      : console.log;
    fn(`[${level}]`, ...args);
  }
}

function safeStringify(v) {
  try { return JSON.stringify(v); }
  catch { return String(v); }
}

module.exports = {
  debug: (...args) => emit('debug', args),
  info:  (...args) => emit('info',  args),
  warn:  (...args) => emit('warn',  args),
  error: (...args) => emit('error', args),
};
