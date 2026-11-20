/**
 * تقرير الأرباح والخسائر — دوال نقية (بدون قاعدة بيانات) لتسهيل الاختبار.
 *
 * القواعد (أساس نقدي — لما الفلوس تتحرك فعلاً):
 *  - إيراد الاشتراكات = الدفعات بتاريخ الدفع (القديم = كامل المبلغ يوم الإنشاء).
 *  - رسوم المباريات = مدفوعات المباريات المضافة للإيرادات بتاريخ الدفع.
 *  - مبيعات المتجر = الطلبات "المكتملة" بتاريخ آخر تحديث للطلب.
 *  - المصروفات = بتاريخ المصروف.
 *  - الرواتب = المصروفة فعلاً بتاريخ الصرف (المستحقة غير المصروفة تُعرض للمعلومة فقط).
 */

const { round2 } = require('./subscriptionPayments');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 3 * 366;
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');
const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMonthStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const startOfDay = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
};
const endOfDay = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
};

/**
 * يقرأ الفترة من الاستعلام. غياب from/to ⇒ الشهر الحالي.
 * يرجّع { error } أو { fromStr, toStr, from, to, days }.
 */
function parseRange(rawFrom, rawTo, now = new Date()) {
  const fromStr = rawFrom || toDateStr(new Date(now.getFullYear(), now.getMonth(), 1));
  const toStr = rawTo || toDateStr(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  if (!DATE_RE.test(fromStr) || !DATE_RE.test(toStr)) {
    return { error: 'صيغة التاريخ غير صحيحة (YYYY-MM-DD)' };
  }
  const from = startOfDay(fromStr);
  const to = endOfDay(toStr);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: 'تاريخ غير صحيح' };
  }
  if (from > to) return { error: 'تاريخ البداية بعد تاريخ النهاية' };
  const days = Math.round((startOfDay(toStr) - from) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) return { error: 'الفترة طويلة جداً (الحد 3 سنوات)' };
  return { fromStr, toStr, from, to, days };
}

/**
 * الفترة السابقة للمقارنة:
 *  - فترة = شهور كاملة (من أول شهر لآخر شهر) ⇒ نفس عدد الشهور الكاملة قبلها
 *    (نوفمبر ⇒ أكتوبر كاملاً، الربع ⇒ الربع السابق، السنة ⇒ السنة السابقة).
 *  - غير ذلك ⇒ نفس عدد الأيام مباشرة قبلها.
 */
function previousRange(range) {
  const fromD = range.from;
  const toD = startOfDay(range.toStr);
  const isMonthStart = fromD.getDate() === 1;
  const isMonthEnd = new Date(toD.getFullYear(), toD.getMonth(), toD.getDate() + 1).getDate() === 1;
  if (isMonthStart && isMonthEnd) {
    const months = (toD.getFullYear() * 12 + toD.getMonth()) - (fromD.getFullYear() * 12 + fromD.getMonth()) + 1;
    const prevFrom = new Date(fromD.getFullYear(), fromD.getMonth() - months, 1);
    const prevTo = new Date(fromD.getFullYear(), fromD.getMonth(), 0);
    return parseRange(toDateStr(prevFrom), toDateStr(prevTo));
  }
  const prevTo = new Date(range.from.getTime() - DAY_MS);
  const prevFrom = new Date(prevTo.getFullYear(), prevTo.getMonth(), prevTo.getDate() - (range.days - 1));
  return parseRange(toDateStr(prevFrom), toDateStr(prevTo));
}

/** مفاتيح آخر n شهر تنتهي بشهر "إلى" — 'YYYY-MM' بالترتيب. */
function monthKeys(toStr, n = 12) {
  const [y, m] = toStr.split('-').map(Number);
  const keys = [];
  for (let i = n - 1; i >= 0; i--) keys.push(toMonthStr(new Date(y, m - 1 - i, 1)));
  return keys;
}

/** أول يوم في أقدم شهر من monthKeys (لبداية نافذة الرسم البياني). */
const windowStart = (keys) => startOfDay(`${keys[0]}-01`);

/** نسبة التغيّر % (null لو الفترة السابقة صفر). */
function changePct(current, previous) {
  if (!previous) return null;
  return round2(((current - previous) / Math.abs(previous)) * 100);
}

/**
 * يجمع البنود في ملخص الأرباح والخسائر.
 * expensesByCategory: { rent: 100, ... }
 */
function summarize({ subscriptions = 0, matches = 0, store = 0, expensesByCategory = {}, payrollPaid = 0 }) {
  const revenueTotal = round2(subscriptions + matches + store);
  const expensesTotal = round2(Object.values(expensesByCategory).reduce((s, v) => s + (Number(v) || 0), 0));
  const costsTotal = round2(expensesTotal + payrollPaid);
  const netProfit = round2(revenueTotal - costsTotal);
  return {
    revenue: {
      subscriptions: round2(subscriptions),
      matches: round2(matches),
      store: round2(store),
      total: revenueTotal,
    },
    expenses: {
      byCategory: Object.fromEntries(
        Object.entries(expensesByCategory).map(([k, v]) => [k, round2(v)])
      ),
      total: expensesTotal,
    },
    payroll: { paid: round2(payrollPaid) },
    costsTotal,
    netProfit,
    margin: revenueTotal > 0 ? round2((netProfit / revenueTotal) * 100) : null,
  };
}

/**
 * يدمج صفوف تجميع شهرية من مصادر متعددة في سلسلة 12 شهر.
 * revenue/costs: قائمة من مصفوفات صفوف { _id: 'YYYY-MM', total }.
 */
function buildMonthlySeries(keys, { revenue = [], costs = [] }) {
  const sumBy = (rowsList) => {
    const map = {};
    for (const rows of rowsList) {
      for (const r of rows || []) {
        if (!r || !r._id) continue;
        map[r._id] = (map[r._id] || 0) + (Number(r.total) || 0);
      }
    }
    return map;
  };
  const rev = sumBy(revenue);
  const cost = sumBy(costs);
  return keys.map((month) => {
    const revenueTotal = round2(rev[month] || 0);
    const costsTotal = round2(cost[month] || 0);
    return { month, revenue: revenueTotal, costs: costsTotal, profit: round2(revenueTotal - costsTotal) };
  });
}

module.exports = {
  parseRange,
  previousRange,
  monthKeys,
  windowStart,
  changePct,
  summarize,
  buildMonthlySeries,
  toMonthStr,
};
