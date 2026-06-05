const User = require('../models/user.model');
const AppError = require('../utils/AppError');
const { generateToken, generateRefreshToken } = require('../utils/jwt');
const { sendSuccess } = require('../utils/apiResponse');
const logger = require('../utils/logger');

const login = async (req, res, next) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email }).select('+password').populate('academyId', 'name');

  if (!user || !(await user.comparePassword(password))) {
    return next(new AppError('البريد الإلكتروني أو كلمة المرور غير صحيحة', 401));
  }

  if (!user.isActive) {
    return next(new AppError('تم تعطيل هذا الحساب', 403));
  }

  const token = generateToken(user._id);
  const refreshToken = generateRefreshToken(user._id);

  logger.info(`User logged in: ${user.email} [${user.role}]`);

  return sendSuccess(res, {
    message: 'تم تسجيل الدخول بنجاح',
    data: {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      academy_id: user.academyId ? user.academyId._id : null,
      academy_name: user.academyId ? user.academyId.name : null,
      created_at: user.created_at,
    },
    statusCode: 200,
  });
};

const logout = async (req, res, next) => {
  return sendSuccess(res, { message: 'تم تسجيل الخروج بنجاح' });
};

const getMe = async (req, res, next) => {
  const user = await User.findById(req.user._id).populate('academyId', 'name');
  if (!user) return next(new AppError('المستخدم غير موجود', 404));

  return sendSuccess(res, {
    data: {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      academy_id: user.academyId ? user.academyId._id : null,
      academy_name: user.academyId ? user.academyId.name : null,
      created_at: user.created_at,
    },
  });
};

const changePassword = async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user._id).select('+password');

  if (!(await user.comparePassword(currentPassword))) {
    return next(new AppError('كلمة المرور الحالية غير صحيحة', 400));
  }

  user.password = newPassword;
  await user.save();

  logger.info(`Password changed for user: ${user.email}`);
  return sendSuccess(res, { message: 'تم تغيير كلمة المرور بنجاح' });
};

module.exports = { login, logout, getMe, changePassword };
