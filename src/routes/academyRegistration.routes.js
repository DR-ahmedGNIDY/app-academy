const express = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { registerAcademy, parseSports } = require('../controllers/academyRegistration.controller');
const validate = require('../middleware/validate');
const { uploadAcademyLogo } = require('../config/cloudinary');

const router = express.Router();

// حد صارم لمنع إساءة استخدام التسجيل الذاتي: 5 محاولات / 15 دقيقة / IP.
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'تم تجاوز الحد المسموح به من محاولات التسجيل' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerValidators = [
  body('academyName')
    .notEmpty().withMessage('اسم الأكاديمية مطلوب')
    .isLength({ min: 2, max: 150 }).withMessage('اسم الأكاديمية يجب أن يكون بين 2 و 150 حرف'),
  body('adminName')
    .notEmpty().withMessage('اسم المدير مطلوب')
    .isLength({ min: 2, max: 100 }).withMessage('اسم المدير يجب أن يكون بين 2 و 100 حرف'),
  body('phone')
    .notEmpty().withMessage('رقم الهاتف مطلوب')
    .matches(/^[0-9+\-\s()]{7,20}$/).withMessage('رقم الهاتف غير صحيح'),
  body('email')
    .isEmail().withMessage('البريد الإلكتروني غير صحيح').normalizeEmail(),
  body('city')
    .notEmpty().withMessage('المدينة مطلوبة')
    .isLength({ min: 2, max: 300 }).withMessage('المدينة غير صحيحة'),
  // الرياضات: sports (قائمة JSON — متعددة/مخصّصة) أو sport (رياضة واحدة — نسخ قديمة).
  body('sports').custom((value, { req }) => {
    const list = parseSports(value, req.body.sport);
    if (list.length === 0) throw new Error('يجب اختيار رياضة واحدة على الأقل');
    if (list.length > 20) throw new Error('عدد الرياضات كبير جداً');
    if (list.some((s) => s.length < 2 || s.length > 60)) throw new Error('اسم الرياضة غير صحيح');
    return true;
  }),
  body('password')
    .isLength({ min: 8 }).withMessage('كلمة المرور يجب أن تكون 8 أحرف على الأقل'),
  // العملة اختيارية (تُشتق من الدولة في الفرونت)؛ إن أُرسلت نتحقق من صحتها.
  body('currency')
    .optional()
    .isIn([
      'EGP', 'SAR', 'AED', 'KWD', 'QAR', 'BHD', 'OMR', 'JOD', 'LBP', 'SYP',
      'IQD', 'ILS', 'YER', 'LYD', 'TND', 'DZD', 'MAD', 'MRU', 'SDG', 'SOS',
      'DJF', 'KMF', 'USD',
    ]).withMessage('العملة غير صحيحة'),
];

// POST /api/v1/register-academy
router.post(
  '/',
  registerLimiter,
  uploadAcademyLogo.single('logo'),
  registerValidators,
  validate,
  registerAcademy
);

module.exports = router;
