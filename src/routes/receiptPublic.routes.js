const express = require('express');
const rateLimit = require('express-rate-limit');
const Subscription = require('../models/subscription.model');
const Player = require('../models/player.model');
const Academy = require('../models/academy.model');
const {
  isValidToken,
  hasValidShare,
  renderReceiptPage,
  renderExpiredPage,
  RECEIPT_PAGE_CSP,
} = require('../utils/receiptShare');
const { formatReceiptNo } = require('../utils/subscriptionPayments');

// صفحة الإيصال العامة: GET /r/:token — بلا تسجيل دخول (الرابط نفسه هو الإذن).
// واتساب يقرأ وسوم og:image منها لعرض معاينة صورة الإيصال في المحادثة.
const router = express.Router();

router.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
}));

const sendHtml = (res, status, html) => {
  res.set('Content-Security-Policy', RECEIPT_PAGE_CSP);
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'private, max-age=300');
  res.status(status).type('html').send(html);
};

router.get('/:token', async (req, res) => {
  const { token } = req.params;
  if (!isValidToken(token)) return sendHtml(res, 404, renderExpiredPage());

  const sub = await Subscription.findOne({ 'payments.shareToken': token })
    .select('academyId playerId payments');
  const payment = sub?.payments?.find((p) => p.shareToken === token);
  if (!sub || !hasValidShare(payment)) return sendHtml(res, 404, renderExpiredPage());

  const [player, academy] = await Promise.all([
    Player.findById(sub.playerId).select('fullName'),
    Academy.findById(sub.academyId).select('name currency'),
  ]);

  return sendHtml(res, 200, renderReceiptPage({
    academyName: academy?.name || '',
    playerName: player?.fullName || '',
    amount: payment.amount,
    currency: academy?.currency || 'EGP',
    date: payment.date,
    receiptNoLabel: formatReceiptNo(payment.receiptNo),
    imageUrl: payment.shareImageUrl,
    expiresAt: payment.shareExpiresAt,
  }));
});

module.exports = router;
