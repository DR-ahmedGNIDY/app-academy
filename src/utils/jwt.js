const jwt = require('jsonwebtoken');

// tv = tokenVersion للمستخدم: تغيير كلمة المرور يرفع الرقم فتُرفض التوكنات القديمة.
const generateToken = (userId, tv = 0) => {
  return jwt.sign({ id: userId, tv }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

const generateRefreshToken = (userId, tv = 0) => {
  return jwt.sign({ id: userId, tv, type: 'refresh' }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  });
};

// توكن دخول اللاعب — نفس السر لكن يحمل type:'player' لتمييزه عن توكن المدير.
const generatePlayerToken = (playerAccountId) => {
  return jwt.sign({ id: playerAccountId, type: 'player' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

const verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET);
const verifyRefreshToken = (token) => jwt.verify(token, process.env.JWT_REFRESH_SECRET);

module.exports = {
  generateToken,
  generateRefreshToken,
  generatePlayerToken,
  verifyToken,
  verifyRefreshToken,
};
