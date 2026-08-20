/* =============================================================
   Shared ECharts wrapper — single chart lifecycle used by every
   page so init/resize/dispose and option updates behave identically.
   ============================================================= */

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export function EChart({ option, height = 320, onEvents, fill = false }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

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
    if (chartRef.current) chartRef.current.setOption(option, true);
  }, [option]);

  return <div ref={ref} style={fill ? { width: '100%', height: '100%', flex: 1, minHeight: 0 } : { width: '100%', height }} />;
}
