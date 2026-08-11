const express = require('express');
const router = express.Router();

const { protect, requirePermission } = require('../middleware/auth.middleware');
const {
  getDashboardStats,
  getRevenueByMonth,
  getSubscriptionsByType,
  getPlayersByBirthYear,
  getEvaluationDistribution,
  getRecentActivities,
  getSportStats,
} = require('../controllers/dashboard.controller');

router.use(protect);
router.use(requirePermission('view_dashboard_revenue'));

router.get('/stats', getDashboardStats);
router.get('/revenue-by-month', getRevenueByMonth);
router.get('/subscriptions-by-type', getSubscriptionsByType);
router.get('/players-by-birth-year', getPlayersByBirthYear);
router.get('/evaluation-distribution', getEvaluationDistribution);
router.get('/recent-activities', getRecentActivities);
router.get('/sport-stats', getSportStats);

module.exports = router;
