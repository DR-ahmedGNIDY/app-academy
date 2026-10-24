const mongoose = require('mongoose');

// مباراة (جدولة + تذكير) — بدون نتيجة أو فريق خصم أو حالة دورة حياة.
const matchSchema = new mongoose.Schema(
  {
    academyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Academy',
      required: [true, 'معرّف الأكاديمية مطلوب'],
    },
    sport: {
      type: String,
      default: null,
    },
    name: {
      type: String,
      required: [true, 'اسم المباراة مطلوب'],
      trim: true,
      minlength: [2, 'اسم المباراة يجب أن يكون حرفين على الأقل'],
      maxlength: [150, 'اسم المباراة لا يمكن أن يتجاوز 150 حرف'],
    },
    location: {
      type: String,
      required: [true, 'مكان المباراة مطلوب'],
      trim: true,
      maxlength: [200, 'المكان لا يمكن أن يتجاوز 200 حرف'],
    },
    date: {
      type: String,
      required: [true, 'تاريخ المباراة مطلوب'],
      match: [/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ غير صحيحة'],
    },
    time: {
      type: String,
      required: [true, 'وقت المباراة مطلوب'],
      match: [/^\d{2}:\d{2}$/, 'صيغة الوقت غير صحيحة'],
    },
    notes: {
      type: String,
      default: '',
      trim: true,
      maxlength: [500, 'الملاحظات لا يمكن أن تتجاوز 500 حرف'],
    },
    playerIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }],
      default: [],
    },
    // هل يُحتسب حضور يوم المباراة ضمن حصص اشتراك اللاعب؟
    countsAsSession: { type: Boolean, default: false },
    // هل للمباراة اشتراك يدفعه اللاعب؟ وقيمته (قد تُكتب بعد الإنشاء).
    hasFee: { type: Boolean, default: false },
    feeAmount: { type: Number, default: null, min: [0, 'قيمة الاشتراك لا يمكن أن تكون سالبة'] },
    // هل تُضاف مدفوعات المباراة إلى إيرادات الأكاديمية؟
    addToRevenue: { type: Boolean, default: false },
    // من دفع اشتراك المباراة (المبلغ وقت الدفع + تاريخه — أساس الإيرادات).
    payments: {
      type: [
        {
          playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' },
          amount: { type: Number, default: 0 },
          paidAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    // لاعبون سُجّل لهم حضور يوم المباراة (انظر matchAttendanceScheduler).
    matchAttendanceDone: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }],
      default: [],
    },
    reminderLog: {
      type: [
        {
          playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' },
          sentAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        ret._id = ret._id.toString();
        ret.academyId = ret.academyId?.toString();
        ret.playerIds = (ret.playerIds || []).map((id) => id.toString());
        ret.payments = (ret.payments || []).map((p) => ({
          playerId: p.playerId?.toString(),
          amount: p.amount,
          paidAt: p.paidAt,
        }));
        delete ret.matchAttendanceDone;
        ret.reminderLog = (ret.reminderLog || []).map((r) => ({
          playerId: r.playerId?.toString(),
          sentAt: r.sentAt,
        }));
        delete ret.__v;
        return ret;
      },
    },
  }
);

matchSchema.index({ academyId: 1 });
matchSchema.index({ academyId: 1, date: 1 });

const Match = mongoose.model('Match', matchSchema);
module.exports = Match;
