// SQLite persistence layer (better-sqlite3 — synchronous, zero-config, ideal for a single indie server).
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL'); // better concurrency for the read API while the poller writes
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    message_id    TEXT PRIMARY KEY,
    issuer_sign   TEXT,
    issuer_name   TEXT,
    title         TEXT,
    category      TEXT,
    published_time TEXT,            -- raw NewsWeb publishedTime string
    published_ms  INTEGER,         -- parsed epoch ms (nullable if unparseable)
    matched_desks TEXT,            -- JSON array of desk keys that matched, e.g. ["finanswatch"]
    first_seen_at INTEGER NOT NULL -- epoch ms when the poller first ingested it
  );

  CREATE INDEX IF NOT EXISTS idx_messages_published_ms ON messages(published_ms);
  CREATE INDEX IF NOT EXISTS idx_messages_issuer ON messages(issuer_sign);

  -- One row per (message, desk) we've handled. Doubles as the persistent dedupe ledger:
  -- a row's existence means "already handled for this desk" (sent, failed, or seeded).
  CREATE TABLE IF NOT EXISTS notifications (
    message_id   TEXT NOT NULL,
    desk         TEXT NOT NULL,
    sent_at      INTEGER NOT NULL,  -- epoch ms
    http_status  INTEGER,
    ok           INTEGER NOT NULL,  -- 1 if the webhook accepted it
    error        TEXT,
    seeded       INTEGER NOT NULL DEFAULT 0,  -- 1 = recorded WITHOUT sending (backlog/out-of-window)
    PRIMARY KEY (message_id, desk)
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_sent_at ON notifications(sent_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_desk ON notifications(desk);
`);

// Migration: add `seeded` to notifications tables created before this column existed.
{
  const cols = db.prepare(`PRAGMA table_info(notifications)`).all().map((c) => c.name);
  if (!cols.includes('seeded')) {
    db.exec(`ALTER TABLE notifications ADD COLUMN seeded INTEGER NOT NULL DEFAULT 0`);
  }
}

const stmts = {
  insertMessage: db.prepare(`
    INSERT INTO messages
      (message_id, issuer_sign, issuer_name, title, category, published_time, published_ms, matched_desks, first_seen_at)
    VALUES
      (@message_id, @issuer_sign, @issuer_name, @title, @category, @published_time, @published_ms, @matched_desks, @first_seen_at)
    ON CONFLICT(message_id) DO UPDATE SET
      matched_desks = excluded.matched_desks
  `),
  hasNotification: db.prepare(`SELECT 1 FROM notifications WHERE message_id = ? AND desk = ?`),
  insertNotification: db.prepare(`
    INSERT OR IGNORE INTO notifications (message_id, desk, sent_at, http_status, ok, error, seeded)
    VALUES (@message_id, @desk, @sent_at, @http_status, @ok, @error, @seeded)
  `),
  desksWithNotifications: db.prepare(`SELECT DISTINCT desk FROM notifications`),
};

// Upsert a polled message. matchedDesks is an array of desk keys.
export function upsertMessage(msg, matchedDesks) {
  stmts.insertMessage.run({
    message_id: msg.messageId,
    issuer_sign: msg.issuerSign,
    issuer_name: msg.issuerName,
    title: msg.title,
    category: msg.category,
    published_time: msg.publishedTime,
    published_ms: msg.publishedMs ?? null,
    matched_desks: JSON.stringify(matchedDesks || []),
    first_seen_at: Date.now(),
  });
}

export function hasNotified(messageId, desk) {
  return !!stmts.hasNotification.get(messageId, desk);
}

export function recordNotification({ messageId, desk, httpStatus, ok, error, seeded }) {
  stmts.insertNotification.run({
    message_id: messageId,
    desk,
    sent_at: Date.now(),
    http_status: httpStatus ?? null,
    ok: ok ? 1 : 0,
    error: error || null,
    seeded: seeded ? 1 : 0,
  });
}

// Set of desk keys that already have at least one notification row (sent, failed, or
// seeded). Used at poller startup to tell an established desk (catch up the gap) apart
// from a first-boot / newly-activated desk (seed the backlog silently).
export function getDesksWithNotifications() {
  return new Set(stmts.desksWithNotifications.all().map((r) => r.desk));
}

// ---- Dashboard read queries ----

// Messages that matched at least one desk within [fromMs, toMs), optionally filtered by desk.
export function getHits({ fromMs, toMs, desk }) {
  const rows = db
    .prepare(
      `SELECT * FROM messages
       WHERE matched_desks != '[]' AND matched_desks IS NOT NULL
         AND published_ms >= ? AND published_ms < ?
       ORDER BY published_ms DESC`,
    )
    .all(fromMs, toMs);

  const mapped = rows.map(rowToMessage);
  return desk ? mapped.filter((m) => m.matchedDesks.includes(desk)) : mapped;
}

// Per-ticker message activity over [fromMs, toMs), keyed by UPPERCASE ticker.
// Returns a Map so the API can join it against the desk watchlists.
export function getTickerActivity({ fromMs, toMs }) {
  const rows = db
    .prepare(
      `SELECT issuer_sign AS ticker,
              COUNT(*)    AS count,
              SUM(CASE WHEN matched_desks != '[]' THEN 1 ELSE 0 END) AS hitCount,
              MAX(published_ms) AS lastPublishedMs
       FROM messages
       WHERE published_ms >= ? AND published_ms < ?
       GROUP BY issuer_sign`,
    )
    .all(fromMs, toMs);
  const map = new Map();
  for (const r of rows) map.set((r.ticker || '').toUpperCase(), r);
  return map;
}

export function getStats({ fromMs, toMs }) {
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS totalMessages,
         SUM(CASE WHEN matched_desks != '[]' THEN 1 ELSE 0 END) AS totalHits
       FROM messages
       WHERE published_ms >= ? AND published_ms < ?`,
    )
    .get(fromMs, toMs);

  const perDesk = db
    .prepare(
      `SELECT desk, COUNT(*) AS sent
       FROM notifications
       WHERE sent_at >= ? AND sent_at < ? AND ok = 1 AND seeded = 0
       GROUP BY desk`,
    )
    .all(fromMs, toMs);

  return {
    totalMessages: totals.totalMessages || 0,
    totalHits: totals.totalHits || 0,
    notificationsByDesk: Object.fromEntries(perDesk.map((r) => [r.desk, r.sent])),
  };
}

function rowToMessage(r) {
  return {
    messageId: r.message_id,
    issuerSign: r.issuer_sign,
    issuerName: r.issuer_name,
    title: r.title,
    category: r.category,
    publishedTime: r.published_time,
    publishedMs: r.published_ms,
    matchedDesks: safeParseArray(r.matched_desks),
    firstSeenAt: r.first_seen_at,
  };
}

function safeParseArray(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export default db;
