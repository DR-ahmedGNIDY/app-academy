/**
 * الدفع الجزئي والمديونيات للاشتراكات.
 *
 * القاعدة: كل اشتراك له `amount` (المستحق) وسجل `payments` ومجموعه `paidAmount`.
 * المتبقي = amount − paidAmount.
 *
 * الاشتراكات القديمة (قبل الميزة) ليس لها paidAmount ولا payments ⇒ تُعتبر
 * مدفوعة بالكامل يوم إنشائها. لذلك كل الحسابات هنا تستخدم $ifNull بدل افتراض
 * وجود الحقول، فالأرقام القديمة لا تتغيّر حتى قبل تشغيل الـ migration.
 */

const PAYMENT_METHODS = ['cash', 'vodafone_cash', 'instapay', 'bank_transfer', 'card', 'other'];

// هامش لأخطاء الكسور العشرية (0.1 + 0.2).
const EPSILON = 0.005;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** المدفوع الفعلي — القديم بلا paidAmount يُعتبر مدفوعاً بالكامل. */
function effectivePaid(sub) {
  const paid = sub.paidAmount;
  return paid === undefined || paid === null ? round2(sub.amount) : round2(paid);
}

/** حالة الدفع والمتبقي لاشتراك واحد. */
function paymentState(sub) {
  const amount = round2(sub.amount);
  const paid = effectivePaid(sub);
  const remaining = Math.max(0, round2(amount - paid));
  let status;
  if (remaining <= EPSILON) status = 'paid';
  else if (paid <= EPSILON) status = 'unpaid';
  else status = 'partial';
  return { paidAmount: paid, remainingAmount: remaining, paymentStatus: status };
}

/**
 * يتحقّق من مبلغ دفعة جديدة مقابل المتبقي. يرجّع رسالة خطأ أو null.
 */
function validatePaymentAmount(amount, remaining) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 'مبلغ الدفعة يجب أن يكون أكبر من صفر';
  if (remaining <= EPSILON) return 'هذا الاشتراك مدفوع بالكامل';
  if (value - remaining > EPSILON) {
    return `مبلغ الدفعة أكبر من المتبقي (${round2(remaining)})`;
  }
  return null;
}

/**
 * المدفوع عند إنشاء الاشتراك: غير مُرسل ⇒ المبلغ كاملاً (توافق مع نسخ التطبيق
 * القديمة التي لا تعرف الدفع الجزئي). يرجّع { paid } أو { error }.
 */
function resolveInitialPaid(amount, rawPaid) {
  const total = round2(amount);
  if (rawPaid === undefined || rawPaid === null || rawPaid === '') return { paid: total };
  if (!Number.isFinite(Number(rawPaid))) return { error: 'المبلغ المدفوع غير صحيح' };
  const paid = round2(rawPaid);
  if (paid < 0) return { error: 'المبلغ المدفوع غير صحيح' };
  if (paid - total > EPSILON) return { error: 'المبلغ المدفوع لا يمكن أن يتجاوز مبلغ الاشتراك' };
  return { paid };
}

// ─── Aggregation helpers ─────────────────────────────────────────────────────

/** تعبير المدفوع داخل aggregation (القديم = amount). */
const PAID_EXPR = { $ifNull: ['$paidAmount', '$amount'] };

/** تعبير المتبقي داخل aggregation (لا يقل عن صفر). */
const REMAINING_EXPR = { $max: [0, { $subtract: ['$amount', PAID_EXPR] }] };

/**
 * مراحل تفكّ الدفعات: صف لكل دفعة فيه `_pay.amount` و`_pay.date`.
 * الاشتراك القديم بلا payments ⇒ دفعة واحدة بكامل المبلغ يوم الإنشاء.
 * (مصفوفة فارغة = اشتراك لم يُدفع منه شيء، فلا ينتج صفوفاً.)
 */
function unwindPaymentsStages() {
  return [
    {
      $addFields: {
        _pay: {
          $ifNull: ['$payments', [{ amount: '$amount', date: '$created_at' }]],
        },
      },
    },
    { $unwind: '$_pay' },
  ];
}

/** مراحل مجموع المُحصَّل فعلاً، اختيارياً داخل نطاق تاريخ دفع. */
function collectedTotalStages({ from, to } = {}) {
  const stages = [...unwindPaymentsStages()];
  if (from || to) {
    const range = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    stages.push({ $match: { '_pay.date': range } });
  }
  stages.push({ $group: { _id: null, total: { $sum: '$_pay.amount' } } });
  return stages;
}

/** مراحل مجموع المتبقي على كل الاشتراكات. */
function outstandingTotalStages() {
  return [{ $group: { _id: null, total: { $sum: REMAINING_EXPR } } }];
}

/**
 * يجمع صفوف الاشتراكات المدينة (بعد populate للاعب) في قائمة لكل لاعب،
 * مرتّبة بالأكبر مديونية. دالة نقية لتسهيل الاختبار.
 */
function groupDebtsByPlayer(subscriptions) {
  const byPlayer = new Map();
  for (const sub of subscriptions) {
    const state = paymentState(sub);
    if (state.remainingAmount <= EPSILON) continue;
    const player = sub.playerId && typeof sub.playerId === 'object' && sub.playerId.fullName !== undefined
      ? sub.playerId
      : null;
    const pid = (player ? player._id : sub.playerId)?.toString();
    if (!pid) continue;

    if (!byPlayer.has(pid)) {
      byPlayer.set(pid, {
        playerId: pid,
        fullName: player?.fullName ?? '',
        playerCode: player?.playerCode ?? '',
        parentPhone: player?.parentPhone ?? null,
        playerPhone: player?.playerPhone ?? null,
        image_url: player?.image_url ?? null,
        isActive: player?.isActive ?? true,
        totalDue: 0,
        oldestStartDate: null,
        subscriptions: [],
      });
    }
    const row = byPlayer.get(pid);
    row.totalDue = round2(row.totalDue + state.remainingAmount);
    const start = sub.startDate ? new Date(sub.startDate) : null;
    if (start && (!row.oldestStartDate || start < row.oldestStartDate)) row.oldestStartDate = start;
    row.subscriptions.push({
      _id: sub._id.toString(),
      type: sub.type,
      amount: round2(sub.amount),
      startDate: sub.startDate,
      endDate: sub.endDate,
      ...state,
    });
  }

  const players = [...byPlayer.values()].sort((a, b) => b.totalDue - a.totalDue);
  for (const p of players) {
    p.subscriptions.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  }
  return {
    players,
    summary: {
      totalOutstanding: round2(players.reduce((s, p) => s + p.totalDue, 0)),
      playersCount: players.length,
      subscriptionsCount: players.reduce((s, p) => s + p.subscriptions.length, 0),
    },
  };
}

// ─── Receipts ────────────────────────────────────────────────────────────────

/** اسم عدّاد أرقام الإيصالات — تسلسل مستقل لكل أكاديمية. */
const receiptCounterName = (academyId) => `receipt:${academyId}`;

/** رقم الإيصال المعروض: 000123. */
const formatReceiptNo = (n) => (n ? String(n).padStart(6, '0') : '');

/**
 * بيانات إيصال دفعة واحدة. دالة نقية: تعتمد على payments المرتّبة بالتاريخ
 * لحساب "المدفوع حتى هذه الدفعة" و"المتبقي بعدها" كما كانا لحظة الدفع.
 */
function buildReceipt({ subscription, payment, academy, player }) {
  const sorted = [...(subscription.payments || [])].sort(
    (a, b) => new Date(a.date) - new Date(b.date) || String(a._id).localeCompare(String(b._id))
  );
  const idx = sorted.findIndex((p) => String(p._id) === String(payment._id));
  const paidToDate = round2(
    sorted.slice(0, idx + 1).reduce((s, p) => s + (Number(p.amount) || 0), 0)
  );
  const amount = round2(subscription.amount);
  return {
    receiptNo: payment.receiptNo ?? null,
    receiptNoLabel: formatReceiptNo(payment.receiptNo),
    payment: {
      _id: String(payment._id),
      amount: round2(payment.amount),
      date: payment.date,
      method: payment.method || 'cash',
      note: payment.note || '',
      recordedByName: payment.recordedByName || '',
    },
    subscription: {
      _id: String(subscription._id),
      type: subscription.type,
      amount,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      paidToDate,
      remainingAfter: Math.max(0, round2(amount - paidToDate)),
    },
    player: {
      _id: player?._id ? String(player._id) : '',
      fullName: player?.fullName || '',
      playerCode: player?.playerCode || '',
      parentName: player?.parentName || '',
      parentPhone: player?.parentPhone || '',
      playerPhone: player?.playerPhone || '',
    },
    academy: {
      name: academy?.name || '',
      logo_url: academy?.logo_url || '',
      phone: academy?.phone || '',
      address: academy?.address || '',
      currency: academy?.currency || 'EGP',
    },
  };
}

module.exports = {
  receiptCounterName,
  formatReceiptNo,
  buildReceipt,
  PAYMENT_METHODS,
  EPSILON,
  round2,
  effectivePaid,
  paymentState,
  validatePaymentAmount,
  resolveInitialPaid,
  PAID_EXPR,
  REMAINING_EXPR,
  unwindPaymentsStages,
  collectedTotalStages,
  outstandingTotalStages,
  groupDebtsByPlayer,
};
