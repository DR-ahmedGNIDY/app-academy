const Subscription = require('../models/subscription.model');
const Player = require('../models/player.model');
const AppError = require('../utils/AppError');
const { sendSuccess, sendPaginated } = require('../utils/apiResponse');
const logger = require('../utils/logger');
const { logActivity } = require('../utils/activityLogger');
const { notify } = require('../utils/notificationService');
const {
  PAYMENT_METHODS,
  round2,
  paymentState,
  validatePaymentAmount,
  resolveInitialPaid,
  collectedTotalStages,
  outstandingTotalStages,
  groupDebtsByPlayer,
  receiptCounterName,
  buildReceipt,
} = require('../utils/subscriptionPayments');
const Counter = require('../models/counter.model');
const Academy = require('../models/academy.model');
const { cloudinary } = require('../config/cloudinary');
const {
  SHARE_TTL_MS,
  RECEIPTS_FOLDER,
  newShareToken,
  shareUrlFor,
  hasValidShare,
} = require('../utils/receiptShare');
const {
  destroyShareImage,
  destroySubscriptionShareImages,
} = require('../utils/receiptShareCleanup');

/** يرفع صورة (Buffer) لـ Cloudinary ويرجّع { secure_url, public_id }. */
const uploadImageBuffer = (buffer, options) => new Promise((resolve, reject) => {
  const stream = cloudinary.uploader.upload_stream(
    { resource_type: 'image', ...options },
    (err, result) => (err ? reject(err) : resolve(result))
  );
  stream.end(buffer);
});

/** رقم الإيصال التالي لأكاديمية (ذرّي). */
const nextReceiptNo = (academyId) => Counter.next(receiptCounterName(academyId));

/**
 * يضمن أن لكل دفعة رقم إيصال. الاشتراك القديم بلا سجل دفعات يُحوَّل لدفعة
 * واحدة بكامل المدفوع يوم الإنشاء (نفس قاعدة الإيرادات، فلا تتغيّر الأرقام).
 * يحفظ فقط عند وجود تغيير. يرجّع true لو حفظ.
 */
async function ensureReceiptNumbers(subscription) {
  let changed = false;
  if (!Array.isArray(subscription.payments) || subscription.payments.length === 0) {
    const { paidAmount } = paymentState(subscription);
    if (!Array.isArray(subscription.payments) && paidAmount > 0) {
      subscription.payments = [{
        amount: paidAmount, date: subscription.created_at, method: 'cash', note: 'رصيد سابق',
      }];
      subscription.paidAmount = paidAmount;
      changed = true;
    }
  }
  const missing = (subscription.payments || [])
    .filter((p) => !p.receiptNo)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const p of missing) {
    p.receiptNo = await nextReceiptNo(subscription.academyId);
    changed = true;
  }
  if (changed) await subscription.save();
  return changed;
}

const RECEIPT_PLAYER_FIELDS = 'fullName playerCode parentName parentPhone playerPhone';
const RECEIPT_ACADEMY_FIELDS = 'name logo_url phone address currency';

/** بيانات من سجّل الدفعة (للعرض في السجل). */
function recorderOf(req) {
  return { recordedBy: req.user?._id ?? null, recordedByName: req.user?.name ?? '' };
}

/** يتحقّق أن الاشتراك يخص أكاديمية المستخدم (super_admin يتجاوز). */
function canAccessSubscription(req, subscription) {
  return req.user.role === 'super_admin' ||
    subscription.academyId.toString() === req.user.academyId?.toString();
}

// ─── Helper: resolve and verify academyId access ────────────────────────────
/**
 * Returns the academyId the request is scoped to, or throws an AppError if
 * an academy_admin tries to access a different academy.
 */
function resolveAcademyId(req, paramAcademyId) {
  // super_admin يثق بالـ id المُمرّر؛ أي دور آخر (admin/academy_admin) مُقيَّد بأكاديميته.
  if (req.user.role === 'super_admin') {
    return paramAcademyId;
  }
  return req.user.academyId?.toString();
}

// ─── POST / ──────────────────────────────────────────────────────────────────
const createSubscription = async (req, res, next) => {
  const { playerId, type, amount, startDate, endDate, notes } = req.body;
  // الدفع الجزئي: paidAmount غير مُرسل ⇒ مدفوع بالكامل (توافق مع التطبيقات القديمة).
  const initial = resolveInitialPaid(amount, req.body.paidAmount);
  if (initial.error) return next(new AppError(initial.error, 400));
  const paymentMethod = PAYMENT_METHODS.includes(req.body.paymentMethod) ? req.body.paymentMethod : 'cash';
  // عدد الحصص: القيمة المرسلة (null/فارغ = بلا حدّ)، وإن لم تُرسل فالافتراضي المحفوظ على اللاعب.
  const rawLimit = req.body.sessionsLimit;

  // Determine academyId — super_admin يحدّدها، غيره مُقيَّد بأكاديميته.
  let academyId;
  if (req.user.role === 'super_admin') {
    academyId = req.body.academyId;
    if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  } else {
    academyId = req.user.academyId?.toString();
  }

  // Verify player belongs to this academy
  const player = await Player.findById(playerId);
  if (!player) return next(new AppError('اللاعب غير موجود', 404));
  if (player.academyId.toString() !== academyId.toString()) {
    return next(new AppError('اللاعب لا ينتمي إلى هذه الأكاديمية', 403));
  }

  // Optional warning check for NEW_SUBSCRIPTION: player already has subscriptions
  let warning = null;
  if (type === 'NEW_SUBSCRIPTION') {
    const existing = await Subscription.countDocuments({ playerId, academyId });
    if (existing > 0) {
      warning = 'هذا اللاعب لديه اشتراكات سابقة';
    }
  }

  const subscription = await Subscription.create({
    academyId,
    playerId,
    type,
    amount,
    startDate,
    endDate,
    notes,
    paidAmount: initial.paid,
    payments: initial.paid > 0
      ? [{
        amount: initial.paid, date: new Date(), method: paymentMethod, ...recorderOf(req),
        receiptNo: await nextReceiptNo(academyId),
      }]
      : [],
    sessionsLimit: rawLimit === undefined
      ? (player.sessionsLimit || null)
      : (parseInt(rawLimit, 10) > 0 ? parseInt(rawLimit, 10) : null),
  });

  logger.info(`Subscription created: ${subscription._id} for player ${playerId}`);
  // حضور "الدفع لاحقاً" السابق يُحتسب على الاشتراك الجديد — قد يستهلك حصصه فوراً.
  if (subscription.sessionsLimit) {
    await require('./attendance.controller').refreshPlayerQuotas(player._id);
  }
  logActivity(req, {
    actionType: type === 'RENEWAL' ? 'RENEW_SUBSCRIPTION' : 'ADD_SUBSCRIPTION',
    entityType: 'SUBSCRIPTION',
    entityId: subscription._id, entityName: player.fullName, academyId,
  });
  // إشعار اللاعب بتجديد/إضافة اشتراكه (fire-and-forget).
  notify({
    recipientType: 'player', recipientId: player._id, academyId,
    type: 'SUBSCRIPTION_RENEWED',
    title: type === 'RENEWAL' ? 'تم تجديد اشتراكك' : 'تم تسجيل اشتراكك',
    body: `ساري حتى ${new Date(endDate).toLocaleDateString('ar-EG')}`,
    meta: { subscriptionId: subscription._id.toString(), endDate },
  });

  const responseData = warning
    ? { subscription, warning }
    : subscription;

  return sendSuccess(res, {
    data: responseData,
    message: 'تم إنشاء الاشتراك بنجاح',
    statusCode: 201,
  });
};

// ─── PATCH /:id/notes ────────────────────────────────────────────────────────
const updateSubscriptionNotes = async (req, res, next) => {
  const subscription = await Subscription.findById(req.params.id);
  if (!subscription) return next(new AppError('الاشتراك غير موجود', 404));

  // Academy access check
  if (
    req.user.role !== 'super_admin' &&
    subscription.academyId.toString() !== req.user.academyId?.toString()
  ) {
    return next(new AppError('ليس لديك صلاحية لتعديل هذا الاشتراك', 403));
  }

  subscription.notes = req.body.notes !== undefined ? req.body.notes : subscription.notes;
  await subscription.save();

  logger.info(`Subscription notes updated: ${subscription._id}`);
  return sendSuccess(res, { data: subscription, message: 'تم تحديث الملاحظات بنجاح' });
};

// ─── DELETE /:id ─────────────────────────────────────────────────────────────
const deleteSubscription = async (req, res, next) => {
  const subscription = await Subscription.findById(req.params.id);
  if (!subscription) return next(new AppError('الاشتراك غير موجود', 404));

  // super_admin can delete any; academy_admin only their own academy
  if (
    req.user.role !== 'super_admin' &&
    subscription.academyId.toString() !== req.user.academyId?.toString()
  ) {
    return next(new AppError('ليس لديك صلاحية لحذف هذا الاشتراك', 403));
  }

  await Subscription.deleteOne({ _id: subscription._id });
  destroySubscriptionShareImages(subscription); // صور روابط الإيصالات (fire-and-forget)

  const subPlayer = await Player.findById(subscription.playerId).select('fullName');
  logger.info(`Subscription deleted: ${subscription._id}`);
  logActivity(req, {
    actionType: 'DELETE_SUBSCRIPTION', entityType: 'SUBSCRIPTION',
    entityId: subscription._id, entityName: subPlayer ? subPlayer.fullName : '',
    academyId: subscription.academyId,
  });
  return sendSuccess(res, { message: 'تم حذف الاشتراك بنجاح' });
};

// ─── GET /:id ────────────────────────────────────────────────────────────────
const getSubscriptionById = async (req, res, next) => {
  const subscription = await Subscription.findById(req.params.id)
    .populate('playerId', 'fullName playerCode')
    .populate('academyId', 'name');

  if (!subscription) return next(new AppError('الاشتراك غير موجود', 404));

  // Academy access check
  const academyIdStr =
    subscription.academyId?._id?.toString() || subscription.academyId?.toString();

  if (
    req.user.role !== 'super_admin' &&
    academyIdStr !== req.user.academyId?.toString()
  ) {
    return next(new AppError('ليس لديك صلاحية للوصول إلى هذا الاشتراك', 403));
  }

  return sendSuccess(res, { data: subscription, message: 'تم جلب بيانات الاشتراك بنجاح' });
};

// ─── GET /player/:playerId ───────────────────────────────────────────────────
const getSubscriptionsByPlayer = async (req, res, next) => {
  const { playerId } = req.params;

  // Verify player exists
  const player = await Player.findById(playerId);
  if (!player) return next(new AppError('اللاعب غير موجود', 404));

  // academy_admin can only see players from their own academy
  if (
    req.user.role !== 'super_admin' &&
    player.academyId.toString() !== req.user.academyId?.toString()
  ) {
    return next(new AppError('ليس لديك صلاحية للوصول إلى اشتراكات هذا اللاعب', 403));
  }

  const filter = { playerId };

  // Status filter using endDate comparison
  if (req.query.status === 'active') {
    filter.endDate = { $gte: new Date() };
    filter.exhaustedAt = null;
  } else if (req.query.status === 'expired') {
    filter.$or = [{ endDate: { $lt: new Date() } }, { exhaustedAt: { $ne: null } }];
  }

  const subscriptions = await Subscription.find(filter).sort({ startDate: -1 });

  return sendSuccess(res, {
    data: subscriptions,
    message: 'تم جلب اشتراكات اللاعب بنجاح',
  });
};

// ─── GET /academy/:academyId ─────────────────────────────────────────────────
const getSubscriptionsByAcademy = async (req, res, next) => {
  // Resolve the target academy
  let academyId;
  if (req.user.role === 'super_admin') {
    academyId = req.params.academyId;
    if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  } else {
    academyId = req.user.academyId?.toString();
    // أي دور غير super مُقيَّد بأكاديميته ولا يستطيع طلب أكاديمية أخرى.
    if (req.params.academyId && req.params.academyId !== academyId) {
      return next(new AppError('ليس لديك صلاحية للوصول إلى اشتراكات هذه الأكاديمية', 403));
    }
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(250, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const filter = { academyId };

  // Type filter
  if (req.query.type && ['NEW_SUBSCRIPTION', 'RENEWAL'].includes(req.query.type)) {
    filter.type = req.query.type;
  }

  // Status filter
  if (req.query.status === 'active') {
    filter.endDate = { $gte: new Date() };
    filter.exhaustedAt = null;
  } else if (req.query.status === 'expired') {
    filter.$or = [{ endDate: { $lt: new Date() } }, { exhaustedAt: { $ne: null } }];
    // كل تجديد بينشئ سجل اشتراك جديد، فيفضل السجل القديم منتهي الصلاحية
    // بتاريخه. لازم نستبعد أي لاعب عنده اشتراك نشط حاليًا (بعد التجديد)
    // من قائمة "منتهي" — حالة اللاعب الحقيقية هي أحدث اشتراك، مش كل سجل
    // تاريخي على حدة.
    const activePlayerIds = await Subscription.distinct('playerId', {
      academyId,
      endDate: { $gte: new Date() },
      exhaustedAt: null,
    });
    if (activePlayerIds.length) {
      filter.playerId = { $nin: activePlayerIds };
    }
  }

  // Player filter
  if (req.query.playerId) {
    filter.playerId = req.query.playerId;
  }

  const [subscriptions, total] = await Promise.all([
    Subscription.find(filter)
      .populate('playerId', 'fullName playerCode parentPhone image_url')
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit),
    Subscription.countDocuments(filter),
  ]);

  return sendPaginated(res, {
    data: subscriptions,
    total,
    page,
    limit,
    message: 'تم جلب اشتراكات الأكاديمية بنجاح',
  });
};

// ─── GET /academy/:academyId/player-status ───────────────────────────────────
/**
 * خريطة حالة الاشتراك لكل لاعب: { "<playerId>": "active" | "expired" }.
 *
 * صفحة اللاعبين كانت بتجيب سجلات الاشتراكات نفسها (مع pagination) وتحسب منها
 * الحالة، فاللاعبين اللي سجلاتهم برّه الصفحة الأولى كانوا بيظهروا "جديد" غلط.
 * كل تجديد بينشئ سجل جديد، فعدد السجلات بيكبر مع الوقت وأي حد ثابت بينكسر.
 *
 * هنا بنحسب الحالة على السيرفر بـ aggregation واحدة — أحدث endDate لكل لاعب —
 * وهي نفس القاعدة اللي بتستخدمها الداشبورد، فالأرقام بتتطابق. الرد سطر واحد
 * لكل لاعب بدل السجل الكامل، ومفيش pagination أصلاً.
 */
const getAcademyPlayerStatusMap = async (req, res, next) => {
  const academyId = resolveAcademyId(req, req.params.academyId);
  if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  if (req.user.role !== 'super_admin' && req.params.academyId &&
      req.params.academyId !== academyId) {
    return next(new AppError('ليس لديك صلاحية للوصول إلى اشتراكات هذه الأكاديمية', 403));
  }

  const mongoose = require('mongoose');
  const now = new Date();

  const rows = await Subscription.aggregate([
    { $match: { academyId: new mongoose.Types.ObjectId(academyId) } },
    { $group: { _id: '$playerId', maxEndDate: { $max: { $ifNull: ['$exhaustedAt', '$endDate'] } } } },
  ]);

  const statusMap = {};
  for (const row of rows) {
    if (!row._id) continue;
    statusMap[row._id.toString()] = row.maxEndDate >= now ? 'active' : 'expired';
  }

  return sendSuccess(res, {
    data: statusMap,
    message: 'تم جلب حالات اشتراكات اللاعبين بنجاح',
  });
};

// ─── POST /:id/payments ──────────────────────────────────────────────────────
/** تسجيل دفعة على اشتراك (قسط / سداد المتبقي). */
const addPayment = async (req, res, next) => {
  const subscription = await Subscription.findById(req.params.id);
  if (!subscription) return next(new AppError('الاشتراك غير موجود', 404));
  if (!canAccessSubscription(req, subscription)) {
    return next(new AppError('ليس لديك صلاحية لتعديل هذا الاشتراك', 403));
  }

  const { remainingAmount, paidAmount } = paymentState(subscription);
  const amount = round2(req.body.amount);
  const error = validatePaymentAmount(req.body.amount, remainingAmount);
  if (error) return next(new AppError(error, 400));

  const method = PAYMENT_METHODS.includes(req.body.method) ? req.body.method : 'cash';
  const date = req.body.date ? new Date(req.body.date) : new Date();
  if (Number.isNaN(date.getTime())) return next(new AppError('تاريخ الدفعة غير صحيح', 400));

  // اشتراك قديم بلا سجل دفعات: نثبّت المدفوع السابق كدفعة أولى قبل الإضافة.
  if (!Array.isArray(subscription.payments)) {
    subscription.payments = paidAmount > 0
      ? [{ amount: paidAmount, date: subscription.created_at, method: 'cash', note: 'رصيد سابق' }]
      : [];
  }
  subscription.payments.push({
    amount, date, method,
    note: req.body.note ? String(req.body.note).slice(0, 200) : undefined,
    ...recorderOf(req),
    receiptNo: await nextReceiptNo(subscription.academyId),
  });
  subscription.paidAmount = round2(paidAmount + amount);
  await subscription.save();

  const player = await Player.findById(subscription.playerId).select('fullName');
  logger.info(`Payment ${amount} recorded on subscription ${subscription._id}`);
  logActivity(req, {
    actionType: 'ADD_PAYMENT', entityType: 'SUBSCRIPTION',
    entityId: subscription._id, entityName: player ? player.fullName : '',
    academyId: subscription.academyId,
  });

  return sendSuccess(res, { data: subscription, message: 'تم تسجيل الدفعة بنجاح', statusCode: 201 });
};

// ─── DELETE /:id/payments/:paymentId ─────────────────────────────────────────
/** حذف دفعة مسجّلة بالخطأ — يرجع مبلغها للمتبقي. */
const deletePayment = async (req, res, next) => {
  const subscription = await Subscription.findById(req.params.id);
  if (!subscription) return next(new AppError('الاشتراك غير موجود', 404));
  if (!canAccessSubscription(req, subscription)) {
    return next(new AppError('ليس لديك صلاحية لتعديل هذا الاشتراك', 403));
  }

  const payment = subscription.payments?.id(req.params.paymentId);
  if (!payment) return next(new AppError('الدفعة غير موجودة', 404));

  if (payment.shareImagePublicId) destroyShareImage(payment.shareImagePublicId);
  payment.deleteOne();
  subscription.paidAmount = round2(
    subscription.payments.reduce((sum, p) => sum + (p.amount || 0), 0)
  );
  await subscription.save();

  const player = await Player.findById(subscription.playerId).select('fullName');
  logActivity(req, {
    actionType: 'DELETE_PAYMENT', entityType: 'SUBSCRIPTION',
    entityId: subscription._id, entityName: player ? player.fullName : '',
    academyId: subscription.academyId,
  });

  return sendSuccess(res, { data: subscription, message: 'تم حذف الدفعة' });
};

// ─── GET /:id/payments/:paymentId/receipt ────────────────────────────────────
/**
 * بيانات إيصال دفعة (للـ PDF). paymentId = 'legacy' للاشتراك القديم بلا سجل
 * دفعات ⇒ يُنشأ له سجل ويُرجَع إيصال دفعته الوحيدة.
 */
const getPaymentReceipt = async (req, res, next) => {
  const subscription = await Subscription.findById(req.params.id);
  if (!subscription) return next(new AppError('الاشتراك غير موجود', 404));
  if (!canAccessSubscription(req, subscription)) {
    return next(new AppError('ليس لديك صلاحية للوصول إلى هذا الاشتراك', 403));
  }

  await ensureReceiptNumbers(subscription);
  const payment = req.params.paymentId === 'legacy'
    ? subscription.payments?.[0]
    : subscription.payments?.id(req.params.paymentId);
  if (!payment) return next(new AppError('الدفعة غير موجودة', 404));

  const [player, academy] = await Promise.all([
    Player.findById(subscription.playerId).select(RECEIPT_PLAYER_FIELDS),
    Academy.findById(subscription.academyId).select(RECEIPT_ACADEMY_FIELDS),
  ]);
  return sendSuccess(res, {
    data: buildReceipt({ subscription, payment, academy, player }),
    message: 'تم جلب الإيصال',
  });
};

// ─── POST /:id/payments/:paymentId/share ─────────────────────────────────────
/**
 * رابط عام لصورة الإيصال (لرسالة واتساب بمعاينة الصورة). الجهاز يرسل صورة
 * الإيصال (PNG) في الحقل image. لو للدفعة رابط صالح بالفعل يُعاد كما هو بلا
 * رفع جديد. الصلاحية 60 يوماً ثم تُحذف الصورة تلقائياً.
 */
const shareReceiptImage = async (req, res, next) => {
  const subscription = await Subscription.findById(req.params.id);
  if (!subscription) return next(new AppError('الاشتراك غير موجود', 404));
  if (!canAccessSubscription(req, subscription)) {
    return next(new AppError('ليس لديك صلاحية للوصول إلى هذا الاشتراك', 403));
  }

  await ensureReceiptNumbers(subscription);
  const payment = req.params.paymentId === 'legacy'
    ? subscription.payments?.[0]
    : subscription.payments?.id(req.params.paymentId);
  if (!payment) return next(new AppError('الدفعة غير موجودة', 404));

  if (!hasValidShare(payment)) {
    if (!req.file) return next(new AppError('صورة الإيصال مطلوبة', 400));
    const oldPublicId = payment.shareImagePublicId;
    const uploaded = await uploadImageBuffer(req.file.buffer, {
      folder: RECEIPTS_FOLDER,
      public_id: `receipt_${subscription.academyId}_${payment.receiptNo || payment._id}_${Date.now()}`,
      transformation: [{ width: 1200, crop: 'limit' }, { quality: 'auto' }],
    });
    payment.shareToken = newShareToken();
    payment.shareImageUrl = uploaded.secure_url;
    payment.shareImagePublicId = uploaded.public_id;
    payment.shareExpiresAt = new Date(Date.now() + SHARE_TTL_MS);
    await subscription.save();
    if (oldPublicId) destroyShareImage(oldPublicId); // صورة منتهية قديمة (fire-and-forget)
  }

  return sendSuccess(res, {
    data: { url: shareUrlFor(req, payment.shareToken), expiresAt: payment.shareExpiresAt },
    message: 'تم تجهيز رابط الإيصال',
  });
};

// ─── GET /player/receipts (بوابة اللاعب) ─────────────────────────────────────
/** كل إيصالات اللاعب الحالي، الأحدث أولاً. */
const getPlayerReceipts = async (req, res) => {
  const player = req.player;
  const [subs, academy, fullPlayer] = await Promise.all([
    Subscription.find({ playerId: player._id }).sort({ startDate: -1 }),
    Academy.findById(player.academyId).select(RECEIPT_ACADEMY_FIELDS),
    Player.findById(player._id).select(RECEIPT_PLAYER_FIELDS),
  ]);
  const receipts = [];
  for (const subscription of subs) {
    await ensureReceiptNumbers(subscription);
    for (const payment of subscription.payments || []) {
      receipts.push(buildReceipt({ subscription, payment, academy, player: fullPlayer || player }));
    }
  }
  receipts.sort((a, b) => new Date(b.payment.date) - new Date(a.payment.date));
  return sendSuccess(res, { data: receipts, message: 'تم جلب الإيصالات' });
};

// ─── GET /academy/:academyId/debts ───────────────────────────────────────────
/**
 * اللاعبون الذين عليهم مبالغ متبقية، مجمّعين لكل لاعب ومرتّبين بالأكبر.
 * ?search= يفلتر بالاسم أو الكود.
 */
const getAcademyDebts = async (req, res, next) => {
  const academyId = resolveAcademyId(req, req.params.academyId);
  if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  if (req.user.role !== 'super_admin' && req.params.academyId &&
      req.params.academyId !== academyId) {
    return next(new AppError('ليس لديك صلاحية للوصول إلى هذه الأكاديمية', 403));
  }

  // paidAmount موجود فقط للاشتراكات الجديدة؛ القديم مدفوع بالكامل فلا يدخل هنا.
  const subs = await Subscription.find({
    academyId,
    paidAmount: { $ne: null },
    $expr: { $gt: ['$amount', '$paidAmount'] },
  })
    .select('playerId type amount paidAmount startDate endDate')
    .populate('playerId', 'fullName playerCode parentPhone playerPhone image_url isActive')
    .lean();

  let result = groupDebtsByPlayer(subs);
  const search = (req.query.search || '').toString().trim().toLowerCase();
  if (search) {
    const players = result.players.filter((p) =>
      p.fullName.toLowerCase().includes(search) || String(p.playerCode).toLowerCase().includes(search));
    result = {
      players,
      summary: {
        totalOutstanding: round2(players.reduce((sum, p) => sum + p.totalDue, 0)),
        playersCount: players.length,
        subscriptionsCount: players.reduce((sum, p) => sum + p.subscriptions.length, 0),
      },
    };
  }

  return sendSuccess(res, { data: result, message: 'تم جلب المديونيات بنجاح' });
};

// ─── GET /academy/:academyId/revenue ─────────────────────────────────────────
const getRevenueSummary = async (req, res, next) => {
  // Resolve academy
  let academyId;
  if (req.user.role === 'super_admin') {
    academyId = req.params.academyId;
    if (!academyId) return next(new AppError('معرّف الأكاديمية مطلوب', 400));
  } else {
    academyId = req.user.academyId?.toString();
    if (req.params.academyId && req.params.academyId !== academyId) {
      return next(new AppError('ليس لديك صلاحية للوصول إلى تقارير هذه الأكاديمية', 403));
    }
  }

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const mongoose = require('mongoose');
  const academyObjectId = new mongoose.Types.ObjectId(academyId);

  const [summary] = await Subscription.aggregate([
    { $match: { academyId: academyObjectId } },
    {
      $facet: {
        // الإيراد = المُحصَّل فعلاً بتاريخ الدفع (القديم = كامل المبلغ يوم الإنشاء).
        totalRevenue: collectedTotalStages(),
        monthlyRevenue: collectedTotalStages({ from: startOfMonth, to: endOfMonth }),
        outstanding: outstandingTotalStages(),
        newSubscriptionsCount: [
          { $match: { type: 'NEW_SUBSCRIPTION' } },
          { $count: 'count' },
        ],
        renewalsCount: [
          { $match: { type: 'RENEWAL' } },
          { $count: 'count' },
        ],
        // نُجمّع لكل لاعب أحدث تاريخ انتهاء بين كل اشتراكاته، ونحكم على حالته
        // بناءً عليه — عشان لاعب جدّد اشتراكه ميتحسبش "منتهي" بسبب سجل قديم.
        activeCount: [
          { $group: { _id: '$playerId', maxEndDate: { $max: { $ifNull: ['$exhaustedAt', '$endDate'] } } } },
          { $match: { maxEndDate: { $gte: now } } },
          { $count: 'count' },
        ],
        expiredCount: [
          { $group: { _id: '$playerId', maxEndDate: { $max: { $ifNull: ['$exhaustedAt', '$endDate'] } } } },
          { $match: { maxEndDate: { $lt: now } } },
          { $count: 'count' },
        ],
      },
    },
  ]);

  // اشتراكات المباريات المضافة للإيرادات.
  const { matchRevenueTotal } = require('../utils/matchRevenue');
  const [matchRevTotal, matchRevMonth] = await Promise.all([
    matchRevenueTotal({ academyMatch: { academyId: academyObjectId } }),
    matchRevenueTotal({ academyMatch: { academyId: academyObjectId }, from: startOfMonth, to: endOfMonth }),
  ]);

  const result = {
    totalRevenue: (summary?.totalRevenue?.[0]?.total ?? 0) + matchRevTotal,
    monthlyRevenue: (summary?.monthlyRevenue?.[0]?.total ?? 0) + matchRevMonth,
    matchRevenue: matchRevTotal,
    outstandingTotal: round2(summary?.outstanding?.[0]?.total ?? 0),
    newSubscriptionsCount: summary?.newSubscriptionsCount?.[0]?.count ?? 0,
    renewalsCount: summary?.renewalsCount?.[0]?.count ?? 0,
    activeCount: summary?.activeCount?.[0]?.count ?? 0,
    expiredCount: summary?.expiredCount?.[0]?.count ?? 0,
  };

  return sendSuccess(res, {
    data: result,
    message: 'تم جلب ملخص الإيرادات بنجاح',
  });
};

module.exports = {
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
  getPlayerReceipts,
  ensureReceiptNumbers,
  shareReceiptImage,
};
