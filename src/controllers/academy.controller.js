const Academy = require('../models/academy.model');
const AppError = require('../utils/AppError');
const { sendSuccess } = require('../utils/apiResponse');
const { deleteImage } = require('../config/cloudinary');
const logger = require('../utils/logger');

const getAcademies = async (req, res, next) => {
  let query = { isActive: true };

  if (req.user.role === 'academy_admin') {
    query._id = req.user.academyId;
  }

  const academies = await Academy.find(query)
    .populate('player_count')
    .sort({ created_at: -1 });

  return sendSuccess(res, { data: academies, message: 'تم جلب الأكاديميات بنجاح' });
};

const getAcademyById = async (req, res, next) => {
  const academy = await Academy.findById(req.params.id).populate('player_count');

  if (!academy) return next(new AppError('الأكاديمية غير موجودة', 404));

  if (req.user.role === 'academy_admin' &&
      academy._id.toString() !== req.user.academyId?.toString()) {
    return next(new AppError('ليس لديك صلاحية للوصول إلى هذه الأكاديمية', 403));
  }

  return sendSuccess(res, { data: academy });
};

const createAcademy = async (req, res, next) => {
  const { name, phone, address } = req.body;

  const academy = await Academy.create({
    name,
    phone,
    address,
    logo_url: req.file ? req.file.path : null,
    logo_public_id: req.file ? req.file.filename : null,
  });

  logger.info(`Academy created: ${academy.name} by ${req.user.email}`);
  return sendSuccess(res, { data: academy, message: 'تم إنشاء الأكاديمية بنجاح', statusCode: 201 });
};

const updateAcademy = async (req, res, next) => {
  const academy = await Academy.findById(req.params.id).select('+logo_public_id');
  if (!academy) return next(new AppError('الأكاديمية غير موجودة', 404));

  if (req.user.role === 'academy_admin' &&
      academy._id.toString() !== req.user.academyId?.toString()) {
    return next(new AppError('ليس لديك صلاحية لتعديل هذه الأكاديمية', 403));
  }

  if (req.file) {
    if (academy.logo_public_id) {
      await deleteImage(academy.logo_public_id).catch(() => {});
    }
    academy.logo_url = req.file.path;
    academy.logo_public_id = req.file.filename;
  }

  if (req.body.name) academy.name = req.body.name;
  if (req.body.phone) academy.phone = req.body.phone;
  if (req.body.address) academy.address = req.body.address;

  await academy.save();
  logger.info(`Academy updated: ${academy.name} by ${req.user.email}`);
  return sendSuccess(res, { data: academy, message: 'تم تحديث الأكاديمية بنجاح' });
};

const deleteAcademy = async (req, res, next) => {
  const academy = await Academy.findById(req.params.id).select('+logo_public_id');
  if (!academy) return next(new AppError('الأكاديمية غير موجودة', 404));

  if (academy.logo_public_id) {
    await deleteImage(academy.logo_public_id).catch(() => {});
  }

  academy.isActive = false;
  await academy.save();

  logger.info(`Academy deleted: ${academy.name} by ${req.user.email}`);
  return sendSuccess(res, { message: 'تم حذف الأكاديمية بنجاح' });
};

const deleteAcademyLogo = async (req, res, next) => {
  const academy = await Academy.findById(req.params.id).select('+logo_public_id');
  if (!academy) return next(new AppError('الأكاديمية غير موجودة', 404));
  if (!academy.logo_public_id) return next(new AppError('لا توجد صورة لحذفها', 400));

  await deleteImage(academy.logo_public_id);
  academy.logo_url = null;
  academy.logo_public_id = null;
  await academy.save();

  return sendSuccess(res, { message: 'تم حذف الشعار بنجاح' });
};

module.exports = { getAcademies, getAcademyById, createAcademy, updateAcademy, deleteAcademy, deleteAcademyLogo };
