const test = require('node:test');
const assert = require('node:assert');

const {
  parseRange,
  previousRange,
  monthKeys,
  changePct,
  summarize,
  buildMonthlySeries,
} = require('../src/utils/profitLoss');

test('default range is the current calendar month', () => {
  const r = parseRange(undefined, undefined, new Date(2026, 1, 14)); // Feb 2026
  assert.strictEqual(r.fromStr, '2026-02-01');
  assert.strictEqual(r.toStr, '2026-02-28');
  assert.strictEqual(r.days, 28);
});

test('range validation', () => {
  assert.ok(parseRange('bad', '2026-01-01').error);
  assert.ok(parseRange('2026-03-01', '2026-02-01').error);
  assert.ok(parseRange('2020-01-01', '2026-01-01').error); // > 3 years
  assert.strictEqual(parseRange('2026-11-20', '2026-11-20').days, 1);
});

test('whole-month periods compare against the whole previous months', () => {
  const nov = previousRange(parseRange('2026-11-01', '2026-11-30'));
  assert.deepStrictEqual([nov.fromStr, nov.toStr], ['2026-10-01', '2026-10-31']);
  const mar = previousRange(parseRange('2026-03-01', '2026-03-31'));
  assert.deepStrictEqual([mar.fromStr, mar.toStr], ['2026-02-01', '2026-02-28']);
  const jan = previousRange(parseRange('2026-01-01', '2026-01-31'));
  assert.deepStrictEqual([jan.fromStr, jan.toStr], ['2025-12-01', '2025-12-31']);
  const q = previousRange(parseRange('2026-04-01', '2026-06-30'));
  assert.deepStrictEqual([q.fromStr, q.toStr], ['2026-01-01', '2026-03-31']);
  const year = previousRange(parseRange('2026-01-01', '2026-12-31'));
  assert.deepStrictEqual([year.fromStr, year.toStr], ['2025-01-01', '2025-12-31']);
});

test('custom periods compare against the same number of days before', () => {
  const prev = previousRange(parseRange('2026-11-10', '2026-11-19'));
  assert.deepStrictEqual([prev.fromStr, prev.toStr, prev.days], ['2026-10-31', '2026-11-09', 10]);
});

test('monthKeys returns 12 months ending at the range month', () => {
  const keys = monthKeys('2026-02-28');
  assert.strictEqual(keys.length, 12);
  assert.strictEqual(keys[0], '2025-03');
  assert.strictEqual(keys[11], '2026-02');
});

test('summarize computes totals, net profit and margin', () => {
  const s = summarize({
    subscriptions: 10000, matches: 500, store: 300,
    expensesByCategory: { rent: 3000, electricity: 400.5 },
    payrollPaid: 4000,
  });
  assert.strictEqual(s.revenue.total, 10800);
  assert.strictEqual(s.expenses.total, 3400.5);
  assert.strictEqual(s.costsTotal, 7400.5);
  assert.strictEqual(s.netProfit, 3399.5);
  assert.strictEqual(s.margin, 31.48);
  assert.strictEqual(summarize({ expensesByCategory: { rent: 100 } }).margin, null);
  assert.strictEqual(summarize({ expensesByCategory: { rent: 100 } }).netProfit, -100);
});

test('changePct handles zero and negative bases', () => {
  assert.strictEqual(changePct(150, 100), 50);
  assert.strictEqual(changePct(50, 100), -50);
  assert.strictEqual(changePct(10, 0), null);
  assert.strictEqual(changePct(-50, -100), 50); // loss shrank
});

test('monthly series merges sources and fills empty months', () => {
  const keys = ['2026-10', '2026-11'];
  const series = buildMonthlySeries(keys, {
    revenue: [[{ _id: '2026-11', total: 1000 }], [{ _id: '2026-11', total: 200 }], []],
    costs: [[{ _id: '2026-10', total: 300 }], [{ _id: '2026-11', total: 500 }]],
  });
  assert.deepStrictEqual(series, [
    { month: '2026-10', revenue: 0, costs: 300, profit: -300 },
    { month: '2026-11', revenue: 1200, costs: 500, profit: 700 },
  ]);
});
