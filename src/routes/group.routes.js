const express = require('express');
const { body } = require('express-validator');
const {
  getGroups,
  getGroupsByAcademy,
  getGroupsBySport,
  getGroupById,
  createGroup,
  updateGroup,
  deleteGroup,
} = require('../controllers/group.controller');
const { protect, restrictTo } = require('../middleware/auth.middleware');
const { blockIfNotWritable } = require('../middleware/subscriptionGuard');
const validate = require('../middleware/validate');

const router = express.Router();

router.use(protect);
// حارس اشتراك المنصة: يمنع الكتابة عند انتهاء/تعليق الاشتراك (لا يمسّ GET).
router.use(blockIfNotWritable);

const createValidators = [
  body('name')
    .notEmpty().withMessage('اسم المجموعة مطلوب')
    .isLength({ min: 2, max: 150 }).withMessage('الاسم يجب أن يكون بين 2 و 150 حرف'),
  body('ageGroup')
    .optional({ checkFalsy: true })
    .isLength({ max: 60 }).withMessage('الفئة العمرية لا يمكن أن تتجاوز 60 حرف'),
  body('capacity')
    .optional({ checkFalsy: true })
    .isInt({ min: 1 }).withMessage('السعة القصوى غير صحيحة'),
  body('sportId')
    .optional({ checkFalsy: true })
    .isLength({ max: 60 }).withMessage('اسم الرياضة غير صحيح'),
];

const updateValidators = [
  body('name').optional().isLength({ min: 2, max: 150 }).withMessage('الاسم يجب أن يكون بين 2 و 150 حرف'),
  body('ageGroup').optional({ checkFalsy: true }).isLength({ max: 60 }).withMessage('الفئة العمرية لا يمكن أن تتجاوز 60 حرف'),
  body('capacity').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('السعة القصوى غير صحيحة'),
  body('isActive').optional().isBoolean().withMessage('قيمة التفعيل غير صحيحة'),
  body('sportId').optional({ checkFalsy: true }).isLength({ max: 60 }).withMessage('اسم الرياضة غير صحيح'),
];

// GET /groups
router.get('/', getGroups);

// GET /groups/academy/:academyId
router.get('/academy/:academyId', getGroupsByAcademy);

// GET /groups/sport/:sportId
router.get('/sport/:sportId', getGroupsBySport);

// GET /groups/:id
router.get('/:id', getGroupById);

// POST /groups
router.post('/', restrictTo('super_admin'), createValidators, validate, createGroup);

// PATCH /groups/:id
router.patch('/:id', restrictTo('super_admin', 'academy_admin'), updateValidators, validate, updateGroup);

// DELETE /groups/:id
router.delete('/:id', restrictTo('super_admin'), deleteGroup);

module.exports = router;
