import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotaWindowLabel, orderQuotaWindows } from '../src/client/shared/quota.js';

// The exact payload the Anthropic endpoint started returning.
const LIVE = [
  { name: 'nimbus_quill', utilization: 0, resetsAt: null },
  { name: 'five_hour', utilization: 0.18, resetsAt: '2026-08-15T14:09:59Z' },
  { name: 'seven_day', utilization: 0.08, resetsAt: '2026-08-17T05:59:59Z' }
];

test('known windows keep their Chinese labels', () => {
  assert.equal(quotaWindowLabel('five_hour'), '5 小时');
  assert.equal(quotaWindowLabel('seven_day'), '7 天');
  assert.equal(quotaWindowLabel('seven_day_opus'), '7 天 · Opus');
});

test('an unknown window falls back to its raw name', () => {
  assert.equal(quotaWindowLabel('nimbus_quill'), 'nimbus_quill');
});

test('an unknown empty window never displaces a real one', () => {
  // Regression: indexOf returned -1 for nimbus_quill, sorting it ahead of
  // five_hour (0), and the card's slice(0, 2) then dropped seven_day.
  const ordered = orderQuotaWindows(LIVE);
  assert.deepEqual(ordered.map(w => w.name), ['five_hour', 'seven_day']);
  assert.deepEqual(ordered.slice(0, 2).map(w => w.name), ['five_hour', 'seven_day']);
});

test('known windows sort into the declared order regardless of input order', () => {
  const shuffled = [
    { name: 'seven_day_sonnet', utilization: 0.1, resetsAt: 'x' },
    { name: 'seven_day', utilization: 0.2, resetsAt: 'x' },
    { name: 'five_hour', utilization: 0.3, resetsAt: 'x' }
  ];
  assert.deepEqual(
    orderQuotaWindows(shuffled).map(w => w.name),
    ['five_hour', 'seven_day', 'seven_day_sonnet']
  );
});

test('an unknown window with real usage is kept, but ranked last', () => {
  const withData = [
    { name: 'future_window', utilization: 0.5, resetsAt: '2026-09-01T00:00:00Z' },
    { name: 'five_hour', utilization: 0.1, resetsAt: 'x' }
  ];
  assert.deepEqual(
    orderQuotaWindows(withData).map(w => w.name),
    ['five_hour', 'future_window']
  );
});

test('unknown windows hold their relative order behind the known ones', () => {
  const many = [
    { name: 'beta_two', utilization: 0.2, resetsAt: 'x' },
    { name: 'beta_one', utilization: 0.3, resetsAt: 'x' },
    { name: 'seven_day', utilization: 0.1, resetsAt: 'x' }
  ];
  assert.deepEqual(
    orderQuotaWindows(many).map(w => w.name),
    ['seven_day', 'beta_two', 'beta_one']
  );
});

test('empty and malformed input does not throw', () => {
  assert.deepEqual(orderQuotaWindows([]), []);
  assert.deepEqual(orderQuotaWindows(null), []);
  assert.deepEqual(orderQuotaWindows(undefined), []);
  assert.deepEqual(orderQuotaWindows([null, undefined]), []);
});
