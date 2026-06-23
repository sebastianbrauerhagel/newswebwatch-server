// Minimal structured-ish logger. PM2 captures stdout/stderr to its log files.
function ts() {
  return new Date().toISOString();
}

export const log = {
  info: (...a) => console.log(`[${ts()}] [INFO]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${ts()}] [ERROR]`, ...a),
};
