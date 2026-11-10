const test = require('node:test');
const assert = require('node:assert');

const { groupedUpsert } = require('../src/utils/notificationService');
const { hiddenTypesFor, centerFilter } = require('../src/controllers/notification.controller');
const { albumCommentNotification } = require('../src/controllers/academyAlbum.controller');

test('academy center shows NEW_MESSAGE, player center hides it', () => {
  assert.deepStrictEqual(hiddenTypesFor('academy'), []);
  assert.deepStrictEqual(hiddenTypesFor('player'), ['NEW_MESSAGE']);
  assert.strictEqual(centerFilter('academy', 'a1').type, undefined);
  assert.deepStrictEqual(centerFilter('player', 'p1').type, { $nin: ['NEW_MESSAGE'] });
});

test('groupedUpsert targets the unread notification with the same groupKey', () => {
  const { filter, update } = groupedUpsert({
    recipientType: 'academy', recipientId: 'a1', academyId: 'a1', type: 'NEW_MESSAGE',
    title: 't', body: 'b', meta: { conversationId: 'c1', count: 99 }, groupKey: 'chat:c1',
  });
  assert.deepStrictEqual(filter, {
    recipientType: 'academy', recipientId: 'a1', type: 'NEW_MESSAGE', isRead: false, 'meta.groupKey': 'chat:c1',
  });
  assert.strictEqual(update.$set['meta.conversationId'], 'c1');
  assert.strictEqual(update.$set['meta.count'], undefined); // count managed by $inc only
  assert.deepStrictEqual(update.$inc, { 'meta.count': 1 });
  assert.ok(update.$set.createdAt instanceof Date);
});

test('album comment by a player notifies the academy', () => {
  const item = { _id: { toString: () => 'img1' }, academyId: 'acad1' };
  const n = albumCommentNotification(item, { userType: 'player', userId: 'p1', name: 'أحمد' }, 'صورة جميلة');
  assert.strictEqual(n.recipientType, 'academy');
  assert.strictEqual(n.recipientId, 'acad1');
  assert.strictEqual(n.type, 'ALBUM_COMMENT');
  assert.match(n.title, /أحمد/);
  assert.strictEqual(n.meta.albumItemId, 'img1');
});

test('album comment by staff does not notify', () => {
  const item = { _id: 'img1', academyId: 'acad1' };
  assert.strictEqual(albumCommentNotification(item, { userType: 'admin', userId: 'u1' }, 'x'), null);
});

test('long comment body is truncated', () => {
  const item = { _id: 'img1', academyId: 'acad1' };
  const n = albumCommentNotification(item, { userType: 'player', userId: 'p1' }, 'a'.repeat(200));
  assert.strictEqual(n.body.length, 81);
});
