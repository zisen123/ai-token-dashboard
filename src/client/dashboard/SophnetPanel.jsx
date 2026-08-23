/* =============================================================
   Sophnet Panel — platform balance, usage and model health
   Uses the same KPI / panel / ECharts language as the main dashboard.
   ============================================================= */

import { useMemo, useState } from 'react';
import { U } from '../shared/utils.js';
import { EChart } from '../shared/echart.jsx';
import { chartPalette, useTheme } from '../shared/theme.js';

const fmtCNY = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function fmtMs(value) {
  const n = Number(value) || 0;
  if (!n) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 1 : 2)}s` : `${Math.round(n)}ms`;
}

function fmtCny(value) {
  return fmtCNY.format(Number(value) || 0);
}

function fmtDelta(curr, prev) {
  const pct = U.deltaPct(curr, prev);
  if (pct == null) return '';
  return `${pct >= 0 ? '↑' : '↓'}${Math.abs(pct).toFixed(0)}%`;
}

function modelTone(row) {
  const p90 = Number(row.p90) || 0;
  const p99 = Number(row.p99) || 0;
  if (p90 > 10_000 || p99 > 30_000) return 'bad';
  if (p90 > 4_000 || p99 > 12_000) return 'warn';
  return 'ok';
}

function normalizeTotals(totals) {
  return {
    tokens: totals?.tokens || 0,
    costCny: totals?.costCny || 0,
    invokes: totals?.invokes || 0,
    days: totals?.dayCount || totals?.days?.size || totals?.days?.length || 0,
    models: totals?.modelCount || totals?.models?.size || totals?.models?.length || 0
  };
}

function SophnetPanel({ data, loading, error, onRefresh, startDate, endDate }) {
  const [tab, setTab] = useState('stability');
  const [query, setQuery] = useState('');
  const [vendorFilter, setVendorFilter] = useState(new Set());

  // The dashboard's global time-range filter applies to every Sophnet figure
  // that is date-bucketed. API payloads already cover the recent window, so
  // filtering here is just an intersect with [startDate, endDate].
  const inRange = (d) => (!startDate || d >= startDate) && (!endDate || d <= endDate);

  const overview = data?.overview || {};
  const balance = data?.live?.balance || {};
  const balanceLow = Number(overview.balance) <= Number(overview.threshold || 0);
  const modelCatalog = data?.live?.models || data?.modelCatalog || { total: 0, vendors: [], items: [] };
  const allDaily = data?.live?.usage?.daily || data?.recentDaily || [];
  const daily = useMemo(() => allDaily.filter(r => inRange(r.date)), [allDaily, startDate, endDate]);
  const allDates = data?.live?.usage?.dates || (data?.range ? U.rangeDates(data.range.start, data.range.end) : []);
  const dates = useMemo(() => allDates.filter(inRange), [allDates, startDate, endDate]);
  const tokensSpark = useMemo(() => sparkFromDaily(daily, dates, 'tokens'), [daily, dates]);

  // Calendar-anchored spend (month / week / today) is computed from the full
  // history, not the range-filtered window, so "本日已花" stays correct even
  // when the global time filter excludes today.
  const calSpend = useMemo(() => {
    const now = new Date();
    const todayStr = U.localDateStr(now);
    const yest = new Date(now);
    yest.setDate(yest.getDate() - 1);
    const yesterdayStr = U.localDateStr(yest);
    const monday = new Date(now);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const weekStart = U.localDateStr(monday);
    const monthStart = `${todayStr.slice(0, 7)}-01`;
    const acc = { month: 0, week: 0, day: 0, yesterday: 0 };
    for (const r of allDaily) {
      const c = Number(r.costCny) || 0;
      if (r.date >= monthStart) acc.month += c;
      if (r.date >= weekStart) acc.week += c;
      if (r.date === todayStr) acc.day += c;
      if (r.date === yesterdayStr) acc.yesterday += c;
    }
    return {
      month: Math.round(acc.month * 10000) / 10000,
      week: Math.round(acc.week * 10000) / 10000,
      day: Math.round(acc.day * 10000) / 10000,
      yesterday: Math.round(acc.yesterday * 10000) / 10000,
      weekStart,
      todayStr
    };
  }, [allDaily]);

  // Aggregates recomputed over the filtered window so every card/chart/table
  // moves with the global time filter.
  const totals = useMemo(() => {
    const acc = { tokens: 0, costCny: 0, invokes: 0, days: new Set(), models: new Set() };
    for (const r of daily) {
      acc.tokens += r.tokens || 0;
      acc.costCny += r.costCny || 0;
      acc.invokes += r.invokes || 0;
      acc.days.add(r.date);
      acc.models.add(r.model);
    }
    return { tokens: acc.tokens, costCny: Math.round(acc.costCny * 10000) / 10000,
             invokes: acc.invokes, days: acc.days.size, models: acc.models.size };
  }, [daily]);

  const modelTotals = useMemo(() => {
    const map = new Map();
    for (const r of daily) {
      const x = map.get(r.model) || { model: r.model, rawModel: r.rawModel, tokens: 0, costCny: 0, invokes: 0, activeDays: new Set() };
      x.tokens += r.tokens || 0;
      x.costCny += r.costCny || 0;
      x.invokes += r.invokes || 0;
      x.activeDays.add(r.date);
      map.set(r.model, x);
    }
    return Array.from(map.values())
      .map(x => ({ ...x, activeDays: x.activeDays.size }))
      .sort((a, b) => b.costCny - a.costCny || b.tokens - a.tokens);
  }, [daily]);

  const vendorTotals = useMemo(() => {
    const vendorByModel = new Map();
    for (const item of modelCatalog.items || []) vendorByModel.set(item.id, item.vendor || 'Other');
    const map = new Map();
    for (const r of daily) {
      const vendor = vendorByModel.get(r.model) || vendorByModel.get(r.rawModel) || classifyVendorFallback(r.model);
      const x = map.get(vendor) || { vendor, tokens: 0, costCny: 0, invokes: 0, models: new Set() };
      x.tokens += r.tokens || 0;
      x.costCny += r.costCny || 0;
      x.invokes += r.invokes || 0;
      x.models.add(r.model);
      map.set(vendor, x);
    }
    return Array.from(map.values())
      .map(x => ({ ...x, models: x.models.size }))
      .sort((a, b) => b.costCny - a.costCny || b.tokens - a.tokens);
  }, [daily, modelCatalog.items]);

  // Latency ranking is also sliced to the selected window: recompute weighted
  // averages from the per-day latency rows restricted to [startDate, endDate].
  const latencyRows = data?.live?.latency?.rows || [];
  const { stability, lowSample } = useMemo(() => {
    const rows = latencyRows.filter(r => inRange(r.date));
    const byModel = new Map();
    for (const r of rows) {
      if (!byModel.has(r.rawModel)) byModel.set(r.rawModel, []);
      byModel.get(r.rawModel).push(r);
    }
    const ranking = [];
    const low = [];
    for (const [rawModel, list] of byModel) {
      const model = list[0]?.model || rawModel;
      const active = list.filter(r => r.invokes > 0 || r.p50 > 0 || r.p90 > 0 || r.p99 > 0);
      if (!active.length) continue;
      const totalInvokes = active.reduce((s, r) => s + r.invokes, 0);
      const withLatency = active.filter(r => r.p50 > 0 || r.p90 > 0 || r.p99 > 0);
      if (!withLatency.length || totalInvokes < 10 || active.length < 2) {
        low.push({ model, rawModel, invokes: totalInvokes, activeDays: active.length, hasLatency: withLatency.length > 0 });
        continue;
      }
      const wavg = (field) => {
        let sum = 0, w = 0;
        for (const r of withLatency) {
          const v = Number(r[field]) || 0;
          if (v <= 0) continue;
          const weight = Math.max(1, r.invokes || 0);
          sum += v * weight; w += weight;
        }
        return w ? sum / w : 0;
      };
      const p50 = wavg('p50'), p90 = wavg('p90'), p99 = wavg('p99');
      const worstP99 = Math.max(...withLatency.map(r => r.p99 || 0), 0);
      const p99Values = withLatency.map(r => r.p99).filter(v => v > 0);
      const mean = p99Values.length ? p99Values.reduce((s, v) => s + v, 0) / p99Values.length : 0;
      const p99Std = p99Values.length ? Math.sqrt(p99Values.reduce((s, v) => s + (v - mean) ** 2, 0) / p99Values.length) : 0;
      const tailRatio = p50 > 0 ? p99 / p50 : 0;
      const score = p90 + p99 * 0.45 + p99Std * 0.25 + Math.max(0, tailRatio - 2) * 650;
      ranking.push({
        model, rawModel, invokes: totalInvokes, activeDays: active.length,
        latencyDays: withLatency.length,
        p50: Math.round(p50), p90: Math.round(p90), p99: Math.round(p99),
        worstP99: Math.round(worstP99), p99Std: Math.round(p99Std),
        tailRatio: Number(tailRatio.toFixed(2)),
        stabilityScore: Math.round(score), hasLatency: true
      });
    }
    ranking.sort((a, b) => a.stabilityScore - b.stabilityScore);
    low.sort((a, b) => b.invokes - a.invokes);
    return { stability: ranking, lowSample: low };
  }, [latencyRows, startDate, endDate]);

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (modelCatalog.items || []).filter(m => {
      if (vendorFilter.size && !vendorFilter.has(m.vendor || 'Other')) return false;
      if (!q) return true;
      return String(m.id || '').toLowerCase().includes(q)
        || String(m.vendor || '').toLowerCase().includes(q);
    });
  }, [modelCatalog.items, query, vendorFilter]);

  const toggleVendor = (vendor) => {
    setVendorFilter(prev => {
      const next = new Set(prev);
      if (next.has(vendor)) next.delete(vendor); else next.add(vendor);
      return next;
    });
  };

  const dailyByDate = useMemo(() => {
    const map = new Map();
    for (const r of daily) {
      const x = map.get(r.date) || { date: r.date, tokens: 0, costCny: 0, invokes: 0 };
      x.tokens += r.tokens || 0;
      x.costCny += r.costCny || 0;
      x.invokes += r.invokes || 0;
      map.set(r.date, x);
    }
    return dates.map(date => map.get(date) || { date, tokens: 0, costCny: 0, invokes: 0 });
  }, [daily, dates]);

  // Per-vendor daily breakdown for the stacked trend chart. Vendor is derived
  // from the model catalog (live /v1/models) or the local classifier cache.
  const vendorDaily = useMemo(() => {
    const vendorByModel = new Map();
    for (const item of modelCatalog.items || []) {
      vendorByModel.set(item.id, item.vendor || 'Other');
    }
    const map = new Map();
    for (const r of daily) {
      const vendor = vendorByModel.get(r.model) || vendorByModel.get(r.rawModel) || classifyVendorFallback(r.model);
      const key = `${r.date}::${vendor}`;
      const x = map.get(key) || { date: r.date, vendor, tokens: 0, costCny: 0 };
      x.tokens += r.tokens || 0;
      x.costCny += r.costCny || 0;
      map.set(key, x);
    }
    return Array.from(map.values());
  }, [daily, modelCatalog.items]);

  // Assign vendor colors once for the whole panel: every component (stacked
  // trend, pie, legend) draws from the same set-assignment so two vendors can
  // never land on the same or a perceptually-near color.
  const vendorColorMap = useMemo(() => {
    const names = new Set();
    for (const v of vendorDaily) names.add(v.vendor);
    for (const v of vendorTotals) names.add(v.vendor);
    for (const v of (modelCatalog.vendors || [])) names.add(v.vendor);
    return U.getSourceColors(Array.from(names));
  }, [vendorDaily, vendorTotals, modelCatalog]);

  if (!loading && !data && !error) return null;

  return (
    <div className="sophnet-block">
      <div className="sophnet-head">
        <div>
          <h2 className="sophnet-title">Sophnet 平台</h2>
          <p className="sophnet-sub">余额 · 日粒度用量 · P50/P90/P99 延迟 · 模型目录</p>
        </div>
        <button className={`btn btn-primary ${loading ? 'loading' : ''}`} onClick={onRefresh} disabled={loading}>
          {loading ? '同步中' : '同步 Sophnet'}
        </button>
      </div>

      {error && <div className="sophnet-alert">Sophnet 数据加载失败：{error}</div>}
      {data?.error && <div className="sophnet-alert warn">{data.error} · 当前显示本地缓存</div>}

      <div className="kpi-row sophnet-kpis">
        <KpiCard
          label="账户余额"
          value={overview.balance != null ? fmtCny(overview.balance) : '—'}
          sub={`阈值 ${fmtCny(overview.threshold || 0)}`}
          tone={balanceLow ? 'bad' : 'ok'}
          sparkValues={tokensSpark}
          sparkColor="oklch(0.65 0.12 150)" />
        <KpiCard
          label="本月已花"
          value={fmtCny(calSpend.month)}
          sub={`自 ${calSpend.todayStr.slice(0, 7)}-01`}
          sparkValues={tokensSpark}
          sparkColor="oklch(0.72 0.14 75)" />
        <KpiCard
          label="本周已花"
          value={fmtCny(calSpend.week)}
          sub={`自 ${calSpend.weekStart}（周一）`}
          sparkValues={tokensSpark}
          sparkColor="oklch(0.60 0.15 295)" />
        <KpiCard
          label="本日已花"
          value={fmtCny(calSpend.day)}
          sub={calSpend.yesterday > 0
            ? `昨日 ${fmtCny(calSpend.yesterday)} · ${fmtDelta(calSpend.day, calSpend.yesterday)}`
            : '昨日无消耗'}
          sparkValues={tokensSpark}
          sparkColor="oklch(0.62 0.16 20)" />
        <KpiCard
          label="最近 30 天 Tokens"
          value={U.compactCN(totals.tokens)}
          sub={`${U.compact(totals.invokes)} 次调用 · ${totals.models} 模型`}
          sparkValues={tokensSpark}
          sparkColor="oklch(0.55 0.16 265)" />
      </div>

      <div className="grid">
        <div className="col-8 sophnet-trend-cell">
          <SophnetTrendChart rows={dailyByDate} vendorRows={vendorDaily} totals={totals} colorMap={vendorColorMap} />
        </div>
        <div className="col-4">
          <VendorPanel rows={vendorTotals.slice(0, 8)} total={totals.costCny} colorMap={vendorColorMap} />
        </div>
        <div className="col-12">
          <div className="panel">
            <div className="panel-header">
              <div className="panel-tabs">
                {[
                  ['stability', '稳定性排行', stability.length],
                  ['models', '用量模型', modelTotals.length],
                  ['catalog', '模型目录', modelCatalog.total || 0],
                  ['raw', '可读字段', (data?.live?.usage?.rawFieldNames || []).length]
                ].map(([id, label, count]) => (
                  <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
                    {label} <span className="sophnet-tab-count">{count}</span>
                  </button>
                ))}
              </div>
              {tab === 'catalog' && (
                <input className="search-input" placeholder="搜索模型或供应商..."
                  value={query} onChange={e => setQuery(e.target.value)} />
              )}
            </div>

            {tab === 'stability' && <StabilityTable rows={stability} lowSample={lowSample} />}
            {tab === 'models' && <UsageModelTable rows={modelTotals} totalCost={totals.costCny} />}
            {tab === 'catalog' && (
              <CatalogView items={filteredModels} vendors={modelCatalog.vendors || []}
                vendorFilter={vendorFilter} onToggleVendor={toggleVendor} />
            )}
            {tab === 'raw' && <RawFields data={data} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function sparkFromDaily(daily, dates, field) {
  const map = new Map();
  for (const r of daily) map.set(r.date, (map.get(r.date) || 0) + (Number(r[field]) || 0));
  return dates.map(d => map.get(d) || 0);
}

function KpiCard({ label, value, sub, tone, sparkValues, sparkColor }) {
  return (
    <div className={`kpi${tone === 'bad' ? ' kpi-bad' : ''}`}>
      <div className="kpi-label">{label}{tone && <span className="dot" style={{color: tone === 'bad' ? 'var(--bad)' : 'var(--good)'}} />}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub"><span>{sub}</span></div>
      <KpiSpark values={sparkValues} color={sparkColor} />
    </div>
  );
}

function KpiSpark({ values, color }) {
  if (!values || !values.length) return null;
  const w = 100, h = 28;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1 || 1)) * w;
    const y = h - (v / max) * (h - 3) - 1;
    return [x, y];
  });
  const d = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  return (
    <svg className="kpi-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={`${d} L${w},${h} L0,${h} Z`} fill={color} opacity="0.12" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const SOPHNET_TREND_MODES = [
  { id: 'bar',  label: '柱状' },
  { id: 'line', label: '折线' }
];

function classifyVendorFallback(model) {
  const text = String(model || '').toLowerCase();
  if (text.startsWith('claude') || text.startsWith('anthropic')) return 'Anthropic';
  if (text.startsWith('deepseek')) return 'DeepSeek';
  if (text.startsWith('qwen')) return 'Alibaba Qwen';
  if (text.startsWith('glm')) return 'Zhipu GLM';
  if (text.startsWith('kimi')) return 'Moonshot Kimi';
  if (text.startsWith('doubao')) return 'ByteDance Doubao';
  if (text.startsWith('minimax')) return 'MiniMax';
  if (text.startsWith('gemini')) return 'Google Gemini';
  if (text.startsWith('gpt-') || text.startsWith('o')) return 'OpenAI';
  return 'Other';
}

function SophnetTrendChart({ rows, vendorRows, totals, colorMap }) {
  const pal = chartPalette(useTheme().theme);
  const [mode, setMode] = useState('bar');
  const dates = rows.map(r => r.date);
  const tokens = rows.map(r => r.tokens || 0);
  const costByDate = useMemo(() => {
    const m = new Map();
    for (const r of rows) m.set(r.date, r.costCny || 0);
    return m;
  }, [rows]);

  // Vendor × date lookup for the stacked series (same shape as the main TrendChart).
  const { vendors, byKey } = useMemo(() => {
    const totalsByVendor = new Map();
    for (const r of vendorRows) {
      totalsByVendor.set(r.vendor, (totalsByVendor.get(r.vendor) || 0) + r.tokens);
    }
    const vendors = Array.from(totalsByVendor.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    const byKey = new Map();
    for (const r of vendorRows) byKey.set(`${r.date}::${r.vendor}`, r.tokens);
    return { vendors, byKey };
  }, [vendorRows]);

  const vendorColor = (vendor) => (colorMap && colorMap.get(vendor)) || U.getSourceColor(vendor);

  // Rolling 7-day baseline, same as the main TrendChart's "7 日均线" overlay.
  const rolling = (() => {
    const arr = [];
    const win = Math.min(7, Math.max(2, Math.floor(dates.length / 8)));
    for (let i = 0; i < tokens.length; i++) {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - win + 1); j <= i; j++) { sum += tokens[j]; count++; }
      arr.push(count ? sum / count : 0);
    }
    return arr;
  })();

  const series = [];
  // Same protection the main TrendChart documents for its line mode: letting
  // ECharts recompute per-item styles on hover can break its color pipeline
  // (it cannot interpolate oklch strings), which renders the column under the
  // cursor invisible. Disabling emphasis entirely keeps the axis tooltip
  // without any per-item restyle, so columns stay put.
  const stableBarState = {
    emphasis: { disabled: true },
    blur: { itemStyle: { opacity: 1 } },
    select: { itemStyle: { opacity: 1 } }
  };
  if (mode === 'bar') {
    vendors.forEach((vendor, i) => {
      series.push({
        name: vendor,
        type: 'bar',
        stack: 'total',
        barMaxWidth: 24,
        itemStyle: { color: vendorColor(vendor) },
        ...stableBarState,
        data: dates.map(d => byKey.get(`${d}::${vendor}`) || 0)
      });
    });
  } else {
    vendors.forEach((vendor, i) => {
      series.push({
        name: vendor,
      type: 'line',
      smooth: 0.3,
      symbol: 'circle',
      symbolSize: 4,
      showSymbol: false,
        lineStyle: { width: 2, color: vendorColor(vendor) },
        itemStyle: { color: vendorColor(vendor) },
      areaStyle: {
        opacity: 0.08,
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
              { offset: 0, color: vendorColor(vendor) },
            { offset: 1, color: 'transparent' }
          ]
        }
      },
      emphasis: { disabled: true },
        data: dates.map(d => byKey.get(`${d}::${vendor}`) || 0)
      });
    });
  }
  if (mode !== 'line' && dates.length > 10) {
    series.push({
      name: '7 日均线',
      type: 'line',
      smooth: 0.5,
      symbol: 'none',
      lineStyle: { width: 1.6, color: pal.markLineCompare, type: [4, 4] },
      itemStyle: { color: pal.markLineCompare },
      emphasis: { focus: 'none', lineStyle: { width: 1.6, opacity: 1 }, itemStyle: { opacity: 1 } },
      blur: { lineStyle: { opacity: 1 }, itemStyle: { opacity: 1 } },
      select: { lineStyle: { opacity: 1 }, itemStyle: { opacity: 1 } },
      data: rolling,
      z: 4
    });
  }

  const option = {
    backgroundColor: 'transparent',
    animationDuration: 400,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: pal.crossHair, width: 1, type: [3, 3] } },
      backgroundColor: pal.tooltipBg,
      borderColor: pal.tooltipBorder,
      borderWidth: 1,
      padding: [10, 12],
      textStyle: { color: pal.tooltipText, fontSize: 12 },
      extraCssText: 'box-shadow: var(--shadow-pop); border-radius: 10px;',
      formatter(params) {
        const date = params[0]?.axisValue || '';
        let totalTokens = 0;
        for (const p of params) if (vendors.includes(p.seriesName)) totalTokens += p.value || 0;
        const cost = costByDate.get(date) || 0;
        let html = `<div style="font-weight:600;margin-bottom:6px;color:${pal.tooltipLabel};font-size:11.5px;letter-spacing:.04em">${date}</div>`;
        html += `<div style="font-size:16px;font-weight:600;margin-bottom:2px">${U.compactCN(totalTokens)} <span style="font-size:11px;color:${pal.tooltipMuted};font-weight:500"> tokens</span></div>`;
        html += `<div style="font-size:12px;color:${pal.tooltipSeries};margin-bottom:8px">${fmtCny(cost)}</div>`;
        // Highest-token vendors first so the tooltip reads like a ranking.
        const rows = params
          .filter(p => p.seriesName !== '7 日均线' && p.value)
          .sort((a, b) => (b.value || 0) - (a.value || 0));
        for (const p of rows) {
          const val = U.compactCN(p.value || 0);
          html += `<div style="display:flex;align-items:center;gap:8px;margin-top:3px;font-size:12px">
            <span style="width:8px;height:8px;border-radius:2px;background:${p.color};display:inline-block"></span>
            <span style="color:${pal.tooltipSeries};flex:1">${p.seriesName}</span>
            <span style="font-weight:600;margin-left:18px;font-variant-numeric:tabular-nums">${val} tokens</span>
          </div>`;
        }
        return html;
      }
    },
    legend: { show: false },
    grid: { left: 8, right: 12, top: 16, bottom: dates.length > 20 ? 40 : 30, containLabel: true },
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: mode !== 'line',
      axisLine: { lineStyle: { color: pal.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: pal.axisLabel, fontSize: 10.5, hideOverlap: true, formatter: v => v.slice(5) }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: pal.axisLabelDim, fontSize: 10.5, formatter: v => U.compact(v) },
      splitLine: { lineStyle: { color: pal.splitLine } },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    dataZoom: dates.length > 20 ? [
      { type: 'inside', start: 0, end: 100, zoomLock: false },
      {
        type: 'slider',
        height: 18,
        bottom: 4,
        borderColor: 'transparent',
        backgroundColor: pal.zoomBg,
        fillerColor: pal.zoomFiller,
        handleStyle: { color: pal.zoomHandle, borderColor: pal.zoomHandleEdge },
        moveHandleSize: 4,
        textStyle: { color: pal.tooltipMuted, fontSize: 10 }
      }
    ] : [],
    series
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">Sophnet Token 使用趋势</h2>
          <p className="panel-sub">
            当前周期 <b style={{color:'var(--text)', fontWeight:600}}>{U.compactCN(totals.tokens)}</b> tokens · {dates.length} 天 · {fmtCny(totals.costCny)} · {U.fmt.format(totals.invokes)} 次调用
          </p>
        </div>
        <div className="panel-actions">
          <div className="panel-tabs">
            {SOPHNET_TREND_MODES.map(m => (
              <button key={m.id} className={`tab ${mode === m.id ? 'active' : ''}`} onClick={() => setMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <EChart option={option} fill />
    </div>
  );
}

function VendorPanel({ rows, total, colorMap }) {
  const pal = chartPalette(useTheme().theme);
  const [focused, setFocused] = useState(null);
  const data = rows.map((v, i) => ({
    name: v.vendor,
    value: Number(v.costCny) || 0,
    color: (colorMap && colorMap.get(v.vendor)) || U.getSourceColor(v.vendor)
  })).sort((a, b) => b.value - a.value);
  const sum = data.reduce((s, d) => s + d.value, 0);

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      appendToBody: true,
      confine: true,
      transitionDuration: 0,
      backgroundColor: pal.tooltipBg,
      borderColor: pal.tooltipBorder,
      borderWidth: 1,
      textStyle: { color: pal.tooltipText, fontSize: 12 },
      extraCssText: 'pointer-events:none;box-shadow:0 8px 24px rgb(0 0 0 / 0.08);border-radius:8px;',
      formatter: p => `<div style="font-weight:600;margin-bottom:4px">${p.name}</div>
        <div style="font-size:14px;font-weight:600">${fmtCny(p.value)}</div>
        <div style="font-size:11px;color:${pal.tooltipMuted}">${(p.percent || 0).toFixed(1)}%</div>`
    },
    series: [{
      type: 'pie',
      animationDurationUpdate: 220,
      animationEasingUpdate: 'cubicOut',
      stateAnimation: {
        duration: 140,
        easing: 'cubicOut'
      },
      radius: ['48%', '78%'],
      center: ['50%', '50%'],
      minAngle: 2,
      avoidLabelOverlap: true,
      label: { show: false },
      labelLine: { show: false },
      itemStyle: {
        borderColor: pal.sliceBorder,
        borderWidth: 2,
        shadowBlur: 12,
        shadowOffsetY: 3,
        shadowColor: 'rgba(15, 23, 42, 0.16)'
      },
      emphasis: {
        scale: true,
        scaleSize: 3,
        itemStyle: {
          shadowBlur: 12,
          shadowOffsetY: 3,
          shadowColor: 'rgba(15, 23, 42, 0.16)'
        }
      },
      blur: {
        itemStyle: { opacity: 1 }
      },
      data: data.map(d => ({
        name: d.name,
        value: d.value,
        itemStyle: {
          color: d.color,
          borderRadius: sum && d.value / sum >= 0.03 ? 8 : 0,
          opacity: focused && focused !== d.name ? 0.25 : 1
        },
        emphasis: {
          itemStyle: {
            color: d.color,
            borderRadius: sum && d.value / sum >= 0.03 ? 8 : 0,
            opacity: 1,
            borderColor: pal.sliceBorder,
            borderWidth: 2,
            shadowBlur: 12,
            shadowOffsetY: 3,
            shadowColor: 'rgba(15, 23, 42, 0.16)'
          }
        }
      }))
    }]
  };

  return (
    <div className="panel source-donut-panel">
      <div className="panel-header source-donut-header">
        <div>
          <h2 className="panel-title">供应商费用占比</h2>
        </div>
        <p className="panel-sub source-donut-note">按最近 30 天费用聚合 · 顶部 1 项 {data[0] && sum ? ((data[0].value / sum) * 100).toFixed(0) : 0}%</p>
      </div>
      {!data.length && <div className="empty">暂无供应商聚合数据</div>}
      <div className="donut-stack">
        <div className="donut-stage">
          <EChart option={option} height={236} />
          <div style={{
            position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
            pointerEvents: 'none', textAlign: 'center'
          }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 650, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>{fmtCny(total)}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>最近 30 天</div>
            </div>
          </div>
        </div>
        <div className="legend">
          {data.slice(0, 8).map(d => {
            const pct = sum ? (d.value / sum) * 100 : 0;
            return (
              <div key={d.name}
                className={`legend-item ${focused && focused !== d.name ? 'dim' : ''}`}
                onClick={() => setFocused(focused === d.name ? null : d.name)}>
                <span className="legend-swatch" style={{ background: d.color }} />
                <span className="legend-name" title={d.name}>{d.name}</span>
                <span className="legend-val">{fmtCny(d.value)}</span>
                <span className="legend-pct">{pct.toFixed(1)}%</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StabilityTable({ rows, lowSample }) {
  return (
    <>
      <div className="table-wrap">
        <table className="dt">
          <thead>
            <tr>
              <th>排名</th><th>模型</th><th>调用</th><th>活跃天</th><th>P50</th><th>P90</th><th>P99</th><th>最差 P99</th><th>尾部比</th><th>稳定分</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length && <tr><td colSpan="10" className="muted" style={{textAlign:'center', padding: 28}}>暂无足够样本的 latency 数据</td></tr>}
            {rows.slice(0, 6).map((r, i) => (
              <tr key={r.rawModel || r.model}>
                <td>{i + 1}</td>
                <td><span className="mono">{r.model}</span> <span className={`health-dot ${modelTone(r)}`} /></td>
                <td>{U.fmt.format(r.invokes)}</td>
                <td>{r.activeDays}</td>
                <td>{fmtMs(r.p50)}</td>
                <td>{fmtMs(r.p90)}</td>
                <td>{fmtMs(r.p99)}</td>
                <td>{fmtMs(r.worstP99)}</td>
                <td>{r.tailRatio || '—'}</td>
                <td><span className="num-strong">{U.fmt.format(r.stabilityScore)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 6 && (
        <p className="panel-sub sophnet-footnote">仅显示前 6 名 · 共 {rows.length} 个模型</p>
      )}
      {lowSample.length > 0 && (
        <p className="panel-sub sophnet-footnote">低样本未进主榜：{lowSample.slice(0, 6).map(r => `${r.model}(${r.invokes})`).join('、')}</p>
      )}
    </>
  );
}

function UsageModelTable({ rows, totalCost }) {
  return (
    <div className="table-wrap">
      <table className="dt">
        <thead><tr><th>模型</th><th>活跃天</th><th>调用</th><th>Tokens</th><th>费用</th><th>占比</th></tr></thead>
        <tbody>
          {rows.map(r => {
            const pct = totalCost ? (r.costCny / totalCost) * 100 : 0;
            return (
              <tr key={r.rawModel || r.model}>
                <td><span className="mono">{r.model}</span></td>
                <td>{r.activeDays}</td>
                <td>{U.fmt.format(r.invokes)}</td>
                <td>{U.compactCN(r.tokens)}</td>
                <td>{fmtCny(r.costCny)}</td>
                <td><span className="share-bar"><span style={{width: `${Math.min(100, pct)}%`}} /></span><span className="share-pct">{pct.toFixed(1)}%</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CatalogView({ items, vendors, vendorFilter, onToggleVendor }) {
  return (
    <div className="sophnet-catalog">
      <div className="sophnet-vendor-cloud">
        {vendors.map(v => (
          <button key={v.vendor}
            className={`sophnet-vendor-chip${vendorFilter.has(v.vendor) ? ' active' : ''}`}
            onClick={() => onToggleVendor(v.vendor)}
            title={vendorFilter.has(v.vendor) ? '取消筛选' : '只显示该组'}>
            {v.vendor}<b>{v.count}</b>
          </button>
        ))}
      </div>
      <div className="table-wrap">
        <table className="dt">
          <thead><tr><th>供应商</th><th>Model ID</th><th>UUID</th></tr></thead>
          <tbody>
            {!items.length && <tr><td colSpan="3" className="muted" style={{textAlign:'center', padding: 24}}>没有匹配的模型</td></tr>}
            {items.map(item => (
              <tr key={item.id}>
                <td>{item.vendor || 'Other'}</td>
                <td><span className="mono">{item.id}</span></td>
                <td><span className="mono muted">{item.logicResourceUUID || '—'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RawFields({ data }) {
  const fields = data?.live?.usage?.rawFieldNames || [];
  const balance = data?.live?.balance || {};
  const modelFields = data?.live?.models?.rawFieldNames || [];
  return (
    <div className="sophnet-raw">
      <div><span>数据目录</span><b className="mono">{data?.dataDir || '—'}</b></div>
      <div><span>刷新时间</span><b>{data?.generatedAt ? U.formatTs(data.generatedAt) : '—'}</b></div>
      <div><span>接口状态</span><b>{data?.status || '—'}</b></div>
      <div><span>余额详情</span><b>付费 {fmtCny(balance.paid)} / 赠金 {fmtCny(balance.gift)} / 授信 {fmtCny(balance.creditLimit)} / 欠款 {fmtCny(balance.debt)} / 保证金 {fmtCny(balance.securityDeposit)} / {balance.creditLimitLocked ? '授信锁定' : '授信正常'}</b></div>
      <div><span>balance 字段</span><b>{balance.rawFieldNames?.length ? balance.rawFieldNames.join(' / ') : '—'}</b></div>
      <div><span>usage_detail 字段</span><b>{fields.length ? fields.join(' / ') : '—'}</b></div>
      <div><span>models 字段</span><b>{modelFields.length ? modelFields.join(' / ') : '—'}</b></div>
      <p>说明：Sophnet 官方接口目前按日期返回，小时级趋势无法回溯；面板展示的是日粒度 usage_detail 与本地缓存历史。</p>
    </div>
  );
}

export { SophnetPanel };
