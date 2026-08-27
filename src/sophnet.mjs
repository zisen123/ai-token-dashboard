import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { queryOpencodexPerf } from './opencodex-perf.mjs';

const DEFAULT_BASE_URL = 'https://www.sophnet.com/api/open-apis';
const DEFAULT_DATA_DIR = '/home/yicong.wu/sophnet';
const RECENT_DAYS = 30;
const HTTP_TIMEOUT_MS = 30_000;
const NEW_MODEL_WINDOW_MS = 24 * 3600 * 1000;

let cache = { until: 0, data: null };

export async function querySophnet({ force = false } = {}) {
  const ttl = Math.max(10_000, Number(process.env.SOPHNET_CACHE_TTL_MS) || 300_000);
  const now = Date.now();
  if (!force && cache.data && now < cache.until) return cache.data;

  const dataDir = resolve(process.env.SOPHNET_DATA_DIR || DEFAULT_DATA_DIR);
  const baseUrl = String(process.env.SOPHNET_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const today = localDate(new Date());
  const start = addDays(today, -(RECENT_DAYS - 1));

  const tokensCache = readJson(resolve(dataDir, '.tokens.json'), {});
  const overviewCache = readJson(resolve(dataDir, '.overview.json'), null);
  const costBreakdown = readJson(resolve(dataDir, '.cost_breakdown.json'), null);
  const modelCache = readJson(resolve(dataDir, '.models_cache.json'), {});

  const localPayload = buildLocalPayload({
    dataDir,
    today,
    start,
    tokensCache,
    overviewCache,
    costBreakdown,
    modelCache
  });

  // Fetch routing-history perf independently: its failure must never block
  // the main Sophnet payload. Kicked off early so it overlaps with API calls.
  const perfPromise = queryOpencodexPerf({ force }).catch(() => ({ ok: false, rows: [] }));

  const apiKey = resolveApiKey(dataDir);
  if (!apiKey) {
    const payload = {
      ...localPayload,
      ok: false,
      status: 'missing_key',
      error: '未找到 Sophnet API key：设置 SOPHNET_API_KEY 或保留 sophnet/apikey 文件',
      live: null,
      newModels: fallbackNewModels(dataDir, localPayload.modelCatalog.items, Date.now()),
      perf: await perfPromise
    };
    cache = { until: now + Math.min(ttl, 60_000), data: payload };
    return payload;
  }

  try {
    const [balanceBox, usageBox, modelsBox, perf] = await Promise.all([
      sophnetGet(baseUrl, apiKey, '/projects/balance'),
      sophnetGet(baseUrl, apiKey, '/projects/usage_detail', { beginTime: start, endTime: today }),
      sophnetGet(baseUrl, apiKey, '/v1/models'),
      perfPromise
    ]);

    const live = buildLivePayload({ balanceBox, usageBox, modelsBox, start, today });
    const nowMs = Date.now();
    const seen = recordModelsSeen(dataDir, live.models.items, nowMs);
    const payload = {
      ...localPayload,
      ok: true,
      status: 'ok',
      error: '',
      generatedAt: new Date().toISOString(),
      live,
      newModels: computeNewModels(live.models.items, seen, nowMs),
      overview: mergeOverview(localPayload.overview, live.balance),
      perf
    };
    cache = { until: now + ttl, data: payload };
    return payload;
  } catch (error) {
    const payload = {
      ...localPayload,
      ok: false,
      status: 'api_error',
      error: error.message,
      generatedAt: new Date().toISOString(),
      live: null,
      newModels: fallbackNewModels(dataDir, localPayload.modelCatalog.items, Date.now()),
      perf: await perfPromise
    };
    cache = { until: now + Math.min(ttl, 60_000), data: payload };
    return payload;
  }
}

function buildLocalPayload({ dataDir, today, start, tokensCache, overviewCache, costBreakdown, modelCache }) {
  const daily = dailyRowsFromCache(tokensCache);
  const recentDaily = daily.filter(r => r.date >= start && r.date <= today);
  const recentTotals = aggregateRows(recentDaily);
  const allTotals = aggregateRows(daily);
  const modelTotals = aggregateByModel(recentDaily);
  const vendorTotals = aggregateVendors(modelTotals, modelCache);
  const modelCatalog = catalogFromCache(modelCache);

  return {
    ok: true,
    status: 'local_cache',
    error: '',
    generatedAt: new Date().toISOString(),
    dataDir,
    range: { start, end: today, days: RECENT_DAYS },
    overview: overviewCache,
    costBreakdown,
    daily,
    recentDaily,
    recentTotals,
    allTotals,
    modelTotals,
    vendorTotals,
    modelCatalog,
    live: null
  };
}

function dailyRowsFromCache(cacheData) {
  const rows = [];
  for (const [date, entry] of Object.entries(cacheData || {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!entry || typeof entry !== 'object') continue;
    const tokensByModel = entry.m || {};
    const costByModel = entry.mc || {};
    const invokesByModel = entry.i || {};
    const names = new Set([
      ...Object.keys(tokensByModel),
      ...Object.keys(costByModel),
      ...Object.keys(invokesByModel)
    ]);
    for (const model of names) {
      const tokens = Number(tokensByModel[model]) || 0;
      const costCny = Number(costByModel[model]) || 0;
      const invokes = Number(invokesByModel[model]) || 0;
      if (!tokens && !costCny && !invokes) continue;
      rows.push({ date, model: shortModelName(model), rawModel: model, tokens, costCny, invokes });
    }
  }
  return rows;
}

function aggregateRows(rows) {
  const acc = rows.reduce((memo, r) => {
    memo.tokens += r.tokens || 0;
    memo.costCny += r.costCny || 0;
    memo.invokes += r.invokes || 0;
    memo.days.add(r.date);
    memo.models.add(r.model);
    return memo;
  }, { tokens: 0, costCny: 0, invokes: 0, days: new Set(), models: new Set() });
  return {
    tokens: acc.tokens,
    costCny: round4(acc.costCny),
    invokes: acc.invokes,
    dayCount: acc.days.size,
    modelCount: acc.models.size
  };
}

function aggregateByModel(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.model;
    if (!map.has(key)) {
      map.set(key, { model: key, rawModel: r.rawModel, tokens: 0, costCny: 0, invokes: 0, activeDays: new Set() });
    }
    const x = map.get(key);
    x.tokens += r.tokens || 0;
    x.costCny += r.costCny || 0;
    x.invokes += r.invokes || 0;
    x.activeDays.add(r.date);
  }
  return Array.from(map.values())
    .map(x => ({ ...x, activeDays: x.activeDays.size }))
    .sort((a, b) => b.costCny - a.costCny || b.tokens - a.tokens);
}

function aggregateVendors(modelTotals, modelCache) {
  const map = new Map();
  for (const m of modelTotals) {
    const vendor = modelCache[m.model] || modelCache[m.rawModel] || classifyModel(m.model);
    if (!map.has(vendor)) map.set(vendor, { vendor, tokens: 0, costCny: 0, invokes: 0, models: 0 });
    const x = map.get(vendor);
    x.tokens += m.tokens;
    x.costCny += m.costCny;
    x.invokes += m.invokes;
    x.models += 1;
  }
  return Array.from(map.values()).sort((a, b) => b.costCny - a.costCny || b.tokens - a.tokens);
}

function catalogFromCache(modelCache) {
  const items = Object.entries(modelCache || {})
    .map(([id, vendor]) => ({ id, vendor: vendor || classifyModel(id) }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.id.localeCompare(b.id));
  const vendors = [];
  const counts = new Map();
  for (const item of items) counts.set(item.vendor, (counts.get(item.vendor) || 0) + 1);
  for (const [vendor, count] of counts) vendors.push({ vendor, count });
  return { total: items.length, vendors, items };
}

function buildLivePayload({ balanceBox, usageBox, modelsBox, start, today }) {
  assertSophnetOk(balanceBox, 'balance');
  assertSophnetOk(usageBox, 'usage_detail');
  const usage = usageBox.result || {};
  const dates = Array.isArray(usage.dates) ? usage.dates : [];
  const liveDaily = dailyRowsFromUsage(usage);
  const liveModelTotals = aggregateByModel(liveDaily);
  const latency = latencyPayload(usage, dates);
  const models = modelsPayload(modelsBox);
  return {
    range: { start, end: today, dates },
    balance: normalizeBalance(balanceBox.result || {}),
    usage: {
      dates,
      services: usage.services || [],
      daily: liveDaily,
      totals: aggregateRows(liveDaily),
      modelTotals: liveModelTotals,
      vendorTotals: aggregateVendors(liveModelTotals, {}),
      rawFieldNames: Object.keys(usage).sort()
    },
    latency,
    models
  };
}

function dailyRowsFromUsage(usage) {
  const dates = Array.isArray(usage.dates) ? usage.dates : [];
  const tokenDetails = usage.tokenDetails || {};
  const costDetails = usage.costDetails || {};
  const invokeDetails = usage.invokeDetails || {};
  const names = new Set([
    ...Object.keys(tokenDetails),
    ...Object.keys(costDetails),
    ...Object.keys(invokeDetails)
  ]);
  const rows = [];
  for (const rawName of names) {
    for (let i = 0; i < dates.length; i += 1) {
      const tokens = Number(tokenDetails[rawName]?.[i]) || 0;
      const costCny = Number(costDetails[rawName]?.[i]) || 0;
      const invokes = Number(invokeDetails[rawName]?.[i]) || 0;
      if (!tokens && !costCny && !invokes) continue;
      rows.push({ date: dates[i], model: shortModelName(rawName), rawModel: rawName, tokens, costCny, invokes });
    }
  }
  return rows;
}

function latencyPayload(usage, dates) {
  const p50 = usage.latency50Details || {};
  const p90 = usage.latency90Details || {};
  const p99 = usage.latency99Details || {};
  const invokes = usage.invokeDetails || {};
  const names = new Set([...Object.keys(p50), ...Object.keys(p90), ...Object.keys(p99)]);
  const rows = [];
  const ranking = [];

  for (const rawName of names) {
    const model = shortModelName(rawName);
    const perDay = dates.map((date, i) => ({
      date,
      model,
      rawModel: rawName,
      p50: Number(p50[rawName]?.[i]) || 0,
      p90: Number(p90[rawName]?.[i]) || 0,
      p99: Number(p99[rawName]?.[i]) || 0,
      invokes: Number(invokes[rawName]?.[i]) || 0
    }));
    rows.push(...perDay);
    const active = perDay.filter(r => r.invokes > 0 || r.p50 > 0 || r.p90 > 0 || r.p99 > 0);
    if (!active.length) continue;
    const totalInvokes = active.reduce((sum, r) => sum + r.invokes, 0);
    const activeWithLatency = active.filter(r => r.p50 > 0 || r.p90 > 0 || r.p99 > 0);
    if (!activeWithLatency.length) {
      ranking.push({
        model,
        rawModel: rawName,
        invokes: totalInvokes,
        activeDays: active.length,
        latencyDays: 0,
        p50: 0,
        p90: 0,
        p99: 0,
        worstP99: 0,
        p99Std: 0,
        tailRatio: 0,
        stabilityScore: null,
        hasLatency: false
      });
      continue;
    }
    const weight = r => Math.max(1, r.invokes || 0);
    const avgP50 = weightedAvg(activeWithLatency, 'p50', weight);
    const avgP90 = weightedAvg(activeWithLatency, 'p90', weight);
    const avgP99 = weightedAvg(activeWithLatency, 'p99', weight);
    const worstP99 = Math.max(...activeWithLatency.map(r => r.p99 || 0), 0);
    const p99Values = activeWithLatency.map(r => r.p99).filter(v => v > 0);
    const p99Std = stddev(p99Values);
    const tailRatio = avgP50 > 0 ? avgP99 / avgP50 : 0;
    const score = avgP90 + avgP99 * 0.45 + p99Std * 0.25 + Math.max(0, tailRatio - 2) * 650;
    ranking.push({
      model,
      rawModel: rawName,
      invokes: totalInvokes,
      activeDays: active.length,
      latencyDays: activeWithLatency.length,
      p50: Math.round(avgP50),
      p90: Math.round(avgP90),
      p99: Math.round(avgP99),
      worstP99: Math.round(worstP99),
      p99Std: Math.round(p99Std),
      tailRatio: Number(tailRatio.toFixed(2)),
      stabilityScore: Math.round(score),
      hasLatency: true
    });
  }

  return {
    dates,
    rows,
    ranking: ranking
      .filter(r => r.hasLatency && r.invokes >= 10 && r.activeDays >= 2)
      .sort((a, b) => a.stabilityScore - b.stabilityScore),
    lowSample: ranking
      .filter(r => !r.hasLatency || r.invokes < 10 || r.activeDays < 2)
      .sort((a, b) => b.invokes - a.invokes)
  };
}

function modelsPayload(box) {
  const items = Array.isArray(box?.data) ? box.data : [];
  const normalized = items.map(item => ({
    id: item.id || item.model || '',
    logicResourceUUID: item.logic_resource_uuid || item.logicResourceUUID || '',
    vendor: classifyModel(item.id || item.model || '')
  })).filter(item => item.id);
  const vendors = [];
  const counts = new Map();
  for (const item of normalized) counts.set(item.vendor, (counts.get(item.vendor) || 0) + 1);
  for (const [vendor, count] of counts) vendors.push({ vendor, count });
  vendors.sort((a, b) => b.count - a.count || a.vendor.localeCompare(b.vendor));
  const rawFieldNames = Array.from(new Set(items.flatMap(item => Object.keys(item || {})))).sort();
  return {
    total: normalized.length,
    vendors,
    items: normalized.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.id.localeCompare(b.id)),
    rawFieldNames
  };
}

function normalizeBalance(result) {
  return {
    balance: Number(result.currentBalance) || 0,
    paid: Number(result.currentBalanceWithoutGift) || 0,
    gift: Number(result.currentGiftBalance) || 0,
    threshold: Number(result.balanceThreshold) || 0,
    creditLimit: Number(result.creditLimit) || 0,
    debt: Number(result.currentDebt) || 0,
    securityDeposit: Number(result.securityDeposit) || 0,
    creditLimitLocked: Boolean(result.creditLimitLocked),
    rawFieldNames: Object.keys(result || {}).sort()
  };
}

function mergeOverview(overview, liveBalance) {
  if (!liveBalance) return overview;
  return {
    ...(overview || {}),
    balance: round4(liveBalance.balance),
    paid: round4(liveBalance.paid),
    gift: round4(liveBalance.gift),
    threshold: round4(liveBalance.threshold)
  };
}

async function sophnetGet(baseUrl, apiKey, path, params = {}) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json'
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Sophnet ${path} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function assertSophnetOk(box, name) {
  if (!box || typeof box !== 'object') throw new Error(`Sophnet ${name} 返回空响应`);
  if ('status' in box && box.status !== 0) throw new Error(`Sophnet ${name}: ${box.message || box.status}`);
}

function resolveApiKey(dataDir) {
  const envKey = process.env.SOPHNET_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();
  const keyPath = resolve(dataDir, 'apikey');
  if (!existsSync(keyPath)) return '';
  return String(readFileSync(keyPath, 'utf8')).trim();
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  try {
    writeFileSync(path, JSON.stringify(value, null, 2));
    return true;
  } catch (err) {
    // A silent failure here would re-announce every model as "new" on every
    // refresh, so surface it once per write instead of swallowing.
    console.warn(`[sophnet] failed to persist ${path}: ${err?.message || err}`);
    return false;
  }
}

// Track when each sophnet model id was first observed, persisted next to the
// other cache files. On the very first run after this ships, every current
// model is treated as "new" once (option B): the banner announces the whole
// catalog for 24h and then settles into only flagging genuinely new arrivals.
function loadModelsSeen(dataDir) {
  return readJson(resolve(dataDir, '.models_seen.json'), {});
}

function recordModelsSeen(dataDir, items, nowMs) {
  const seen = loadModelsSeen(dataDir);
  let dirty = false;
  for (const it of items) {
    if (!it.id) continue;
    if (!seen[it.id]) {
      seen[it.id] = new Date(nowMs).toISOString();
      dirty = true;
    }
  }
  if (dirty) writeJson(resolve(dataDir, '.models_seen.json'), seen);
  return seen;
}

function computeNewModels(items, seen, nowMs) {
  if (!seen || typeof seen !== 'object') return [];
  return items
    .filter(it => it.id && seen[it.id])
    .map(it => ({ id: it.id, vendor: it.vendor, firstSeen: seen[it.id] }))
    .filter(it => (nowMs - Date.parse(it.firstSeen)) < NEW_MODEL_WINDOW_MS)
    .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen) || a.id.localeCompare(b.id));
}

// When the live call fails we still surface models that were recently flagged
// as new, so the 24h banner expires on schedule instead of flickering off and
// back on with each transient API error.
function fallbackNewModels(dataDir, catalogItems, nowMs) {
  const seen = loadModelsSeen(dataDir);
  const items = Array.isArray(catalogItems) && catalogItems.length
    ? catalogItems
    : Object.keys(seen).map(id => ({ id, vendor: '' }));
  return computeNewModels(items, seen, nowMs);
}

function shortModelName(name) {
  return String(name || '')
    .replace(/^ChatCompletion-/, '')
    .replace(/^anthropic\./, '')
    .replace(/^google\./, '');
}

function classifyModel(id) {
  const text = String(id || '');
  const lower = text.toLowerCase();
  if (lower.startsWith('anthropic.claude') || lower.startsWith('claude-')) return 'Anthropic';
  if (lower.startsWith('deepseek')) return 'DeepSeek';
  if (lower.startsWith('qwen')) return 'Alibaba Qwen';
  if (lower.startsWith('glm')) return 'Zhipu GLM';
  if (lower.startsWith('kimi')) return 'Moonshot Kimi';
  if (lower.startsWith('doubao')) return 'ByteDance Doubao';
  if (lower.startsWith('minimax')) return 'MiniMax';
  if (lower.startsWith('mimo')) return 'Xiaomi MiMo';
  if (lower.startsWith('gemini')) return 'Google Gemini';
  if (lower.startsWith('gpt-') || lower.startsWith('o') || lower.includes('openai')) return 'OpenAI';
  if (lower.startsWith('claw')) return 'Claw';
  if (lower.startsWith('hy')) return 'Hy';
  return 'Other';
}

function weightedAvg(rows, field, weightFn) {
  let sum = 0;
  let weightSum = 0;
  for (const r of rows) {
    const value = Number(r[field]) || 0;
    if (value <= 0) continue;
    const weight = weightFn(r);
    sum += value * weight;
    weightSum += weight;
  }
  return weightSum ? sum / weightSum : 0;
}

function stddev(values) {
  if (!values.length) return 0;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function round4(value) {
  return Math.round((Number(value) || 0) * 10_000) / 10_000;
}

function localDate(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function addDays(dateStr, days) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return localDate(date);
}
