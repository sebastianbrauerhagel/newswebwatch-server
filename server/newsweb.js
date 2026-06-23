// Thin client for the Oslo Børs NewsWeb public API.
const LIST_URL = 'https://api3.oslo.oslobors.no/v1/newsreader/list';
const ISSUERS_URL = 'https://api3.oslo.oslobors.no/v1/newsreader/issuers';

const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; NewsWebMonitor/1.0)',
};

// Fetch the latest messages. Returns an array of message objects (possibly empty).
export async function fetchMessages({ start = 0, limit = 50 } = {}) {
  const url = `${LIST_URL}?start=${start}&limit=${limit}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`NewsWeb list HTTP ${r.status}`);
  const json = await r.json();
  return json?.data?.messages || [];
}

// Fetch the active issuer list (symbol + name). Used by the dashboard ticker overview.
export async function fetchIssuers() {
  const r = await fetch(ISSUERS_URL, { headers: HEADERS });
  if (!r.ok) throw new Error(`NewsWeb issuers HTTP ${r.status}`);
  const json = await r.json();
  return (json?.data?.issuers || [])
    .filter((i) => i.isActive === 1 && i.symbol && i.name)
    .map((i) => ({ symbol: i.symbol, name: i.name }));
}
