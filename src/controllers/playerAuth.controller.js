const PlayerAccount = require('../models/playerAccount.model');
const Academy = require('../models/academy.model');
const AppError = require('../utils/AppError');
const { generatePlayerToken } = require('../utils/jwt');
const { sendSuccess } = require('../utils/apiResponse');
const logger = require('../utils/logger');

// يبني حمولة اللاعب الموحّدة للاستجابات.
const buildPlayerPayload = (account, academyName) => {
  const player = account.playerId;
  return {
    accountId: account._id.toString(),
    username: account.username,
    playerId: player?._id?.toString() || null,
    fullName: player?.fullName || '',
    playerCode: player?.playerCode || '',
    image_url: player?.image_url || null,
    academy_id: account.academyId?.toString() || null,
    academy_name: academyName || '',
  };
};

// POST /api/v1/auth/player/login  (عام)
const playerLogin = async (req, res, next) => {
  const { username, password } = req.body;

  const account = await PlayerAccount.findOne({ username: String(username).toLowerCase().trim() })
    .select('+password')
    .populate('playerId');

  if (!account || !(await account.comparePassword(password))) {
    return next(new AppError('اسم المستخدم أو كلمة المرور غير صحيحة', 401));
  }
  if (!account.isActive) {
    return next(new AppError('تم تعطيل هذا الحساب', 403));
  }
  if (!account.playerId || account.playerId.isActive === false) {
    return next(new AppError('حساب اللاعب غير متاح', 403));
  }

  const academy = await Academy.findById(account.academyId).select('name');
  const token = generatePlayerToken(account._id);

  logger.info(`Player logged in: ${account.username}`);

  return res.status(200).json({
    success: true,
    message: 'تم تسجيل الدخول بنجاح',
    token,
    data: buildPlayerPayload(account, academy?.name),
  });
};

// GET /api/v1/auth/player/me  (protectPlayer)
const playerMe = async (req, res, next) => {
  const account = req.playerAccount;
  const academy = await Academy.findById(account.academyId).select('name');
  return sendSuccess(res, { data: buildPlayerPayload(account, academy?.name) });
};

module.exports = { playerLogin, playerMe };
