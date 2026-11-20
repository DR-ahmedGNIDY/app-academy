const express = require('express');
const { param } = require('express-validator');
const {
  getTemplates,
  getMatchStats,
  saveMatchStats,
  getPlayerStats,
  getLeaderboard,
} = require('../controllers/matchStats.controller');
const { protect, requirePermission } = require('../middleware/auth.middleware');
const { blockIfNotWritable } = require('../middleware/subscriptionGuard');
const validate = require('../middleware/validate');

// إحصائيات اللاعبين في المباريات (قوالب لكل رياضة).
const router = express.Router();
router.use(protect);

router.get('/templates', getTemplates);
router.get('/leaderboard', getLeaderboard);
router.get('/player/:playerId', [param('playerId').isMongoId()], validate, getPlayerStats);
router.get('/match/:matchId', [param('matchId').isMongoId()], validate, getMatchStats);
router.put(
  '/match/:matchId',
  requirePermission('add_matches'),
  blockIfNotWritable,
  [param('matchId').isMongoId()],
  validate,
  saveMatchStats
);

module.exports = router;
