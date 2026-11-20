const Academy = require('../models/academy.model');
const RegistrationRequest = require('../models/registrationRequest.model');
const AppError = require('../utils/AppError');
const { sendSuccess } = require('../utils/apiResponse');
const logger = require('../utils/logger');
const { newJoinCode } = require('../utils/registrationForm');
const { createPlayer } = require('./player.controller');

/** القاعدة الموحّدة: super_admin يمرّر academyId؛ غيره مُقيَّد بأكاديميته. */
function resolveAcademyId(req) {
  if (req.user.role === 'super_admin') return req.query.academyId || req.body?.academyId || null;
  return req.user.academyId?.toString() || null;
}

const joinUrl = (req, code) => (code ? `${req.protocol}://${req.get('host')}/join/${code}` : null);

/** كود فريد جديد (يعيد المحاولة نادراً عند التصادم). */
async function uniqueJoinCode() {
  for (let i = 0; i < 5; i++) {
    const code = newJoinCode();
    // eslint-disable-next-line no-await-in-loop
    if (!(await Academy.exists({ 'onlineRegistration.code': code }))) return code;
  }
  throw new AppError('تعذّر إنشاء رابط — حاول مرة أخرى', 500);
}

function settingsPayload(req, academy, pendingCount) {
  const reg = academy.onlineRegistration || {};
  return {
    enabled: Boolean(reg.enabled),
    code: reg.code || null,
    url: joinUrl(req, reg.code),
    sports: reg.sports || [],
    welcomeMessage: reg.welcomeMessage || '',
    academySports: academy.sports?.length ? academy.sports : ['كرة سلة'],
    pendingCount,
  };
}

// ─── GET /registration-requests/settings ─────────────────────────────────────
const getSettings = async (req, res, next) => {
  const academyId = resolveAcademyId(req);
  if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  const academy = await Academy.findById(academyId).select('sports onlineRegistration');
  if (!academy) return next(new AppError('الأكاديمية غير موجودة', 404));
  const pendingCount = await RegistrationRequest.countDocuments({ academyId, status: 'pending' });
  return sendSuccess(res, { data: settingsPayload(req, academy, pendingCount), message: 'إعدادات التسجيل الأونلاين' });
};

// ─── PATCH /registration-requests/settings ───────────────────────────────────
// body: { enabled?, sports?, welcomeMessage?, regenerate? }
const updateSettings = async (req, res, next) => {
  const academyId = resolveAcademyId(req);
  if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  const academy = await Academy.findById(academyId).select('sports onlineRegistration');
  if (!academy) return next(new AppError('الأكاديمية غير موجودة', 404));

  const reg = academy.onlineRegistration || {};
  if (req.body.enabled !== undefined) reg.enabled = Boolean(req.body.enabled);
  if (Array.isArray(req.body.sports)) {
    const all = academy.sports?.length ? academy.sports : ['كرة سلة'];
    reg.sports = req.body.sports.map((s) => String(s).trim()).filter((s) => all.includes(s));
  }
  if (req.body.welcomeMessage !== undefined) {
    reg.welcomeMessage = String(req.body.welcomeMessage || '').trim().slice(0, 300);
  }
  // كود عند أول تفعيل، أو عند طلب رابط جديد (الرابط القديم يتوقف).
  if ((reg.enabled && !reg.code) || req.body.regenerate === true) reg.code = await uniqueJoinCode();
  academy.onlineRegistration = reg;
  await academy.save();

  const pendingCount = await RegistrationRequest.countDocuments({ academyId, status: 'pending' });
  return sendSuccess(res, { data: settingsPayload(req, academy, pendingCount), message: 'تم حفظ إعدادات التسجيل الأونلاين' });
};

// ─── GET /registration-requests?status=pending ───────────────────────────────
const listRequests = async (req, res, next) => {
  const academyId = resolveAcademyId(req);
  if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  const status = ['pending', 'accepted', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const [items, counts] = await Promise.all([
    RegistrationRequest.find({ academyId, status }).sort({ created_at: -1 }).limit(300),
    RegistrationRequest.aggregate([
      { $match: { academyId: new (require('mongoose').Types.ObjectId)(academyId) } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
  ]);
  const byStatus = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  return sendSuccess(res, {
    data: {
      items,
      counts: { pending: byStatus.pending || 0, accepted: byStatus.accepted || 0, rejected: byStatus.rejected || 0 },
    },
    message: 'طلبات التسجيل',
  });
};

/** يحجز الطلب ذرّياً (pending → processing) لمنع القبول/الرفض المزدوج. */
async function claimRequest(req, next) {
  const academyId = resolveAcademyId(req);
  if (!academyId) { next(new AppError('معرّف الأكاديمية مطلوب', 400)); return null; }
  const claimed = await RegistrationRequest.findOneAndUpdate(
    { _id: req.params.id, academyId, status: 'pending' },
    { $set: { status: 'processing' } },
    { new: true }
  );
  if (!claimed) {
    const exists = await RegistrationRequest.exists({ _id: req.params.id, academyId });
    next(new AppError(exists ? 'الطلب تمت معالجته بالفعل' : 'الطلب غير موجود', exists ? 409 : 404));
    return null;
  }
  return claimed;
}

const release = (request) => RegistrationRequest.updateOne({ _id: request._id, status: 'processing' }, { $set: { status: 'pending' } });

// ─── POST /registration-requests/:id/accept  body: { groupId? } ─────────────
/**
 * ينشئ اللاعب بنفس منطق "إضافة لاعب" (الرياضة، كود اللاعب، حساب البوابة،
 * سجل النشاط). حد عدد اللاعبين مُطبَّق قبلها بـ enforcePlayerLimit.
 * الرد = رد إضافة اللاعب + الطلب بعد القبول.
 */
const acceptRequest = async (req, res, next) => {
  const request = await claimRequest(req, next);
  if (!request) return;

  const groupId = req.body?.groupId || undefined;
  req.body = {
    fullName: request.playerName,
    birthDate: request.birthDate,
    parentName: request.parentName,
    parentRelationship: request.parentRelationship,
    parentPhone: request.parentPhone,
    ...(request.playerPhone ? { playerPhone: request.playerPhone } : {}),
    ...(request.notes ? { notes: request.notes } : {}),
    ...(request.sport ? { sport: request.sport } : {}),
    ...(groupId ? { groupId } : {}),
    ...(req.user.role === 'super_admin' ? { academyId: request.academyId.toString() } : {}),
  };

  // نستدعي createPlayer بـ res وسيط لنلتقط النتيجة ثم نُكمل الطلب.
  let captured = null;
  const proxyRes = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { captured = { status: this.statusCode, body }; return this; },
  };
  let failure = null;
  try {
    await createPlayer(req, proxyRes, (err) => { failure = err; });
  } catch (err) {
    failure = err;
  }
  if (failure || !captured || captured.status >= 300) {
    await release(request);
    if (failure) return next(failure);
    return res.status(captured?.status || 500).json(captured?.body || { success: false, message: 'تعذّر إنشاء اللاعب' });
  }

  const player = captured.body.data;
  request.status = 'accepted';
  request.playerId = player._id;
  request.handledByName = req.user?.name || '';
  request.handledAt = new Date();
  await request.save();
  logger.info(`[JOIN] request ${request._id} accepted → player ${player.playerCode}`);

  return res.status(201).json({ ...captured.body, request, message: 'تم قبول الطلب وإضافة اللاعب' });
};

// ─── POST /registration-requests/:id/reject  body: { reason? } ──────────────
const rejectRequest = async (req, res, next) => {
  const request = await claimRequest(req, next);
  if (!request) return;
  request.status = 'rejected';
  request.rejectReason = String(req.body?.reason || '').trim().slice(0, 200);
  request.handledByName = req.user?.name || '';
  request.handledAt = new Date();
  await request.save();
  return sendSuccess(res, { data: request, message: 'تم رفض الطلب' });
};

module.exports = { getSettings, updateSettings, listRequests, acceptRequest, rejectRequest };
