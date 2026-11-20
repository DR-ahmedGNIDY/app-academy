/**
 * مشاركة صورة الإيصال برابط عام (واتساب يعرض معاينة الصورة).
 *
 * - الصورة تُولَّد على جهاز المدير وتُرفع لـ Cloudinary (السيرفر لا يرسم صوراً).
 * - الرابط: https://<api-host>/r/<token> — token عشوائي 32 حرفاً (192 بت) غير قابل للتخمين.
 * - الصلاحية 60 يوماً؛ مهمة دورية تحذف الصورة من Cloudinary وتمسح الرابط بعدها.
 */

const crypto = require('crypto');

const SHARE_TTL_DAYS = 60;
const SHARE_TTL_MS = SHARE_TTL_DAYS * 24 * 60 * 60 * 1000;
const RECEIPTS_FOLDER = 'basketball_academy/receipts';
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

const CURRENCY_LABELS = {
  EGP: 'جنيه', SAR: 'ريال', AED: 'درهم', KWD: 'دينار', QAR: 'ريال',
  BHD: 'دينار', OMR: 'ريال', JOD: 'دينار', USD: 'دولار', EUR: 'يورو',
};

/** token عشوائي آمن (base64url، 32 حرفاً). */
const newShareToken = () => crypto.randomBytes(24).toString('base64url');

const isValidToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);

/** رابط المشاركة العام — يُشتق من نطاق الطلب (خلف nginx مع trust proxy). */
const shareUrlFor = (req, token) => `${req.protocol}://${req.get('host')}/r/${token}`;

/** هل للدفعة رابط مشاركة صالح الآن؟ */
const hasValidShare = (payment, now = new Date()) =>
  Boolean(payment && payment.shareToken && payment.shareImageUrl &&
    payment.shareExpiresAt && new Date(payment.shareExpiresAt) > now);

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const money = (v) => {
  const n = Math.round((Number(v) || 0) * 100) / 100;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

const fmtDate = (d) => {
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
};

/** سياسة أمان خاصة بصفحة الإيصال: صور Cloudinary فقط، بلا سكربتات. */
const RECEIPT_PAGE_CSP =
  "default-src 'none'; img-src https://res.cloudinary.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const pageShell = (head, body) => `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${head}
<style>
  body{margin:0;background:#f3f4f6;font-family:Tahoma,Arial,sans-serif;color:#1a2b4a}
  main{max-width:560px;margin:0 auto;padding:16px}
  .card{background:#fff;border-radius:14px;padding:16px;box-shadow:0 2px 10px rgba(0,0,0,.06)}
  h1{font-size:18px;margin:0 0 4px}
  p{margin:4px 0;color:#4b5563;font-size:14px}
  img{width:100%;height:auto;border-radius:10px;margin-top:12px;border:1px solid #e5e7eb}
  .muted{color:#9ca3af;font-size:12px;margin-top:10px}
  a.btn{display:inline-block;margin-top:12px;background:#e85d04;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;font-size:14px}
</style>
</head>
<body><main>${body}</main></body>
</html>`;

/** صفحة الإيصال مع وسوم Open Graph لمعاينة واتساب. */
function renderReceiptPage({ academyName, playerName, amount, currency, date, receiptNoLabel, imageUrl, expiresAt }) {
  const cur = CURRENCY_LABELS[currency] || currency || '';
  const title = `إيصال دفع${receiptNoLabel ? ` رقم ${receiptNoLabel}` : ''} — ${academyName || ''}`.trim();
  const desc = `${playerName || ''} — ${money(amount)} ${cur} — ${fmtDate(date)}`;
  const head = `
<title>${escapeHtml(title)}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:image" content="${escapeHtml(imageUrl)}">
<meta property="og:image:alt" content="${escapeHtml(title)}">
<meta name="twitter:card" content="summary_large_image">`;
  const body = `
<div class="card">
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(desc)}</p>
  <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}">
  <a class="btn" href="${escapeHtml(imageUrl)}" download>تحميل صورة الإيصال</a>
  <p class="muted">هذا الرابط صالح حتى ${escapeHtml(fmtDate(expiresAt))}.</p>
</div>`;
  return pageShell(head, body);
}

/** صفحة رابط منتهٍ أو غير موجود. */
function renderExpiredPage() {
  return pageShell(
    '<title>رابط الإيصال غير متاح</title>',
    `<div class="card">
  <h1>رابط الإيصال غير متاح</h1>
  <p>انتهت صلاحية هذا الرابط أو أنه غير صحيح.</p>
  <p>يمكنك طلب الإيصال من الأكاديمية، أو مشاهدته من "إيصالاتي" في تطبيق اللاعب.</p>
</div>`
  );
}

/** يمسح حقول المشاركة من دفعة (بعد حذف الصورة). */
function clearShare(payment) {
  payment.shareToken = undefined;
  payment.shareImageUrl = undefined;
  payment.shareImagePublicId = undefined;
  payment.shareExpiresAt = undefined;
}

module.exports = {
  SHARE_TTL_DAYS,
  SHARE_TTL_MS,
  RECEIPTS_FOLDER,
  RECEIPT_PAGE_CSP,
  newShareToken,
  isValidToken,
  shareUrlFor,
  hasValidShare,
  escapeHtml,
  renderReceiptPage,
  renderExpiredPage,
  clearShare,
};
