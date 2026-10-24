const Match = require('../models/match.model');
const Attendance = require('../models/attendance.model');
const Player = require('../models/player.model');
const logger = require('./logger');

// يوم المباراة يُسجَّل حضوراً (kind: 'match') تلقائياً لكل لاعب مُضاف إليها.
// - لا يتكرر: الفهرس الفريد (playerId, date) يُبقي أي حضور عادي سُجّل في نفس اليوم.
// - matchAttendanceDone يحفظ من عولج من اللاعبين فلا نعيد المحاولة كل دورة.
// - يُحتسب ضمن حصص الاشتراك فقط لو اختارت الإدارة ذلك (match.countsAsSession).
const INTERVAL_MS = 5 * 60 * 1000;

const pad2 = (n) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

const runOnce = async () => {
  const today = todayStr();
  const matches = await Match.find({ date: today, 'playerIds.0': { $exists: true } });
  // تحميل كسول لتفادي الاعتماد الدائري مع controller الحضور.
  const { refreshPlayerQuotas } = require('../controllers/attendance.controller');

  for (const match of matches) {
    const done = new Set((match.matchAttendanceDone || []).map((id) => id.toString()));
    const pending = match.playerIds.filter((id) => !done.has(id.toString()));
    if (!pending.length) continue;

    const players = await Player.find({ _id: { $in: pending }, isActive: true })
      .select('academyId sport').lean();
    for (const p of players) {
      try {
        await Attendance.create({
          playerId: p._id,
          academyId: p.academyId,
          sport: p.sport,
          date: match.date,
          time: match.time,
          status: 'present',
          kind: 'match',
          matchId: match._id,
          countsAsSession: match.countsAsSession === true,
          // المباراة ليست تمريناً — لا نطلب "قيّم تمرينك" عنها.
          ratingRequestSentAt: new Date(),
        });
        if (match.countsAsSession) await refreshPlayerQuotas(p._id);
      } catch (err) {
        // 11000 = لديه حضور مسجّل اليوم بالفعل → يبقى كما هو.
        if (!err || err.code !== 11000) {
          logger.warn(`[MATCH_ATTENDANCE] ${match._id}/${p._id}: ${err && err.message}`);
          continue;
        }
      }
    }
    await Match.updateOne(
      { _id: match._id },
      { $addToSet: { matchAttendanceDone: { $each: pending } } }
    );
    logger.info(`[MATCH_ATTENDANCE] match ${match._id}: processed ${pending.length} players`);
  }
};

const startMatchAttendanceScheduler = () => {
  const tick = () => runOnce().catch((err) => logger.warn(`[MATCH_ATTENDANCE] ${err.message}`));
  setTimeout(tick, 45 * 1000).unref();
  setInterval(tick, INTERVAL_MS).unref();
};

module.exports = { startMatchAttendanceScheduler, runOnce };
