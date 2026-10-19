const Attendance = require('../models/attendance.model');
const PlayerAccount = require('../models/playerAccount.model');
const { notify } = require('./notificationService');
const logger = require('./logger');

// بعد ساعتين من تسجيل الحضور يصل اللاعب إشعار "قيّم تمرينك".
// فحص دوري بدل مؤقّت لكل حضور: يصمد أمام إعادة تشغيل السيرفر. المطالبة الذرّية
// (ratingRequestSentAt: null → now) تمنع التكرار حتى مع أكثر من نسخة PM2.
const DELAY_MS = 2 * 60 * 60 * 1000;
const WINDOW_MS = 12 * 60 * 60 * 1000; // لا نرسل لحضور أقدم من 12 ساعة (مثلاً بعد توقف طويل)
const INTERVAL_MS = 5 * 60 * 1000;

const runOnce = async () => {
  const now = Date.now();
  const due = await Attendance.find({
    ratingRequestSentAt: null,
    timestamp: { $lte: new Date(now - DELAY_MS), $gte: new Date(now - WINDOW_MS) },
  }).select('_id playerId academyId date').limit(500).lean();

  for (const a of due) {
    const claimed = await Attendance.updateOne(
      { _id: a._id, ratingRequestSentAt: null },
      { $set: { ratingRequestSentAt: new Date() } }
    );
    if (!claimed.modifiedCount) continue;
    const account = await PlayerAccount.exists({ playerId: a.playerId, isActive: true });
    if (!account) continue;
    notify({
      recipientType: 'player', recipientId: a.playerId, academyId: a.academyId,
      type: 'TRAINING_RATING_REQUEST', title: 'قيّم تمرينك',
      body: 'كيف كان تمرين اليوم؟ شاركنا تقييمك بالنجوم وملاحظاتك',
      meta: { attendanceId: a._id.toString(), date: a.date },
    });
  }
  if (due.length) logger.info(`[TRAINING_RATING] processed ${due.length} rating requests`);
};

const startTrainingRatingScheduler = () => {
  const tick = () => runOnce().catch((err) => logger.warn(`[TRAINING_RATING] ${err.message}`));
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, INTERVAL_MS).unref();
};

module.exports = { startTrainingRatingScheduler, runOnce };
