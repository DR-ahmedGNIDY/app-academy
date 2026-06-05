const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      dbName: 'basketball_academy',
    });
    logger.info(`✅ MongoDB متصل: ${conn.connection.host}`);

    mongoose.connection.on('error', (err) => {
      logger.error(`MongoDB خطأ: ${err.message}`);
    });
    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB انقطع الاتصال');
    });
  } catch (error) {
    logger.error(`❌ فشل الاتصال بـ MongoDB: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
