const Evaluation = require('../models/evaluation.model');
const Player = require('../models/player.model');
const AppError = require('../utils/AppError');
const { sendSuccess, sendPaginated } = require('../utils/apiResponse');
const logger = require('../utils/logger');

// ─── Helper: verify player belongs to academy ────────────────────────────────
const verifyPlayerAcademy = async (playerId, academyId, next) => {
  const player = await Player.findById(playerId);
  if (!player) {
    next(new AppError('اللاعب غير موجود', 404));
    return null;
  }
  if (player.academyId.toString() !== academyId.toString()) {
    next(new AppError('هذا اللاعب لا ينتمي إلى أكاديميتك', 403));
    return null;
  }
  return player;
};

// ─── POST / ───────────────────────────────────────────────────────────────────
const createEvaluation = async (req, res, next) => {
  const evaluatorId = req.user._id;

  let academyId;
  if (req.user.role === 'academy_admin') {
    academyId = req.user.academyId;
  } else {
    academyId = req.body.academyId;
    if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  }

  const { playerId, evaluationDate, fitness, basicSkills, attack, defense, commitment, notes } = req.body;

  // Verify player belongs to this academy
  const player = await verifyPlayerAcademy(playerId, academyId, next);
  if (!player) return;

  const evaluation = await Evaluation.create({
    academyId,
    playerId,
    evaluatorId,
    evaluationDate: evaluationDate || Date.now(),
    fitness,
    basicSkills,
    attack,
    defense,
    commitment,
    notes,
  });

  logger.info(`Evaluation created for player: ${player.playerCode} by evaluator: ${evaluatorId}`);
  return sendSuccess(res, { data: evaluation, message: 'تم إنشاء التقييم بنجاح', statusCode: 201 });
};

// ─── GET /player/:playerId ────────────────────────────────────────────────────
const getEvaluationsByPlayer = async (req, res, next) => {
  const { playerId } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const skip = (page - 1) * limit;

  // Academy admin: verify player belongs to their academy
  if (req.user.role === 'academy_admin') {
    const player = await verifyPlayerAcademy(playerId, req.user.academyId, next);
    if (!player) return;
  } else {
    // super_admin: just verify player exists
    const player = await Player.findById(playerId);
    if (!player) return next(new AppError('اللاعب غير موجود', 404));
  }

  const filter = { playerId };

  const [evaluations, total] = await Promise.all([
    Evaluation.find(filter)
      .sort({ evaluationDate: -1 })
      .skip(skip)
      .limit(limit)
      .populate('evaluatorId', 'name role'),
    Evaluation.countDocuments(filter),
  ]);

  return sendPaginated(res, {
    data: evaluations,
    total,
    page,
    limit,
    message: 'تم جلب تقييمات اللاعب بنجاح',
  });
};

// ─── GET /player/:playerId/latest ─────────────────────────────────────────────
const getLatestEvaluation = async (req, res, next) => {
  const { playerId } = req.params;

  // Academy admin: verify player belongs to their academy
  if (req.user.role === 'academy_admin') {
    const player = await verifyPlayerAcademy(playerId, req.user.academyId, next);
    if (!player) return;
  } else {
    // super_admin: just verify player exists
    const player = await Player.findById(playerId);
    if (!player) return next(new AppError('اللاعب غير موجود', 404));
  }

  const evaluation = await Evaluation.findOne({ playerId })
    .sort({ evaluationDate: -1 })
    .limit(1)
    .populate('evaluatorId', 'name');

  // Return null data (not 404) when no evaluation exists
  return sendSuccess(res, {
    data: evaluation || null,
    message: evaluation ? 'تم جلب آخر تقييم بنجاح' : 'لا يوجد تقييم لهذا اللاعب',
  });
};

// ─── GET /:id ─────────────────────────────────────────────────────────────────
const getEvaluationById = async (req, res, next) => {
  const evaluation = await Evaluation.findById(req.params.id)
    .populate('evaluatorId', 'name')
    .populate('playerId', 'fullName playerCode');

  if (!evaluation) return next(new AppError('التقييم غير موجود', 404));

  // Access check for academy_admin
  if (req.user.role === 'academy_admin' &&
      evaluation.academyId.toString() !== req.user.academyId?.toString()) {
    return next(new AppError('ليس لديك صلاحية للوصول إلى هذا التقييم', 403));
  }

  return sendSuccess(res, { data: evaluation, message: 'تم جلب التقييم بنجاح' });
};

// ─── PUT /:id ─────────────────────────────────────────────────────────────────
const updateEvaluation = async (req, res, next) => {
  const evaluation = await Evaluation.findById(req.params.id);
  if (!evaluation) return next(new AppError('التقييم غير موجود', 404));

  // Access check
  if (req.user.role === 'academy_admin' &&
      evaluation.academyId.toString() !== req.user.academyId?.toString()) {
    return next(new AppError('ليس لديك صلاحية لتعديل هذا التقييم', 403));
  }

  const allowedFields = ['fitness', 'basicSkills', 'attack', 'defense', 'commitment', 'notes', 'evaluationDate'];
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      evaluation[field] = req.body[field];
    }
  }

  // average is recalculated by the pre('save') hook
  await evaluation.save();

  logger.info(`Evaluation updated: ${evaluation._id}`);
  return sendSuccess(res, { data: evaluation, message: 'تم تحديث التقييم بنجاح' });
};

// ─── DELETE /:id ──────────────────────────────────────────────────────────────
const deleteEvaluation = async (req, res, next) => {
  const evaluation = await Evaluation.findById(req.params.id);
  if (!evaluation) return next(new AppError('التقييم غير موجود', 404));

  // Access check
  if (req.user.role === 'academy_admin' &&
      evaluation.academyId.toString() !== req.user.academyId?.toString()) {
    return next(new AppError('ليس لديك صلاحية لحذف هذا التقييم', 403));
  }

  await Evaluation.findByIdAndDelete(req.params.id);

  logger.info(`Evaluation deleted: ${req.params.id}`);
  return sendSuccess(res, { message: 'تم حذف التقييم بنجاح' });
};

// ─── GET /academy/:academyId ──────────────────────────────────────────────────
const getEvaluationsByAcademy = async (req, res, next) => {
  const academyId = req.user.role === 'academy_admin'
    ? req.user.academyId
    : req.params.academyId;

  if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const skip = (page - 1) * limit;

  // Optional date range filters
  const dateFilter = {};
  if (req.query.startDate) dateFilter.$gte = new Date(req.query.startDate);
  if (req.query.endDate) dateFilter.$lte = new Date(req.query.endDate);

  const query = { academyId };
  if (Object.keys(dateFilter).length) query.created_at = dateFilter;

  const [evaluations, total] = await Promise.all([
    Evaluation.find(query)
      .populate('playerId', 'fullName playerCode')
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit),
    Evaluation.countDocuments(query),
  ]);

  return sendPaginated(res, {
    data: evaluations,
    total,
    page,
    limit,
    message: 'تم جلب التقييمات بنجاح',
  });
};

module.exports = {
  createEvaluation,
  getEvaluationsByPlayer,
  getLatestEvaluation,
  getEvaluationById,
  updateEvaluation,
  deleteEvaluation,
  getEvaluationsByAcademy,
};
