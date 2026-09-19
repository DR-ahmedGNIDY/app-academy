const express = require('express');
const { body } = require('express-validator');
const {
  recordAttendance,
  getAttendance,
  getAttendanceReport,
  searchAttendancePlayers,
  getPlayerAttendanceSummary,
  deleteAttendance,
} = require('../controllers/attendance.controller');
const { protect, restrictTo } = require('../middleware/auth.middleware');
const { blockIfNotWritable } = require('../middleware/subscriptionGuard');
const validate = require('../middleware/validate');

const router = express.Router();

// All routes require authentication
router.use(protect);
// حارس اشتراك المنصة: يمنع الكتابة عند انتهاء/تعليق الاشتراك (لا يمسّ GET).
router.use(blockIfNotWritable);

// ─── Validators ──────────────────────────────────────────────────────────────

const recordValidators = [
  body('code')
    .optional({ checkFalsy: true })
    .isLength({ max: 60 }).withMessage('كود اللاعب غير صحيح'),
  body('playerId')
    .optional({ checkFalsy: true })
    .isMongoId().withMessage('معرّف اللاعب غير صحيح'),
  body('localDate')
    .optional({ checkFalsy: true })
    .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('صيغة التاريخ غير صحيحة'),
  body('localTime')
    .optional({ checkFalsy: true })
    .matches(/^\d{2}:\d{2}$/).withMessage('صيغة الوقت غير صحيحة'),
];

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /attendance/report   ← MUST be before any '/:id' style route
// بلا بوابة صلاحيات عمداً: التقرير تجميع إحصائي لبيانات GET /attendance التي
// يقرؤها نفس المستخدم بلا قيد، فالبوابة كانت تمنع الراحة لا الوصول. وكل من
// يرى صفحة اللاعبين (كل حسابات admin) يجب أن يرى سجل الحضور وتقريره.
// عزل الأكاديمية يبقى مضموناً داخل getAttendanceReport (super_admin وحده
// يمرّر academyId؛ غيره مقيَّد بأكاديميته).
router.get('/report', getAttendanceReport);

// GET /attendance/players?search=  ← بحث لاعب لسجل الحضور
router.get('/players', searchAttendancePlayers);

// GET /attendance/player/:id/summary  ← حضور اللاعب في اشتراكه الأخير
router.get('/player/:id/summary', getPlayerAttendanceSummary);

// GET /attendance
router.get('/', getAttendance);

// POST /attendance
router.post('/', recordValidators, validate, recordAttendance);

// DELETE /attendance/:id
router.delete('/:id', restrictTo('super_admin', 'academy_admin', 'admin'), deleteAttendance);

module.exports = router;
