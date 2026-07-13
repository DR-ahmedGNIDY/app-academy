const Group = require('../models/group.model');
const Player = require('../models/player.model');
const Academy = require('../models/academy.model');
const AppError = require('../utils/AppError');
const { sendSuccess, sendPaginated } = require('../utils/apiResponse');
const logger = require('../utils/logger');
const { logActivity } = require('../utils/activityLogger');

// ─── Helpers ─────────────────────────────────────────────────────────────────

// يحدّد فلتر الأكاديمية حسب الدور: super_admin/admin يمرّرون academyId صراحةً،
// وغيرهم مُقيَّد حتمياً بأكاديميته.
const resolveAcademyFilter = (req) => {
  if (req.user.role === 'super_admin' || req.user.role === 'admin') {
    if (!req.query.academyId) {
      throw new AppError('معرّف الأكاديمية مطلوب', 400);
    }
    return req.query.academyId;
  }
  return req.user.academyId;
};

// حارس وصول: يمنع الوصول لمجموعة تخصّ أكاديمية أخرى.
const assertAccess = (req, group) => {
  if (
    req.user.role !== 'super_admin' &&
    req.user.role !== 'admin' &&
    group.academyId.toString() !== req.user.academyId?.toString()
  ) {
    throw new AppError('ليس لديك صلاحية للوصول إلى هذه المجموعة', 403);
  }
};

// يُرفق playersCount / occupationRate المحسوبتين وقت القراءة (لا تُخزَّنان في الوثيقة).
const withOccupancy = async (groups) => {
  const list = Array.isArray(groups) ? groups : [groups];
  if (list.length === 0) return groups;

  const groupIds = list.map((g) => g._id);
  const counts = await Player.aggregate([
    { $match: { groupId: { $in: groupIds }, isActive: true } },
    { $group: { _id: '$groupId', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [c._id.toString(), c.count]));

  const attach = (g) => {
    const obj = g.toJSON ? g.toJSON() : g;
    const playersCount = countMap.get(obj._id.toString()) || 0;
    obj.playersCount = playersCount;
    obj.occupationRate = obj.capacity ? Math.round((playersCount / obj.capacity) * 100) : null;
    return obj;
  };

  const result = list.map(attach);
  return Array.isArray(groups) ? result : result[0];
};

// ─── GET /groups ─────────────────────────────────────────────────────────────
const getGroups = async (req, res, next) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const academyId = resolveAcademyFilter(req);
  const filter = { academyId };
  if (req.query.sportId && req.query.sportId.trim().length > 0) {
    filter.sportId = req.query.sportId.trim();
  }

  const [groups, total] = await Promise.all([
    Group.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit),
    Group.countDocuments(filter),
  ]);

  const data = await withOccupancy(groups);

  return sendPaginated(res, { data, total, page, limit, message: 'تم جلب المجموعات بنجاح' });
};

// ─── GET /groups/academy/:academyId ──────────────────────────────────────────
const getGroupsByAcademy = async (req, res, next) => {
  const { academyId } = req.params;
  if (
    req.user.role !== 'super_admin' &&
    req.user.role !== 'admin' &&
    academyId !== req.user.academyId?.toString()
  ) {
    return next(new AppError('ليس لديك صلاحية للوصول إلى مجموعات هذه الأكاديمية', 403));
  }

  const filter = { academyId };
  if (req.query.sportId && req.query.sportId.trim().length > 0) {
    filter.sportId = req.query.sportId.trim();
  }

  const groups = await Group.find(filter).sort({ name: 1 });
  const data = await withOccupancy(groups);

  return sendSuccess(res, { data, message: 'تم جلب المجموعات بنجاح' });
};

// ─── GET /groups/sport/:sportId ──────────────────────────────────────────────
const getGroupsBySport = async (req, res, next) => {
  const academyId = resolveAcademyFilter(req);
  const groups = await Group.find({ academyId, sportId: req.params.sportId }).sort({ name: 1 });
  const data = await withOccupancy(groups);

  return sendSuccess(res, { data, message: 'تم جلب المجموعات بنجاح' });
};

// ─── GET /groups/:id ──────────────────────────────────────────────────────────
const getGroupById = async (req, res, next) => {
  const group = await Group.findById(req.params.id);
  if (!group) return next(new AppError('المجموعة غير موجودة', 404));

  assertAccess(req, group);

  const [withCount] = await withOccupancy([group]);
  const players = await Player.find({ groupId: group._id, isActive: true }).sort({ fullName: 1 });

  return sendSuccess(res, {
    data: { ...withCount, players },
    message: 'تم جلب بيانات المجموعة بنجاح',
  });
};

// ─── POST /groups ─────────────────────────────────────────────────────────────
const createGroup = async (req, res, next) => {
  let academyId;
  if (req.user.role === 'super_admin') {
    academyId = req.body.academyId;
    if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  } else {
    academyId = req.user.academyId;
  }

  const academy = await Academy.findById(academyId).select('sports');
  if (!academy) return next(new AppError('الأكاديمية غير موجودة', 404));
  const academySports = Array.isArray(academy.sports) && academy.sports.length > 0
    ? academy.sports
    : ['كرة سلة'];

  const groupData = {
    academyId,
    name: req.body.name,
  };

  if (academySports.length === 1) {
    groupData.sportId = academySports[0];
  } else {
    const chosen = req.body.sportId ? String(req.body.sportId).trim() : '';
    if (!chosen) return next(new AppError('الرياضة مطلوبة', 422));
    if (!academySports.includes(chosen)) {
      return next(new AppError('الرياضة المختارة غير متاحة في هذه الأكاديمية', 422));
    }
    groupData.sportId = chosen;
  }

  if (req.body.ageGroup !== undefined) groupData.ageGroup = req.body.ageGroup;
  if (req.body.capacity !== undefined) groupData.capacity = req.body.capacity;
  const group = await Group.create(groupData);

  logger.info(`Group created: ${group.name}`);
  logActivity(req, {
    actionType: 'CREATE_GROUP', entityType: 'GROUP',
    entityId: group._id, entityName: group.name, academyId: group.academyId,
  });

  return res.status(201).json({ success: true, message: 'تم إنشاء المجموعة بنجاح', data: group });
};

// ─── PATCH /groups/:id ────────────────────────────────────────────────────────
const updateGroup = async (req, res, next) => {
  const group = await Group.findById(req.params.id);
  if (!group) return next(new AppError('المجموعة غير موجودة', 404));

  assertAccess(req, group);

  const allowedFields = ['name', 'ageGroup', 'capacity', 'isActive'];
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      group[field] = req.body[field] === '' ? null : req.body[field];
    }
  }

  if (req.body.sportId !== undefined) {
    const academy = await Academy.findById(group.academyId).select('sports');
    const academySports = academy && Array.isArray(academy.sports) && academy.sports.length > 0
      ? academy.sports
      : ['كرة سلة'];
    const chosen = String(req.body.sportId).trim();
    if (chosen && !academySports.includes(chosen)) {
      return next(new AppError('الرياضة المختارة غير متاحة في هذه الأكاديمية', 422));
    }
    if (chosen) group.sportId = chosen;
  }

  await group.save();

  logger.info(`Group updated: ${group.name}`);
  logActivity(req, {
    actionType: 'UPDATE_GROUP', entityType: 'GROUP',
    entityId: group._id, entityName: group.name, academyId: group.academyId,
  });

  return sendSuccess(res, { data: group, message: 'تم تحديث بيانات المجموعة بنجاح' });
};

// ─── DELETE /groups/:id ───────────────────────────────────────────────────────
const deleteGroup = async (req, res, next) => {
  const group = await Group.findById(req.params.id);
  if (!group) return next(new AppError('المجموعة غير موجودة', 404));

  assertAccess(req, group);

  await Player.updateMany({ groupId: group._id }, { $set: { groupId: null } });
  await group.deleteOne();

  logger.info(`Group deleted: ${group.name}`);
  logActivity(req, {
    actionType: 'DELETE_GROUP', entityType: 'GROUP',
    entityId: group._id, entityName: group.name, academyId: group.academyId,
  });

  return sendSuccess(res, { message: 'تم حذف المجموعة بنجاح' });
};

module.exports = {
  getGroups,
  getGroupsByAcademy,
  getGroupsBySport,
  getGroupById,
  createGroup,
  updateGroup,
  deleteGroup,
};
