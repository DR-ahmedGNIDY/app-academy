const AcademySubscription = require('../models/academySubscription.model');
const Academy = require('../models/academy.model');
const Player = require('../models/player.model');
const AppError = require('../utils/AppError');
const { sendSuccess } = require('../utils/apiResponse');
const { logActivity } = require('../utils/activityLogger');
const logger = require('../utils/logger');

// حساب تاريخ النهاية حسب الباقة من تاريخ بداية معطى.
const computeEndDate = (startDate, plan) => {
  const end = new Date(startDate);
  if (plan === 'month') end.setMonth(end.getMonth() + 1);
  else if (plan === 'year') end.setFullYear(end.getFullYear() + 1);
  else end.setDate(end.getDate() + 7); // احتياطي (trial)
  return end;
};

// يبني تمثيل صف موحّد للأكاديمية + اشتراكها.
const buildRow = (academy, sub, playerCount) => {
  const s = sub || null;
  return {
    academyId: academy._id.toString(),
    academyName: academy.name,
    isActive: academy.isActive,
    playerCount,
    subscription: s
      ? {
          _id: s._id.toString(),
          status: s.effectiveStatus(),
          rawStatus: s.status,
          plan: s.plan,
          maxPlayers: s.maxPlayers,
          startDate: s.startDate,
          endDate: s.endDate,
          daysRemaining: s.daysRemaining,
        }
      : null,
  };
};

// GET /api/v1/platform/subscriptions — كل الأكاديميات وحالات اشتراكاتها.
const listAcademiesSubscriptions = async (req, res, next) => {
  const [academies, subs, counts] = await Promise.all([
    Academy.find({}).sort({ created_at: -1 }),
    AcademySubscription.find({}),
    Player.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$academyId', count: { $sum: 1 } } },
    ]),
  ]);

  const subByAcademy = new Map(subs.map((s) => [s.academyId.toString(), s]));
  const countByAcademy = new Map(counts.map((c) => [c._id.toString(), c.count]));

  const rows = academies.map((a) =>
    buildRow(a, subByAcademy.get(a._id.toString()), countByAcademy.get(a._id.toString()) || 0)
  );

  return sendSuccess(res, { data: rows, message: 'تم جلب الاشتراكات بنجاح' });
};

// يضمن وجود وثيقة اشتراك للأكاديمية (ينشئ واحدة إن غابت — احتياط للأكاديميات القديمة).
const ensureSubscription = async (academyId) => {
  let sub = await AcademySubscription.findOne({ academyId });
  if (!sub) {
    const now = new Date();
    sub = await AcademySubscription.create({
      academyId,
      status: 'expired',
      plan: 'trial',
      maxPlayers: 0,
      startDate: now,
      endDate: now,
      history: [],
    });
  }
  return sub;
};

// POST /api/v1/platform/subscriptions/:academyId/activate
// body: { plan: 'month'|'year', maxPlayers }
const activateSubscription = async (req, res, next) => {
  const { academyId } = req.params;
  const { plan, maxPlayers } = req.body;

  const academy = await Academy.findById(academyId).select('name');
  if (!academy) return next(new AppError('الأكاديمية غير موجودة', 404));

  const sub = await ensureSubscription(academyId);

  const now = new Date();
  const endDate = computeEndDate(now, plan);

  sub.status = 'active';
  sub.plan = plan;
  sub.maxPlayers = maxPlayers;
  sub.startDate = now;
  sub.endDate = endDate;
  sub.history.push({
    action: 'ACTIVATED',
    plan,
    maxPlayers,
    startDate: now,
    endDate,
    changedBy: req.user._id,
    changedByName: req.user.name || '',
    note: 'تفعيل اشتراك من الإدارة',
    changedAt: now,
  });
  await sub.save();

  logger.info(`Subscription activated for academy ${academyId}: ${plan}, max ${maxPlayers}`);
  logActivity(req, {
    actionType: 'ACTIVATE_SUBSCRIPTION',
    entityType: 'PLATFORM_SUBSCRIPTION',
    entityId: sub._id,
    entityName: academy.name,
    academyId,
  });

  return sendSuccess(res, {
    data: buildRow(academy, sub, undefined).subscription,
    message: 'تم تفعيل الاشتراك بنجاح',
  });
};

// PATCH /api/v1/platform/subscriptions/:academyId
// body: { plan?, maxPlayers?, status? } — تعديل بدون إنشاء اشتراك جديد + تسجيل في History.
const updateSubscription = async (req, res, next) => {
  const { academyId } = req.params;
  const { plan, maxPlayers, status } = req.body;

  const academy = await Academy.findById(academyId).select('name');
  if (!academy) return next(new AppError('الأكاديمية غير موجودة', 404));

  const sub = await ensureSubscription(academyId);
  const now = new Date();
  let action = 'UPDATED';

  if (plan !== undefined && plan !== sub.plan) {
    sub.plan = plan;
    // عند تغيير الباقة (شهر↔سنة) نُعيد حساب تاريخ النهاية من تاريخ البداية الحالي.
    if (plan === 'month' || plan === 'year') {
      sub.endDate = computeEndDate(sub.startDate || now, plan);
      if (sub.effectiveStatus() !== 'active' && new Date() <= sub.endDate) sub.status = 'active';
    }
  }

  if (maxPlayers !== undefined) sub.maxPlayers = maxPlayers;

  if (status !== undefined && status !== sub.status) {
    sub.status = status;
    if (status === 'suspended') action = 'SUSPENDED';
    else if (status === 'active') action = 'REACTIVATED';
  }

  sub.history.push({
    action,
    plan: sub.plan,
    maxPlayers: sub.maxPlayers,
    startDate: sub.startDate,
    endDate: sub.endDate,
    changedBy: req.user._id,
    changedByName: req.user.name || '',
    note: 'تعديل اشتراك من الإدارة',
    changedAt: now,
  });
  await sub.save();

  logger.info(`Subscription updated for academy ${academyId}`);
  logActivity(req, {
    actionType: 'UPDATE_SUBSCRIPTION',
    entityType: 'PLATFORM_SUBSCRIPTION',
    entityId: sub._id,
    entityName: academy.name,
    academyId,
  });

  return sendSuccess(res, {
    data: buildRow(academy, sub, undefined).subscription,
    message: 'تم تعديل الاشتراك بنجاح',
  });
};

// GET /api/v1/platform/subscriptions/:academyId/history
const getSubscriptionHistory = async (req, res, next) => {
  const { academyId } = req.params;
  const sub = await AcademySubscription.findOne({ academyId });
  if (!sub) return next(new AppError('لا يوجد اشتراك لهذه الأكاديمية', 404));
  return sendSuccess(res, { data: sub.history || [], message: 'تم جلب سجل الاشتراك بنجاح' });
};

module.exports = {
  listAcademiesSubscriptions,
  activateSubscription,
  updateSubscription,
  getSubscriptionHistory,
};
