const mongoose = require('mongoose');

// توكن FCM لجهاز مسجّل الدخول — يُستخدم لإرسال Push Notifications.
// ownerType 'user'   → ownerId = User (مدير/موظف)، تصله إشعارات أكاديميته.
// ownerType 'player' → ownerId = Player، تصله إشعاراته الشخصية.
const deviceTokenSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, trim: true },
    ownerType: { type: String, enum: ['user', 'player'], required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    academyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Academy', default: null },
    platform: { type: String, enum: ['android', 'ios', 'web'], default: 'android' },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

deviceTokenSchema.index({ ownerType: 1, ownerId: 1 });
deviceTokenSchema.index({ ownerType: 1, academyId: 1 });

module.exports = mongoose.model('DeviceToken', deviceTokenSchema);
