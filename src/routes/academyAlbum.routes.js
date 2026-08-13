const express = require('express');
const { body, param } = require('express-validator');
const {
  getAlbum,
  createAlbumImage,
  updateAlbumImage,
  deleteAlbumImage,
  reorderAlbum,
  toggleLike,
  addComment,
  deleteComment,
} = require('../controllers/academyAlbum.controller');
const { protect, requirePermission } = require('../middleware/auth.middleware');
const { blockIfNotWritable } = require('../middleware/subscriptionGuard');
const { uploadAlbumImage } = require('../config/cloudinary');
const validate = require('../middleware/validate');

const router = express.Router();

router.use(protect);
// حارس اشتراك المنصة: يمنع الكتابة عند انتهاء/تعليق الاشتراك (لا يمسّ GET).
router.use(blockIfNotWritable);

const manage = requirePermission('use_album');

// GET /academy-album — قائمة مرقّمة (Pagination)
router.get('/', getAlbum);

// PATCH /academy-album/reorder ← قبل /:id لتفادي التعارض
router.patch('/reorder', manage, reorderAlbum);

// POST /academy-album — رفع صورة (نفس multer/Cloudinary، حد 2MB مطبَّق هناك)
router.post(
  '/',
  manage,
  uploadAlbumImage.single('image'),
  [
    body('title').notEmpty().withMessage('العنوان مطلوب')
      .isLength({ max: 150 }).withMessage('العنوان لا يمكن أن يتجاوز 150 حرف'),
    body('description').optional().isLength({ max: 1000 })
      .withMessage('الوصف لا يمكن أن يتجاوز 1000 حرف'),
  ],
  validate,
  createAlbumImage
);

// PATCH /academy-album/:id — تعديل العنوان/الوصف
router.patch(
  '/:id',
  manage,
  [
    param('id').isMongoId().withMessage('معرّف الصورة غير صحيح'),
    body('title').optional().isLength({ min: 1, max: 150 })
      .withMessage('العنوان يجب أن يكون بين 1 و 150 حرف'),
    body('description').optional().isLength({ max: 1000 })
      .withMessage('الوصف لا يمكن أن يتجاوز 1000 حرف'),
  ],
  validate,
  updateAlbumImage
);

// DELETE /academy-album/:id
router.delete(
  '/:id',
  manage,
  [param('id').isMongoId().withMessage('معرّف الصورة غير صحيح')],
  validate,
  deleteAlbumImage
);

// POST /academy-album/:id/like — تبديل إعجاب (يتطلب صلاحية use_album)
router.post(
  '/:id/like',
  manage,
  [param('id').isMongoId().withMessage('معرّف العنصر غير صحيح')],
  validate,
  toggleLike
);

// POST /academy-album/:id/comments — إضافة تعليق
router.post(
  '/:id/comments',
  manage,
  [
    param('id').isMongoId().withMessage('معرّف العنصر غير صحيح'),
    body('text').notEmpty().withMessage('نص التعليق مطلوب')
      .isLength({ max: 500 }).withMessage('التعليق لا يمكن أن يتجاوز 500 حرف'),
  ],
  validate,
  addComment
);

// DELETE /academy-album/:id/comments/:commentId
router.delete(
  '/:id/comments/:commentId',
  manage,
  [
    param('id').isMongoId().withMessage('معرّف العنصر غير صحيح'),
    param('commentId').isMongoId().withMessage('معرّف التعليق غير صحيح'),
  ],
  validate,
  deleteComment
);

module.exports = router;
