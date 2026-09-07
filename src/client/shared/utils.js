/* =============================================================
   Shared helpers, formatters, and aggregations
   ============================================================= */

const PALETTE = {
  // Claude family → indigo
  'Claude Code':        'oklch(0.55 0.16 265)',
  'Claude Code (JS)':   'oklch(0.55 0.16 265)',
  // Codex / OpenAI → violet
  'Codex CLI':          'oklch(0.60 0.15 295)',
  'Codex CLI (JS)':     'oklch(0.60 0.15 295)',
  // Hermes → blue
  'Hermes Agent':       'oklch(0.58 0.14 240)',
  'Hermes Agent (JS)':  'oklch(0.58 0.14 240)',
  // OpenClaw → teal
  'OpenClaw':           'oklch(0.65 0.11 200)',
  'OpenClaw (JS)':      'oklch(0.65 0.11 200)',
  'openclaw, hermes':   'oklch(0.65 0.11 200)',
  // OpenCode → cyan
  'OpenCode':           'oklch(0.62 0.12 195)',
  // Gemini → amber
  'Gemini CLI':         'oklch(0.72 0.14 75)',
  'Gemini CLI (JS)':    'oklch(0.72 0.14 75)',
  // Cursor → sky
  'Cursor':             'oklch(0.68 0.12 220)',
  // Aider → green
  'Aider':              'oklch(0.65 0.13 155)',
  // Amp → rose
  'Amp':                'oklch(0.62 0.16 20)',
  // pi-agent → pink
  'pi-agent':           'oklch(0.63 0.14 330)',
};

const PALETTE_FALLBACK = [
  'oklch(0.55 0.16 265)', 'oklch(0.60 0.15 295)', 'oklch(0.65 0.11 200)',
  'oklch(0.72 0.14 75)',  'oklch(0.65 0.12 150)', 'oklch(0.62 0.16 20)',
  'oklch(0.58 0.14 240)', 'oklch(0.63 0.14 330)', 'oklch(0.68 0.12 220)',
];

// Sophnet model vendors → their brand colors. The hex values each brand
// actually uses, converted to oklch with lightness lifted or capped into
// the 0.55–0.72 band so they hold up on both light and dark themes.
// Chinese AI vendors skew heavily blue, so hues are nudged apart while
// staying on-brand (brand fidelity wins over maximum separation).
const VENDOR_BRAND_COLORS = {
  'Anthropic':       'oklch(0.67 0.14 45)',   // Anthropic coral #D97757
  'OpenAI':          'oklch(0.63 0.13 175)',  // OpenAI teal-green #10A37F
  'DeepSeek':        'oklch(0.50 0.16 265)',  // DeepSeek whale blue, darkened indigo
  'Moonshot Kimi':   'oklch(0.56 0.13 275)',  // Kimi navy with violet lean
  'Zhipu GLM':       'oklch(0.70 0.13 228)',  // Zhipu bright azure, cyan lean
  'Alibaba Qwen':    'oklch(0.61 0.15 300)',  // Tongyi purple
  'ByteDance Doubao':'oklch(0.76 0.10 205)',  // Doubao pale cyan (clear of GLM)
  'MiniMax':         'oklch(0.60 0.12 218)',  // MiniMax blue with cyan lean
  'Google Gemini':   'oklch(0.66 0.15 260)',  // Google blue #4285F4
  'Xiaomi MiMo':     'oklch(0.70 0.15 55)',   // Xiaomi orange #FF6900
  'Claw':            'oklch(0.65 0.11 200)',  // matches the OpenClaw teal
};

// Deterministic color for any source name (even future ones not in PALETTE)
function getSourceColor(name) {
  if (!name) return 'var(--muted)';
  if (PALETTE[name]) return PALETTE[name];
  if (VENDOR_BRAND_COLORS[name]) return VENDOR_BRAND_COLORS[name];
  // Hash the name to pick a consistent fallback color
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE_FALLBACK[h % PALETTE_FALLBACK.length];
}

/* ------------------------------------------------------------
   Automatic comfortable color assignment for a *set* of names.

   Problem it solves: single-name hash lookup can hand two names
   on the same screen the same (or perceptually identical) color.
   Instead, assign colors to the whole set at once:

   1. Names with a brand color (VENDOR_BRAND_COLORS for model vendors,
      PALETTE for tools) keep it; their position in OKLab is marked
      as occupied.
   2. Unknown names are processed in hash order (deterministic)
      and greedily take the pool color that maximizes the minimum
      perceptual distance (OKLab ΔE) to everything already used.

   The pool itself was generated offline with comfort constraints:
   L chosen per hue to balance contrast on both light and dark
   backgrounds (all ≥ 3.1:1), C capped in the yellow-green band,
   and chroma reduced adaptively where high-L hues leave sRGB.
   ------------------------------------------------------------ */

// 24-hue categorical pool, precomputed (see gen_palette script).
const COLOR_POOL = [
  'oklch(0.755 0.13 7)',  'oklch(0.755 0.13 22)', 'oklch(0.755 0.13 37)',
  'oklch(0.76 0.13 52)',  'oklch(0.76 0.13 67)',  'oklch(0.76 0.13 82)',
  'oklch(0.76 0.11 97)',  'oklch(0.76 0.11 112)', 'oklch(0.76 0.11 127)',
  'oklch(0.76 0.13 142)', 'oklch(0.755 0.13 157)','oklch(0.75 0.13 172)',
  'oklch(0.75 0.13 187)', 'oklch(0.755 0.12 202)','oklch(0.75 0.13 217)',
  'oklch(0.755 0.13 232)','oklch(0.76 0.13 247)', 'oklch(0.745 0.13 262)',
  'oklch(0.745 0.13 277)','oklch(0.76 0.13 292)', 'oklch(0.76 0.13 307)',
  'oklch(0.76 0.13 322)', 'oklch(0.76 0.13 337)', 'oklch(0.76 0.13 352)',
];

function oklchToOklab(L, C, hDeg) {
  const h = hDeg * Math.PI / 180;
  return [L, C * Math.cos(h), C * Math.sin(h)];
}

function parseOklab(color) {
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)/.exec(color);
  if (!m) return null;
  return oklchToOklab(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
}

const POOL_LAB = COLOR_POOL.map(parseOklab);

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

// Cache: sorted-name-set key → Map(name → color), so repeated calls
// across components in one render return the identical assignment.
const colorSetCache = new Map();

function getSourceColors(names) {
  const unique = Array.from(new Set(names.filter(Boolean)));
  const key = unique.slice().sort().join('\u0000');
  const hit = colorSetCache.get(key);
  if (hit) return hit;

  const result = new Map();
  const usedLab = [];   // OKLab coords of every color handed out
  const usedIdx = new Set(); // pool indices already taken

  const put = (name, color) => {
    result.set(name, color);
    const lab = parseOklab(color);
    if (lab) usedLab.push(lab);
  };

  // 1) brand colors first (their hues become off-limits for auto picks):
  //    vendor brand colors, then tool PALETTE entries.
  const unknown = [];
  for (const name of unique) {
    if (VENDOR_BRAND_COLORS[name]) put(name, VENDOR_BRAND_COLORS[name]);
    else if (PALETTE[name]) put(name, PALETTE[name]);
    else unknown.push(name);
  }

  // 2) unknown names in hash order, greedy max-min ΔE over the pool
  unknown.sort((a, b) => hashName(a) - hashName(b));
  for (const name of unknown) {
    let bestIdx = -1, bestDist = -1;
    for (let i = 0; i < POOL_LAB.length; i++) {
      if (usedIdx.has(i)) continue;
      const c = POOL_LAB[i];
      let minD = Infinity;
      for (const u of usedLab) {
        const d = Math.hypot(c[0] - u[0], c[1] - u[1], c[2] - u[2]);
        if (d < minD) minD = d;
      }
      const score = usedLab.length ? minD : Infinity;
      if (score > bestDist) { bestDist = score; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      usedIdx.add(bestIdx);
      put(name, COLOR_POOL[bestIdx]);
    } else {
      // pool exhausted (unlikely, 24 slots) — legacy hash fallback
      put(name, PALETTE_FALLBACK[hashName(name) % PALETTE_FALLBACK.length]);
    }
  }

  colorSetCache.set(key, result);
  return result;
}

const fmt   = new Intl.NumberFormat('zh-CN');
const fmtUS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtUS4 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });

function compact(v) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return fmt.format(v);
}

function compactCN(v) {
  // Thousands-based units (K/M/B) — same scale as `compact`, kept as a
  // separate name so existing call sites stay readable.
  return compact(v);
}

function pct(num, den) {
  if (!num || !den) return 0;
  return (num / den) * 100;
}

function deltaPct(curr, prev) {
  if (prev == null || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

function formatTs(v) {
  if (!v) return '—';
  const text = String(v).trim();
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const value = new Date(hasZone ? normalized : `${normalized}Z`);
  if (Number.isNaN(value.getTime())) return text.replace('T', ' ').slice(0, 16);

  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(value);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function localDateStr(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function parseLocalDate(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return localDateStr(d);
}

function toDateTimeLocalValue(date) {
  return [
    localDateStr(date),
    [
      String(date.getHours()).padStart(2, '0'),
      String(date.getMinutes()).padStart(2, '0')
    ].join(':')
  ].join('T');
}

function startOfDayLocal(dateStr) {
  const d = parseLocalDate(dateStr);
  d.setHours(0, 0, 0, 0);
  return toDateTimeLocalValue(d);
}

function endOfDayLocal(dateStr) {
  const d = parseLocalDate(dateStr);
  d.setHours(23, 59, 0, 0);
  return toDateTimeLocalValue(d);
}

function timestampMs(value) {
  if (!value) return null;
  const text = String(value);
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const ms = new Date(hasZone ? normalized : normalized).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function addDays(dateStr, days) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

function rangeDates(startStr, endStr) {
  const out = [];
  const s = parseLocalDate(startStr), e = parseLocalDate(endStr);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.push(localDateStr(d));
  }
  return out;
}

// Apply filters to daily rows
function filterDaily(rows, f) {
  return rows.filter(r =>
    r.usageDate >= f.startDate && r.usageDate <= f.endDate &&
    (f.sources.size === 0 || f.sources.has(r.source)) &&
    (f.devices.size === 0 || f.devices.has(r.device)) &&
    (f.models.size  === 0 || f.models.has(r.model))
  );
}

function filterTime(rows, f) {
  const startMs = timestampMs(f.startDateTime || startOfDayLocal(f.startDate));
  const endMs = timestampMs(f.endDateTime || endOfDayLocal(f.endDate));
  return rows.filter(r => {
    const ms = timestampMs(r.eventTime);
    return ms != null &&
      (startMs == null || ms >= startMs) &&
      (endMs == null || ms <= endMs) &&
      (f.sources.size === 0 || f.sources.has(r.source)) &&
      (f.devices.size === 0 || f.devices.has(r.device)) &&
      (f.models.size  === 0 || f.models.has(r.model));
  });
}

// Aggregate totals across rows
function aggregateTotals(rows) {
  let total = 0, inp = 0, out = 0, cacheRd = 0, cacheCr = 0, reason = 0, cost = 0, saved = 0;
  for (const r of rows) {
    total += r.totalTokens;
    inp   += r.inputTokens;
    out   += r.outputTokens;
    cacheRd += r.cacheReadTokens;
    cacheCr += r.cacheCreationTokens;
    reason += r.reasoningOutputTokens;
    cost  += r.costUSD;
    saved += r.cacheSavedUSD || 0;
  }
  return {
    totalTokens: total,
    inputTokens: inp,
    outputTokens: out,
    cacheReadTokens: cacheRd,
    cacheCreationTokens: cacheCr,
    cacheTokens: cacheRd + cacheCr,
    reasoningTokens: reason,
    costUSD: cost,
    cacheSavedUSD: saved,
    cacheHitRate: total ? (cacheRd / total) * 100 : 0
  };
}

// Group by date + dimension
function groupByDate(rows, dim = 'source') {
  const map = new Map(); // date -> {dim -> total}
  for (const r of rows) {
    const d = r.usageDate;
    if (!map.has(d)) map.set(d, {});
    const k = r[dim];
    map.get(d)[k] = (map.get(d)[k] || 0) + r.totalTokens;
  }
  return map;
}

function uniqueValues(rows, field) {
  const s = new Set();
  for (const r of rows) if (r[field]) s.add(r[field]);
  return Array.from(s).sort();
}

// CSV download
function downloadCSV(filename, rows, columns) {
  const header = columns.map(c => c.title).join(',');
  const body = rows.map(r =>
    columns.map(c => {
      const v = typeof c.value === 'function' ? c.value(r) : r[c.field];
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')
  ).join('\n');
  const blob = new Blob([header + '\n' + body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Project path label from sessionId
function projectLabel(s) {
  return s.projectPath || s.sessionId;
}

// Mix two oklch colors by t  via color-mix string
function alpha(color, a) {
  return `color-mix(in oklab, ${color}, transparent ${100 - a * 100}%)`;
}

// Canonical display order for source lists; anything unlisted keeps its data
// order after the known sources.
const SOURCE_ORDER = [
  'Claude Code', 'Codex CLI', 'OpenCode', 'Gemini CLI', 'Hermes Agent', 'OpenClaw',
  'Grok CLI', 'DeepSeek Harness'
];

function sortSources(list) {
  const rank = new Map(SOURCE_ORDER.map((name, i) => [name, i]));
  return [...list].sort((a, b) =>
    (rank.get(a) ?? SOURCE_ORDER.length) - (rank.get(b) ?? SOURCE_ORDER.length));
}

export const U = {
  PALETTE, PALETTE_FALLBACK, getSourceColor, getSourceColors, sortSources,
  fmt, fmtUS, fmtUS4,
  compact, compactCN, pct, deltaPct, formatTs,
  localDateStr, toDateTimeLocalValue, startOfDayLocal, endOfDayLocal, daysAgo, addDays, rangeDates,
  filterDaily, filterTime, aggregateTotals, groupByDate, uniqueValues,
  downloadCSV, projectLabel, alpha
};
