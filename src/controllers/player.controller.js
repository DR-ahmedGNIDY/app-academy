const Player = require('../models/player.model');
const AppError = require('../utils/AppError');
const { sendSuccess, sendPaginated } = require('../utils/apiResponse');
const { deleteImage } = require('../config/cloudinary');
const logger = require('../utils/logger');

// ─── GET /players ───────────────────────────────────────────────────────────
const getPlayers = async (req, res, next) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  // Build base filter
  const filter = {};

  // Active filter (super_admin can request inactive players)
  if (req.query.showInactive === 'true' && req.user.role === 'super_admin') {
    // no isActive filter — show all
  } else {
    filter.isActive = true;
  }

  // Academy scope
  if (req.user.role === 'academy_admin') {
    filter.academyId = req.user.academyId;
  } else if (req.user.role === 'super_admin' && req.query.academyId) {
    filter.academyId = req.query.academyId;
  }

  // Birth year filter
  if (req.query.birthYear) {
    const year = parseInt(req.query.birthYear, 10);
    if (!isNaN(year)) {
      filter.birthDate = {
        $gte: new Date(`${year}-01-01`),
        $lt: new Date(`${year + 1}-01-01`),
      };
    }
  }

  // Search
  if (req.query.search && req.query.search.trim().length > 0) {
    const searchTerm = req.query.search.trim();
    try {
      // Try text index first
      filter.$text = { $search: searchTerm };
    } catch (e) {
      // Fallback to regex search
      const regex = new RegExp(searchTerm, 'i');
      filter.$or = [
        { fullName: regex },
        { playerCode: regex },
        { parentPhone: regex },
      ];
    }
  }

  const [players, total] = await Promise.all([
    Player.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit),
    Player.countDocuments(filter),
  ]);

  return sendPaginated(res, {
    data: players,
    total,
    page,
    limit,
    message: 'تم جلب اللاعبين بنجاح',
  });
};

// ─── GET /players/search ─────────────────────────────────────────────────────
const searchPlayers = async (req, res, next) => {
  const q = req.query.q ? req.query.q.trim() : '';
  if (q.length < 2) {
    return next(new AppError('يجب أن يكون نص البحث حرفين على الأقل', 400));
  }

  const regex = new RegExp(q, 'i');
  const filter = {
    isActive: true,
    $or: [
      { fullName: regex },
      { playerCode: regex },
      { parentPhone: regex },
    ],
  };

  if (req.user.role === 'academy_admin') {
    filter.academyId = req.user.academyId;
  }

  const players = await Player.find(filter).sort({ created_at: -1 }).limit(50);

  return sendSuccess(res, { data: players, message: 'تم البحث بنجاح' });
};

// ─── GET /players/:id ────────────────────────────────────────────────────────
const getPlayerById = async (req, res, next) => {
  const player = await Player.findById(req.params.id);
  if (!player) return next(new AppError('اللاعب غير موجود', 404));

  if (req.user.role === 'academy_admin' &&
      player.academyId.toString() !== req.user.academyId?.toString()) {
    return next(new AppError('ليس لديك صلاحية للوصول إلى هذا اللاعب', 403));
  }

  return sendSuccess(res, { data: player, message: 'تم جلب بيانات اللاعب بنجاح' });
};

// ─── POST /players ───────────────────────────────────────────────────────────
const createPlayer = async (req, res, next) => {
  // Determine academyId
  let academyId;
  if (req.user.role === 'academy_admin') {
    academyId = req.user.academyId;
  } else {
    academyId = req.body.academyId;
    if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  }

  const {
    fullName,
    birthDate,
    parentName,
    parentRelationship,
    parentJob,
    parentPhone,
    notes,
  } = req.body;

  const playerData = {
    academyId,
    fullName,
    birthDate,
    parentName,
    parentRelationship,
    parentPhone,
  };

  if (parentJob !== undefined) playerData.parentJob = parentJob;
  if (notes !== undefined) playerData.notes = notes;

  if (req.file) {
    playerData.image_url = req.file.path;
    playerData.image_public_id = req.file.filename;
  }

  const player = await Player.create(playerData);

  logger.info(`Player created: ${player.playerCode} - ${player.fullName}`);
  return sendSuccess(res, { data: player, message: 'تم إضافة اللاعب بنجاح', statusCode: 201 });
};

// ─── PUT /players/:id ────────────────────────────────────────────────────────
const updatePlayer = async (req, res, next) => {
  const player = await Player.findById(req.params.id).select('+image_public_id');
  if (!player) return next(new AppError('اللاعب غير موجود', 404));

  if (req.user.role === 'academy_admin' &&
      player.academyId.toString() !== req.user.academyId?.toString()) {
    return next(new AppError('ليس لديك صلاحية لتعديل هذا اللاعب', 403));
  }

  // Allowed updatable fields (playerCode is NOT updatable)
  const allowedFields = ['fullName', 'birthDate', 'parentName', 'parentRelationship', 'parentJob', 'parentPhone', 'notes'];
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      player[field] = req.body[field];
    }
  }

  // Handle image replacement
  if (req.file) {
    if (player.image_public_id) {
      await deleteImage(player.image_public_id).catch(() => {});
    }
    player.image_url = req.file.path;
    player.image_public_id = req.file.filename;
  }

  await player.save();

  logger.info(`Player updated: ${player.playerCode} - ${player.fullName}`);
  return sendSuccess(res, { data: player, message: 'تم تحديث بيانات اللاعب بنجاح' });
};

// ─── DELETE /players/:id ─────────────────────────────────────────────────────
const deletePlayer = async (req, res, next) => {
  const player = await Player.findById(req.params.id);
  if (!player) return next(new AppError('اللاعب غير موجود', 404));

  if (req.user.role === 'academy_admin' &&
      player.academyId.toString() !== req.user.academyId?.toString()) {
    return next(new AppError('ليس لديك صلاحية لحذف هذا اللاعب', 403));
  }

  player.isActive = false;
  await player.save();

  logger.info(`Player deleted (soft): ${player.playerCode} - ${player.fullName}`);
  return sendSuccess(res, { message: 'تم حذف اللاعب بنجاح' });
};

// ─── DELETE /players/:id/image ───────────────────────────────────────────────
const deletePlayerImage = async (req, res, next) => {
  const player = await Player.findById(req.params.id).select('+image_public_id');
  if (!player) return next(new AppError('اللاعب غير موجود', 404));

  if (req.user.role === 'academy_admin' &&
      player.academyId.toString() !== req.user.academyId?.toString()) {
    return next(new AppError('ليس لديك صلاحية لحذف صورة هذا اللاعب', 403));
  }

  if (!player.image_public_id) {
    return next(new AppError('لا توجد صورة لحذفها', 400));
  }

  await deleteImage(player.image_public_id);
  player.image_url = null;
  player.image_public_id = null;
  await player.save();

  return sendSuccess(res, { message: 'تم حذف صورة اللاعب بنجاح' });
};

module.exports = {
  getPlayers,
  searchPlayers,
  getPlayerById,
  createPlayer,
  updatePlayer,
  deletePlayer,
  deletePlayerImage,
};
