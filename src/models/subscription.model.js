const mongoose = require('mongoose');
const { PAYMENT_METHODS, paymentState } = require('../utils/subscriptionPayments');

// دفعة واحدة من مبلغ الاشتراك (دفع جزئي / أقساط).
const paymentSchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: [true, 'مبلغ الدفعة مطلوب'],
      min: [0.01, 'مبلغ الدفعة يجب أن يكون أكبر من صفر'],
    },
    date: { type: Date, default: Date.now },
    method: { type: String, enum: PAYMENT_METHODS, default: 'cash' },
    note: { type: String, trim: true, maxlength: [200, 'ملاحظة الدفعة طويلة جداً'] },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    recordedByName: { type: String, trim: true, default: '' },
    // رقم الإيصال (تسلسل لكل أكاديمية). القديم يُرقَّم عند أول طلب لإيصاله.
    receiptNo: { type: Number, default: null },
  },
  { _id: true }
);

const subscriptionSchema = new mongoose.Schema(
  {
    academyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Academy',
      required: [true, 'معرّف الأكاديمية مطلوب'],
    },
    playerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Player',
      required: [true, 'معرّف اللاعب مطلوب'],
    },
    type: {
      type: String,
      enum: {
        values: ['NEW_SUBSCRIPTION', 'RENEWAL'],
        message: 'نوع الاشتراك يجب أن يكون NEW_SUBSCRIPTION أو RENEWAL',
      },
      required: [true, 'نوع الاشتراك مطلوب'],
    },
    amount: {
      type: Number,
      required: [true, 'مبلغ الاشتراك مطلوب'],
      min: [0, 'مبلغ الاشتراك لا يمكن أن يكون سالباً'],
    },
    startDate: {
      type: Date,
      required: [true, 'تاريخ بداية الاشتراك مطلوب'],
    },
    endDate: {
      type: Date,
      required: [true, 'تاريخ نهاية الاشتراك مطلوب'],
      validate: {
        validator: function (value) {
          return value > this.startDate;
        },
        message: 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية',
      },
    },
    // عدد حصص الاشتراك (اختياري). عند استهلاكها ينتهي الاشتراك حتى لو لم ينتهِ تاريخه.
    sessionsLimit: {
      type: Number,
      default: null,
      min: [1, 'عدد الحصص يجب أن يكون 1 على الأقل'],
      max: [365, 'عدد الحصص كبير جداً'],
    },
    // لحظة استهلاك آخر حصة (null = لم تُستهلك). النهاية الفعلية = exhaustedAt ?? endDate.
    exhaustedAt: {
      type: Date,
      default: null,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [500, 'الملاحظات لا يمكن أن تتجاوز 500 حرف'],
    },
    // سجل الدفعات. غياب الحقل (اشتراك قديم) = مدفوع بالكامل يوم الإنشاء.
    payments: {
      type: [paymentSchema],
      default: undefined,
    },
    // مجموع payments (مُخزَّن لتسريع تقارير المديونيات). غيابه = amount.
    paidAmount: {
      type: Number,
      min: [0, 'المبلغ المدفوع لا يمكن أن يكون سالباً'],
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: {
      virtuals: true,
      transform: function (doc, ret) {
        ret._id = ret._id.toString();
        ret.academyId = ret.academyId?.toString();

        // إذا كان playerId مُحمَّلاً (populated object) نحتفظ به كـ object
        // ونحوّل فقط الـ _id الداخلي إلى string
        // إذا كان ObjectId عادياً نحوّله إلى string
        if (ret.playerId && typeof ret.playerId === 'object' && ret.playerId._id !== undefined) {
          // populated — stringify the nested _id only
          ret.playerId._id = ret.playerId._id?.toString();
        } else if (ret.playerId) {
          ret.playerId = ret.playerId.toString();
        }

        // حالة الدفع — القديم بلا paidAmount يظهر مدفوعاً بالكامل.
        Object.assign(ret, paymentState(ret));
        ret.payments = (ret.payments || []).map((p) => ({
          ...p,
          _id: p._id?.toString(),
          recordedBy: p.recordedBy?.toString() ?? null,
        }));

        delete ret.__v;
        return ret;
      },
    },
  }
);

// Virtuals
subscriptionSchema.virtual('isActive').get(function () {
  return !this.exhaustedAt && new Date() <= this.endDate;
});

subscriptionSchema.virtual('status').get(function () {
  return !this.exhaustedAt && new Date() <= this.endDate ? 'active' : 'expired';
});

// Indexes
subscriptionSchema.index({ playerId: 1 });
subscriptionSchema.index({ academyId: 1 });
subscriptionSchema.index({ academyId: 1, playerId: 1 });
subscriptionSchema.index({ endDate: 1 });
subscriptionSchema.index({ type: 1 });
subscriptionSchema.index({ academyId: 1, paidAmount: 1 });

const Subscription = mongoose.model('Subscription', subscriptionSchema);
module.exports = Subscription;
