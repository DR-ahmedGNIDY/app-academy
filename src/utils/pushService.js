// إرسال Push Notifications عبر Firebase Cloud Messaging (HTTP v1) بدون مكتبة
// firebase-admin: نوقّع JWT بمفتاح حساب الخدمة (jsonwebtoken الموجودة أصلاً)
// ونبدّله بـ access token من Google ثم نستدعي FCM مباشرة.
//
// الإعداد على السيرفر (لا يُرفع المفتاح للـ Git أبداً):
//   FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/service-account.json
// بدون هذا المتغير يُعطَّل الإرسال بصمت — الإشعارات داخل التطبيق تعمل كالمعتاد.
const fs = require('fs');
const jwt = require('jsonwebtoken');
const DeviceToken = require('../models/deviceToken.model');
const User = require('../models/user.model');
const logger = require('./logger');

let account; // { project_id, client_email, private_key } أو false لو غير مُعدّ
let cachedToken = null; // { value, expiresAt }

const loadAccount = () => {
  if (account !== undefined) return account;
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!path) {
    logger.info('[PUSH] FIREBASE_SERVICE_ACCOUNT_PATH not set — push disabled');
    account = false;
    return account;
  }
  try {
    const json = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!json.project_id || !json.client_email || !json.private_key) {
      throw new Error('missing project_id/client_email/private_key');
    }
    account = json;
    logger.info(`[PUSH] enabled for Firebase project ${json.project_id}`);
  } catch (err) {
    logger.warn(`[PUSH] cannot load service account: ${err.message} — push disabled`);
    account = false;
  }
  return account;
};

const getAccessToken = async (acc) => {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: acc.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    acc.private_key,
    { algorithm: 'RS256' }
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`oauth ${res.status}: ${body.error || 'no token'}`);
  }
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return cachedToken.value;
};

// قيم data في FCM يجب أن تكون نصوصاً.
const stringify = (obj = {}) =>
  Object.fromEntries(
    Object.entries(obj)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])
  );

const sendToTokens = async (tokens, { title, body, data }) => {
  const acc = loadAccount();
  if (!acc || !tokens.length) return;
  const accessToken = await getAccessToken(acc);
  const url = `https://fcm.googleapis.com/v1/projects/${acc.project_id}/messages:send`;
  const dead = [];
  await Promise.all(
    tokens.map(async (token) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token,
              notification: { title, body: body || '' },
              data: stringify(data),
              android: {
                priority: 'high',
                notification: { channel_id: 'nosait_default', sound: 'default' },
              },
            },
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          const code =
            err?.error?.details?.find((d) => d.errorCode)?.errorCode || err?.error?.status;
          // التوكن لم يعد صالحاً (حُذف التطبيق / انتهى التسجيل) → نحذفه.
          if (res.status === 404 || code === 'UNREGISTERED') dead.push(token);
          else logger.warn(`[PUSH] send failed ${res.status} ${code || ''}`);
        }
      } catch (err) {
        logger.warn(`[PUSH] send error: ${err.message}`);
      }
    })
  );
  if (dead.length) await DeviceToken.deleteMany({ token: { $in: dead } });
};

// يُستدعى من notify(): يرسل Push لأصحاب الإشعار. لا يرمي أخطاء أبداً.
// recipientType 'player'  → أجهزة اللاعب.
// recipientType 'academy' → أجهزة مدراء/موظفي الأكاديمية النشطين.
const pushForNotification = async ({ recipientType, recipientId, type, title, body, meta }) => {
  try {
    if (!loadAccount()) return;
    let filter;
    if (recipientType === 'player') {
      filter = { ownerType: 'player', ownerId: recipientId };
    } else {
      const staff = await User.find({ academyId: recipientId, isActive: true }).select('_id');
      if (!staff.length) return;
      filter = { ownerType: 'user', ownerId: { $in: staff.map((u) => u._id) } };
    }
    const tokens = (await DeviceToken.find(filter).select('token')).map((d) => d.token);
    await sendToTokens(tokens, { title, body, data: { type, ...meta } });
  } catch (err) {
    logger.warn(`[PUSH] pushForNotification error: ${err.message}`);
  }
};

module.exports = { pushForNotification, sendToTokens };
