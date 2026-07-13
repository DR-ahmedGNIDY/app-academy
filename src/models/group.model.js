const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema(
  {
    academyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Academy',
      required: [true, 'معرّف الأكاديمية مطلوب'],
    },
    sportId: {
      type: String,
      trim: true,
      default: null,
    },
    name: {
      type: String,
      required: [true, 'اسم المجموعة مطلوب'],
      trim: true,
      minlength: [2, 'الاسم يجب أن يكون حرفين على الأقل'],
      maxlength: [150, 'الاسم لا يمكن أن يتجاوز 150 حرف'],
    },
    ageGroup: {
      type: String,
      trim: true,
      maxlength: [60, 'الفئة العمرية لا يمكن أن تتجاوز 60 حرف'],
      default: null,
    },
    capacity: {
      type: Number,
      min: [1, 'السعة القصوى يجب أن تكون 1 على الأقل'],
      default: null,
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
        ret.academyId = ret.academyId?.toString();
        delete ret.__v;
        return ret;
      },
    },
  }
);

groupSchema.index({ academyId: 1 });
groupSchema.index({ academyId: 1, sportId: 1 });

const Group = mongoose.model('Group', groupSchema);
module.exports = Group;
