/* =============================================================
   Shared stacked-trend chart building blocks.

   Both the main dashboard TrendChart and the Sophnet panel trend
   chart are "dates × named sources" stacked bar/line charts with
   the same ECharts pitfalls, so the tricky parts live here once:

   - oklch-safe emphasis/blur state (ECharts 6 cannot interpolate
     oklch() strings on hover; the hovered column renders invisible)
   - two-level tooltip: hovering a segment shows that source's
     dedicated row, empty grid space shows the full breakdown
   - hover events that feed a cross-chart focus state
   - animation config that never replays a grow on hover-driven
     re-renders (the EChart wrapper merges when the series
     signature is unchanged; updates must be instant)
   ============================================================= */

// Bars: emphasis disabled entirely; axis tooltip needs no per-item restyle.
const stableBarState = {
  emphasis: { disabled: true },
  blur: { itemStyle: { opacity: 1 } },
  select: { itemStyle: { opacity: 1 } }
};

// Lines: keep axisPointer/tooltip but never let hover restyle the line.
// NOTE: never put areaStyle in a state object — ECharts animates the
// gradient on hover and crashes its color interpolator.
function stableLineState(width = 2) {
  return {
    emphasis: { focus: 'none', lineStyle: { width, opacity: 1 }, itemStyle: { opacity: 1 } },
    blur: { lineStyle: { opacity: 1 }, itemStyle: { opacity: 1 } },
    select: { lineStyle: { opacity: 1 }, itemStyle: { opacity: 1 } }
  };
}

// First render animates in; every later update (hover dimming, data
// refresh) is instant so nothing visibly replays.
const TREND_ANIMATION = {
  animationDuration: 400,
  animationDurationUpdate: 0
};

/**
 * Build the source series (+ optional overlays) for a trend chart.
 *
 * @param {object} o
 * @param {'bar'|'stacked'|'line'} o.mode
 * @param {string[]} o.names        source/vendor names, in draw order
 * @param {(name)=>string} o.colorOf color per source
 * @param {Map<string,number>} o.byKey `${date}::${name}` → value
 * @param {string[]} o.dates
 * @param {string|null} o.dimName   focused source; others render at 0.25
 * @param {number[]|null} o.rolling 7-day baseline overlay (bar modes only)
 * @param {object|null} o.compare   { data, pal } previous-period overlay
 * @param {object} o.pal            chart palette for overlay colors
 */
function buildTrendSeries(o) {
  const { mode, names, colorOf, byKey, dates, dimName, rolling, compare, pal } = o;
  const dimmed = (name) => (dimName && dimName !== name ? 0.25 : 1);
  const series = [];

  if (mode === 'line') {
    names.forEach(name => {
      series.push({
        name,
        type: 'line',
        smooth: 0.3,
        symbol: 'circle',
        symbolSize: 4,
        showSymbol: false,
        lineStyle: { width: 2, color: colorOf(name), opacity: dimmed(name) },
        itemStyle: { color: colorOf(name), opacity: dimmed(name) },
        areaStyle: {
          opacity: 0.08,
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: colorOf(name) },
              { offset: 1, color: 'transparent' }
            ]
          }
        },
        emphasis: { disabled: true },
        data: dates.map(d => byKey.get(`${d}::${name}`) || 0)
      });
    });
  } else {
    names.forEach(name => {
      series.push({
        name,
        type: 'bar',
        stack: mode === 'stacked' ? 'total' : undefined,
        barMaxWidth: 24,
        itemStyle: { color: colorOf(name), opacity: dimmed(name) },
        ...stableBarState,
        data: dates.map(d => byKey.get(`${d}::${name}`) || 0)
      });
    });
  }

  if (compare) {
    series.push({
      name: compare.name || '上一周期',
      type: 'line',
      smooth: 0.3,
      symbol: 'none',
      lineStyle: { width: 1.2, color: pal.markLine, type: 'dashed', opacity: 0.55 },
      itemStyle: { color: pal.markLine },
      ...stableLineState(1.2),
      data: compare.data,
      z: 3
    });
  }

  if (mode !== 'line' && rolling && dates.length > 10) {
    series.push({
      name: '7 日均线',
      type: 'line',
      smooth: 0.5,
      symbol: 'none',
      lineStyle: { width: 1.6, color: pal.markLineCompare, type: [4, 4] },
      itemStyle: { color: pal.markLineCompare },
      ...stableLineState(1.6),
      data: rolling,
      z: 4
    });
  }
  return series;
}

/**
 * Two-level tooltip formatter factory.
 *
 * segmentRef.current holds the source the pointer sits on (set by
 * makeTrendHoverEvents); null → full breakdown for the whole column.
 *
 * The big headline number uses the primary formatter (fmtValue /
 * valueSuffix); `secondaryOf` optionally returns a pre-formatted string
 * for a second, always-shown line (e.g. the other metric of the same
 * column). Keeping it pre-formatted lets each caller own its units.
 *
 * Back-compat: the old {costOf, fmtCost} pair maps to a secondary cost
 * line, so existing callers (main dashboard) keep the "tokens headline
 * + cost line" layout untouched.
 *
 * @param {object} o
 * @param {object} o.pal
 * @param {string[]} o.names
 * @param {{current:string|null}} o.segmentRef
 * @param {(date)=>number|null} [o.costOf] column cost (legacy secondary)
 * @param {(v)=>string} o.fmtValue     value formatter
 * @param {string} [o.valueSuffix]     e.g. ' tokens'
 * @param {(v,date)=>string} [o.fmtCost]
 * @param {(date)=>string|null} [o.secondaryOf] pre-formatted secondary line
 * @param {string} [o.secondaryLabel] prefix of the segment-mode sub line
 */
function makeTrendFormatter(o) {
  const { pal, names, segmentRef, costOf, fmtValue, valueSuffix = '', fmtCost, secondaryOf, secondaryLabel = '当日费用' } = o;
  const secondary = (date) => {
    if (secondaryOf) return secondaryOf(date) || null;
    const cost = costOf ? (costOf(date) || 0) : null;
    return cost != null ? fmtCost(cost) : null;
  };
  return function formatter(params) {
    const date = params[0]?.axisValue || '';
    let total = 0;
    for (const p of params) if (names.includes(p.seriesName)) total += p.value || 0;
    const sub = secondary(date);
    let html = `<div style="font-weight:600;margin-bottom:6px;color:${pal.tooltipLabel};font-size:11.5px;letter-spacing:.04em">${date}</div>`;
    html += `<div style="font-size:16px;font-weight:600;margin-bottom:2px">${fmtValue(total)} <span style="font-size:11px;color:${pal.tooltipMuted};font-weight:500">${valueSuffix.trim()}</span></div>`;
    if (sub != null) html += `<div style="font-size:12px;color:${pal.tooltipSeries};margin-bottom:8px">${sub}</div>`;

    // Single-source mode: pointer sits on that source's segment.
    const seg = segmentRef.current;
    if (seg && names.includes(seg)) {
      const p = params.find(x => x.seriesName === seg);
      const val = p ? (p.value || 0) : 0;
      html += `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;padding:6px 8px;border-radius:8px;background:rgba(125,125,150,0.12)">
        <span style="width:10px;height:10px;border-radius:3px;background:${p ? p.color : 'transparent'};display:inline-block"></span>
        <span style="color:${pal.tooltipSeries};flex:1;font-weight:600">${seg}</span>
        <span style="font-weight:600;font-variant-numeric:tabular-nums">${fmtValue(val)}${valueSuffix}</span>
      </div>`;
      const pct = total ? (val / total) * 100 : 0;
      html += `<div style="font-size:11px;color:${pal.tooltipMuted};margin-top:3px">占当日 ${pct.toFixed(1)}%${sub != null ? ` · ${secondaryLabel} ${sub}` : ''}</div>`;
      return html;
    }

    // Full breakdown (pointer in empty grid space / y-axis area).
    const rows = params
      .filter(p => p.seriesName !== '7 日均线' && p.seriesName !== '上一周期' && p.value)
      .sort((a, b) => (b.value || 0) - (a.value || 0));
    for (const p of rows) {
      html += `<div style="display:flex;align-items:center;gap:8px;margin-top:3px;font-size:12px">
        <span style="width:8px;height:8px;border-radius:2px;background:${p.color};display:inline-block"></span>
        <span style="color:${pal.tooltipSeries};flex:1">${p.seriesName}</span>
        <span style="font-weight:600;margin-left:18px;font-variant-numeric:tabular-nums">${fmtValue(p.value || 0)}${valueSuffix}</span>
      </div>`;
    }
    return html;
  };
}

/**
 * Hover events feeding the cross-chart focus state. Bind once via
 * EChart onEvents; handlers read the latest name list through namesRef.
 *
 * @param {object} o
 * @param {{current:string[]}} o.namesRef
 * @param {{current:string|null}} o.segmentRef
 * @param {(name:string|null)=>void} o.onFocus
 */
function makeTrendHoverEvents(o) {
  const { namesRef, segmentRef, onFocus } = o;
  return {
    mouseover(params) {
      if (params.componentType === 'series' && params.seriesType === 'bar' && namesRef.current.includes(params.seriesName)) {
        segmentRef.current = params.seriesName;
        onFocus?.(params.seriesName);
      }
    },
    mouseout(params) {
      if (params.componentType === 'series' && params.seriesType === 'bar') {
        segmentRef.current = null;
        onFocus?.(null);
      }
    },
    globalout() {
      segmentRef.current = null;
      onFocus?.(null);
    }
  };
}

export { stableBarState, stableLineState, TREND_ANIMATION, buildTrendSeries, makeTrendFormatter, makeTrendHoverEvents };
