require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const connectDB = require('./config/database');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const notFound = require('./middleware/notFound');

const authRoutes = require('./routes/auth.routes');
const academyRoutes = require('./routes/academy.routes');
const userRoutes = require('./routes/user.routes');
const playerRoutes = require('./routes/player.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const evaluationRoutes = require('./routes/evaluation.routes');
const dashboardRoutes = require('./routes/dashboard.routes');

const app = express();

connectDB();

app.use(helmet());

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  message: { success: false, message: 'تم تجاوز الحد المسموح به من الطلبات' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (msg) => logger.info(msg.trim()) },
  }));
}

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'الخادم يعمل بشكل طبيعي',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
  });
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/academies', academyRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/players', playerRoutes);
app.use('/api/v1/subscriptions', subscriptionRoutes);
app.use('/api/v1/evaluations', evaluationRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  logger.info(`🚀 الخادم يعمل على المنفذ ${PORT} في بيئة ${process.env.NODE_ENV}`);
});

process.on('unhandledRejection', (err) => {
  logger.error(`Unhandled Rejection: ${err.message}`);
  server.close(() => process.exit(1));
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`);
  process.exit(1);
});

module.exports = server;
