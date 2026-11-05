// اختبارات تجديد الجلسة و tokenVersion — بلا قاعدة بيانات (User مُستبدَل بنسخة وهمية).
process.env.JWT_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const users = new Map();
const fakeUser = (id, extra = {}) => ({ _id: id, isActive: true, tokenVersion: 0, ...extra });
const userPath = path.join(__dirname, '../src/models/user.model.js');
require.cache[userPath] = {
  id: userPath, filename: userPath, loaded: true,
  exports: { findById: (id) => { const u = users.get(String(id)) || null;
    const q = Promise.resolve(u); q.select = () => q; q.populate = () => q; return q; } },
};

const jwt = require('../src/utils/jwt');
const { refresh } = require('../src/controllers/auth.controller');
const { protect } = require('../src/middleware/auth.middleware');

const run = (handler, req) => new Promise((resolve) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
  handler(req, res, (err) => resolve({ error: err }));
});

test('refresh: refresh token صالح → توكنات جديدة بنفس tokenVersion', async () => {
  users.set('u1', fakeUser('u1', { tokenVersion: 2 }));
  const r = await run(refresh, { body: { refreshToken: jwt.generateRefreshToken('u1', 2) } });
  assert.equal(r.status, 200);
  assert.equal(jwt.verifyToken(r.body.token).tv, 2);
  assert.equal(jwt.verifyRefreshToken(r.body.refreshToken).type, 'refresh');
});

test('refresh: بعد تغيير كلمة المرور (tokenVersion أعلى) يُرفض', async () => {
  users.set('u2', fakeUser('u2', { tokenVersion: 1 }));
  const r = await run(refresh, { body: { refreshToken: jwt.generateRefreshToken('u2', 0) } });
  assert.equal(r.error.statusCode, 401);
});

test('refresh: حساب معطّل أو توكن دخول بدل refresh يُرفض', async () => {
  users.set('u3', fakeUser('u3', { isActive: false }));
  assert.equal((await run(refresh, { body: { refreshToken: jwt.generateRefreshToken('u3') } })).error.statusCode, 401);
  users.set('u4', fakeUser('u4'));
  assert.equal((await run(refresh, { body: { refreshToken: jwt.generateToken('u4') } })).error.statusCode, 401);
});

test('protect: توكن قديم بلا tv يعمل طالما tokenVersion = 0، ويسقط بعد التغيير', async () => {
  const legacy = require('jsonwebtoken').sign({ id: 'u5' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  users.set('u5', fakeUser('u5'));
  const ok = await run(protect, { headers: { authorization: `Bearer ${legacy}` } });
  assert.equal(ok.error, undefined);
  users.set('u5', fakeUser('u5', { tokenVersion: 1 }));
  const bad = await run(protect, { headers: { authorization: `Bearer ${legacy}` } });
  assert.equal(bad.error.statusCode, 401);
});
