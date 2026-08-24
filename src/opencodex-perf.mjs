import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DB_PATH = '/home/yicong.wu/.opencodex/routing-history.sqlite';
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_WINDOW_DAYS = 7;
const MIN_SAMPLES = 3;
const DAY_MS = 86_400_000;

let cache = { until: 0, data: null };

export async function queryOpencodexPerf({ force = false } = {}) {
  const ttl = Math.max(5_000, Number(process.env.OPENCODEX_PERF_TTL_MS) || DEFAULT_TTL_MS);
  const now = Date.now();
  if (!force && cache.data && now < cache.until) return cache.data;

  const dbPath = process.env.OPENCODEX_HISTORY_DB || DEFAULT_DB_PATH;
  const windowDays = Math.max(1, Math.floor(Number(process.env.OPENCODEX_PERF_WINDOW_DAYS) || DEFAULT_WINDOW_DAYS));

  let result;
  try {
    result = computePerf(dbPath, windowDays, now);
  } catch {
    result = { ok: false, rows: [] };
  }
  cache = { until: now + (result.ok ? ttl : Math.min(ttl, DEFAULT_TTL_MS)), data: result };
  return result;
}

function computePerf(dbPath, windowDays, now) {
  if (!existsSync(dbPath)) return { ok: false, rows: [] };

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return { ok: false, rows: [] };
  }

  try {
    const cutoff = now - windowDays * DAY_MS;
    const rawRows = db.prepare(
      'SELECT model, first_output_ms, duration_ms, usage_json FROM requests WHERE status = 200 AND timestamp >= ?'
    ).all(cutoff);
    const rows = aggregatePerf(rawRows);
    return { ok: true, windowDays, updatedAt: new Date().toISOString(), rows };
  } finally {
    db.close();
  }
}

function aggregatePerf(rawRows) {
  const groups = new Map();
  for (const raw of rawRows) {
    const model = String(raw.model || '').trim();
    if (!model || model.toLowerCase() === 'unknown') continue;

    let group = groups.get(model);
    if (!group) {
      group = { model, ttft: [], outputTokens: 0, durationMs: 0 };
      groups.set(model, group);
    }

    const ttft = Number(raw.first_output_ms) || 0;
    if (ttft > 0) group.ttft.push(ttft);

    // tps follows the opencodex convention: outputTokens / (duration / 1000),
    // without subtracting TTFT; only rows with actual output count.
    const usage = parseJson(raw.usage_json);
    const outputTokens = Number(usage?.outputTokens) || 0;
    const durationMs = Number(raw.duration_ms) || 0;
    if (outputTokens > 0 && durationMs > 0) {
      group.outputTokens += outputTokens;
      group.durationMs += durationMs;
    }
  }

  const rows = [];
  for (const group of groups.values()) {
    if (group.ttft.length < MIN_SAMPLES) continue;
    const sorted = group.ttft.sort((a, b) => a - b);
    const tps = group.durationMs > 0 ? (group.outputTokens / group.durationMs) * 1000 : 0;
    rows.push({
      model: group.model,
      samples: sorted.length,
      ttftP50Ms: percentile(sorted, 0.5),
      ttftP95Ms: percentile(sorted, 0.95),
      tps: Math.round(tps * 10) / 10
    });
  }
  return rows.sort((a, b) => b.samples - a.samples || a.model.localeCompare(b.model));
}

// Nearest-rank percentile over ascending values.
function percentile(sortedValues, q) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(q * sortedValues.length) - 1));
  return Math.round(sortedValues[index]);
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
