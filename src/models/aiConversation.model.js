const mongoose = require('mongoose');

// محادثة المدير مع المساعد الذكي (نص فقط — نتائج الأدوات لا تُخزَّن).
// محادثة واحدة نشطة لكل مستخدم؛ "محادثة جديدة" تمسحها. تُحذف تلقائياً بعد
// 30 يوماً من آخر نشاط.
const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true, maxlength: 6000 },
    at: { type: Date, default: Date.now },
    reported: { type: Boolean, default: false },
    reportReason: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { _id: true }
);

const aiConversationSchema = new mongoose.Schema(
  {
    academyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Academy', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    messages: { type: [messageSchema], default: [] },
    lastActivityAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

aiConversationSchema.index({ userId: 1 }, { unique: true });
aiConversationSchema.index({ lastActivityAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.model('AiConversation', aiConversationSchema);
