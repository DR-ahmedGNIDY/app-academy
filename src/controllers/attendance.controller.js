const mongoose = require('mongoose');
const Attendance = require('../models/attendance.model');
const Player = require('../models/player.model');
const Subscription = require('../models/subscription.model');
const AppError = require('../utils/AppError');
const { sendSuccess, sendPaginated } = require('../utils/apiResponse');
const logger = require('../utils/logger');
const { logActivity } = require('../utils/activityLogger');
const { notify } = require('../utils/notificationService');
const escapeRegex = require('../utils/escapeRegex');

// أسماء أيام الأسبوع العربية مرتبطة بـ Date.getDay() (0 = الأحد ... 6 = السبت)
// مطابقة تماماً للقيم المخزّنة في player.attendanceDays و SportsConstants.weekDays.
const WEEKDAY_AR = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

// تطبيع كود اللاعب القادم من الـ QR: يقبل 'PLAYER:Y-0001' أو 'Y-0001'.
// نُزيل المسافات أولاً ثم بادئة PLAYER: (غير حسّاسة لحالة الأحرف) ثم المسافات مجدداً.
const normalizeCode = (raw) => {
  if (!raw) return '';
  let v = String(raw).trim();
  v = v.replace(/^PLAYER:/i, '').trim();
  return v;
};

const pad2 = (n) => String(n).padStart(2, '0');
const serverDateStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const serverTimeStr = () => {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const playerSummary = (p) => ({
  id: p._id.toString(),
  fullName: p.fullName,
  playerCode: p.playerCode,
  sport: p.sport,
  image_url: p.image_url,
});

// ─── POST /attendance ─────────────────────────────────────────────────────────
// مسح واحد = طلب واحد: بحث عن اللاعب + منع التكرار + إنشاء السجل + إرجاع بيانات اللاعب.
const recordAttendance = async (req, res, next) => {
  const { code, playerId, localDate, localTime, allowExpired } = req.body;
  logger.info(`[ATTENDANCE] record request: code="${code ?? ''}" playerId="${playerId ?? ''}"`);

  // 1) العثور على اللاعب (بالكود من الـ QR أو بالمعرّف)
  let player;
  let searchKey = playerId;
  if (playerId) {
    player = await Player.findById(playerId);
  } else {
    const normalized = normalizeCode(code);
    searchKey = normalized;
    logger.info(`[ATTENDANCE] normalized playerCode for search: "${normalized}"`);
    if (!normalized) return next(new AppError('كود اللاعب مطلوب', 400));
    player = await Player.findOne({ playerCode: normalized });
  }

  if (!player || player.isActive === false) {
    logger.warn(`[ATTENDANCE] player NOT FOUND for "${searchKey}"`);
    return next(new AppError('اللاعب غير موجود', 404));
  }
  logger.info(`[ATTENDANCE] player found: ${player.playerCode} - ${player.fullName}`);

  // 2) فحص صلاحية النطاق
  if (
    req.user.role !== 'super_admin' &&
    player.academyId.toString() !== req.user.academyId?.toString()
  ) {
    return next(new AppError('ليس لديك صلاحية لتسجيل حضور هذا اللاعب', 403));
  }

  const date = (localDate && /^\d{4}-\d{2}-\d{2}$/.test(localDate)) ? localDate : serverDateStr();
  const time = (localTime && /^\d{2}:\d{2}$/.test(localTime)) ? localTime : serverTimeStr();

  // 3) فحص حالة الاشتراك — آخر اشتراك للاعب (الأحدث تاريخ انتهاء).
  const latestSubscription = await latestSubscriptionOf(player._id);
  const subscriptionExpired = !latestSubscription || latestSubscription.endDate < new Date();

  if (subscriptionExpired && allowExpired !== true) {
    return sendSuccess(res, {
      data: {
        recorded: false,
        alreadyToday: false,
        subscriptionExpired: true,
        player: playerSummary(player),
        // حضور/غياب اللاعب في اشتراكه السابق (آخر اشتراك كان نشطاً).
        stats: await subscriptionStats(player, latestSubscription),
      },
      message: 'اشتراك اللاعب منتهي',
    });
  }

  // 4) محاولة الإنشاء — الفهرس الفريد (playerId, date) هو حارس منع التكرار.
  try {
    const attendance = await Attendance.create({
      playerId: player._id,
      academyId: player.academyId,
      sport: player.sport,
      date,
      time,
      status: 'present',
      subscriptionExpiredAtCheckin: subscriptionExpired && allowExpired === true,
    });

    logger.info(`Attendance recorded: ${player.playerCode} @ ${date} ${time}`);
    logActivity(req, {
      actionType: 'RECORD_ATTENDANCE', entityType: 'ATTENDANCE',
      entityId: player._id, entityName: player.fullName, academyId: player.academyId,
    });
    // إشعار اللاعب بتسجيل حضوره (fire-and-forget).
    notify({
      recipientType: 'player', recipientId: player._id, academyId: player.academyId,
      type: 'ATTENDANCE_PRESENT', title: 'تم تسجيل حضورك',
      body: `تم تسجيل حضورك بتاريخ ${date} الساعة ${time}`,
      meta: { date, time },
    });
    return sendSuccess(res, {
      data: {
        recorded: true,
        alreadyToday: false,
        player: playerSummary(player),
        attendance,
        stats: await subscriptionStats(player, latestSubscription),
      },
      message: 'تم تسجيل الحضور بنجاح',
      statusCode: 201,
    });
  } catch (err) {
    // مفتاح مكرّر ⇒ اللاعب سُجّل مسبقاً في نفس اليوم
    if (err && err.code === 11000) {
      return sendSuccess(res, {
        data: {
          recorded: false,
          alreadyToday: true,
          player: playerSummary(player),
          stats: await subscriptionStats(player, latestSubscription),
        },
        message: 'تم تسجيل حضور هذا اللاعب مسبقاً اليوم',
      });
    }
    return next(err);
  }
};

// ─── GET /attendance ──────────────────────────────────────────────────────────
// سجل الحضور — مُصفحَّن مع فلاتر (التاريخ، الرياضة، اللاعب). استعلام واحد + populate.
const getAttendance = async (req, res, next) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 30));
  const skip = (page - 1) * limit;

  const filter = {};

  // نطاق الأكاديمية إلزامي — super_admin يمرّر academyId، وغيره مُقيَّد بأكاديميته.
  if (req.user.role === 'super_admin') {
    if (!req.query.academyId) {
      return next(new AppError('معرّف الأكاديمية مطلوب', 400));
    }
    filter.academyId = req.query.academyId;
  } else {
    filter.academyId = req.user.academyId;
  }

  // فلتر يوم محدّد، أو نطاق تاريخي (مقارنة نصية صالحة لصيغة YYYY-MM-DD)
  if (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) {
    filter.date = req.query.date;
  } else if (req.query.startDate || req.query.endDate) {
    filter.date = {};
    if (req.query.startDate) filter.date.$gte = req.query.startDate;
    if (req.query.endDate) filter.date.$lte = req.query.endDate;
  }

  if (req.query.sport && req.query.sport.trim().length > 0) {
    filter.sport = req.query.sport.trim();
  }
  if (req.query.playerId) {
    filter.playerId = req.query.playerId;
  }

  const [records, total] = await Promise.all([
    Attendance.find(filter)
      .populate('playerId', 'fullName playerCode image_url')
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit),
    Attendance.countDocuments(filter),
  ]);

  return sendPaginated(res, {
    data: records,
    total,
    page,
    limit,
    message: 'تم جلب سجل الحضور بنجاح',
  });
};

// عدد كل يوم من أيام الأسبوع ضمن نطاق [start, end] شامل الطرفين.
const weekdayCountsInRange = (startStr, endStr) => {
  const counts = {};
  for (const d of WEEKDAY_AR) counts[d] = 0;
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  // حدّ أمان: لا نتجاوز ~370 تكرار (سنة واحدة)
  let guard = 0;
  while (cur <= end && guard < 400) {
    counts[WEEKDAY_AR[cur.getDay()]] += 1;
    cur.setDate(cur.getDate() + 1);
    guard += 1;
  }
  return counts;
};

// Date → YYYY-MM-DD بتوقيت السيرفر المحلي (نفس صيغة Attendance.date).
const dateToStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// عدد الأيام المتوقعة للاعب ضمن [start, end] حسب أيام حضوره (attendanceDays).
const expectedInRange = (days, startStr, endStr) => {
  if (!Array.isArray(days) || days.length === 0 || startStr > endStr) return 0;
  const counts = weekdayCountsInRange(startStr, endStr);
  return days.reduce((sum, d) => sum + (counts[d] || 0), 0);
};

// آخر اشتراك للاعب (الأحدث تاريخ انتهاء). "نشط" ⇔ endDate >= الآن.
// لو منتهي فهو "الاشتراك السابق" = آخر اشتراك كان نشطاً للاعب.
const latestSubscriptionOf = (playerId) =>
  Subscription.findOne({ playerId }).sort({ endDate: -1 });

// إحصائيات حضور اللاعب داخل اشتراك معيّن.
// نشط  → الحضور من بداية الاشتراك، والغياب حتى اليوم.
// منتهي → الحضور والغياب على كامل فترة الاشتراك السابق.
const subscriptionStats = async (player, sub) => {
  if (!sub) {
    return { status: 'none', subscription: null, present: 0, absent: 0, expected: 0, expectedTotal: 0 };
  }
  const today = serverDateStr();
  const active = sub.endDate >= new Date();
  const startStr = dateToStr(sub.startDate);
  const endStr = dateToStr(sub.endDate);
  const countUntil = active && today < endStr ? today : endStr;
  const days = player.attendanceDays;
  const present = await Attendance.countDocuments({
    playerId: player._id,
    date: { $gte: startStr, $lte: endStr },
  });
  const expected = expectedInRange(days, startStr, countUntil);
  return {
    status: active ? 'active' : 'expired',
    subscription: { id: sub._id.toString(), type: sub.type, startDate: startStr, endDate: endStr },
    present,
    absent: Math.max(expected - present, 0),
    expected,
    expectedTotal: expectedInRange(days, startStr, endStr),
  };
};

// نطاق الأكاديمية — super_admin يمرّر academyId، وغيره مُقيَّد بأكاديميته.
const resolveAcademyId = (req) => {
  if (req.user.role === 'super_admin') return req.query.academyId || null;
  return req.user.academyId;
};

// ─── GET /attendance/report ───────────────────────────────────────────────────
// تقرير الحضور/الغياب — كل لاعب يُحسب على فترة اشتراكه النشط (بدايته → نهايته)
// وليس على الشهر. اللاعب المنتهي اشتراكه يُعرض بحالة "منتهي" فقط بلا أرقام.
// 3 استعلامات: اشتراكات نشطة + لاعبون + سجلات الحضور (playerId/date فقط).
const getAttendanceReport = async (req, res, next) => {
  const academyId = resolveAcademyId(req);
  if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));

  const sport = (req.query.sport && req.query.sport.trim().length > 0)
    ? req.query.sport.trim() : null;

  // 'active' = اللاعبون ذوو الاشتراك النشط الآن، 'all' = كل اللاعبين النشطين.
  const subscriptionFilter = req.query.subscription === 'active' ? 'active' : 'all';

  const now = new Date();
  const today = serverDateStr();

  // (أ) الاشتراك النشط لكل لاعب = أحدث اشتراك (أبعد endDate) لم ينتهِ بعد.
  // نفس تعريف شاشة المسح (latestSubscriptionOf): آخر اشتراك endDate >= الآن.
  const activeSubs = await Subscription.find({ academyId, endDate: { $gte: now } })
    .select('playerId type startDate endDate')
    .sort({ endDate: -1 })
    .lean();
  const activeSubMap = {};
  for (const s of activeSubs) {
    const key = s.playerId.toString();
    if (!activeSubMap[key]) activeSubMap[key] = s;
  }

  // (ب) اللاعبون
  const playerFilter = { academyId, isActive: true };
  if (sport) playerFilter.sport = sport;
  if (subscriptionFilter === 'active') {
    playerFilter._id = {
      $in: Object.keys(activeSubMap).map((id) => new mongoose.Types.ObjectId(id)),
    };
  }
  const players = await Player.find(playerFilter)
    .select('fullName playerCode sport attendanceDays')
    .sort({ fullName: 1 })
    .lean();

  // (ج) الحضور من أقدم بداية اشتراك نشط — ثم عدّ كل لاعب داخل فترته في الذاكرة.
  let minStart = null;
  for (const p of players) {
    const s = activeSubMap[p._id.toString()];
    if (!s) continue;
    const st = dateToStr(new Date(s.startDate));
    if (!minStart || st < minStart) minStart = st;
  }
  const datesByPlayer = {};
  if (minStart) {
    const records = await Attendance.find({
      academyId,
      playerId: { $in: players.map((p) => p._id) },
      date: { $gte: minStart },
    }).select('playerId date').lean();
    for (const r of records) {
      const key = r.playerId.toString();
      (datesByPlayer[key] = datesByPlayer[key] || []).push(r.date);
    }
  }

  let totalPresent = 0;
  let totalAbsent = 0;
  let activeCount = 0;

  const rows = players.map((p) => {
    const id = p._id.toString();
    const days = Array.isArray(p.attendanceDays) ? p.attendanceDays : [];
    const base = {
      playerId: id,
      playerCode: p.playerCode,
      fullName: p.fullName,
      sport: p.sport,
      attendanceDays: days,
    };
    const sub = activeSubMap[id];
    if (!sub) {
      return {
        ...base,
        subscriptionStatus: 'expired',
        subscriptionStart: null,
        subscriptionEnd: null,
        expected: 0,
        expectedTotal: 0,
        expectedThisMonth: 0,
        present: 0,
        absent: 0,
        rate: 0,
      };
    }
    const startStr = dateToStr(new Date(sub.startDate));
    const endStr = dateToStr(new Date(sub.endDate));
    const countUntil = today < endStr ? today : endStr;
    const present = (datesByPlayer[id] || [])
      .filter((d) => d >= startStr && d <= endStr).length;
    const expected = expectedInRange(days, startStr, countUntil);
    const expectedTotal = expectedInRange(days, startStr, endStr);
    const absent = Math.max(expected - present, 0);
    const rate = expected > 0
      ? Math.min(100, Math.round((present / expected) * 100))
      : (present > 0 ? 100 : 0);
    totalPresent += present;
    totalAbsent += absent;
    activeCount += 1;
    return {
      ...base,
      subscriptionStatus: 'active',
      subscriptionStart: startStr,
      subscriptionEnd: endStr,
      expected,
      expectedTotal,
      // توافق رجعي مع نسخ الواجهة القديمة (الدوائر).
      expectedThisMonth: expectedTotal,
      present,
      absent,
      rate,
    };
  });

  return sendSuccess(res, {
    data: {
      basis: 'subscription',
      startDate: minStart || today,
      endDate: today,
      sport,
      subscription: subscriptionFilter,
      playersCount: rows.length,
      activeCount,
      totalPresent,
      totalAbsent,
      rows,
    },
    message: 'تم جلب تقرير الحضور بنجاح',
  });
};

// ─── GET /attendance/players?search= ───────────────────────────────────────────
// بحث لاعبي الأكاديمية بالاسم/الكود لسجل الحضور (كارت لكل لاعب).
const searchAttendancePlayers = async (req, res, next) => {
  const academyId = resolveAcademyId(req);
  if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  const q = String(req.query.search || '').trim();
  if (!q) return sendSuccess(res, { data: [], message: 'لا توجد نتائج' });

  const rx = new RegExp(escapeRegex(q), 'i');
  const filter = { academyId, $or: [{ fullName: rx }, { playerCode: rx }] };
  if (req.query.sport && req.query.sport.trim()) filter.sport = req.query.sport.trim();
  const players = await Player.find(filter)
    .select('fullName playerCode sport image_url')
    .sort({ fullName: 1 })
    .limit(30);
  return sendSuccess(res, {
    data: players.map(playerSummary),
    message: 'تم جلب اللاعبين بنجاح',
  });
};

// ─── GET /attendance/player/:id/summary ────────────────────────────────────────
// ملخص حضور اللاعب في اشتراكه الأخير: نشط → منذ بدايته، منتهي → الاشتراك السابق.
const getPlayerAttendanceSummary = async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(new AppError('معرّف اللاعب غير صحيح', 400));
  }
  const player = await Player.findById(req.params.id)
    .select('fullName playerCode sport image_url attendanceDays academyId');
  if (!player) return next(new AppError('اللاعب غير موجود', 404));
  if (
    req.user.role !== 'super_admin' &&
    player.academyId.toString() !== req.user.academyId?.toString()
  ) {
    return next(new AppError('ليس لديك صلاحية لعرض هذا اللاعب', 403));
  }
  const sub = await latestSubscriptionOf(player._id);
  return sendSuccess(res, {
    data: {
      player: playerSummary(player),
      stats: await subscriptionStats(player, sub),
    },
    message: 'تم جلب ملخص حضور اللاعب بنجاح',
  });
};

// ─── DELETE /attendance/:id ────────────────────────────────────────────────────
const deleteAttendance = async (req, res, next) => {
  const record = await Attendance.findById(req.params.id);
  if (!record) return next(new AppError('سجل الحضور غير موجود', 404));

  if (
    req.user.role !== 'super_admin' &&
    record.academyId.toString() !== req.user.academyId?.toString()
  ) {
    return next(new AppError('ليس لديك صلاحية لحذف هذا السجل', 403));
  }

  await record.deleteOne();

  logActivity(req, {
    actionType: 'DELETE_ATTENDANCE', entityType: 'ATTENDANCE',
    entityId: record._id, academyId: record.academyId,
  });
  return sendSuccess(res, { message: 'تم حذف سجل الحضور بنجاح' });
};

module.exports = {
  recordAttendance,
  getAttendance,
  getAttendanceReport,
  searchAttendancePlayers,
  getPlayerAttendanceSummary,
  deleteAttendance,
};
