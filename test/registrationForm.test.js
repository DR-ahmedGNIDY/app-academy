const test = require('node:test');
const assert = require('node:assert');

const {
  newJoinCode,
  isValidJoinCode,
  normalizePhone,
  validateRegistration,
  renderJoinForm,
  renderJoinThanks,
  renderJoinClosed,
} = require('../src/utils/registrationForm');

const now = new Date(2026, 10, 20);
const good = {
  playerName: 'يوسف محمد علي',
  birthDate: '2015-03-10',
  sport: 'كرة سلة',
  parentName: 'محمد علي',
  parentRelationship: 'أب',
  parentPhone: '010 1234 5678',
  playerPhone: '',
  notes: 'لعب قبل كده',
  consent: 'on',
};

test('join codes are 8 unambiguous lowercase chars', () => {
  const c = newJoinCode();
  assert.ok(isValidJoinCode(c));
  assert.ok(!/[o0l1i]/.test(c));
  assert.ok(!isValidJoinCode('ABC12345'));
  assert.ok(!isValidJoinCode('short'));
  assert.ok(!isValidJoinCode(undefined));
});

test('phones keep digits only and accept Arabic numerals', () => {
  assert.strictEqual(normalizePhone('010 1234-5678'), '01012345678');
  assert.strictEqual(normalizePhone('٠١٠١٢٣٤٥٦٧٨'), '01012345678');
  assert.strictEqual(normalizePhone('+20 101 234 5678'), '+201012345678');
});

test('valid submission produces clean data', () => {
  const r = validateRegistration(good, { sports: ['كرة سلة', 'سباحة'], now });
  assert.ok(!r.errors, JSON.stringify(r.errors));
  assert.strictEqual(r.data.parentPhone, '01012345678');
  assert.strictEqual(r.data.sport, 'كرة سلة');
  assert.deepStrictEqual(r.data.birthDate, new Date(2015, 2, 10));
});

test('single-sport academies get the sport automatically', () => {
  const r = validateRegistration({ ...good, sport: '' }, { sports: ['كرة قدم'], now });
  assert.strictEqual(r.data.sport, 'كرة قدم');
});

test('validation errors are reported per field', () => {
  const r = validateRegistration({
    playerName: 'ع', birthDate: '2030-01-01', sport: 'شطرنج', parentName: '',
    parentRelationship: 'جار', parentPhone: '123', playerPhone: '12', notes: 'x'.repeat(501),
  }, { sports: ['كرة سلة', 'سباحة'], now });
  assert.deepStrictEqual(Object.keys(r.errors).sort(), [
    'birthDate', 'consent', 'notes', 'parentName', 'parentPhone', 'parentRelationship', 'playerName', 'playerPhone', 'sport',
  ].sort());
  assert.strictEqual(r.values.playerName, 'ع'); // values kept for re-render
  assert.ok(validateRegistration({ ...good, birthDate: '2015-02-30' }, { sports: [], now }).errors.birthDate);
});

test('pages escape academy and user content', () => {
  const academy = { name: 'أكاديمية <script>x</script>', logo_url: '', phone: '01000000000' };
  const form = renderJoinForm({
    academy, sports: ['كرة سلة', 'سباحة'], welcomeMessage: 'أهلاً "بكم"',
    errors: { playerName: 'خطأ' }, values: { playerName: '<b>علي</b>', sport: 'سباحة' },
  });
  assert.ok(!form.includes('<script>x'));
  assert.ok(form.includes('&lt;b&gt;علي&lt;/b&gt;'));
  assert.ok(form.includes('<option value="سباحة" selected>'));
  assert.ok(form.includes('name="website"')); // honeypot
  assert.ok(form.includes('method="post"'));
  const thanks = renderJoinThanks({ academy, playerName: 'علي' });
  assert.ok(thanks.includes('https://wa.me/201000000000'));
  assert.match(renderJoinClosed('أكاديمية'), /غير متاح/);
});
