const Subscription = require('../models/subscription.model');
const { cloudinary } = require('../config/cloudinary');
const { clearShare } = require('./receiptShare');
const logger = require('./logger');

// حذف صور الإيصالات المنتهية (60 يوماً) من Cloudinary ومسح روابطها.
// فحص دوري (كل 6 ساعات) يصمد أمام إعادة التشغيل؛ الحذف آمن للتكرار.
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const BATCH = 100;

/** يحذف صورة من Cloudinary بدون أن يُفشل العملية لو كانت محذوفة أصلاً. */
async function destroyShareImage(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
  } catch (err) {
    logger.warn(`[RECEIPT_SHARE] destroy ${publicId} failed: ${err.message}`);
  }
}

/** يحذف صور مشاركة كل دفعات اشتراك (عند حذف الاشتراك). */
async function destroySubscriptionShareImages(subscription) {
  for (const p of subscription.payments || []) {
    if (p.shareImagePublicId) await destroyShareImage(p.shareImagePublicId);
  }
}

async function runOnce(now = new Date()) {
  const subs = await Subscription.find({ 'payments.shareExpiresAt': { $lte: now } }).limit(BATCH);
  let cleared = 0;
  for (const sub of subs) {
    let changed = false;
    for (const p of sub.payments || []) {
      if (p.shareExpiresAt && new Date(p.shareExpiresAt) <= now) {
        await destroyShareImage(p.shareImagePublicId);
        clearShare(p);
        changed = true;
        cleared++;
      }
    }
    if (changed) await sub.save();
  }
  if (cleared) logger.info(`[RECEIPT_SHARE] cleared ${cleared} expired receipt images`);
  return cleared;
}

const startReceiptShareCleanup = () => {
  const tick = () => runOnce().catch((err) => logger.warn(`[RECEIPT_SHARE] ${err.message}`));
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, INTERVAL_MS).unref();
};

module.exports = { runOnce, startReceiptShareCleanup, destroyShareImage, destroySubscriptionShareImages };
