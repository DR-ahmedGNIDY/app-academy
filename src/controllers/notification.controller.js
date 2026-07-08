const Notification = require('../models/notification.model');
const AppError = require('../utils/AppError');
const { sendSuccess } = require('../utils/apiResponse');

// جلب قائمة إشعارات + عدد غير المقروء لمستلم مُحدَّد.
const listFor = async (recipientType, recipientId, res) => {
  const [items, unread] = await Promise.all([
    Notification.find({ recipientType, recipientId }).sort({ createdAt: -1 }).limit(100),
    Notification.countDocuments({ recipientType, recipientId, isRead: false }),
  ]);
  return sendSuccess(res, {
    data: { items, unread },
    message: 'تم جلب الإشعارات بنجاح',
  });
};

const markOneRead = async (recipientType, recipientId, id, res, next) => {
  const notif = await Notification.findById(id);
  if (!notif) return next(new AppError('الإشعار غير موجود', 404));
  if (notif.recipientType !== recipientType || notif.recipientId.toString() !== recipientId.toString()) {
    return next(new AppError('ليس لديك صلاحية لهذا الإشعار', 403));
  }
  if (!notif.isRead) {
    notif.isRead = true;
    await notif.save();
  }
  return sendSuccess(res, { data: notif, message: 'تم تعليم الإشعار كمقروء' });
};

const markAllRead = async (recipientType, recipientId, res) => {
  await Notification.updateMany(
    { recipientType, recipientId, isRead: false },
    { $set: { isRead: true } }
  );
  return sendSuccess(res, { message: 'تم تعليم كل الإشعارات كمقروءة' });
};

// ─────────────── جهة الأكاديمية (recipientId = academyId) ───────────────
const getAcademyNotifications = async (req, res, next) => {
  const academyId = req.user.academyId;
  if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  return listFor('academy', academyId, res);
};

const markAcademyNotificationRead = async (req, res, next) => {
  if (!req.user.academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  return markOneRead('academy', req.user.academyId, req.params.id, res, next);
};

const markAllAcademyRead = async (req, res, next) => {
  if (!req.user.academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  return markAllRead('academy', req.user.academyId, res);
};

// ─────────────── جهة اللاعب (recipientId = playerId) ───────────────
const getPlayerNotifications = async (req, res) => {
  return listFor('player', req.player._id, res);
};

const markPlayerNotificationRead = async (req, res, next) => {
  return markOneRead('player', req.player._id, req.params.id, res, next);
};

const markAllPlayerRead = async (req, res) => {
  return markAllRead('player', req.player._id, res);
};

module.exports = {
  getAcademyNotifications,
  markAcademyNotificationRead,
  markAllAcademyRead,
  getPlayerNotifications,
  markPlayerNotificationRead,
  markAllPlayerRead,
};
