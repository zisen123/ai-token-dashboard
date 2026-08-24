import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { queryOpencodexPerf } from '../src/opencodex-perf.mjs';

const DAY_MS = 86_400_000;
const CREATE_TABLE = `CREATE TABLE requests (
  request_id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  first_output_ms INTEGER,
  usage_json TEXT
)`;

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ocxperf-'));
  const path = join(dir, 'routing-history.sqlite');
  const db = new DatabaseSync(path);
  db.exec(CREATE_TABLE);
  let closed = false;
  return {
    path,
    insert(row, index) {
      db.prepare(
        'INSERT INTO requests (request_id, timestamp, provider, model, status, duration_ms, first_output_ms, usage_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        `req-${index}`,
        row.timestamp,
        row.provider || 'sophnet',
        row.model,
        row.status ?? 200,
        row.durationMs,
        row.firstOutputMs ?? null,
        row.usageJson ?? null
      );
    },
    close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
    cleanup() {
      this.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function withDbEnv(path, fn) {
  const prev = {
    db: process.env.OPENCODEX_HISTORY_DB,
    window: process.env.OPENCODEX_PERF_WINDOW_DAYS
  };
  process.env.OPENCODEX_HISTORY_DB = path;
  delete process.env.OPENCODEX_PERF_WINDOW_DAYS;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev.db === undefined) delete process.env.OPENCODEX_HISTORY_DB;
      else process.env.OPENCODEX_HISTORY_DB = prev.db;
      if (prev.window === undefined) delete process.env.OPENCODEX_PERF_WINDOW_DAYS;
      else process.env.OPENCODEX_PERF_WINDOW_DAYS = prev.window;
    });
}

test('aggregates TTFT percentiles, samples and tps per model', async () => {
  const db = tmpDb();
  const now = Date.now();
  try {
    // Model A: four valid TTFT samples [100,200,300,400] -> P50=200, P95=400.
    // tps uses every row with outputTokens (including the NULL/zero-TTFT ones):
    // (100+200+300+50+50)/(1000+2000+3000+700+700)*1000 = 94.6; the fourth row
    // has no outputTokens and must not contribute to the ratio.
    db.insert({ model: 'model-a', timestamp: now - 1000, durationMs: 1000, firstOutputMs: 100, usageJson: '{"outputTokens":100}' }, 1);
    db.insert({ model: 'model-a', timestamp: now - 2000, durationMs: 2000, firstOutputMs: 200, usageJson: '{"outputTokens":200}' }, 2);
    db.insert({ model: 'model-a', timestamp: now - 3000, durationMs: 3000, firstOutputMs: 300, usageJson: '{"outputTokens":300}' }, 3);
    db.insert({ model: 'model-a', timestamp: now - 4000, durationMs: 500, firstOutputMs: 400, usageJson: '{"inputTokens":5}' }, 4);
    // NULL / zero first_output_ms rows do not count as samples.
    db.insert({ model: 'model-a', timestamp: now - 5000, durationMs: 700, firstOutputMs: null, usageJson: '{"outputTokens":50}' }, 5);
    db.insert({ model: 'model-a', timestamp: now - 6000, durationMs: 700, firstOutputMs: 0, usageJson: '{"outputTokens":50}' }, 6);

    // Model B: only two TTFT samples -> dropped by the min-samples filter.
    db.insert({ model: 'model-b', timestamp: now - 1000, durationMs: 900, firstOutputMs: 150, usageJson: '{"outputTokens":10}' }, 7);
    db.insert({ model: 'model-b', timestamp: now - 2000, durationMs: 900, firstOutputMs: 250, usageJson: '{"outputTokens":10}' }, 8);

    // Old row outside the 7-day window must be ignored.
    db.insert({ model: 'model-a', timestamp: now - 8 * DAY_MS, durationMs: 100, firstOutputMs: 999, usageJson: '{"outputTokens":999}' }, 9);

    // Non-200 rows and empty/unknown models are discarded.
    db.insert({ model: 'model-a', timestamp: now - 1000, durationMs: 100, firstOutputMs: 5, status: 500, usageJson: '{"outputTokens":1}' }, 10);
    db.insert({ model: 'unknown', timestamp: now - 1000, durationMs: 100, firstOutputMs: 5, usageJson: '{"outputTokens":1}' }, 11);
    db.insert({ model: '', timestamp: now - 1000, durationMs: 100, firstOutputMs: 5, usageJson: '{"outputTokens":1}' }, 12);

    db.close();

    await withDbEnv(db.path, async () => {
      const result = await queryOpencodexPerf({ force: true });
      assert.equal(result.ok, true);
      assert.equal(result.windowDays, 7);
      assert.deepEqual(result.rows.map(r => r.model), ['model-a'], 'low-sample models are filtered out');
      const row = result.rows[0];
      assert.equal(row.samples, 4);
      assert.equal(row.ttftP50Ms, 200);
      assert.equal(row.ttftP95Ms, 400);
      assert.equal(row.tps, 94.6);
    });
  } finally {
    db.cleanup();
  }
});

test('window length follows OPENCODEX_PERF_WINDOW_DAYS', async () => {
  const db = tmpDb();
  const now = Date.now();
  try {
    // Samples at now-1d, now-2d and now-2.5d stay inside a 3-day window,
    // the now-6d row drops out.
    db.insert({ model: 'model-w', timestamp: now - 1 * DAY_MS, durationMs: 1000, firstOutputMs: 100, usageJson: '{"outputTokens":10}' }, 1);
    db.insert({ model: 'model-w', timestamp: now - 2 * DAY_MS, durationMs: 1000, firstOutputMs: 200, usageJson: '{"outputTokens":10}' }, 2);
    db.insert({ model: 'model-w', timestamp: now - 2.5 * DAY_MS, durationMs: 1000, firstOutputMs: 300, usageJson: '{"outputTokens":10}' }, 3);
    db.insert({ model: 'model-w', timestamp: now - 6 * DAY_MS, durationMs: 1000, firstOutputMs: 900, usageJson: '{"outputTokens":10}' }, 4);
    db.close();

    const prevWindow = process.env.OPENCODEX_PERF_WINDOW_DAYS;
    const prevDb = process.env.OPENCODEX_HISTORY_DB;
    process.env.OPENCODEX_HISTORY_DB = db.path;
    process.env.OPENCODEX_PERF_WINDOW_DAYS = '3';
    try {
      const result = await queryOpencodexPerf({ force: true });
      assert.equal(result.windowDays, 3);
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].samples, 3, 'the 6-day-old row must be excluded');
      assert.equal(result.rows[0].ttftP95Ms, 300);
    } finally {
      if (prevDb === undefined) delete process.env.OPENCODEX_HISTORY_DB;
      else process.env.OPENCODEX_HISTORY_DB = prevDb;
      if (prevWindow === undefined) delete process.env.OPENCODEX_PERF_WINDOW_DAYS;
      else process.env.OPENCODEX_PERF_WINDOW_DAYS = prevWindow;
    }
  } finally {
    db.cleanup();
  }
});

test('returns ok:false without throwing when the db file is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocxperf-missing-'));
  try {
    await withDbEnv(join(dir, 'does-not-exist.sqlite'), async () => {
      const result = await queryOpencodexPerf({ force: true });
      assert.deepEqual(result, { ok: false, rows: [] });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the 60s cache returns the same payload until forced', async () => {
  const db = tmpDb();
  try {
    db.insert({ model: 'model-c', timestamp: Date.now() - 1000, durationMs: 1000, firstOutputMs: 100, usageJson: '{"outputTokens":10}' }, 1);
    db.insert({ model: 'model-c', timestamp: Date.now() - 2000, durationMs: 1000, firstOutputMs: 200, usageJson: '{"outputTokens":10}' }, 2);
    db.insert({ model: 'model-c', timestamp: Date.now() - 3000, durationMs: 1000, firstOutputMs: 300, usageJson: '{"outputTokens":10}' }, 3);
    db.close();

    await withDbEnv(db.path, async () => {
      const first = await queryOpencodexPerf({ force: true });
      const second = await queryOpencodexPerf();
      assert.equal(second, first, 'cached payload is reused within the TTL');
      const third = await queryOpencodexPerf({ force: true });
      assert.notEqual(third, first, 'force bypasses the cache');
      assert.equal(third.rows.length, 1);
    });
  } finally {
    db.cleanup();
  }
});
