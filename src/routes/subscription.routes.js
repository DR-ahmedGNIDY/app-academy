const express = require('express');
const { body, param } = require('express-validator');
const {
  createSubscription,
  updateSubscriptionNotes,
  deleteSubscription,
  getSubscriptionById,
  getSubscriptionsByPlayer,
  getSubscriptionsByAcademy,
  getAcademyPlayerStatusMap,
  getRevenueSummary,
  addPayment,
  deletePayment,
  getAcademyDebts,
  getPaymentReceipt,
  shareReceiptImage,
  freezeSubscription,
  resumeSubscription,
} = require('../controllers/subscription.controller');
const { FREEZE_REASONS, MAX_FREEZE_DAYS } = require('../utils/subscriptionFreeze');
const multer = require('multer');

// صورة الإيصال للمشاركة: في الذاكرة ثم Cloudinary من الـ controller
// (لا رفع لو للدفعة رابط صالح بالفعل). PNG/JPEG فقط، حد 3MB.
const uploadReceiptImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/png', 'image/jpeg'].includes(file.mimetype)) return cb(null, true);
    return cb(new Error('صيغة صورة الإيصال غير مدعومة'));
  },
});
const { PAYMENT_METHODS } = require('../utils/subscriptionPayments');
const { protect, restrictTo, requirePermission } = require('../middleware/auth.middleware');
const { blockIfNotWritable } = require('../middleware/subscriptionGuard');
const validate = require('../middleware/validate');

const router = express.Router();

// All routes require authentication
router.use(protect);
// حارس اشتراك المنصة: يمنع الكتابة عند انتهاء/تعليق الاشتراك (لا يمسّ GET).
router.use(blockIfNotWritable);

// ─── Validators ──────────────────────────────────────────────────────────────

const createValidators = [
  body('playerId')
    .notEmpty().withMessage('معرّف اللاعب مطلوب')
    .isMongoId().withMessage('معرّف اللاعب غير صحيح'),
  body('type')
    .notEmpty().withMessage('نوع الاشتراك مطلوب')
    .isIn(['NEW_SUBSCRIPTION', 'RENEWAL']).withMessage('نوع الاشتراك يجب أن يكون NEW_SUBSCRIPTION أو RENEWAL'),
  body('amount')
    .notEmpty().withMessage('مبلغ الاشتراك مطلوب')
    .isNumeric().withMessage('مبلغ الاشتراك يجب أن يكون رقماً')
    .custom((value) => {
      if (parseFloat(value) < 0) throw new Error('مبلغ الاشتراك لا يمكن أن يكون سالباً');
      return true;
    }),
  body('startDate')
    .notEmpty().withMessage('تاريخ بداية الاشتراك مطلوب')
    .isISO8601().withMessage('تاريخ البداية غير صحيح'),
  body('endDate')
    .notEmpty().withMessage('تاريخ نهاية الاشتراك مطلوب')
    .isISO8601().withMessage('تاريخ النهاية غير صحيح')
    .custom((value, { req }) => {
      if (new Date(value) <= new Date(req.body.startDate)) {
        throw new Error('تاريخ النهاية يجب أن يكون بعد تاريخ البداية');
      }
      return true;
    }),
  body('notes')
    .optional()
    .isLength({ max: 500 }).withMessage('الملاحظات لا يمكن أن تتجاوز 500 حرف'),
  body('sessionsLimit')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1, max: 365 }).withMessage('عدد الحصص غير صحيح'),
  body('academyId')
    .optional()
    .isMongoId().withMessage('معرّف الأكاديمية غير صحيح'),
  // الدفع الجزئي — غير مُرسل ⇒ مدفوع بالكامل.
  body('paidAmount')
    .optional({ nullable: true })
    .isFloat({ min: 0 }).withMessage('المبلغ المدفوع غير صحيح'),
  body('paymentMethod')
    .optional({ nullable: true })
    .isIn(PAYMENT_METHODS).withMessage('طريقة الدفع غير صحيحة'),
];

const paymentValidators = [
  body('amount')
    .notEmpty().withMessage('مبلغ الدفعة مطلوب')
    .isFloat({ gt: 0 }).withMessage('مبلغ الدفعة يجب أن يكون أكبر من صفر'),
  body('method')
    .optional({ nullable: true })
    .isIn(PAYMENT_METHODS).withMessage('طريقة الدفع غير صحيحة'),
  body('date')
    .optional({ nullable: true })
    .isISO8601().withMessage('تاريخ الدفعة غير صحيح'),
  body('note')
    .optional({ nullable: true })
    .isLength({ max: 200 }).withMessage('ملاحظة الدفعة طويلة جداً'),
];

const notesValidators = [
  body('notes')
    .optional({ nullable: true })
    .isLength({ max: 500 }).withMessage('الملاحظات لا يمكن أن تتجاوز 500 حرف'),
];

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET  /subscriptions/player/:playerId
router.get('/player/:playerId', getSubscriptionsByPlayer);

// GET  /subscriptions/academy/:academyId/player-status — خريطة playerId → active/expired
router.get('/academy/:academyId/player-status', restrictTo('super_admin', 'academy_admin'), getAcademyPlayerStatusMap);

// GET  /subscriptions/academy/:academyId/revenue — admin needs view_dashboard_revenue permission
router.get('/academy/:academyId/revenue', requirePermission('view_dashboard_revenue'), getRevenueSummary);

// GET  /subscriptions/academy/:academyId/debts — اللاعبون عليهم مبالغ متبقية
router.get('/academy/:academyId/debts', requirePermission('record_subscriptions'), getAcademyDebts);

// GET  /subscriptions/academy/:academyId — admin blocked (uses player-level access instead)
router.get('/academy/:academyId', restrictTo('super_admin', 'academy_admin'), getSubscriptionsByAcademy);

// GET  /subscriptions/:id
router.get('/:id', getSubscriptionById);

// POST /subscriptions
router.post('/', requirePermission('record_subscriptions'), createValidators, validate, createSubscription);

// POST   /subscriptions/:id/payments — تسجيل دفعة (قسط)
router.post('/:id/payments', requirePermission('record_subscriptions'), paymentValidators, validate, addPayment);

// POST   /subscriptions/:id/freeze — تجميد عدد أيام (يمدّد نهاية الاشتراك)
router.post(
  '/:id/freeze',
  requirePermission('record_subscriptions'),
  [
    body('days').isInt({ min: 1, max: MAX_FREEZE_DAYS }).withMessage('عدد أيام التجميد غير صحيح'),
    body('startDate').optional({ nullable: true }).matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('تاريخ بداية التجميد غير صحيح'),
    body('reason').optional({ nullable: true }).isIn(FREEZE_REASONS).withMessage('سبب التجميد غير صحيح'),
    body('note').optional({ nullable: true }).isLength({ max: 200 }).withMessage('الملاحظة طويلة جداً'),
  ],
  validate,
  freezeSubscription
);

// POST   /subscriptions/:id/freeze/resume — فك التجميد الآن
router.post('/:id/freeze/resume', requirePermission('record_subscriptions'), resumeSubscription);

// GET    /subscriptions/:id/payments/:paymentId/receipt — بيانات إيصال الدفع
router.get('/:id/payments/:paymentId/receipt', getPaymentReceipt);

// POST   /subscriptions/:id/payments/:paymentId/share — رابط عام لصورة الإيصال (60 يوم)
router.post(
  '/:id/payments/:paymentId/share',
  requirePermission('record_subscriptions'),
  uploadReceiptImage.single('image'),
  shareReceiptImage
);

// DELETE /subscriptions/:id/payments/:paymentId — حذف دفعة مسجّلة بالخطأ
router.delete('/:id/payments/:paymentId', requirePermission('record_subscriptions'), deletePayment);

// PATCH /subscriptions/:id/notes
router.patch('/:id/notes', notesValidators, validate, updateSubscriptionNotes);

// DELETE /subscriptions/:id
router.delete('/:id', deleteSubscription);

module.exports = router;
