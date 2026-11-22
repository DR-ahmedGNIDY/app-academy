const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeArabic,
  nameMatchScore,
  weekdayAr,
  addDays,
  cairoDateStr,
  TOOL_DEFINITIONS,
  runTool,
} = require('../src/utils/assistant/tools');

test('normalizeArabic unifies alef/taa marbuta/yaa and strips tashkeel', () => {
  assert.equal(normalizeArabic('أحمد إسماعيل'), 'احمد اسماعيل');
  assert.equal(normalizeArabic('فاطمة'), 'فاطمه');
  assert.equal(normalizeArabic('مُصْطَفَى'), 'مصطفي');
  assert.equal(normalizeArabic('  آدم   علي '), 'ادم علي');
});

test('nameMatchScore: tokens in any spelling, exact > prefix > contains, code match', () => {
  assert.ok(nameMatchScore('احمد اسماعيل احمد', 'Y-0251', 'أحمد إسماعيل') > 0);
  assert.ok(nameMatchScore('احمد اسماعيل احمد', 'Y-0251', 'اسماعيل') > 0);
  assert.equal(nameMatchScore('احمد اسماعيل احمد', 'Y-0251', 'محمود'), 0);
  assert.equal(nameMatchScore('محمود البنا', 'Y-0132', 'y-0132'), 100);
  assert.ok(nameMatchScore('سارة محمد', 'Y-1', 'ساره محمد') > nameMatchScore('محمد سارة علي', 'Y-2', 'ساره محمد'));
  assert.equal(nameMatchScore('احمد', 'Y-1', ''), 0);
});

test('date helpers: Arabic weekday, add days across months, Cairo date format', () => {
  assert.equal(weekdayAr('2026-11-21'), 'السبت');
  assert.equal(weekdayAr('2026-11-22'), 'الأحد');
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.match(cairoDateStr(), /^\d{4}-\d{2}-\d{2}$/);
  // 23:30 UTC = 01:30 next day in Cairo (UTC+2)
  assert.equal(cairoDateStr(new Date('2026-11-21T23:30:00Z')), '2026-11-22');
});

test('tool definitions are read-only and well-formed', () => {
  const names = TOOL_DEFINITIONS.map((t) => t.function.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of TOOL_DEFINITIONS) {
    assert.equal(t.type, 'function');
    assert.equal(t.function.parameters.type, 'object');
    assert.equal(t.function.parameters.additionalProperties, false);
  }
  // لا أدوات كتابة/مسح في المرحلة 1
  assert.ok(!names.some((n) => /create|add|delete|update|remove|record|set_/.test(n)));
});

test('runTool returns errors as data, never throws', async () => {
  assert.match(await runTool('nope', '{}', {}), /unknown tool/);
  assert.match(await runTool('search_players', '{bad json', {}), /invalid arguments/);
  assert.match(await runTool('player_details', '{"playerId":"x"}', { academyId: 'a' }), /معرّف لاعب غير صحيح/);
});
