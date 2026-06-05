const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/auth.middleware');
const {
  getDashboardStats,
  getRevenueByMonth,
  getSubscriptionsByType,
  getPlayersByBirthYear,
  getEvaluationDistribution,
  getRecentActivities,
} = require('../controllers/dashboard.controller');

router.use(protect);

router.get('/stats', getDashboardStats);
router.get('/revenue-by-month', getRevenueByMonth);
router.get('/subscriptions-by-type', getSubscriptionsByType);
router.get('/players-by-birth-year', getPlayersByBirthYear);
router.get('/evaluation-distribution', getEvaluationDistribution);
router.get('/recent-activities', getRecentActivities);

module.exports = router;
