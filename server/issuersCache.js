// In-memory cache of Oslo Børs issuer names (symbol -> name), refreshed periodically.
// Used by the dashboard ticker overview so the frontend no longer needs a static map.
import { fetchIssuers } from './newsweb.js';
import { log } from './log.js';

let map = new Map();
let refreshTimer = null;

export async function refreshIssuers() {
  const list = await fetchIssuers(); // throws on HTTP error (e.g. the permanent 405)
  if (list.length) {
    map = new Map(list.map((i) => [i.symbol.toUpperCase(), i.name]));
    log.info(`Issuer cache refreshed: ${map.size} issuers.`);
  }
  return map.size;
}

export function issuerName(symbol) {
  return map.get((symbol || '').toUpperCase()) || '';
}

// Try once at startup. NewsWeb's /newsreader/issuers blocks server-side callers (HTTP 405),
// so this usually fails permanently — the dashboard's built-in ISSUER_MAP is the source of
// names in that case. Only schedule hourly refreshes if the first fetch actually worked, so
// we don't spam logs retrying a permanent failure.
export function startIssuerCache() {
  refreshIssuers()
    .then(() => {
      if (!refreshTimer) {
        refreshTimer = setInterval(() => refreshIssuers().catch(() => {}), 60 * 60 * 1000);
      }
    })
    .catch((err) => {
      log.warn(
        `Issuer name cache unavailable (${err.message}). This is expected — NewsWeb blocks ` +
          `server-side issuer lookups; the dashboard uses its built-in ISSUER_MAP instead.`,
      );
    });
}
