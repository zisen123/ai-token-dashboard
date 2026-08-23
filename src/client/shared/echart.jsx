/* =============================================================
   Shared ECharts wrapper — single chart lifecycle used by every
   page so init/resize/dispose and option updates behave identically.
   ============================================================= */

import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts';

// Structural fingerprint of the series array (type+name per entry). When it
// is unchanged between renders, a merge-mode setOption can plain-merge so
// series keep their identity (no re-grow animation, no hover-chain break);
// when it changes (bar↔line switch, source list change) we replaceMerge so
// stale series cannot linger.
function seriesSignature(series) {
  if (!Array.isArray(series)) return '';
  return series.map(s => `${s && s.type}:${s && s.name}`).join('|');
}

export function EChart({ option, height = 320, onEvents, fill = false, merge = false }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  const sig = useMemo(() => seriesSignature(option && option.series), [option]);
  const prevSig = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    chartRef.current = echarts.init(ref.current, null, { renderer: 'canvas' });
    const onResize = () => chartRef.current?.resize();
    window.addEventListener('resize', onResize);
    // fill mode: observe the container itself so the canvas tracks panel
    // height changes (e.g. a sibling panel stretching the grid row).
    let observer = null;
    if (fill && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => chartRef.current?.resize());
      observer.observe(ref.current);
    }
    if (onEvents) {
      for (const [name, handler] of Object.entries(onEvents)) {
        chartRef.current.on(name, handler);
      }
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, [fill]);

  useEffect(() => {
    if (!chartRef.current) return;
    if (!merge) {
      // Full replace: the safe default for charts whose option shape can
      // change arbitrarily between renders.
      chartRef.current.setOption(option, true);
    } else if (prevSig.current === sig) {
      // Same series structure: plain merge keeps series identity, so a
      // re-render that only touches itemStyle opacity (cross-chart focus
      // dimming) neither rebuilds series (which would fire mouseout and
      // break the hover chain) nor replays the grow animation.
      chartRef.current.setOption(option);
    } else {
      // Structure changed (mode switch / source list change): replace the
      // series array wholesale so no stale series lingers.
      chartRef.current.setOption(option, { replaceMerge: ['series'] });
    }
    prevSig.current = sig;
  }, [option, merge, sig]);

  return <div ref={ref} style={fill ? { width: '100%', height: '100%', flex: 1, minHeight: 0 } : { width: '100%', height }} />;
}
