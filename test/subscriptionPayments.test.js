const test = require('node:test');
const assert = require('node:assert');

const {
  paymentState,
  validatePaymentAmount,
  resolveInitialPaid,
  groupDebtsByPlayer,
  collectedTotalStages,
  buildReceipt,
  formatReceiptNo,
} = require('../src/utils/subscriptionPayments');

test('receipt shows paid-to-date and remaining as of that payment', () => {
  const subscription = {
    _id: 's1', type: 'RENEWAL', amount: 500,
    startDate: '2026-11-01', endDate: '2026-12-01',
    payments: [
      { _id: 'b', amount: 100, date: '2026-11-10', receiptNo: 8, method: 'instapay' },
      { _id: 'a', amount: 200, date: '2026-11-01', receiptNo: 7 },
    ],
  };
  const r1 = buildReceipt({ subscription, payment: subscription.payments[1], academy: { name: 'X' }, player: { fullName: 'علي' } });
  assert.strictEqual(r1.subscription.paidToDate, 200);
  assert.strictEqual(r1.subscription.remainingAfter, 300);
  assert.strictEqual(r1.receiptNoLabel, '000007');
  assert.strictEqual(r1.payment.method, 'cash');
  assert.strictEqual(r1.academy.currency, 'EGP');

  const r2 = buildReceipt({ subscription, payment: subscription.payments[0], academy: null, player: null });
  assert.strictEqual(r2.subscription.paidToDate, 300);
  assert.strictEqual(r2.subscription.remainingAfter, 200);
  assert.strictEqual(r2.payment.method, 'instapay');
  assert.strictEqual(formatReceiptNo(null), '');
});

test('legacy subscription without paidAmount counts as fully paid', () => {
  assert.deepStrictEqual(paymentState({ amount: 500 }), {
    paidAmount: 500, remainingAmount: 0, paymentStatus: 'paid',
  });
});

test('payment status: unpaid / partial / paid', () => {
  assert.strictEqual(paymentState({ amount: 500, paidAmount: 0 }).paymentStatus, 'unpaid');
  const partial = paymentState({ amount: 500, paidAmount: 200 });
  assert.strictEqual(partial.paymentStatus, 'partial');
  assert.strictEqual(partial.remainingAmount, 300);
  assert.strictEqual(paymentState({ amount: 500, paidAmount: 500 }).paymentStatus, 'paid');
  // كسور عشرية لا تترك متبقياً وهمياً
  assert.strictEqual(paymentState({ amount: 0.3, paidAmount: 0.1 + 0.2 }).paymentStatus, 'paid');
});

test('initial paid defaults to full amount for old clients', () => {
  assert.deepStrictEqual(resolveInitialPaid(500, undefined), { paid: 500 });
  assert.deepStrictEqual(resolveInitialPaid(500, null), { paid: 500 });
  assert.deepStrictEqual(resolveInitialPaid(500, 0), { paid: 0 });
  assert.deepStrictEqual(resolveInitialPaid(500, '150'), { paid: 150 });
  assert.ok(resolveInitialPaid(500, 600).error);
  assert.ok(resolveInitialPaid(500, -1).error);
  assert.ok(resolveInitialPaid(500, 'abc').error);
});

test('payment amount must be positive and not exceed remaining', () => {
  assert.strictEqual(validatePaymentAmount(100, 300), null);
  assert.strictEqual(validatePaymentAmount(300, 300), null);
  assert.ok(validatePaymentAmount(0, 300));
  assert.ok(validatePaymentAmount(-5, 300));
  assert.ok(validatePaymentAmount(301, 300));
  assert.ok(validatePaymentAmount(10, 0));
});

test('debts are grouped per player and sorted by total due', () => {
  const ali = { _id: 'p1', fullName: 'علي', playerCode: 'A1', parentPhone: '010' };
  const omar = { _id: 'p2', fullName: 'عمر', playerCode: 'O1', parentPhone: '011' };
  const subs = [
    { _id: 's1', playerId: ali, type: 'NEW_SUBSCRIPTION', amount: 500, paidAmount: 400, startDate: '2026-02-01' },
    { _id: 's2', playerId: ali, type: 'RENEWAL', amount: 500, paidAmount: 300, startDate: '2026-01-01' },
    { _id: 's3', playerId: omar, type: 'RENEWAL', amount: 1000, paidAmount: 0, startDate: '2026-03-01' },
    { _id: 's4', playerId: omar, type: 'RENEWAL', amount: 500, paidAmount: 500, startDate: '2026-04-01' },
  ];
  const { players, summary } = groupDebtsByPlayer(subs);
  assert.deepStrictEqual(players.map((p) => p.playerId), ['p2', 'p1']);
  assert.strictEqual(players[0].totalDue, 1000);
  assert.strictEqual(players[1].totalDue, 300);
  // الأقدم أولاً داخل اللاعب
  assert.deepStrictEqual(players[1].subscriptions.map((s) => s._id), ['s2', 's1']);
  assert.deepStrictEqual(summary, { totalOutstanding: 1300, playersCount: 2, subscriptionsCount: 3 });
});

test('collected revenue falls back to full amount for legacy docs only', () => {
  const [addFields, unwind, match, group] = collectedTotalStages({ from: new Date(0), to: new Date() });
  assert.deepStrictEqual(addFields.$addFields._pay.$ifNull[1], [{ amount: '$amount', date: '$created_at' }]);
  assert.strictEqual(unwind.$unwind, '$_pay');
  assert.ok(match.$match['_pay.date'].$gte);
  assert.strictEqual(group.$group.total.$sum, '$_pay.amount');
  assert.strictEqual(collectedTotalStages().length, 3);
});
