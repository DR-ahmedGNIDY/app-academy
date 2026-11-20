/**
 * قوالب إحصائيات المباريات لكل رياضة — مصدر واحد للحقيقة (الواجهة تبني
 * شاشاتها منه عبر GET /match-stats/templates).
 *
 * kind: count (عدد صحيح ≥0) | percent (0–100) | bool | time (نص قصير مثل 1:05.32)
 *       | select (من options)
 * agg:  sum (المجموع والمتوسط في ملف اللاعب) | avg (المتوسط فقط)
 * leader: يظهر في ترتيب الأكاديمية.
 */

const count = (key, label, extra = {}) => ({ key, label, kind: 'count', agg: 'sum', ...extra });
const percent = (key, label) => ({ key, label, kind: 'percent', agg: 'avg', leader: true });

const INDIVIDUAL_FIELDS = [
  percent('attack', 'الهجوم'),
  percent('defense', 'الدفاع'),
  percent('fitness', 'اللياقة والتحمل'),
  percent('tactics', 'التكتيك والذكاء'),
  percent('spirit', 'الانضباط والروح القتالية'),
  {
    key: 'outcome', label: 'النتيجة', kind: 'select', agg: 'tally',
    options: [
      { value: 'win', label: 'فوز' },
      { value: 'loss', label: 'خسارة' },
      { value: 'draw', label: 'تعادل' },
    ],
  },
  {
    key: 'method', label: 'طريقة النتيجة', kind: 'select', agg: 'none',
    options: [
      { value: 'points', label: 'بالنقاط' },
      { value: 'ko', label: 'بالضربة القاضية' },
      { value: 'submission', label: 'بالاستسلام/الإيقاف' },
      { value: 'decision', label: 'بقرار الحكام' },
      { value: 'other', label: 'أخرى' },
    ],
  },
];

const TIMED_EXTRA = [{ key: 'time', label: 'الزمن / الرقم', kind: 'time', agg: 'none' }];

const TEMPLATES = {
  basketball: {
    key: 'basketball', type: 'team', label: 'كرة سلة',
    fields: [
      count('points', 'نقاط', { leader: true }),
      count('rebounds', 'ريباوند', { leader: true }),
      count('assists', 'أسيست', { leader: true }),
      count('steals', 'سرقات', { leader: true }),
      count('blocks', 'بلوكات', { leader: true }),
      count('threes', 'ثلاثيات', { leader: true }),
      count('fouls', 'أخطاء شخصية'),
      count('minutes', 'دقائق لعب'),
    ],
  },
  football: {
    key: 'football', type: 'team', label: 'كرة قدم',
    fields: [
      count('goals', 'أهداف', { leader: true }),
      count('assists', 'أسيست', { leader: true }),
      count('shotsOnTarget', 'تسديدات على المرمى', { leader: true }),
      count('minutes', 'دقائق لعب'),
      count('yellowCards', 'كروت صفراء'),
      count('redCards', 'كروت حمراء'),
      count('saves', 'تصديات (حارس)', { leader: true }),
      { key: 'cleanSheet', label: 'شباك نظيفة', kind: 'bool', agg: 'sum', leader: true },
    ],
  },
  volleyball: {
    key: 'volleyball', type: 'team', label: 'كرة طائرة',
    fields: [
      count('points', 'نقاط', { leader: true }),
      count('kills', 'ضربات ساحقة', { leader: true }),
      count('aces', 'إرسال ساحق', { leader: true }),
      count('blocks', 'بلوكات', { leader: true }),
      count('receptions', 'استقبال ناجح', { leader: true }),
      count('errors', 'أخطاء'),
    ],
  },
  handball: {
    key: 'handball', type: 'team', label: 'كرة يد',
    fields: [
      count('goals', 'أهداف', { leader: true }),
      count('shots', 'تسديدات'),
      count('assists', 'أسيست', { leader: true }),
      count('saves', 'تصديات (حارس)', { leader: true }),
      count('suspensions', 'إيقاف دقيقتين'),
      count('cards', 'كروت'),
    ],
  },
  individual: {
    key: 'individual', type: 'individual', label: 'رياضة فردية',
    fields: INDIVIDUAL_FIELDS,
  },
  timed: {
    key: 'timed', type: 'individual', label: 'رياضة بالزمن',
    fields: [...INDIVIDUAL_FIELDS.filter((f) => f.key !== 'method'), ...TIMED_EXTRA],
  },
};

// أسماء الرياضات (نصوص عربية حرة) → القالب. غير المعروف ⇒ فردي.
const SPORT_MAP = {
  'كرة سلة': 'basketball',
  'كرة قدم': 'football',
  'كرة طائرة': 'volleyball',
  'كرة يد': 'handball',
  'سباحة': 'timed',
  'جري': 'timed',
  'ألعاب قوى': 'timed',
};

const normalizeSport = (s) => String(s || '').trim().replace(/\s+/g, ' ');

function templateForSport(sport) {
  const key = SPORT_MAP[normalizeSport(sport)] || 'individual';
  return { ...TEMPLATES[key], sport: normalizeSport(sport) || TEMPLATES[key].label };
}

const clampInt = (v, min, max) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
};

/**
 * ينظّف إحصائيات لاعب حسب القالب: يتجاهل المفاتيح غير المعروفة والقيم
 * الفارغة، ويقصّ الأرقام لحدودها. يرجّع كائن نظيف (قد يكون فارغاً).
 */
function sanitizeStats(template, input) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const f of template.fields) {
    const raw = src[f.key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (f.kind === 'count') {
      const n = clampInt(raw, 0, 999);
      if (n !== null) out[f.key] = n;
    } else if (f.kind === 'percent') {
      const n = clampInt(raw, 0, 100);
      if (n !== null) out[f.key] = n;
    } else if (f.kind === 'bool') {
      out[f.key] = raw === true || raw === 'true' || raw === 1 || raw === '1';
    } else if (f.kind === 'time') {
      const s = String(raw).trim().slice(0, 20);
      if (s) out[f.key] = s;
    } else if (f.kind === 'select') {
      if (f.options.some((o) => o.value === raw)) out[f.key] = raw;
    }
  }
  return out;
}

/** تقييم من 10 بخطوة نصف (null لو فارغ). */
function sanitizeRating(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(10, Math.max(0, Math.round(n * 2) / 2));
}

/**
 * ملخص موسم لاعب من قائمة صفوف إحصائياته (كل صف: { stats, rating, mvp }).
 * count/bool ⇒ total + avg ؛ percent ⇒ avg ؛ select(tally) ⇒ عدّ القيم.
 */
function summarizePlayerStats(template, rows) {
  const n = rows.length;
  const fields = {};
  for (const f of template.fields) {
    if (f.agg === 'none') continue;
    if (f.kind === 'select') {
      const tally = {};
      for (const r of rows) {
        const v = r.stats?.[f.key];
        if (v) tally[v] = (tally[v] || 0) + 1;
      }
      fields[f.key] = { tally };
      continue;
    }
    const vals = rows
      .map((r) => r.stats?.[f.key])
      .filter((v) => v !== undefined && v !== null)
      .map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : Number(v)));
    const total = vals.reduce((s, v) => s + v, 0);
    const avg = vals.length ? Math.round((total / vals.length) * 10) / 10 : null;
    fields[f.key] = f.agg === 'avg' ? { avg } : { total, avg };
  }
  const ratings = rows.map((r) => r.rating).filter((v) => typeof v === 'number');
  return {
    matches: n,
    mvpCount: rows.filter((r) => r.mvp).length,
    avgRating: ratings.length ? Math.round((ratings.reduce((s, v) => s + v, 0) / ratings.length) * 10) / 10 : null,
    fields,
  };
}

module.exports = {
  TEMPLATES,
  SPORT_MAP,
  templateForSport,
  sanitizeStats,
  sanitizeRating,
  summarizePlayerStats,
};
