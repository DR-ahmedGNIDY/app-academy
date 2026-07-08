const AppError = require('../utils/AppError');
const { verifyToken } = require('../utils/jwt');
const PlayerAccount = require('../models/playerAccount.model');

// حماية مسارات اللاعب: يتحقق من توكن اللاعب (type:'player') ويحمّل حساب اللاعب.
// منفصل تماماً عن protect الخاص بالمدراء حتى لا يتداخل النظامان.
const protectPlayer = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(new AppError('يجب تسجيل الدخول للوصول إلى هذا المورد', 401));
  }

  try {
    const decoded = verifyToken(token);
    if (decoded.type !== 'player') {
      return next(new AppError('رمز التحقق غير صالح لهذا المورد', 401));
    }

    const account = await PlayerAccount.findById(decoded.id).populate('playerId');
    if (!account) return next(new AppError('الحساب غير موجود', 401));
    if (!account.isActive) return next(new AppError('تم تعطيل هذا الحساب', 401));
    if (!account.playerId) return next(new AppError('اللاعب غير موجود', 401));

    req.playerAccount = account;
    req.player = account.playerId; // وثيقة اللاعب المُحمَّلة
    next();
  } catch (error) {
    return next(new AppError('رمز التحقق غير صحيح أو منتهي الصلاحية', 401));
  }
};

module.exports = { protectPlayer };
