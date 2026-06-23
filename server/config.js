// Loads runtime config from environment + the desks-config.json file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '127.0.0.1',
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 15000,
  newswebLimit: Number(process.env.NEWSWEB_LIMIT) || 50,
  // Crash recovery: on the first poll after (re)start, fetch a larger batch so we can catch
  // up the gap, and only re-notify gap messages published within this window (avoids a burst
  // after a long outage). Both env-configurable.
  catchupWindowMs: Number(process.env.CATCHUP_WINDOW_MS) || 6 * 60 * 60 * 1000, // 6h
  catchupFetchLimit: Number(process.env.CATCHUP_FETCH_LIMIT) || 200,
  desksConfigPath: resolveFromRoot(process.env.DESKS_CONFIG_PATH || 'desks-config.json'),
  dbPath: resolveFromRoot(process.env.DB_PATH || 'data/newsweb.db'),
  tzName: process.env.TZ_NAME || 'Europe/Oslo',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

// Reads and validates the desk config. Returns a normalized map:
//   { finanswatch: { label, keywords:[UPPER], ignoreWords:[lower], teamsWebhookUrl } , ... }
export function loadDesks() {
  let raw;
  try {
    raw = fs.readFileSync(config.desksConfigPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read desks config at ${config.desksConfigPath}: ${err.message}. ` +
        `Copy desks-config.example.json to desks-config.json.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`desks config is not valid JSON: ${err.message}`);
  }

  const desksIn = parsed.desks || {};
  const desks = {};
  for (const [key, d] of Object.entries(desksIn)) {
    desks[key] = {
      key,
      label: d.label || key,
      teamsWebhookUrl: (d.teamsWebhookUrl || '').trim(),
      // Normalize once so the matcher can compare cheaply.
      keywords: (d.keywords || []).map((k) => String(k).toUpperCase().trim()).filter(Boolean),
      ignoreWords: (d.ignoreWords || []).map((w) => String(w).toLowerCase().trim()).filter(Boolean),
    };
  }

  if (Object.keys(desks).length === 0) {
    throw new Error('desks config contains no desks.');
  }
  return desks;
}
