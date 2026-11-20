const mongoose = require('mongoose');
const Match = require('../models/match.model');
const MatchStat = require('../models/matchStat.model');
const Player = require('../models/player.model');
const Academy = require('../models/academy.model');
const AppError = require('../utils/AppError');
const { sendSuccess } = require('../utils/apiResponse');
const {
  TEMPLATES,
  SPORT_MAP,
  templateForSport,
  sanitizeStats,
  sanitizeRating,
  summarizePlayerStats,
} = require('../utils/matchStatsCatalog');

const isSuper = (req) => req.user?.role === 'super_admin';
const sameAcademy = (req, academyId) => isSuper(req) || String(academyId) === String(req.user?.academyId);
const resolveAcademyId = (req) => (isSuper(req) ? req.query.academyId || req.body?.academyId : req.user.academyId);

// ─── GET /match-stats/templates[?sport=] ─────────────────────────────────────
const getTemplates = async (req, res) => {
  if (req.query.sport) {
    return sendSuccess(res, { data: templateForSport(req.query.sport), message: 'قالب الإحصائيات' });
  }
  return sendSuccess(res, { data: { templates: Object.values(TEMPLATES), sportMap: SPORT_MAP }, message: 'قوالب الإحصائيات' });
};

/** بيانات شاشة إحصائيات مباراة: القالب + كل لاعبي المباراة + إحصائياتهم. */
async function matchStatsPayload(match) {
  const template = templateForSport(match.sport);
  const [players, stats] = await Promise.all([
    Player.find({ _id: { $in: match.playerIds } }).select('fullName playerCode image_url').lean(),
    MatchStat.find({ matchId: match._id }).lean(),
  ]);
  const byPlayer = Object.fromEntries(stats.map((s) => [String(s.playerId), s]));
  const rows = players
    .map((p) => {
      const s = byPlayer[String(p._id)];
      return {
        playerId: String(p._id),
        fullName: p.fullName,
        playerCode: p.playerCode,
        image_url: p.image_url || null,
        stats: s?.stats || {},
        rating: s?.rating ?? null,
        mvp: Boolean(s?.mvp),
        notes: s?.notes || '',
        recorded: Boolean(s),
      };
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ar'));
  return {
    match: {
      _id: String(match._id), name: match.name, date: match.date, sport: match.sport,
      opponent: match.opponent || '', ourScore: match.ourScore ?? null, theirScore: match.theirScore ?? null,
      statsRecordedAt: match.statsRecordedAt || null,
    },
    template,
    rows,
  };
}

// ─── GET /match-stats/match/:matchId ─────────────────────────────────────────
const getMatchStats = async (req, res, next) => {
  const match = await Match.findById(req.params.matchId);
  if (!match) return next(new AppError('المباراة غير موجودة', 404));
  if (!sameAcademy(req, match.academyId)) return next(new AppError('ليس لديك صلاحية للوصول إلى هذه المباراة', 403));
  return sendSuccess(res, { data: await matchStatsPayload(match), message: 'إحصائيات المباراة' });
};

// ─── PUT /match-stats/match/:matchId ─────────────────────────────────────────
// body: { opponent?, ourScore?, theirScore?, rows: [{ playerId, stats, rating, mvp, notes }] }
const saveMatchStats = async (req, res, next) => {
  const match = await Match.findById(req.params.matchId);
  if (!match) return next(new AppError('المباراة غير موجودة', 404));
  if (!sameAcademy(req, match.academyId)) return next(new AppError('ليس لديك صلاحية لتعديل هذه المباراة', 403));

  const score = (v) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= 999 ? n : undefined;
  };
  if (req.body.opponent !== undefined) match.opponent = String(req.body.opponent || '').trim().slice(0, 100);
  const ours = score(req.body.ourScore);
  const theirs = score(req.body.theirScore);
  if (ours !== undefined) match.ourScore = ours;
  if (theirs !== undefined) match.theirScore = theirs;

  const template = templateForSport(match.sport);
  const inMatch = new Set(match.playerIds.map(String));
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  let mvpTaken = false;
  const ops = [];
  for (const r of rows) {
    const pid = String(r?.playerId || '');
    if (!inMatch.has(pid)) continue; // لاعب ليس في قائمة المباراة
    const stats = sanitizeStats(template, r.stats);
    const rating = sanitizeRating(r.rating);
    const mvp = Boolean(r.mvp) && !mvpTaken;
    if (mvp) mvpTaken = true;
    const notes = String(r.notes || '').trim().slice(0, 300);
    const empty = !Object.keys(stats).length && rating === null && !mvp && !notes;
    if (empty) {
      ops.push({ deleteOne: { filter: { matchId: match._id, playerId: pid } } });
      continue;
    }
    ops.push({
      updateOne: {
        filter: { matchId: match._id, playerId: pid },
        update: {
          $set: {
            academyId: match.academyId, sport: template.sport, templateKey: template.key,
            matchDate: match.date || null, stats, rating, mvp, notes,
          },
        },
        upsert: true,
      },
    });
  }
  // نجم مباراة واحد فقط: اختيار نجم جديد يلغي النجم السابق في نفس المباراة.
  const mvpPid = ops.find((o) => o.updateOne?.update.$set.mvp)?.updateOne.filter.playerId;
  if (mvpPid) {
    ops.push({ updateMany: { filter: { matchId: match._id, playerId: { $ne: mvpPid }, mvp: true }, update: { $set: { mvp: false } } } });
  }
  if (ops.length) await MatchStat.bulkWrite(ops, { ordered: true });
  match.statsRecordedAt = new Date();
  await match.save();
  return sendSuccess(res, { data: await matchStatsPayload(match), message: 'تم حفظ إحصائيات المباراة' });
};

/** ملخص موسم لاعب + آخر مبارياته + أفضل مباراة. */
async function playerStatsPayload(player) {
  const rows = await MatchStat.find({ playerId: player._id })
    .sort({ matchDate: -1, created_at: -1 })
    .populate('matchId', 'name date opponent ourScore theirScore sport')
    .lean();
  const sport = player.sport || rows[0]?.sport || '';
  const template = templateForSport(sport);
  const sameTemplate = rows.filter((r) => r.templateKey === template.key);
  const summary = summarizePlayerStats(template, sameTemplate);
  const recent = sameTemplate.slice(0, 15).map((r) => ({
    matchId: r.matchId?._id ? String(r.matchId._id) : String(r.matchId),
    matchName: r.matchId?.name || '',
    date: r.matchId?.date || r.matchDate,
    opponent: r.matchId?.opponent || '',
    ourScore: r.matchId?.ourScore ?? null,
    theirScore: r.matchId?.theirScore ?? null,
    stats: r.stats || {},
    rating: r.rating ?? null,
    mvp: Boolean(r.mvp),
  }));
  const best = recent.filter((r) => typeof r.rating === 'number').sort((a, b) => b.rating - a.rating)[0] || null;
  return { player: { _id: String(player._id), fullName: player.fullName, sport }, template, summary, recent, best };
}

// ─── GET /match-stats/player/:playerId ───────────────────────────────────────
const getPlayerStats = async (req, res, next) => {
  const player = await Player.findById(req.params.playerId).select('fullName sport academyId');
  if (!player) return next(new AppError('اللاعب غير موجود', 404));
  if (!sameAcademy(req, player.academyId)) return next(new AppError('ليس لديك صلاحية للوصول إلى هذا اللاعب', 403));
  return sendSuccess(res, { data: await playerStatsPayload(player), message: 'إحصائيات اللاعب' });
};

/** ترتيب الأكاديمية لرياضة وحقل (أعلى 10). */
async function leaderboardPayload(academyId, sport, fieldKey) {
  const template = templateForSport(sport);
  const leaderFields = template.fields.filter((f) => f.leader);
  const field = fieldKey === 'rating'
    ? { key: 'rating', label: 'التقييم', kind: 'rating', agg: 'avg' }
    : leaderFields.find((f) => f.key === fieldKey) || leaderFields[0];
  const path = field.key === 'rating' ? '$rating' : `$stats.${field.key}`;
  let valueExpr;
  if (field.agg === 'avg') valueExpr = { $avg: path };
  else if (field.kind === 'bool') valueExpr = { $sum: { $cond: [{ $eq: [path, true] }, 1, 0] } };
  else valueExpr = { $sum: { $ifNull: [path, 0] } };

  const rows = await MatchStat.aggregate([
    { $match: { academyId: new mongoose.Types.ObjectId(String(academyId)), templateKey: template.key, sport: template.sport } },
    { $group: { _id: '$playerId', value: valueExpr, matches: { $sum: 1 } } },
    { $match: { value: { $ne: null, $gt: 0 } } },
    { $sort: { value: -1, matches: 1 } },
    { $limit: 10 },
    { $lookup: { from: 'players', localField: '_id', foreignField: '_id', as: 'p' } },
    { $unwind: '$p' },
    { $project: { _id: 0, playerId: { $toString: '$_id' }, fullName: '$p.fullName', image_url: '$p.image_url', value: 1, matches: 1 } },
  ]);
  // نفس تقريب ملف اللاعب (Math.round) بدل تقريب Mongo لأقرب زوجي.
  for (const r of rows) r.value = Math.round(r.value * 10) / 10;
  return {
    sport: template.sport,
    template,
    field: { key: field.key, label: field.label, agg: field.agg },
    fields: [...leaderFields.map((f) => ({ key: f.key, label: f.label })), { key: 'rating', label: 'التقييم' }],
    rows,
  };
}

// ─── GET /match-stats/leaderboard?sport=&field= ─────────────────────────────
const getLeaderboard = async (req, res, next) => {
  const academyId = resolveAcademyId(req);
  if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  let { sport } = req.query;
  if (!sport) {
    const academy = await Academy.findById(academyId).select('sports');
    sport = academy?.sports?.[0] || 'كرة سلة';
  }
  return sendSuccess(res, { data: await leaderboardPayload(academyId, sport, req.query.field), message: 'ترتيب الأكاديمية' });
};

// ─── بوابة اللاعب: GET /player/stats , GET /player/leaderboard ──────────────
const getMyStats = async (req, res) => {
  const player = await Player.findById(req.player._id).select('fullName sport academyId');
  return sendSuccess(res, { data: await playerStatsPayload(player), message: 'إحصائياتي' });
};

const getMyLeaderboard = async (req, res) => {
  const player = await Player.findById(req.player._id).select('sport academyId');
  return sendSuccess(res, {
    data: await leaderboardPayload(player.academyId, player.sport || 'كرة سلة', req.query.field),
    message: 'ترتيب الأكاديمية',
  });
};

module.exports = {
  getTemplates,
  getMatchStats,
  saveMatchStats,
  getPlayerStats,
  getLeaderboard,
  getMyStats,
  getMyLeaderboard,
};
