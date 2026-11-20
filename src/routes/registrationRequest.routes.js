const express = require('express');
const {
  getSettings,
  updateSettings,
  listRequests,
  acceptRequest,
  rejectRequest,
} = require('../controllers/registrationRequest.controller');
const { protect, restrictTo, requirePermission } = require('../middleware/auth.middleware');
const { blockIfSuspended, blockIfNotWritable, enforcePlayerLimit } = require('../middleware/subscriptionGuard');

// طلبات التسجيل الأونلاين (لوحة المدير). الصفحة العامة نفسها في joinPublic.routes.
const router = express.Router();
router.use(protect);
router.use(blockIfSuspended);

// الإعدادات (رابط الفورم + الرياضات + رسالة الترحيب)
router.get('/settings', requirePermission('register_players'), getSettings);
router.patch('/settings', restrictTo('super_admin', 'academy_admin'), blockIfNotWritable, updateSettings);

// الطلبات
router.get('/', requirePermission('register_players'), listRequests);
router.post('/:id/accept', requirePermission('register_players'), blockIfNotWritable, enforcePlayerLimit, acceptRequest);
router.post('/:id/reject', requirePermission('register_players'), blockIfNotWritable, rejectRequest);

module.exports = router;
