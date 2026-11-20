const express = require('express');
const { getProfitLoss } = require('../controllers/finance.controller');
const { protect, restrictTo } = require('../middleware/auth.middleware');

const router = express.Router();

// التقارير المالية تكشف المصروفات والرواتب ⇒ مدير الأكاديمية والسوبر أدمن فقط
// (نفس صلاحية المصروفات).
router.use(protect);
router.use(restrictTo('super_admin', 'academy_admin'));

// GET /api/v1/finance/profit-loss?from=YYYY-MM-DD&to=YYYY-MM-DD[&academyId=]
router.get('/profit-loss', getProfitLoss);

module.exports = router;
