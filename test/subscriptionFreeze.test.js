const test = require('node:test');
const assert = require('node:assert');

const {
  planFreeze,
  planResume,
  openFreeze,
  activeFreeze,
  freezeState,
  frozenDayRanges,
} = require('../src/utils/subscriptionFreeze');

const d = (y, m, day, h = 0) => new Date(y, m - 1, day, h);
const sub = (extra = {}) => ({ startDate: d(2026, 11, 1), endDate: d(2026, 12, 1, 23), exhaustedAt: null, freezes: [], ...extra });

test('freeze from today extends the end date by the days', () => {
  const now = d(2026, 11, 20, 10);
  const r = planFreeze(sub(), { days: 14, reason: 'injury' }, now);
  assert.ok(!r.error, r.error);
  assert.deepStrictEqual(r.freeze.startDate, d(2026, 11, 20));
  assert.deepStrictEqual(r.freeze.endDate, d(2026, 12, 4));
  assert.strictEqual(r.freeze.reason, 'injury');
  assert.deepStrictEqual(r.newEndDate, d(2026, 12, 15, 23));
});

test('freeze validation', () => {
  const now = d(2026, 11, 20, 10);
  assert.ok(planFreeze(sub(), { days: 0 }, now).error);
  assert.ok(planFreeze(sub(), { days: 2.5 }, now).error);
  assert.ok(planFreeze(sub(), { days: 400 }, now).error);
  assert.ok(planFreeze(sub({ endDate: d(2026, 11, 19) }), { days: 5 }, now).error); // expired
  assert.ok(planFreeze(sub({ exhaustedAt: d(2026, 11, 18) }), { days: 5 }, now).error);
  assert.ok(planFreeze(sub(), { days: 5, startDate: '2026-11-19' }, now).error); // past start
  assert.ok(planFreeze(sub(), { days: 5, startDate: '2026-12-05' }, now).error); // after end
  const frozen = sub({ freezes: [{ startDate: d(2026, 11, 18), endDate: d(2026, 11, 25), days: 7 }] });
  assert.match(planFreeze(frozen, { days: 3 }, now).error, /مجمّد بالفعل/);
  assert.strictEqual(planFreeze(sub(), { days: 3, reason: 'x' }, now).freeze.reason, 'other');
});

test('active vs scheduled freeze state', () => {
  const s = sub({ freezes: [{ startDate: d(2026, 11, 25), endDate: d(2026, 11, 30), days: 5 }] });
  assert.strictEqual(freezeState(s, d(2026, 11, 20)).freezeStatus, 'scheduled');
  assert.strictEqual(activeFreeze(s, d(2026, 11, 20)), null);
  assert.strictEqual(freezeState(s, d(2026, 11, 26)).freezeStatus, 'frozen');
  assert.ok(activeFreeze(s, d(2026, 11, 26)));
  assert.strictEqual(freezeState(s, d(2026, 11, 30, 1)).freezeStatus, null); // ended
  assert.strictEqual(openFreeze(s, d(2026, 12, 1)), null);
});

test('early resume returns unused days; resume before start cancels', () => {
  // 14-day freeze from 20 Nov, end date was moved to 15 Dec
  const s = sub({
    endDate: d(2026, 12, 15, 23),
    freezes: [{ startDate: d(2026, 11, 20), endDate: d(2026, 12, 4), days: 14 }],
  });
  const r = planResume(s, d(2026, 11, 25, 9)); // back on the 25th ⇒ 5 frozen days
  assert.strictEqual(r.usedDays, 5);
  assert.strictEqual(r.returnedDays, 9);
  assert.deepStrictEqual(r.newFreezeEnd, d(2026, 11, 25));
  assert.deepStrictEqual(r.newEndDate, d(2026, 12, 6, 23));
  assert.strictEqual(r.remove, false);

  const early = planResume(s, d(2026, 11, 19, 9)); // not started yet
  assert.strictEqual(early.usedDays, 0);
  assert.strictEqual(early.returnedDays, 14);
  assert.strictEqual(early.remove, true);

  const sameDay = planResume(s, d(2026, 11, 20, 18)); // resumed on its first day
  assert.strictEqual(sameDay.usedDays, 0);
  assert.strictEqual(sameDay.remove, true);

  assert.ok(planResume(sub(), d(2026, 11, 20)).error);
});

test('frozen day ranges are inclusive date strings', () => {
  const s = sub({ freezes: [
    { startDate: d(2026, 11, 20), endDate: d(2026, 11, 25), days: 5 },
    { startDate: d(2026, 10, 1), endDate: d(2026, 10, 1), days: 0 },
  ] });
  assert.deepStrictEqual(frozenDayRanges(s), [{ fromStr: '2026-11-20', toStr: '2026-11-24' }]);
});
