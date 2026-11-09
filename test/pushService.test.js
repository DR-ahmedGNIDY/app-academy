// اختبار إرسال Push عبر FCM HTTP v1 — بلا شبكة ولا قاعدة بيانات:
// fetch و DeviceToken و User كلها نسخ وهمية، ومفتاح RSA مولَّد للاختبار فقط.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyFile = path.join(os.tmpdir(), `fcm-test-${process.pid}.json`);
fs.writeFileSync(keyFile, JSON.stringify({
  project_id: 'demo-project',
  client_email: 'push@demo-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
}));
process.env.FIREBASE_SERVICE_ACCOUNT_PATH = keyFile;

const deleted = [];
const tokensByFilter = (f) => (f.ownerType === 'player' ? ['tok-ok', 'tok-dead'] : ['staff-1']);
const stub = (rel, exports) => {
  const p = path.join(__dirname, '../src', rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('models/deviceToken.model.js', {
  find: (f) => ({ select: async () => tokensByFilter(f).map((token) => ({ token })) }),
  deleteMany: async (q) => { deleted.push(...q.token.$in); },
});
stub('models/user.model.js', { find: () => ({ select: async () => [{ _id: 'u1' }] }) });
stub('utils/logger.js', { info() {}, warn() {} });

const calls = [];
global.fetch = async (url, opts) => {
  calls.push({ url, opts });
  if (url.includes('oauth2')) {
    return { ok: true, json: async () => ({ access_token: 'at-123', expires_in: 3600 }) };
  }
  const { message } = JSON.parse(opts.body);
  if (message.token === 'tok-dead') {
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }),
    };
  }
  return { ok: true, json: async () => ({ name: 'projects/demo-project/messages/1' }) };
};

const { pushForNotification } = require('../src/utils/pushService');

test.after(() => fs.rmSync(keyFile, { force: true }));

test('player push: يوقّع JWT، يرسل لكل توكن، ويحذف التوكن الميت', async () => {
  await pushForNotification({
    recipientType: 'player', recipientId: 'p1', type: 'MATCH_ADDED',
    title: 'مباراة جديدة', body: 'غداً 5 م', meta: { matchId: 'm1' },
  });
  const oauth = calls.find((c) => c.url.includes('oauth2'));
  const assertion = new URLSearchParams(oauth.opts.body).get('assertion');
  const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
  assert.equal(claims.iss, 'push@demo-project.iam.gserviceaccount.com');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');

  const sends = calls.filter((c) => c.url.includes('fcm.googleapis.com'));
  assert.equal(sends.length, 2);
  assert.ok(sends[0].url.endsWith('/projects/demo-project/messages:send'));
  assert.equal(sends[0].opts.headers.Authorization, 'Bearer at-123');
  const msg = JSON.parse(sends[0].opts.body).message;
  assert.equal(msg.notification.title, 'مباراة جديدة');
  assert.deepEqual(msg.data, { type: 'MATCH_ADDED', matchId: 'm1' });
  assert.deepEqual(deleted, ['tok-dead']);
});

test('academy push: يرسل لأجهزة الموظفين ويعيد استخدام access token المخزّن', async () => {
  calls.length = 0;
  await pushForNotification({ recipientType: 'academy', recipientId: 'a1', type: 'NEW_MESSAGE', title: 'رسالة' });
  assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 0);
  const sends = calls.filter((c) => c.url.includes('fcm.googleapis.com'));
  assert.equal(sends.length, 1);
  assert.equal(JSON.parse(sends[0].opts.body).message.token, 'staff-1');
});
