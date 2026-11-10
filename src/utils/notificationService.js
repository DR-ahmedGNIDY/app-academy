const Notification = require('../models/notification.model');
const logger = require('./logger');
const { pushForNotification } = require('./pushService');

// إنشاء إشعار بشكل "fire-and-forget": لا يكسر العملية الأساسية ولا يؤخّرها.
// recipientType: 'player' → recipientId = playerId
// recipientType: 'academy' → recipientId = academyId (يُعرض لكل مدراء الأكاديمية)
// groupKey (اختياري): بدل إشعار جديد لكل حدث نحدّث الإشعار غير المقروء بنفس
// المفتاح (مثلاً رسائل متتالية من نفس اللاعب) فلا يمتلئ المركز؛ meta.count يزيد.
const groupedUpsert = ({ recipientType, recipientId, academyId, type, title, body, meta, groupKey }) => {
  const $set = { academyId, title, body, createdAt: new Date(), 'meta.groupKey': groupKey };
  for (const [k, v] of Object.entries(meta || {})) {
    if (k !== 'count' && k !== 'groupKey') $set[`meta.${k}`] = v;
  }
  return {
    filter: { recipientType, recipientId, type, isRead: false, 'meta.groupKey': groupKey },
    update: { $set, $inc: { 'meta.count': 1 } },
  };
};

const notify = ({ recipientType, recipientId, academyId, type, title, body = '', meta = {}, groupKey }) => {
  try {
    if (!recipientType || !recipientId || !academyId || !type || !title) return;
    let write;
    if (groupKey) {
      const { filter, update } = groupedUpsert({ recipientType, recipientId, academyId, type, title, body, meta, groupKey });
      write = Notification.findOneAndUpdate(filter, update, { upsert: true, timestamps: false });
    } else {
      write = Notification.create({ recipientType, recipientId, academyId, type, title, body, meta });
    }
    write.catch((err) => {
      logger.warn(`[NOTIFY] failed to create ${type}: ${err.message}`);
    });
    // Push للجهاز (إن كان Firebase مُعدّاً) — بالتوازي ولا يؤثر على الإشعار داخل التطبيق.
    pushForNotification({ recipientType, recipientId, type, title, body, meta });
  } catch (err) {
    logger.warn(`[NOTIFY] notify error: ${err.message}`);
  }
};

module.exports = { notify, groupedUpsert };
