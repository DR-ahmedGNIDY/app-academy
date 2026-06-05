const mongoose = require('mongoose');

const academySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'اسم الأكاديمية مطلوب'],
      trim: true,
      minlength: [2, 'الاسم يجب أن يكون حرفين على الأقل'],
      maxlength: [150, 'الاسم لا يمكن أن يتجاوز 150 حرف'],
    },
    logo_url: {
      type: String,
      default: null,
    },
    logo_public_id: {
      type: String,
      default: null,
      select: false,
    },
    phone: {
      type: String,
      required: [true, 'رقم الهاتف مطلوب'],
      trim: true,
      match: [/^[0-9+\-\s()]{7,20}$/, 'رقم الهاتف غير صحيح'],
    },
    address: {
      type: String,
      required: [true, 'العنوان مطلوب'],
      trim: true,
      maxlength: [300, 'العنوان لا يمكن أن يتجاوز 300 حرف'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: {
      virtuals: true,
      transform: function (doc, ret) {
        ret._id = ret._id.toString();
        delete ret.__v;
        delete ret.logo_public_id;
        return ret;
      },
    },
  }
);

academySchema.virtual('player_count', {
  ref: 'Player',
  localField: '_id',
  foreignField: 'academyId',
  count: true,
});

academySchema.index({ name: 'text' });
academySchema.index({ isActive: 1 });

const Academy = mongoose.model('Academy', academySchema);
module.exports = Academy;
