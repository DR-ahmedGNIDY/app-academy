const mongoose = require('mongoose');

// تقييم اللاعب للتمرين الذي حضره — تقييم واحد لكل سجل حضور.
const trainingRatingSchema = new mongoose.Schema(
  {
    academyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Academy', required: true },
    playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
    attendanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Attendance', required: true },
    // يوم التمرين 'YYYY-MM-DD' (= Attendance.date) — أساس العرض اليومي عند الإدارة.
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    stars: {
      type: Number,
      required: [true, 'التقييم مطلوب'],
      min: [1, 'التقييم من 1 إلى 5'],
      max: [5, 'التقييم من 1 إلى 5'],
    },
    notes: {
      type: String,
      trim: true,
      default: '',
      maxlength: [500, 'الملاحظات لا يمكن أن تتجاوز 500 حرف'],
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: {
      transform: function (doc, ret) {
        ret._id = ret._id.toString();
        delete ret.__v;
        return ret;
      },
    },
  }
);

trainingRatingSchema.index({ attendanceId: 1 }, { unique: true });
trainingRatingSchema.index({ academyId: 1, date: -1 });

module.exports = mongoose.model('TrainingRating', trainingRatingSchema);
