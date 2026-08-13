const AcademyAlbum = require('../models/academyAlbum.model');
const AppError = require('../utils/AppError');
const { sendSuccess, sendPaginated } = require('../utils/apiResponse');
const { deleteImage } = require('../config/cloudinary');
const logger = require('../utils/logger');
const { logActivity } = require('../utils/activityLogger');

// نفس نمط المجموعات/اللاعبين: super_admin وحده يمرّر academyId صراحةً،
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

// حارس وصول لصورة تخصّ أكاديمية أخرى. super_admin وحده يتجاوز القيد.
// يعمل لكل من حسابات المدراء (req.user) وحسابات اللاعبين (req.player).
const assertAccess = (req, item) => {
  if (req.player) {
    if (item.academyId.toString() !== req.player.academyId?.toString()) {
      throw new AppError('ليس لديك صلاحية للوصول إلى هذا العنصر', 403);
    }
    return;
  }
  if (
    req.user.role !== 'super_admin' &&
    item.academyId.toString() !== req.user.academyId?.toString()
  ) {
    throw new AppError('ليس لديك صلاحية للوصول إلى هذا العنصر', 403);
  }
};

// هوية صاحب الطلب (لاعب أو حساب إداري) — مصدر وحيد يُستخدم في اللايك/الكومنت.
const getRequester = (req) => {
  if (req.player) {
    return { userType: 'player', userId: req.player.id, name: req.player.fullName };
  }
  return { userType: 'admin', userId: req.user.id, name: req.user.name };
};

// يحوّل مستند الألبوم الخام إلى شكل العميل: عدّاد لايك + isLiked + تعليقات مرتّبة.
const toClientItem = (item, requester) => {
  const json = item.toJSON();
  const likes = json.likes || [];
  const comments = json.comments || [];

  json.likesCount = likes.length;
  json.isLiked = likes.some(
    (l) => l.userType === requester.userType && l.userId === String(requester.userId)
  );
  json.commentsCount = comments.length;
  json.comments = comments
    .map((c) => ({
      id: c._id,
      userType: c.userType,
      authorName: c.authorName,
      text: c.text,
      created_at: c.created_at,
      isMine: c.userType === requester.userType && c.userId === String(requester.userId),
    }))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  delete json.likes;
  return json;
};

// صفحة موحّدة لجلب ألبوم أكاديمية معيّنة (Pagination + Lazy Loading).
const paginateAlbum = async (academyId, req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const requester = getRequester(req);

  const [items, total] = await Promise.all([
    AcademyAlbum.find({ academyId })
      .sort({ order: 1, created_at: -1 })
      .skip(skip)
      .limit(limit),
    AcademyAlbum.countDocuments({ academyId }),
  ]);

  return sendPaginated(res, {
    data: items.map((i) => toClientItem(i, requester)),
    total,
    page,
    limit,
    message: 'تم جلب ألبوم الأكاديمية بنجاح',
  });
};

// ─── GET /academy-album (جهة المدير) ─────────────────────────────────────────
const getAlbum = async (req, res, next) => {
  const academyId = resolveAcademyFilter(req);
  return paginateAlbum(academyId, req, res);
};

// ─── GET /player/album (جهة اللاعب — قراءة فقط لأكاديميته) ────────────────────
const getPlayerAlbum = async (req, res, next) => {
  // req.player من protectPlayer — عزل صارم: أكاديمية اللاعب فقط.
  return paginateAlbum(req.player.academyId, req, res);
};

// ─── POST /academy-album ─────────────────────────────────────────────────────
const createAlbumImage = async (req, res, next) => {
  const academyId = resolveAcademyFilter(req);
  if (!req.file) return next(new AppError('الصورة مطلوبة', 400));

  const title = String(req.body.title || '').trim();
  if (!title) return next(new AppError('العنوان مطلوب', 400));

  const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';

  const item = await AcademyAlbum.create({
    academyId,
    title,
    description: String(req.body.description || '').trim(),
    image_url: req.file.path,
    image_public_id: req.file.filename,
    mediaType,
  });

  logger.info(`Album ${mediaType} added: ${item._id} (academy ${academyId})`);
  logActivity(req, {
    actionType: 'CREATE_ALBUM_IMAGE', entityType: 'ALBUM',
    entityId: item._id, entityName: title, academyId,
  });
  return sendSuccess(res, {
    data: toClientItem(item, getRequester(req)),
    message: mediaType === 'video' ? 'تمت إضافة الفيديو بنجاح' : 'تمت إضافة الصورة بنجاح',
    statusCode: 201,
  });
};

// ─── PATCH /academy-album/:id (تعديل العنوان/الوصف) ──────────────────────────
const updateAlbumImage = async (req, res, next) => {
  const item = await AcademyAlbum.findById(req.params.id);
  if (!item) return next(new AppError('الصورة غير موجودة', 404));
  assertAccess(req, item);

  if (req.body.title !== undefined) {
    const title = String(req.body.title).trim();
    if (!title) return next(new AppError('العنوان مطلوب', 400));
    item.title = title;
  }
  if (req.body.description !== undefined) {
    item.description = String(req.body.description).trim();
  }
  await item.save();

  logActivity(req, {
    actionType: 'UPDATE_ALBUM_IMAGE', entityType: 'ALBUM',
    entityId: item._id, entityName: item.title, academyId: item.academyId,
  });
  return sendSuccess(res, { data: toClientItem(item, getRequester(req)), message: 'تم تحديث الصورة بنجاح' });
};

// ─── DELETE /academy-album/:id ───────────────────────────────────────────────
const deleteAlbumImage = async (req, res, next) => {
  const item = await AcademyAlbum.findById(req.params.id).select('+image_public_id');
  if (!item) return next(new AppError('الصورة غير موجودة', 404));
  assertAccess(req, item);

  if (item.image_public_id) {
    await deleteImage(item.image_public_id, item.mediaType === 'video' ? 'video' : 'image').catch(() => {});
  }
  await item.deleteOne();

  logActivity(req, {
    actionType: 'DELETE_ALBUM_IMAGE', entityType: 'ALBUM',
    entityId: item._id, entityName: item.title, academyId: item.academyId,
  });
  return sendSuccess(res, { message: 'تم حذف الصورة بنجاح' });
};

// ─── PATCH /academy-album/reorder ────────────────────────────────────────────
const reorderAlbum = async (req, res, next) => {
  const academyId = resolveAcademyFilter(req);
  const ids = Array.isArray(req.body.ids) ? req.body.ids : null;
  if (!ids || ids.length === 0) {
    return next(new AppError('قائمة المعرّفات مطلوبة', 400));
  }

  // نحدّث ترتيب صور هذه الأكاديمية فقط — عزل صارم عبر academyId في الفلتر.
  await Promise.all(
    ids.map((id, index) =>
      AcademyAlbum.updateOne({ _id: id, academyId }, { $set: { order: index } })
    )
  );

  return sendSuccess(res, { message: 'تم تحديث ترتيب الصور بنجاح' });
};

// ─── POST /:id/like (تبديل إعجاب — لاعب أو حساب إداري) ───────────────────────
const toggleLike = async (req, res, next) => {
  const item = await AcademyAlbum.findById(req.params.id);
  if (!item) return next(new AppError('العنصر غير موجود', 404));
  assertAccess(req, item);

  const requester = getRequester(req);
  const idx = item.likes.findIndex(
    (l) => l.userType === requester.userType && l.userId.toString() === String(requester.userId)
  );

  if (idx === -1) {
    item.likes.push({ userType: requester.userType, userId: requester.userId });
  } else {
    item.likes.splice(idx, 1);
  }
  await item.save();

  return sendSuccess(res, {
    data: toClientItem(item, requester),
    message: idx === -1 ? 'تم الإعجاب' : 'تم إلغاء الإعجاب',
  });
};

// ─── POST /:id/comments (إضافة تعليق — لاعب أو حساب إداري) ───────────────────
const addComment = async (req, res, next) => {
  const item = await AcademyAlbum.findById(req.params.id);
  if (!item) return next(new AppError('العنصر غير موجود', 404));
  assertAccess(req, item);

  const text = String(req.body.text || '').trim();
  if (!text) return next(new AppError('نص التعليق مطلوب', 400));
  if (text.length > 500) return next(new AppError('التعليق لا يمكن أن يتجاوز 500 حرف', 400));

  const requester = getRequester(req);
  item.comments.push({
    userType: requester.userType,
    userId: requester.userId,
    authorName: requester.name || (requester.userType === 'player' ? 'لاعب' : 'مسؤول'),
    text,
  });
  await item.save();

  return sendSuccess(res, {
    data: toClientItem(item, requester),
    message: 'تمت إضافة التعليق بنجاح',
    statusCode: 201,
  });
};

// ─── DELETE /:id/comments/:commentId ─────────────────────────────────────────
// صاحب التعليق يحذف تعليقه؛ أما academy_admin/super_admin فيقدر يحذف أي تعليق (إشراف).
const deleteComment = async (req, res, next) => {
  const item = await AcademyAlbum.findById(req.params.id);
  if (!item) return next(new AppError('العنصر غير موجود', 404));
  assertAccess(req, item);

  const comment = item.comments.id(req.params.commentId);
  if (!comment) return next(new AppError('التعليق غير موجود', 404));

  const requester = getRequester(req);
  const isOwner =
    comment.userType === requester.userType && comment.userId.toString() === String(requester.userId);
  const isModerator =
    requester.userType === 'admin' && ['super_admin', 'academy_admin'].includes(req.user.role);

  if (!isOwner && !isModerator) {
    return next(new AppError('لا يمكنك حذف تعليق غير خاص بك', 403));
  }

  comment.deleteOne();
  await item.save();

  return sendSuccess(res, { data: toClientItem(item, requester), message: 'تم حذف التعليق بنجاح' });
};

module.exports = {
  getAlbum,
  getPlayerAlbum,
  createAlbumImage,
  updateAlbumImage,
  deleteAlbumImage,
  reorderAlbum,
  toggleLike,
  addComment,
  deleteComment,
};
