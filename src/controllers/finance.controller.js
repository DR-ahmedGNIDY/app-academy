const mongoose = require('mongoose');
const Subscription = require('../models/subscription.model');
const Match = require('../models/match.model');
const StoreOrder = require('../models/storeOrder.model');
const Expense = require('../models/expense.model');
const Payroll = require('../models/payroll.model');
const AppError = require('../utils/AppError');
const { sendSuccess } = require('../utils/apiResponse');
const { matchRevenueTotal } = require('../utils/matchRevenue');
const { unwindPaymentsStages, round2 } = require('../utils/subscriptionPayments');
const {
  parseRange,
  previousRange,
  monthKeys,
  windowStart,
  changePct,
  summarize,
  buildMonthlySeries,
  toMonthStr,
} = require('../utils/profitLoss');

// المنطقة الزمنية للسيرفر — نفس التي تُبنى بها حدود الفترات (new Date(y,m,d)).
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const monthOf = (field) => ({ $dateToString: { format: '%Y-%m', date: field, timezone: TZ } });

/** super_admin يمرّر academyId؛ غيره مُقيَّد بأكاديميته (القاعدة الموحّدة). */
function resolveAcademyId(req) {
  if (req.user.role === 'super_admin') return req.query.academyId || null;
  return req.user.academyId?.toString() || null;
}

const sumRows = (rows) => round2((rows || []).reduce((s, r) => s + (Number(r.total) || 0), 0));

/** كل أرقام فترة واحدة. */
async function periodFigures(academyId, range, { detailed = false } = {}) {
  const acad = { academyId };
  const between = { $gte: range.from, $lte: range.to };

  const [subsByMethod, matches, storeRows, expenseRows, payrollPaidRows, payrollPendingRows] =
    await Promise.all([
      Subscription.aggregate([
        { $match: acad },
        ...unwindPaymentsStages(),
        { $match: { '_pay.date': between } },
        { $group: { _id: { $ifNull: ['$_pay.method', 'cash'] }, total: { $sum: '$_pay.amount' } } },
      ]),
      matchRevenueTotal({ academyMatch: acad, from: range.from, to: range.to }),
      StoreOrder.aggregate([
        { $match: { ...acad, status: 'completed', updated_at: between } },
        { $group: { _id: null, total: { $sum: '$price' } } },
      ]),
      Expense.aggregate([
        { $match: { ...acad, date: { $gte: range.fromStr, $lte: range.toStr } } },
        { $group: { _id: '$category', total: { $sum: '$amount' } } },
      ]),
      Payroll.aggregate([
        { $match: { ...acad, status: 'paid', paidAt: between } },
        { $group: { _id: null, total: { $sum: '$netSalary' } } },
      ]),
      detailed
        ? Payroll.aggregate([
          {
            $match: {
              ...acad,
              status: 'pending',
              month: { $gte: toMonthStr(range.from), $lte: toMonthStr(range.to) },
            },
          },
          { $group: { _id: null, total: { $sum: '$netSalary' } } },
        ])
        : Promise.resolve([]),
    ]);

  const expensesByCategory = {};
  for (const r of expenseRows) expensesByCategory[r._id || 'other'] = r.total;

  const summary = summarize({
    subscriptions: sumRows(subsByMethod),
    matches,
    store: sumRows(storeRows),
    expensesByCategory,
    payrollPaid: sumRows(payrollPaidRows),
  });

  if (!detailed) return summary;

  const cashbox = {};
  for (const r of subsByMethod) cashbox[r._id] = round2(r.total);
  summary.cashbox = cashbox;
  summary.payroll.pendingDue = sumRows(payrollPendingRows);
  return summary;
}

/** سلسلة آخر 12 شهر (إيرادات/تكاليف/ربح) تنتهي بشهر نهاية الفترة. */
async function monthlySeries(academyId, range) {
  const keys = monthKeys(range.toStr, 12);
  const start = windowStart(keys);
  const between = { $gte: start, $lte: range.to };
  const acad = { academyId };

  const [subs, matches, store, expenses, payroll] = await Promise.all([
    Subscription.aggregate([
      { $match: acad },
      ...unwindPaymentsStages(),
      { $match: { '_pay.date': between } },
      { $group: { _id: monthOf('$_pay.date'), total: { $sum: '$_pay.amount' } } },
    ]),
    Match.aggregate([
      { $match: { ...acad, addToRevenue: true } },
      { $unwind: '$payments' },
      { $match: { 'payments.paidAt': between } },
      { $group: { _id: monthOf('$payments.paidAt'), total: { $sum: '$payments.amount' } } },
    ]),
    StoreOrder.aggregate([
      { $match: { ...acad, status: 'completed', updated_at: between } },
      { $group: { _id: monthOf('$updated_at'), total: { $sum: '$price' } } },
    ]),
    Expense.aggregate([
      { $match: { ...acad, date: { $gte: `${keys[0]}-01`, $lte: range.toStr } } },
      { $group: { _id: { $substrBytes: ['$date', 0, 7] }, total: { $sum: '$amount' } } },
    ]),
    Payroll.aggregate([
      { $match: { ...acad, status: 'paid', paidAt: between } },
      { $group: { _id: monthOf('$paidAt'), total: { $sum: '$netSalary' } } },
    ]),
  ]);

  return buildMonthlySeries(keys, {
    revenue: [subs, matches, store],
    costs: [expenses, payroll],
  });
}

// ─── GET /finance/profit-loss?from=YYYY-MM-DD&to=YYYY-MM-DD ─────────────────
const getProfitLoss = async (req, res, next) => {
  const academyId = resolveAcademyId(req);
  if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  if (!mongoose.Types.ObjectId.isValid(academyId)) {
    return next(new AppError('معرّف الأكاديمية غير صحيح', 400));
  }

  const range = parseRange(req.query.from, req.query.to);
  if (range.error) return next(new AppError(range.error, 400));
  const prev = previousRange(range);

  const academyOid = new mongoose.Types.ObjectId(academyId);
  const [current, previous, monthly] = await Promise.all([
    periodFigures(academyOid, range, { detailed: true }),
    periodFigures(academyOid, prev),
    monthlySeries(academyOid, range),
  ]);

  const warnings = [];
  if ((current.expenses.byCategory.salaries || 0) > 0 && current.payroll.paid > 0) {
    // رواتب مسجّلة كمصروف + كشف مرتبات مصروف في نفس الفترة ⇒ احتمال تكرار.
    warnings.push('salaries_double_count');
  }

  return sendSuccess(res, {
    message: 'تم جلب تقرير الأرباح والخسائر',
    data: {
      period: { from: range.fromStr, to: range.toStr, days: range.days },
      ...current,
      previous: {
        period: { from: prev.fromStr, to: prev.toStr },
        revenueTotal: previous.revenue.total,
        costsTotal: previous.costsTotal,
        netProfit: previous.netProfit,
      },
      change: {
        revenue: changePct(current.revenue.total, previous.revenue.total),
        costs: changePct(current.costsTotal, previous.costsTotal),
        netProfit: changePct(current.netProfit, previous.netProfit),
      },
      monthly,
      warnings,
    },
  });
};

module.exports = { getProfitLoss };
