const User = require('../models/user.model');
const AcademySubscription = require('../models/academySubscription.model');
const AppError = require('../utils/AppError');
const { generateToken, generateRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { sendSuccess } = require('../utils/apiResponse');
const logger = require('../utils/logger');

// اشتراك المنصة على مستوى الأكاديمية (Academy-level) — لا يوجد اشتراك شخصي
// للمدير أو الإداري. نستخرجه دائماً من user.academyId (وليس من أي قيمة يرسلها
// العميل). يُرجع null لـ super_admin (بلا أكاديمية) وللأكاديميات التي لا تملك
// وثيقة اشتراك بعد (قبل الهجرة).
//
// إضافة بحتة: لا تغيّر أي حقل قائم في الردود ولا تكسر أي عميل قديم.
const buildSubscriptionPayload = async (user) => {
  if (!user || user.role === 'super_admin') return null;

  // academyId قد يكون مُحمَّلاً (populate) أو ObjectId خاماً.
  const academyId = user.academyId ? user.academyId._id || user.academyId : null;
  if (!academyId) return null;

  const sub = await AcademySubscription.findOne({ academyId });
  if (!sub) return null;

  return {
    // الحالة الفعلية وليست sub.status الخام — قد يبقى active في DB بعد مرور endDate.
    status: sub.effectiveStatus(),
    plan: sub.plan,
    endDate: sub.endDate,
    daysRemaining: sub.daysRemaining,
  };
};

const login = async (req, res, next) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email }).select('+password').populate('academyId', 'name');

  if (!user || !(await user.comparePassword(password))) {
    return next(new AppError('البريد الإلكتروني أو كلمة المرور غير صحيحة', 401));
  }

  if (!user.isActive) {
    return next(new AppError('تم تعطيل هذا الحساب', 403));
  }

  const token = generateToken(user._id, user.tokenVersion || 0);
  const refreshToken = generateRefreshToken(user._id, user.tokenVersion || 0);

  const subscription = await buildSubscriptionPayload(user);

  logger.info(`User logged in: ${user.email} [${user.role}]`);

  return res.status(200).json({
    success: true,
    message: 'تم تسجيل الدخول بنجاح',
    token,
    refreshToken,
    data: {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      academy_id: user.academyId ? user.academyId._id : null,
      academy_name: user.academyId ? user.academyId.name : null,
      created_at: user.created_at,
      // اشتراك الأكاديمية (Academy-level) — null لـ super_admin أو بلا وثيقة اشتراك.
      subscription,
    },
  });
};

const logout = async (req, res, next) => {
  return sendSuccess(res, { message: 'تم تسجيل الخروج بنجاح' });
};

const getMe = async (req, res, next) => {
  const user = await User.findById(req.user._id).populate('academyId', 'name');
  if (!user) return next(new AppError('المستخدم غير موجود', 404));

  const subscription = await buildSubscriptionPayload(user);

  return sendSuccess(res, {
    data: {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      academy_id: user.academyId ? user.academyId._id : null,
      academy_name: user.academyId ? user.academyId.name : null,
      created_at: user.created_at,
      // اشتراك الأكاديمية (Academy-level) — null لـ super_admin أو بلا وثيقة اشتراك.
      subscription,
    },
  });
};

// PATCH /api/v1/auth/me — current user updates own profile (name only)
const updateMe = async (req, res, next) => {
  const { name } = req.body;
  const user = await User.findById(req.user._id).populate('academyId', 'name');
  if (!user) return next(new AppError('المستخدم غير موجود', 404));

  if (name) user.name = name;
  await user.save();

  const subscription = await buildSubscriptionPayload(user);

  logger.info(`Profile updated for user: ${user.email}`);

  return sendSuccess(res, {
    message: 'تم تحديث البيانات بنجاح',
    data: {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      academy_id: user.academyId ? user.academyId._id : null,
      academy_name: user.academyId ? user.academyId.name : null,
      created_at: user.created_at,
      // اشتراك الأكاديمية (Academy-level) — null لـ super_admin أو بلا وثيقة اشتراك.
      subscription,
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
  // تغيير كلمة المرور يرفع tokenVersion فتسقط كل الجلسات القديمة (ومنها المحفوظة
  // على أجهزة أخرى). نرجّع توكنات جديدة حتى يبقى الجهاز الحالي مسجّلاً.
  return res.status(200).json({
    success: true,
    message: 'تم تغيير كلمة المرور بنجاح',
    token: generateToken(user._id, user.tokenVersion || 0),
    refreshToken: generateRefreshToken(user._id, user.tokenVersion || 0),
  });
};

module.exports = { login, logout, getMe, updateMe, changePassword };

// ─── POST /auth/refresh ───────────────────────────────────────────────────────
// يبدّل refresh token صالحاً بتوكن دخول جديد + refresh token جديد (تدوير)،
// فتبقى الجلسة المحفوظة حيّة طالما استُخدمت خلال مدة صلاحية الـ refresh (30 يوماً).
// يُرفض إذا تغيّرت كلمة المرور بعد إصداره (tokenVersion) أو عُطّل الحساب.
const refresh = async (req, res, next) => {
  const { refreshToken } = req.body;
  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch (_) {
    return next(new AppError('انتهت الجلسة — سجّل الدخول مرة أخرى', 401));
  }
  if (decoded.type && decoded.type !== 'refresh') {
    return next(new AppError('رمز التجديد غير صحيح', 401));
  }
  const user = await User.findById(decoded.id);
  if (!user) return next(new AppError('المستخدم غير موجود', 401));
  if (!user.isActive) return next(new AppError('تم تعطيل هذا الحساب', 401));
  if ((decoded.tv ?? 0) !== (user.tokenVersion ?? 0)) {
    return next(new AppError('انتهت الجلسة — سجّل الدخول مرة أخرى', 401));
  }
  return res.status(200).json({
    success: true,
    message: 'تم تجديد الجلسة',
    token: generateToken(user._id, user.tokenVersion || 0),
    refreshToken: generateRefreshToken(user._id, user.tokenVersion || 0),
  });
};

module.exports.refresh = refresh;
