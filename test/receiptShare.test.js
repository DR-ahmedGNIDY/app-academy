const test = require('node:test');
const assert = require('node:assert');

const {
  newShareToken,
  isValidToken,
  hasValidShare,
  renderReceiptPage,
  renderExpiredPage,
  shareUrlFor,
  clearShare,
  SHARE_TTL_DAYS,
} = require('../src/utils/receiptShare');

test('share tokens are random, url-safe and 32 chars', () => {
  const a = newShareToken();
  const b = newShareToken();
  assert.notStrictEqual(a, b);
  assert.strictEqual(a.length, 32);
  assert.ok(isValidToken(a));
  assert.ok(!isValidToken('short'));
  assert.ok(!isValidToken('../../etc/passwd'.padEnd(32, 'a')));
  assert.ok(!isValidToken(undefined));
});

test('share validity requires token, image and a future expiry', () => {
  const now = new Date('2026-11-20T10:00:00Z');
  const ok = { shareToken: 't', shareImageUrl: 'u', shareExpiresAt: new Date('2027-01-19T10:00:00Z') };
  assert.ok(hasValidShare(ok, now));
  assert.ok(!hasValidShare({ ...ok, shareExpiresAt: new Date('2026-11-19T10:00:00Z') }, now));
  assert.ok(!hasValidShare({ ...ok, shareImageUrl: undefined }, now));
  assert.ok(!hasValidShare(null, now));
  assert.strictEqual(SHARE_TTL_DAYS, 60);
});

test('receipt page has og:image and escapes user content', () => {
  const html = renderReceiptPage({
    academyName: 'أكاديمية <script>alert(1)</script>',
    playerName: 'علي "x"',
    amount: 300,
    currency: 'EGP',
    date: '2026-11-20T10:00:00Z',
    receiptNoLabel: '000123',
    imageUrl: 'https://res.cloudinary.com/demo/image/upload/r.png',
    expiresAt: '2027-01-19T10:00:00Z',
  });
  assert.match(html, /<meta property="og:image" content="https:\/\/res\.cloudinary\.com\/demo\/image\/upload\/r\.png">/);
  assert.match(html, /رقم 000123/);
  assert.match(html, /300 جنيه/);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&quot;x&quot;'));
  assert.match(renderExpiredPage(), /غير متاح/);
});

test('share url uses the request host and clearShare wipes fields', () => {
  const req = { protocol: 'https', get: () => 'api.nosait.com' };
  assert.strictEqual(shareUrlFor(req, 'abc'), 'https://api.nosait.com/r/abc');
  const p = { shareToken: 't', shareImageUrl: 'u', shareImagePublicId: 'id', shareExpiresAt: new Date() };
  clearShare(p);
  assert.deepStrictEqual(
    [p.shareToken, p.shareImageUrl, p.shareImagePublicId, p.shareExpiresAt],
    [undefined, undefined, undefined, undefined]
  );
});
