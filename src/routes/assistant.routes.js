const express = require('express');
const rateLimit = require('express-rate-limit');
const { param } = require('express-validator');
const {
  getStatus,
  getConversation,
  resetConversation,
  chat,
  reportMessage,
} = require('../controllers/assistant.controller');
const { protect, restrictTo } = require('../middleware/auth.middleware');
const validate = require('../middleware/validate');

// المساعد الذكي — لمدير الأكاديمية فقط (academy_admin). التفعيل والحد اليومي
// يتحكم فيهم Super Admin من اشتراكات المنصة.
const router = express.Router();
router.use(protect);
router.use(restrictTo('academy_admin'));

// حماية إضافية من الضغط المتتالي (الحد اليومي في الـ controller).
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  keyGenerator: (req) => String(req.user?._id || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'استنى دقيقة قبل ما تبعت رسائل تانية' },
});

router.get('/status', getStatus);
router.get('/conversation', getConversation);
router.delete('/conversation', resetConversation);
router.post('/chat', chatLimiter, chat);
router.post(
  '/messages/:messageId/report',
  [param('messageId').isMongoId()],
  validate,
  reportMessage
);

module.exports = router;
