const Match = require('../models/match.model');
const Player = require('../models/player.model');
const AppError = require('../utils/AppError');
const { sendSuccess, sendPaginated } = require('../utils/apiResponse');
const logger = require('../utils/logger');
const { logActivity } = require('../utils/activityLogger');
const { notify } = require('../utils/notificationService');

// نفس نمط الألبوم/المتجر/المجموعات: super_admin وحده يمرّر academyId صراحةً،
// وكل من عداه مُقيَّد حتمياً بأكاديميته.
const resolveAcademyFilter = (req) => {
  if (req.user.role === 'super_admin') {
    if (!req.query.academyId) {
      throw new AppError('معرّف الأكاديمية مطلوب', 400);
    }
    return req.query.academyId;
  }
  return req.user.academyId;
};

const assertAccess = (req, match) => {
  if (
    req.user.role !== 'super_admin' &&
    match.academyId.toString() !== req.user.academyId?.toString()
  ) {
    throw new AppError('ليس لديك صلاحية للوصول إلى هذه المباراة', 403);
  }
};

// ─── GET /matches ─────────────────────────────────────────────────────────────
const getMatches = async (req, res, next) => {
  const academyId = resolveAcademyFilter(req);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const filter = { academyId };
  if (req.query.sport) filter.sport = req.query.sport;

  const [items, total] = await Promise.all([
    Match.find(filter)
      .sort({ date: -1, time: -1 })
      .skip(skip)
      .limit(limit),
    Match.countDocuments(filter),
  ]);

  return sendPaginated(res, {
    data: items.map((i) => i.toJSON()),
    total,
    page,
    limit,
    message: 'تم جلب المباريات بنجاح',
  });
};

// ─── GET /matches/:id ──────────────────────────────────────────────────────────
const getMatch = async (req, res, next) => {
  const match = await Match.findById(req.params.id);
  if (!match) return next(new AppError('المباراة غير موجودة', 404));
  assertAccess(req, match);

  const players = await Player.find({ _id: { $in: match.playerIds } }).select(
    'fullName playerCode image_url parentPhone parentName'
  );

  return sendSuccess(res, {
    data: { match: match.toJSON(), players: players.map((p) => p.toJSON()) },
    message: 'تم جلب تفاصيل المباراة بنجاح',
  });
};

// ─── POST /matches ─────────────────────────────────────────────────────────────
const createMatch = async (req, res, next) => {
  const academyId =
    req.user.role === 'super_admin' && req.body.academyId
      ? req.body.academyId
      : req.user.academyId;

  const match = await Match.create({
    academyId,
    sport: req.body.sport || null,
    name: String(req.body.name || '').trim(),
    location: String(req.body.location || '').trim(),
    date: req.body.date,
    time: req.body.time,
    notes: String(req.body.notes || '').trim(),
  });

  logger.info(`Match created: ${match._id} (academy ${academyId})`);
  logActivity(req, {
    actionType: 'CREATE_MATCH', entityType: 'MATCH',
    entityId: match._id, entityName: match.name, academyId,
  });
  return sendSuccess(res, {
    data: match.toJSON(),
    message: 'تم إنشاء المباراة بنجاح',
    statusCode: 201,
  });
};

// ─── PUT /matches/:id ──────────────────────────────────────────────────────────
const updateMatch = async (req, res, next) => {
  const match = await Match.findById(req.params.id);
  if (!match) return next(new AppError('المباراة غير موجودة', 404));
  assertAccess(req, match);

  const allowed = ['name', 'location', 'date', 'time', 'notes', 'sport'];
  allowed.forEach((field) => {
    if (req.body[field] !== undefined) {
      match[field] = typeof req.body[field] === 'string' ? req.body[field].trim() : req.body[field];
    }
  });
  await match.save();

  logActivity(req, {
    actionType: 'UPDATE_MATCH', entityType: 'MATCH',
    entityId: match._id, entityName: match.name, academyId: match.academyId,
  });
  return sendSuccess(res, { data: match.toJSON(), message: 'تم تحديث المباراة بنجاح' });
};

// ─── DELETE /matches/:id ───────────────────────────────────────────────────────
const deleteMatch = async (req, res, next) => {
  const match = await Match.findById(req.params.id);
  if (!match) return next(new AppError('المباراة غير موجودة', 404));
  assertAccess(req, match);

  await match.deleteOne();

  logActivity(req, {
    actionType: 'DELETE_MATCH', entityType: 'MATCH',
    entityId: match._id, entityName: match.name, academyId: match.academyId,
  });
  return sendSuccess(res, { message: 'تم حذف المباراة بنجاح' });
};

// ─── POST /matches/:id/players ─────────────────────────────────────────────────
const addPlayers = async (req, res, next) => {
  const match = await Match.findById(req.params.id);
  if (!match) return next(new AppError('المباراة غير موجودة', 404));
  assertAccess(req, match);

  const ids = Array.isArray(req.body.playerIds) ? req.body.playerIds : [];
  if (ids.length === 0) return next(new AppError('قائمة اللاعبين مطلوبة', 400));

  const existing = new Set(match.playerIds.map((id) => id.toString()));
  const added = ids.map(String).filter((id) => !existing.has(id));
  match.playerIds = Array.from(new Set([...existing, ...added]));
  await match.save();

  // إشعار اللاعبين المضافين حديثاً فقط (لا تكرار لمن كان مسجّلاً).
  const where = match.location ? ` في ${match.location}` : '';
  for (const playerId of added) {
    notify({
      recipientType: 'player', recipientId: playerId, academyId: match.academyId,
      type: 'MATCH_ADDED', title: 'تم تسجيلك في مباراة',
      body: `${match.name} — يوم ${match.date} الساعة ${match.time}${where}`,
      meta: { matchId: match._id.toString(), date: match.date, time: match.time },
    });
  }

  return sendSuccess(res, { data: match.toJSON(), message: 'تمت إضافة اللاعبين بنجاح' });
};

// ─── DELETE /matches/:id/players/:playerId ─────────────────────────────────────
const removePlayer = async (req, res, next) => {
  const match = await Match.findById(req.params.id);
  if (!match) return next(new AppError('المباراة غير موجودة', 404));
  assertAccess(req, match);

  match.playerIds = match.playerIds.filter(
    (id) => id.toString() !== req.params.playerId
  );
  await match.save();

  return sendSuccess(res, { data: match.toJSON(), message: 'تمت إزالة اللاعب بنجاح' });
};

// ─── POST /matches/:id/reminders/:playerId ─────────────────────────────────────
// يوثّق فقط أنه تم فتح واتساب من جهة العميل — لا يرسل رسالة فعلياً.
const logReminder = async (req, res, next) => {
  const match = await Match.findById(req.params.id);
  if (!match) return next(new AppError('المباراة غير موجودة', 404));
  assertAccess(req, match);

  match.reminderLog.push({ playerId: req.params.playerId, sentAt: new Date() });
  await match.save();

  return sendSuccess(res, { data: match.toJSON(), message: 'تم تسجيل التذكير بنجاح' });
};

// ─── GET /player/matches (بوابة اللاعب) ─────────────────────────────────────────
// مباريات اللاعب المسجّل فيها: القادمة (اليوم فما بعد) تصاعدياً، والسابقة تنازلياً.
// ?today=YYYY-MM-DD من جهاز اللاعب لأن match.date نص محلي.
const getPlayerMatches = async (req, res) => {
  const pad2 = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const today = /^\d{4}-\d{2}-\d{2}$/.test(req.query.today || '')
    ? req.query.today
    : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const matches = await Match.find({ academyId: req.player.academyId, playerIds: req.player._id })
    .select('name location date time notes sport')
    .lean();
  const toItem = (m) => ({
    _id: m._id.toString(), name: m.name, location: m.location || '',
    date: m.date, time: m.time, notes: m.notes || '', sport: m.sport || null,
  });
  const upcoming = matches.filter((m) => m.date >= today)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map(toItem);
  const past = matches.filter((m) => m.date < today)
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).slice(0, 30).map(toItem);
  return sendSuccess(res, {
    data: { upcoming, past, upcomingCount: upcoming.length },
    message: 'تم جلب المباريات بنجاح',
  });
};

module.exports = {
  getPlayerMatches,
  getMatches,
  getMatch,
  createMatch,
  updateMatch,
  deleteMatch,
  addPlayers,
  removePlayer,
  logReminder,
};
