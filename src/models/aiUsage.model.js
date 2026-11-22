const mongoose = require('mongoose');

// استهلاك المساعد الذكي: وثيقة لكل أكاديمية لكل يوم (بتوقيت القاهرة).
// count = عدد رسائل المدير المحسوبة على الحد اليومي؛ التوكنز لمتابعة التكلفة.
const aiUsageSchema = new mongoose.Schema(
  {
    academyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Academy', required: true },
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    count: { type: Number, default: 0, min: 0 },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

aiUsageSchema.index({ academyId: 1, day: 1 }, { unique: true });

module.exports = mongoose.model('AiUsage', aiUsageSchema);
