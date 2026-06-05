const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const playerImageStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'basketball_academy/players',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [
      { width: 400, height: 400, crop: 'fill', gravity: 'face' },
      { quality: 'auto', fetch_format: 'auto' },
    ],
  },
});

const academyLogoStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'basketball_academy/logos',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'svg'],
    transformation: [
      { width: 300, height: 300, crop: 'fit' },
      { quality: 'auto', fetch_format: 'auto' },
    ],
  },
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('يُسمح فقط برفع ملفات الصور'), false);
  }
};

const uploadPlayerImage = multer({
  storage: playerImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter,
});

const uploadAcademyLogo = multer({
  storage: academyLogoStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter,
});

const deleteImage = async (publicId) => {
  return cloudinary.uploader.destroy(publicId);
};

module.exports = { cloudinary, uploadPlayerImage, uploadAcademyLogo, deleteImage };
