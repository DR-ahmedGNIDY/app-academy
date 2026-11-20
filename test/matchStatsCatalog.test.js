const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  TEMPLATES,
  templateForSport,
  sanitizeStats,
  sanitizeRating,
  summarizePlayerStats,
} = require('../src/utils/matchStatsCatalog');

test('templateForSport maps known sports and falls back to individual', () => {
  assert.equal(templateForSport('كرة سلة').key, 'basketball');
  assert.equal(templateForSport(' كرة  قدم ').key, 'football');
  assert.equal(templateForSport('كرة طائرة').key, 'volleyball');
  assert.equal(templateForSport('كرة يد').key, 'handball');
  assert.equal(templateForSport('سباحة').key, 'timed');
  assert.equal(templateForSport('ملاكمة').key, 'individual');
  assert.equal(templateForSport('كاراتيه').key, 'individual');
  assert.equal(templateForSport('كاراتيه').sport, 'كاراتيه');
  assert.equal(templateForSport(null).key, 'individual');
  assert.equal(templateForSport('').sport, 'رياضة فردية');
});

test('every template has unique field keys and at least one leader field', () => {
  for (const t of Object.values(TEMPLATES)) {
    const keys = t.fields.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length, t.key);
    assert.ok(t.fields.some((f) => f.leader), t.key);
  }
  assert.ok(!TEMPLATES.timed.fields.some((f) => f.key === 'method'));
  assert.ok(TEMPLATES.timed.fields.some((f) => f.key === 'time'));
});

test('sanitizeStats clamps, coerces and drops unknown keys', () => {
  const bb = templateForSport('كرة سلة');
  assert.deepEqual(
    sanitizeStats(bb, { points: '12', rebounds: -3, assists: 2000, steals: 'x', hack: 5, fouls: '' }),
    { points: 12, rebounds: 0, assists: 999 }
  );
  const fb = templateForSport('كرة قدم');
  assert.deepEqual(sanitizeStats(fb, { cleanSheet: 'true', goals: 1.6 }), { goals: 2, cleanSheet: true });
  assert.deepEqual(sanitizeStats(fb, { cleanSheet: false }), { cleanSheet: false });

  const box = templateForSport('ملاكمة');
  assert.deepEqual(
    sanitizeStats(box, { attack: 140, defense: 55.4, outcome: 'win', method: 'ko' }),
    { attack: 100, defense: 55, outcome: 'win', method: 'ko' }
  );
  assert.deepEqual(sanitizeStats(box, { outcome: 'maybe', method: 'magic' }), {});

  const swim = templateForSport('سباحة');
  assert.deepEqual(sanitizeStats(swim, { time: '  1:05.32  ', method: 'ko' }), { time: '1:05.32' });
  assert.deepEqual(sanitizeStats(bb, null), {});
});

test('sanitizeRating rounds to half steps within 0–10', () => {
  assert.equal(sanitizeRating(7.3), 7.5);
  assert.equal(sanitizeRating('8.74'), 8.5);
  assert.equal(sanitizeRating(12), 10);
  assert.equal(sanitizeRating(-1), 0);
  assert.equal(sanitizeRating(''), null);
  assert.equal(sanitizeRating(null), null);
  assert.equal(sanitizeRating('abc'), null);
});

test('summarizePlayerStats totals counts, averages percents, tallies outcomes', () => {
  const bb = templateForSport('كرة سلة');
  const s = summarizePlayerStats(bb, [
    { stats: { points: 10, rebounds: 4 }, rating: 7, mvp: true },
    { stats: { points: 21 }, rating: 8.5, mvp: false },
    { stats: {}, rating: null, mvp: false },
  ]);
  assert.equal(s.matches, 3);
  assert.equal(s.mvpCount, 1);
  assert.equal(s.avgRating, 7.8);
  assert.deepEqual(s.fields.points, { total: 31, avg: 15.5 });
  assert.deepEqual(s.fields.rebounds, { total: 4, avg: 4 });
  assert.deepEqual(s.fields.assists, { total: 0, avg: null });

  const box = templateForSport('ملاكمة');
  const b = summarizePlayerStats(box, [
    { stats: { attack: 80, outcome: 'win', method: 'ko' } },
    { stats: { attack: 61, outcome: 'win' } },
    { stats: { outcome: 'loss' } },
  ]);
  assert.deepEqual(b.fields.attack, { avg: 70.5 });
  assert.deepEqual(b.fields.outcome, { tally: { win: 2, loss: 1 } });
  assert.equal(b.fields.method, undefined);
  assert.equal(b.avgRating, null);

  const fb = templateForSport('كرة قدم');
  const f = summarizePlayerStats(fb, [{ stats: { cleanSheet: true } }, { stats: { cleanSheet: false } }]);
  assert.deepEqual(f.fields.cleanSheet, { total: 1, avg: 0.5 });
});
