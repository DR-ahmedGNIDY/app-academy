const Match = require('../models/match.model');

// إيرادات اشتراكات المباريات: مدفوعات اللاعبين (payments) في المباريات التي
// اختير فيها "يُضاف إلى الإيرادات". تُحتسب بتاريخ الدفع (paidAt) لا بتاريخ المباراة.
// academyMatch: نفس فلتر الأكاديمية المستخدم مع الاشتراكات ({ academyId } أو {}).
const matchRevenueTotal = async ({ academyMatch = {}, from = null, to = null, sport = null } = {}) => {
  const paidAt = {};
  if (from) paidAt.$gte = from;
  if (to) paidAt.$lte = to;
  const pipeline = [
    { $match: { ...academyMatch, addToRevenue: true, ...(sport ? { sport } : {}) } },
    { $unwind: '$payments' },
  ];
  if (from || to) pipeline.push({ $match: { 'payments.paidAt': paidAt } });
  pipeline.push({ $group: { _id: null, total: { $sum: '$payments.amount' } } });
  const [row] = await Match.aggregate(pipeline);
  return row ? row.total : 0;
};

module.exports = { matchRevenueTotal };
