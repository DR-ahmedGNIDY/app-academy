const mongoose = require('mongoose');

// صورة واحدة في ألبوم أكاديمية. كل صورة مرتبطة حتمياً بـ academyId، فلا
// يمكن للاعبي أكاديمية رؤية صور أكاديمية أخرى (يُفرَض في الـ controller).
const academyAlbumSchema = new mongoose.Schema(
  {
    academyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Academy',
      required: [true, 'معرّف الأكاديمية مطلوب'],
    },
    title: {
      type: String,
      required: [true, 'العنوان مطلوب'],
      trim: true,
      minlength: [1, 'العنوان مطلوب'],
      maxlength: [150, 'العنوان لا يمكن أن يتجاوز 150 حرف'],
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: [1000, 'الوصف لا يمكن أن يتجاوز 1000 حرف'],
    },
    image_url: {
      type: String,
      required: [true, 'الصورة مطلوبة'],
    },
    // مخفي عن العميل؛ يُستخدم لحذف الصورة/الفيديو من Cloudinary.
    image_public_id: {
      type: String,
      required: true,
      select: false,
    },
    mediaType: {
      type: String,
      enum: ['image', 'video'],
      default: 'image',
    },
    // ترتيب العرض داخل الأكاديمية (سحب وإفلات). الافتراضي 0.
    order: {
      type: Number,
      default: 0,
    },
    // إعجابات — لاعب أو حساب إداري، عنصر واحد لكل مستخدم (يُفرَض في الـ controller).
    likes: {
      type: [
        {
          userType: { type: String, enum: ['player', 'admin'], required: true },
          userId: { type: mongoose.Schema.Types.ObjectId, required: true },
        },
      ],
      default: [],
    },
    comments: {
      type: [
        {
          userType: { type: String, enum: ['player', 'admin'], required: true },
          userId: { type: mongoose.Schema.Types.ObjectId, required: true },
          authorName: { type: String, required: true, trim: true },
          text: {
            type: String,
            required: [true, 'نص التعليق مطلوب'],
            trim: true,
            maxlength: [500, 'التعليق لا يمكن أن يتجاوز 500 حرف'],
          },
          created_at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: {
      virtuals: true,
      transform: function (doc, ret) {
        ret._id = ret._id.toString();
        ret.academyId = ret.academyId?.toString();
        (ret.likes || []).forEach((l) => {
          l.userId = l.userId?.toString();
        });
        (ret.comments || []).forEach((c) => {
          c._id = c._id?.toString();
          c.userId = c.userId?.toString();
        });
        delete ret.image_public_id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

academyAlbumSchema.index({ academyId: 1, order: 1, created_at: -1 });

const AcademyAlbum = mongoose.model('AcademyAlbum', academyAlbumSchema);
module.exports = AcademyAlbum;
