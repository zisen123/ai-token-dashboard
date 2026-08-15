/* =============================================================
   Subscription quota windows.

   Vendors add windows without warning — Anthropic started returning
   a `nimbus_quill` window with no reset time and zero utilization.
   Anything unrecognised has to degrade quietly: it must never take a
   slot from a real limit, and it must never be mistaken for one.
   ============================================================= */

export const QUOTA_WINDOW_LABEL = {
  five_hour: '5 小时',
  seven_day: '7 天',
  seven_day_opus: '7 天 · Opus',
  seven_day_sonnet: '7 天 · Sonnet'
};

const QUOTA_WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

/** Chinese label for a known window; the raw vendor name otherwise. */
export function quotaWindowLabel(name) {
  return QUOTA_WINDOW_LABEL[name] || name;
}

/**
 * A window we do not recognise that also carries no reset time and no
 * usage is a vendor placeholder, not a limit the user is spending against.
 */
function isEmptyUnknown(window) {
  return !QUOTA_WINDOW_LABEL[window?.name]
    && !window?.resetsAt
    && !(Number(window?.utilization) > 0);
}

/**
 * Known windows first, in the order above; anything unrecognised keeps its
 * relative order behind them. `indexOf` returns -1 for unknown names, so
 * sorting on it raw would float them to the front and push a real window out
 * of the card's two-row slice.
 */
export function orderQuotaWindows(windows) {
  const rank = name => {
    const i = QUOTA_WINDOW_ORDER.indexOf(name);
    return i === -1 ? QUOTA_WINDOW_ORDER.length : i;
  };
  return (windows || [])
    .filter(w => w && !isEmptyUnknown(w))
    .map((window, i) => ({ window, i }))
    .sort((a, b) => rank(a.window.name) - rank(b.window.name) || a.i - b.i)
    .map(entry => entry.window);
}
