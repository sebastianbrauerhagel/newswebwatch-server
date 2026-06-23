// Read-only dashboard API. The Vercel-hosted index.html consumes these endpoints.
import { Router } from 'express';
import { config, loadDesks } from '../config.js';
import { dayRange } from '../time.js';
import { getHits, getTickerActivity, getStats } from '../db.js';
import { issuerName } from '../issuersCache.js';
import { log } from '../log.js';

export const api = Router();

// GET /api/health — liveness check.
api.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// GET /api/desks — desk keys + labels ONLY (never expose webhook URLs).
api.get('/desks', (_req, res) => {
  try {
    const desks = loadDesks();
    const list = Object.values(desks).map((d) => ({
      key: d.key,
      label: d.label,
      keywordCount: d.keywords.length,
      hasWebhook: !!d.teamsWebhookUrl,
    }));
    res.json({ desks: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hits?date=YYYY-MM-DD&desk=finanswatch
// Matched messages for a day (defaults to today in the configured timezone).
api.get('/hits', (req, res) => {
  try {
    const { fromMs, toMs, date } = dayRange(req.query.date, config.tzName);
    const desk = req.query.desk ? String(req.query.desk) : null;
    const hits = getHits({ fromMs, toMs, desk });
    res.json({ date, desk, count: hits.length, hits });
  } catch (err) {
    log.error('GET /hits failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tickers?date=YYYY-MM-DD
// The ticker overview: every ticker on any desk's watchlist, with company name,
// which desk(s) watch it, and today's message/hit activity. This is the server-driven
// replacement for the old static ISSUER_MAP + per-desk keyword lists.
api.get('/tickers', (req, res) => {
  try {
    const { fromMs, toMs, date } = dayRange(req.query.date, config.tzName);
    const desks = loadDesks();
    const activity = getTickerActivity({ fromMs, toMs });

    // Union of all desk watchlists, tracking desk membership.
    const byTicker = new Map();
    for (const d of Object.values(desks)) {
      for (const sym of d.keywords) {
        const key = sym.toUpperCase();
        if (!byTicker.has(key)) {
          byTicker.set(key, {
            ticker: key,
            name: issuerName(key),
            desks: [],
            count: 0,
            hitCount: 0,
            lastPublishedMs: null,
          });
        }
        byTicker.get(key).desks.push(d.key);
      }
    }

    // Merge in today's activity counts.
    for (const t of byTicker.values()) {
      const a = activity.get(t.ticker);
      if (a) {
        t.count = a.count;
        t.hitCount = a.hitCount;
        t.lastPublishedMs = a.lastPublishedMs;
      }
    }

    const tickers = [...byTicker.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
    const deskList = Object.values(desks).map((d) => ({ key: d.key, label: d.label }));
    res.json({ date, desks: deskList, count: tickers.length, tickers });
  } catch (err) {
    log.error('GET /tickers failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats?date=YYYY-MM-DD — totals + notifications sent per desk.
api.get('/stats', (req, res) => {
  try {
    const { fromMs, toMs, date } = dayRange(req.query.date, config.tzName);
    const stats = getStats({ fromMs, toMs });
    res.json({ date, ...stats });
  } catch (err) {
    log.error('GET /stats failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});
