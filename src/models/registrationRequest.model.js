const mongoose = require('mongoose');

// طلب تسجيل لاعب من الفورم الأونلاين العام (/join/:code). المدير يقبله
// (فيُنشأ اللاعب بنفس منطق إضافة لاعب) أو يرفضه.
const registrationRequestSchema = new mongoose.Schema(
  {
    academyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Academy', required: true },
    playerName: { type: String, required: true, trim: true, maxlength: 100 },
    birthDate: { type: Date, required: true },
    sport: { type: String, trim: true, default: '' },
    parentName: { type: String, required: true, trim: true, maxlength: 100 },
    parentRelationship: { type: String, required: true, trim: true, maxlength: 30 },
    parentPhone: { type: String, required: true, trim: true, maxlength: 20 },
    playerPhone: { type: String, trim: true, maxlength: 20, default: '' },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
    // pending → processing (حجز ذرّي أثناء القبول) → accepted | rejected
    status: {
      type: String,
      enum: ['pending', 'processing', 'accepted', 'rejected'],
      default: 'pending',
    },
    rejectReason: { type: String, trim: true, maxlength: 200, default: '' },
    playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', default: null },
    handledByName: { type: String, trim: true, default: '' },
    handledAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: {
      transform(doc, ret) {
        ret._id = ret._id.toString();
        ret.academyId = ret.academyId?.toString();
        ret.playerId = ret.playerId ? ret.playerId.toString() : null;
        delete ret.__v;
        return ret;
      },
    },
  }
);

registrationRequestSchema.index({ academyId: 1, status: 1, created_at: -1 });
registrationRequestSchema.index({ academyId: 1, parentPhone: 1 });

module.exports = mongoose.model('RegistrationRequest', registrationRequestSchema);
