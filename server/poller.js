// The 24/7 poller. Every POLL_INTERVAL_MS it fetches NewsWeb, stores every message,
// matches against all desks, and notifies each matching desk's Teams webhook at-most-once.
import { config, loadDesks } from './config.js';
import { fetchMessages } from './newsweb.js';
import { matchDesks } from './matcher.js';
import { sendToTeams } from './teams.js';
import {
  upsertMessage,
  hasNotified,
  recordNotification,
  getDesksWithNotifications,
} from './db.js';
import { log } from './log.js';

const MAX_SEND_RETRIES = 5; // per (message, desk) across ticks before giving up

// Captured at boot. Used as the notify cutoff ONLY for desks with no prior history
// (first-ever boot or a newly-activated desk): their backlog is seeded silently and we
// notify forward from here. Established desks instead catch up the gap (see tick()).
const PROCESS_START_MS = Date.now();

// In-memory failure counters for transient webhook errors: "messageId|desk" -> attempts.
const sendAttempts = new Map();

let desks = loadDesks();
let timer = null;
let running = false;

// Snapshot at startup: which desks already had notification history. An established desk
// (in this set) catches up un-notified gap messages within the catch-up window; a desk NOT
// in this set is first-boot/newly-activated and gets its backlog seeded silently.
let desksWithHistoryAtBoot = new Set();
let firstTick = true; // first poll after (re)start fetches a larger batch to catch up

function parsePublishedMs(publishedTime) {
  if (!publishedTime) return null;
  const ms = Date.parse(publishedTime);
  return Number.isNaN(ms) ? null : ms;
}

// NewsWeb returns `category` as an array of objects (e.g. [{ category_no: "..." }]).
// Flatten it to a single human-readable string for storage and the Teams card.
function extractCategory(cat) {
  if (!cat) return '';
  if (typeof cat === 'string') return cat;
  if (Array.isArray(cat)) return cat[0]?.category_no || cat[0]?.category || '';
  return '';
}

function normalize(raw) {
  const messageId = String(raw.messageId ?? raw.id ?? '').trim();
  return {
    messageId,
    issuerSign: String(raw.issuerSign || ''),
    issuerName: String(raw.issuerName || ''),
    title: String(raw.title || ''),
    category: extractCategory(raw.category),
    publishedTime: String(raw.publishedTime || ''),
    publishedMs: parsePublishedMs(raw.publishedTime),
  };
}

async function notifyDesk(deskKey, msg) {
  const key = `${msg.messageId}|${deskKey}`;
  const desk = desks[deskKey];

  if (!desk.teamsWebhookUrl) {
    // No webhook configured yet (placeholder desk). Skip quietly-ish; once you add the
    // URL it will start notifying for messages published after that point.
    return;
  }

  const res = await sendToTeams(desk.teamsWebhookUrl, msg);

  if (res.ok) {
    recordNotification({ messageId: msg.messageId, desk: deskKey, httpStatus: res.status, ok: true });
    sendAttempts.delete(key);
    log.info(`Notified ${desk.label} — ${msg.issuerSign} "${msg.title}" (HTTP ${res.status})`);
    return;
  }

  const attempts = (sendAttempts.get(key) || 0) + 1;
  sendAttempts.set(key, attempts);
  log.error(
    `Teams send failed for ${desk.label} / ${msg.issuerSign} (attempt ${attempts}/${MAX_SEND_RETRIES}): ` +
      `HTTP ${res.status ?? 'n/a'} ${res.error || ''}`,
  );

  if (attempts >= MAX_SEND_RETRIES) {
    // Give up so we don't retry forever; record as failed to stop re-sending.
    recordNotification({
      messageId: msg.messageId,
      desk: deskKey,
      httpStatus: res.status,
      ok: false,
      error: res.error,
    });
    sendAttempts.delete(key);
    log.error(`Giving up on ${desk.label} / ${msg.issuerSign} after ${MAX_SEND_RETRIES} attempts.`);
  }
}

// Decide what to do with a matched message for a desk we haven't handled yet.
// Returns 'send' (notify Teams) or 'seed' (record silently, no send).
function decideAction(deskKey, msg, now) {
  // Unparseable timestamp: don't silently drop a possible alert.
  if (msg.publishedMs === null) return 'send';

  if (desksWithHistoryAtBoot.has(deskKey)) {
    // Established desk: catch up the gap, but only within the catch-up window so a long
    // outage doesn't dump a burst of stale items. Older un-notified items are seeded.
    return msg.publishedMs >= now - config.catchupWindowMs ? 'send' : 'seed';
  }
  // First boot for this desk (or newly activated): seed the backlog, notify forward only.
  return msg.publishedMs > PROCESS_START_MS ? 'send' : 'seed';
}

async function tick() {
  if (running) return; // guard against overlap if a tick runs long
  running = true;
  try {
    // First poll after (re)start pulls a larger batch so the catch-up window has data.
    const limit = firstTick ? config.catchupFetchLimit : config.newswebLimit;
    const raw = await fetchMessages({ limit });
    const messages = raw.map(normalize).filter((m) => m.messageId);

    // Oldest first so Teams cards arrive in chronological order.
    messages.sort((a, b) => (a.publishedMs || 0) - (b.publishedMs || 0));

    const now = Date.now();
    for (const msg of messages) {
      const matched = matchDesks(msg, desks);
      upsertMessage(msg, matched); // store every message (for the dashboard), matched or not

      if (matched.length === 0) continue;

      for (const deskKey of matched) {
        // Placeholder desks (no webhook) are tracked in the DB only — never notified/seeded,
        // so when their webhook is added later they start fresh as a "no history" desk.
        if (!desks[deskKey].teamsWebhookUrl) continue;
        if (hasNotified(msg.messageId, deskKey)) continue;

        if (decideAction(deskKey, msg, now) === 'seed') {
          recordNotification({ messageId: msg.messageId, desk: deskKey, ok: true, seeded: true });
          continue;
        }
        await notifyDesk(deskKey, msg);
      }
    }
    firstTick = false;
  } catch (err) {
    log.error('Poll cycle failed:', err.message);
    // Keep firstTick true so the next cycle retries the larger catch-up fetch.
  } finally {
    running = false;
  }
}

export function startPoller() {
  // Snapshot which desks already have history BEFORE the first tick mutates the table.
  desksWithHistoryAtBoot = getDesksWithNotifications();
  firstTick = true;

  const deskCount = Object.keys(desks).length;
  const liveCount = Object.values(desks).filter((d) => d.teamsWebhookUrl).length;
  const established = [...desksWithHistoryAtBoot].join(', ') || 'none';
  log.info(
    `Poller starting: ${deskCount} desks (${liveCount} with webhooks), every ${config.pollIntervalMs}ms.`,
  );
  log.info(
    `Crash recovery: established desks [${established}] catch up the last ` +
      `${Math.round(config.catchupWindowMs / 3600000)}h (fetch ${config.catchupFetchLimit} on first poll); ` +
      `new desks seed backlog silently and notify forward from ${new Date(PROCESS_START_MS).toISOString()}.`,
  );
  // Run immediately, then on the interval.
  tick();
  timer = setInterval(tick, config.pollIntervalMs);
}

export function stopPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Allow hot-reloading desk config (e.g. after adding a webhook) without a full restart.
export function reloadDesks() {
  desks = loadDesks();
  log.info('Desk config reloaded.');
  return desks;
}
