const DeviceToken = require('../models/deviceToken.model');
const { sendSuccess } = require('../utils/apiResponse');
const AppError = require('../utils/AppError');

const PLATFORMS = ['android', 'ios', 'web'];

// تسجيل/تحديث توكن جهاز. نفس التوكن ينتقل لصاحب الجلسة الحالية (جهاز واحد قد
// يُستخدم لعدة حسابات بالتناوب) فلا تصل إشعارات الحساب السابق لهذا الجهاز.
const upsert = async (token, owner, platform) => {
  if (!token || typeof token !== 'string' || token.length > 4096) {
    throw new AppError('توكن الجهاز غير صحيح', 400);
  }
  await DeviceToken.findOneAndUpdate(
    { token },
    {
      token,
      ...owner,
      platform: PLATFORMS.includes(platform) ? platform : 'android',
      lastSeenAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

// POST /notifications/device-token  (مدير/موظف)
const registerUserToken = async (req, res) => {
  await upsert(
    req.body.token,
    { ownerType: 'user', ownerId: req.user._id, academyId: req.user.academyId || null },
    req.body.platform
  );
  return sendSuccess(res, { message: 'تم تسجيل الجهاز للإشعارات' });
};

// POST /player/device-token  (لاعب)
const registerPlayerToken = async (req, res) => {
  await upsert(
    req.body.token,
    { ownerType: 'player', ownerId: req.player._id, academyId: req.player.academyId || null },
    req.body.platform
  );
  return sendSuccess(res, { message: 'تم تسجيل الجهاز للإشعارات' });
};

// DELETE .../device-token — عند تسجيل الخروج، حتى لا تصل إشعارات الحساب للجهاز.
const removeToken = async (req, res) => {
  if (req.body && typeof req.body.token === 'string') {
    await DeviceToken.deleteOne({ token: req.body.token });
  }
  return sendSuccess(res, { message: 'تم إلغاء تسجيل الجهاز' });
};

module.exports = { registerUserToken, registerPlayerToken, removeToken };
