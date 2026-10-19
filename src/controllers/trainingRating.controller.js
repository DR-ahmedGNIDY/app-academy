const mongoose = require('mongoose');
const Attendance = require('../models/attendance.model');
const TrainingRating = require('../models/trainingRating.model');
const AppError = require('../utils/AppError');
const { sendSuccess } = require('../utils/apiResponse');

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// "اليوم" حسب جهاز اللاعب (?today=) لأن Attendance.date محلي للجهاز؛ وإلا يوم السيرفر.
const todayOf = (req) => {
  const t = (req.query && req.query.today) || (req.body && req.body.today);
  return t && YMD.test(t) ? t : ymd(new Date());
};
const dayBefore = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return ymd(new Date(y, m - 1, d - 1));
};

// مهلة التقييم: يوم التمرين واليوم التالي له.
const withinWindow = (date, today) => date <= today && date >= dayBefore(today);

// ─── GET /player/training-ratings/pending ─────────────────────────────────────
// تمارين اللاعب (أمس واليوم) التي لم يقيّمها بعد. الواجهة تعرض الإجراء السريع
// لتمرين اليوم فقط؛ تمرين أمس يبقى متاحاً من الإشعار.
const getPendingRatings = async (req, res) => {
  const today = todayOf(req);
  const records = await Attendance.find({
    playerId: req.player._id,
    date: { $gte: dayBefore(today), $lte: today },
  }).select('date time').sort({ date: -1 }).lean();
  const rated = await TrainingRating.find({
    attendanceId: { $in: records.map((r) => r._id) },
  }).select('attendanceId').lean();
  const ratedIds = new Set(rated.map((r) => r.attendanceId.toString()));
  const pending = records
    .filter((r) => !ratedIds.has(r._id.toString()))
    .map((r) => ({
      attendanceId: r._id.toString(),
      date: r.date,
      time: r.time,
      isToday: r.date === today,
    }));
  return sendSuccess(res, { data: pending, message: 'تم جلب التمارين غير المقيّمة' });
};

// ─── POST /player/training-ratings ────────────────────────────────────────────
// body: { attendanceId, stars (1-5), notes?, today? }
const createRating = async (req, res, next) => {
  const { attendanceId, stars, notes } = req.body;
  const attendance = await Attendance.findById(attendanceId).select('playerId academyId date');
  if (!attendance || attendance.playerId.toString() !== req.player._id.toString()) {
    return next(new AppError('التمرين غير موجود', 404));
  }
  if (!withinWindow(attendance.date, todayOf(req))) {
    return next(new AppError('انتهت مهلة تقييم هذا التمرين', 400));
  }
  try {
    const rating = await TrainingRating.create({
      academyId: attendance.academyId,
      playerId: attendance.playerId,
      attendanceId: attendance._id,
      date: attendance.date,
      stars: parseInt(stars, 10),
      notes: (notes || '').toString().trim(),
    });
    return sendSuccess(res, { data: rating, message: 'تم تسجيل التقييم، شكراً لك', statusCode: 201 });
  } catch (err) {
    if (err && err.code === 11000) return next(new AppError('تم تقييم هذا التمرين مسبقاً', 409));
    return next(err);
  }
};

// ─── GET /training-ratings?date=&days= ────────────────────────────────────────
// للإدارة: ملخص الأيام الأخيرة (متوسط + عدد) + تفاصيل يوم محدد (افتراضياً أحدث يوم).
const getAcademyRatings = async (req, res, next) => {
  const academyId = req.user.role === 'super_admin' ? req.query.academyId : req.user.academyId;
  if (!academyId || !mongoose.Types.ObjectId.isValid(academyId.toString())) {
    return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  }
  const academyObjectId = new mongoose.Types.ObjectId(academyId.toString());
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));

  const summary = await TrainingRating.aggregate([
    { $match: { academyId: academyObjectId } },
    { $group: { _id: '$date', average: { $avg: '$stars' }, count: { $sum: 1 } } },
    { $sort: { _id: -1 } },
    { $limit: days },
  ]);
  const daysList = summary.map((d) => ({
    date: d._id,
    average: Math.round(d.average * 10) / 10,
    count: d.count,
  }));

  const date = req.query.date && YMD.test(req.query.date)
    ? req.query.date
    : (daysList[0] ? daysList[0].date : ymd(new Date()));
  const ratings = await TrainingRating.find({ academyId: academyObjectId, date })
    .populate('playerId', 'fullName playerCode image_url')
    .sort({ created_at: -1 })
    .lean();
  const items = ratings.map((r) => ({
    _id: r._id.toString(),
    stars: r.stars,
    notes: r.notes || '',
    createdAt: r.created_at,
    player: r.playerId ? {
      id: r.playerId._id.toString(),
      fullName: r.playerId.fullName,
      playerCode: r.playerId.playerCode,
      image_url: r.playerId.image_url,
    } : null,
  }));
  const average = items.length
    ? Math.round((items.reduce((s, r) => s + r.stars, 0) / items.length) * 10) / 10
    : 0;

  return sendSuccess(res, {
    data: { date, average, count: items.length, ratings: items, days: daysList },
    message: 'تم جلب تقييمات التمرين',
  });
};

module.exports = { getPendingRatings, createRating, getAcademyRatings };
