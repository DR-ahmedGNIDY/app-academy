/**
 * الفورم الأونلاين العام لتسجيل لاعب (/join/:code) — صفحات HTML خفيفة يرسمها
 * السيرفر (بدون تطبيق الويب الثقيل) + التحقق من المدخلات (دوال نقية).
 */

const crypto = require('crypto');

const RELATIONSHIPS = ['أب', 'أم', 'أخ', 'أخت', 'جد', 'جدة', 'عم', 'خال', 'ولي أمر آخر', 'اللاعب نفسه'];
const CODE_RE = /^[a-z0-9]{8}$/;

/** كود فورم عشوائي (8 حروف/أرقام صغيرة — سهل الكتابة والطباعة). */
function newJoinCode() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // بدون حروف ملتبسة (o/0, l/1, i)
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const isValidJoinCode = (c) => typeof c === 'string' && CODE_RE.test(c);

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** أرقام فقط (يقبل أرقاماً عربية ٠-٩) + "+" في البداية. */
function normalizePhone(raw) {
  const western = String(raw ?? '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const trimmed = western.trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  return plus + trimmed.replace(/\D/g, '');
}

/**
 * يتحقق من بيانات الفورم. sports = رياضات الفورم المسموحة.
 * يرجّع { data } أو { errors: { field: message }, values }.
 */
function validateRegistration(body, { sports = [], now = new Date() } = {}) {
  const v = (k) => String(body?.[k] ?? '').trim();
  const values = {
    playerName: v('playerName'),
    birthDate: v('birthDate'),
    sport: v('sport'),
    parentName: v('parentName'),
    parentRelationship: v('parentRelationship'),
    parentPhone: v('parentPhone'),
    playerPhone: v('playerPhone'),
    notes: v('notes'),
    consent: body?.consent === 'on' || body?.consent === true || body?.consent === 'true',
  };
  const errors = {};

  if (values.playerName.length < 3) errors.playerName = 'اكتب اسم اللاعب بالكامل';
  else if (values.playerName.length > 100) errors.playerName = 'الاسم طويل جداً';

  let birth = null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.birthDate)) {
    errors.birthDate = 'اختر تاريخ الميلاد';
  } else {
    const [y, m, d] = values.birthDate.split('-').map(Number);
    birth = new Date(y, m - 1, d);
    const age = (now - birth) / (365.25 * 24 * 3600 * 1000);
    if (Number.isNaN(birth.getTime()) || birth.getMonth() !== m - 1) errors.birthDate = 'تاريخ الميلاد غير صحيح';
    else if (age < 2 || age > 70) errors.birthDate = 'تاريخ الميلاد غير منطقي';
  }

  if (sports.length > 1 && !sports.includes(values.sport)) errors.sport = 'اختر الرياضة';
  if (sports.length === 1) values.sport = sports[0];

  if (values.parentName.length < 3) errors.parentName = 'اكتب اسم ولي الأمر';
  else if (values.parentName.length > 100) errors.parentName = 'الاسم طويل جداً';
  if (!RELATIONSHIPS.includes(values.parentRelationship)) errors.parentRelationship = 'اختر صلة القرابة';

  const parentPhone = normalizePhone(values.parentPhone);
  const digits = parentPhone.replace('+', '');
  if (digits.length < 8 || digits.length > 15) errors.parentPhone = 'رقم الموبايل غير صحيح';
  const playerPhone = values.playerPhone ? normalizePhone(values.playerPhone) : '';
  if (playerPhone && (playerPhone.replace('+', '').length < 8 || playerPhone.length > 16)) {
    errors.playerPhone = 'رقم موبايل اللاعب غير صحيح';
  }
  if (values.notes.length > 500) errors.notes = 'الملاحظات طويلة جداً';
  if (!values.consent) errors.consent = 'لازم توافق على استخدام البيانات للتواصل معاك';

  if (Object.keys(errors).length) return { errors, values };
  return {
    data: {
      playerName: values.playerName,
      birthDate: birth,
      sport: values.sport,
      parentName: values.parentName,
      parentRelationship: values.parentRelationship,
      parentPhone,
      playerPhone,
      notes: values.notes,
    },
  };
}

/** سياسة أمان صفحة الفورم: بلا سكربتات، الإرسال لنفس السيرفر، لوجو من Cloudinary. */
const JOIN_PAGE_CSP =
  "default-src 'none'; img-src https://res.cloudinary.com data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const shell = (title, body) => `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<meta property="og:title" content="${escapeHtml(title)}">
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#f3f4f6;font-family:Tahoma,Arial,sans-serif;color:#1a2b4a}
  main{max-width:520px;margin:0 auto;padding:16px}
  .card{background:#fff;border-radius:16px;padding:18px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
  .head{display:flex;align-items:center;gap:12px;margin-bottom:6px}
  .head img{width:56px;height:56px;border-radius:12px;object-fit:cover}
  h1{font-size:19px;margin:0}
  .sub{color:#6b7280;font-size:13px;margin:2px 0 0}
  .msg{background:#fff7ed;border-radius:10px;padding:10px;font-size:14px;margin:12px 0;white-space:pre-line}
  label{display:block;font-size:14px;font-weight:bold;margin:14px 0 6px}
  .opt{color:#9ca3af;font-weight:normal}
  input,select,textarea{width:100%;padding:12px;border:1px solid #d1d5db;border-radius:10px;font-size:16px;font-family:inherit;background:#fff}
  textarea{min-height:80px}
  .err{color:#dc2626;font-size:13px;margin-top:4px}
  .consent{display:flex;gap:8px;align-items:flex-start;margin-top:16px;font-size:13px;color:#4b5563}
  .consent input{width:auto;margin-top:2px}
  button{width:100%;margin-top:18px;padding:14px;border:0;border-radius:12px;background:#e85d04;color:#fff;font-size:17px;font-weight:bold}
  .hp{position:absolute;left:-9999px;top:-9999px}
  .ok{text-align:center;padding:10px 0}
  .ok .big{font-size:52px}
  a.wa{display:inline-block;margin-top:14px;background:#25d366;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:bold}
  .foot{text-align:center;color:#9ca3af;font-size:12px;margin-top:14px}
</style>
</head>
<body><main>${body}<p class="foot">Nosait</p></main></body>
</html>`;

const header = (academy) => `
  <div class="head">
    ${academy.logo_url ? `<img src="${escapeHtml(academy.logo_url)}" alt="">` : ''}
    <div>
      <h1>${escapeHtml(academy.name)}</h1>
      <p class="sub">طلب تسجيل لاعب جديد</p>
    </div>
  </div>`;

/** صفحة الفورم (مع الأخطاء والقيم السابقة عند إعادة العرض). */
function renderJoinForm({ academy, sports = [], welcomeMessage = '', errors = {}, values = {} }) {
  const val = (k) => escapeHtml(values[k] ?? '');
  const err = (k) => (errors[k] ? `<div class="err">${escapeHtml(errors[k])}</div>` : '');
  const sportField = sports.length > 1
    ? `<label for="sport">الرياضة</label>
       <select id="sport" name="sport" required>
         <option value="">اختر الرياضة</option>
         ${sports.map((s) => `<option value="${escapeHtml(s)}"${values.sport === s ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('')}
       </select>${err('sport')}`
    : '';
  const relField = `<select id="parentRelationship" name="parentRelationship" required>
      <option value="">اختر</option>
      ${RELATIONSHIPS.map((r) => `<option value="${escapeHtml(r)}"${values.parentRelationship === r ? ' selected' : ''}>${escapeHtml(r)}</option>`).join('')}
    </select>`;
  const body = `<div class="card">
  ${header(academy)}
  ${welcomeMessage ? `<div class="msg">${escapeHtml(welcomeMessage)}</div>` : ''}
  <form method="post" novalidate>
    <label for="playerName">اسم اللاعب بالكامل</label>
    <input id="playerName" name="playerName" value="${val('playerName')}" maxlength="100" required autocomplete="off">${err('playerName')}
    <label for="birthDate">تاريخ الميلاد</label>
    <input id="birthDate" name="birthDate" type="date" value="${val('birthDate')}" required>${err('birthDate')}
    ${sportField}
    <label for="parentName">اسم ولي الأمر</label>
    <input id="parentName" name="parentName" value="${val('parentName')}" maxlength="100" required>${err('parentName')}
    <label for="parentRelationship">صلة القرابة</label>
    ${relField}${err('parentRelationship')}
    <label for="parentPhone">موبايل ولي الأمر (واتساب)</label>
    <input id="parentPhone" name="parentPhone" type="tel" inputmode="tel" value="${val('parentPhone')}" maxlength="20" required>${err('parentPhone')}
    <label for="playerPhone">موبايل اللاعب <span class="opt">(اختياري)</span></label>
    <input id="playerPhone" name="playerPhone" type="tel" inputmode="tel" value="${val('playerPhone')}" maxlength="20">${err('playerPhone')}
    <label for="notes">ملاحظات <span class="opt">(اختياري — خبرة سابقة، مواعيد مناسبة…)</span></label>
    <textarea id="notes" name="notes" maxlength="500">${val('notes')}</textarea>${err('notes')}
    <div class="hp" aria-hidden="true"><label for="website">اترك هذا الحقل فارغاً</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
    <div class="consent"><input id="consent" name="consent" type="checkbox"${values.consent ? ' checked' : ''}><label for="consent" style="margin:0;font-weight:normal">أوافق على استخدام البيانات دي من الأكاديمية للتواصل معايا بخصوص التسجيل.</label></div>${err('consent')}
    <button type="submit">إرسال الطلب</button>
  </form>
</div>`;
  return shell(`تسجيل لاعب — ${academy.name}`, body);
}

/** صفحة "تم استلام طلبك" (+ زر واتساب للأكاديمية إن وُجد رقم). */
function renderJoinThanks({ academy, playerName }) {
  const wa = String(academy.phone || '').replace(/\D/g, '');
  const waNum = /^0\d{10}$/.test(wa) ? `2${wa}` : wa;
  const waLink = waNum.length >= 8
    ? `<a class="wa" href="https://wa.me/${waNum}?text=${encodeURIComponent(`السلام عليكم، سجلت طلب لـ ${playerName} في ${academy.name}`)}">تواصل مع الأكاديمية على واتساب</a>`
    : '';
  return shell(`تم استلام طلبك — ${academy.name}`, `<div class="card ok">
  ${header(academy)}
  <div class="big">✅</div>
  <h1>تم استلام طلبك</h1>
  <p class="sub">طلب تسجيل ${escapeHtml(playerName)} وصل للأكاديمية، وهيتواصلوا معاك قريب.</p>
  ${waLink}
</div>`);
}

/** صفحة الفورم مقفول أو غير موجود. */
function renderJoinClosed(academyName) {
  return shell('التسجيل غير متاح', `<div class="card ok">
  <div class="big">🔒</div>
  <h1>التسجيل الأونلاين غير متاح</h1>
  <p class="sub">${academyName ? `${escapeHtml(academyName)} مش مستقبلة طلبات أونلاين حالياً.` : 'الرابط غير صحيح أو انتهى.'} تواصل مع الأكاديمية مباشرة.</p>
</div>`);
}

module.exports = {
  RELATIONSHIPS,
  JOIN_PAGE_CSP,
  newJoinCode,
  isValidJoinCode,
  normalizePhone,
  validateRegistration,
  renderJoinForm,
  renderJoinThanks,
  renderJoinClosed,
  escapeHtml,
};
