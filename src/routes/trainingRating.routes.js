const express = require('express');
const { getAcademyRatings } = require('../controllers/trainingRating.controller');
const { protect } = require('../middleware/auth.middleware');

const router = express.Router();
router.use(protect);

// GET /api/v1/training-ratings?date=YYYY-MM-DD&days=30 — تقييمات التمرين اليومية للإدارة
router.get('/', getAcademyRatings);

module.exports = router;
