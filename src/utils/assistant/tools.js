// أدوات المساعد الذكي (المرحلة 1: قراءة فقط).
//
// قواعد أمان:
//  - كل أداة مقيّدة بأكاديمية المستخدم (ctx.academyId) — لا تقبل academyId من الموديل.
//  - لا توجد أي أداة تكتب أو تمسح. المرحلة 2 (تنفيذ أوامر) ستضيف كروت تأكيد.
//  - الأدوات المعقّدة تستدعي نفس الـ controllers التي يستخدمها التطبيق عبر
//    استجابة وهمية، فالأرقام مطابقة لما يظهر في الشاشات.
//  - لا نرسل أرقام هواتف أو بيانات غير لازمة لـ OpenAI.
const mongoose = require('mongoose');
const Player = require('../../models/player.model');
const Subscription = require('../../models/subscription.model');
const Attendance = require('../../models/attendance.model');
const Match = require('../../models/match.model');
const Evaluation = require('../../models/evaluation.model');
const { paymentState } = require('../subscriptionPayments');
const { freezeState } = require('../subscriptionFreeze');
const { getDashboardStats } = require('../../controllers/dashboard.controller');
const { getAcademyDebts } = require('../../controllers/subscription.controller');
const { getProfitLoss } = require('../../controllers/finance.controller');
const { getPlayerAttendanceSummary } = require('../../controllers/attendance.controller');
const { getPlayerStats, getLeaderboard } = require('../../controllers/matchStats.controller');

const WEEKDAY_AR = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIST = 50;
const MAX_RESULT_CHARS = 12000;

// ─── مساعدات ────────────────────────────────────────────────────────────────

/** تاريخ اليوم بتوقيت القاهرة YYYY-MM-DD (السيرفر يعمل بـ UTC). */
function cairoDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function weekdayAr(dateStr) {
  const [y, m, dd] = dateStr.split('-').map(Number);
  return WEEKDAY_AR[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
}

function addDays(dateStr, n) {
  const [y, m, dd] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, dd + n));
  return d.toISOString().slice(0, 10);
}

/** تطبيع عربي للبحث: بلا تشكيل، أ/إ/آ→ا، ة→ه، ى→ي. */
function normalizeArabic(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

/** درجة تطابق الاسم مع البحث (0 = لا تطابق). */
function nameMatchScore(name, code, query) {
  const q = normalizeArabic(query);
  if (!q) return 0;
  const n = normalizeArabic(name);
  if (String(code || '').toLowerCase() === q) return 100;
  if (n === q) return 90;
  const tokens = q.split(' ');
  if (!tokens.every((t) => n.includes(t))) return 0;
  return n.startsWith(q) ? 70 : 50;
}

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const ageOf = (birth) => {
  if (!birth) return null;
  const b = new Date(birth);
  const now = new Date();
  let a = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) a--;
  return a;
};

const cap = (list, n = MAX_LIST) => ({ items: list.slice(0, n), total: list.length, truncated: list.length > n });

/** يستدعي controller قائماً باستجابة وهمية ويرجّع جسم الرد (أو يرمي خطأ). */
function callController(handler, ctx, { params = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = { user: ctx.user, params, query, body: {}, headers: {}, get: () => '' };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) {
        if (this.statusCode >= 400) reject(new Error(body?.message || 'request failed'));
        else resolve(body);
        return this;
      },
    };
    Promise.resolve(handler(req, res, (err) => reject(err || new Error('request failed')))).catch(reject);
  });
}

const oid = (id) => new mongoose.Types.ObjectId(String(id));

// ─── الأدوات ────────────────────────────────────────────────────────────────

async function academyOverview(args, ctx) {
  const body = await callController(getDashboardStats, ctx);
  const d = body.data || {};
  return {
    currency: ctx.currency,
    totalPlayers: d.totalPlayers,
    activePlayers: d.activePlayers,
    activeSubscriptions: d.activeSubscriptions,
    expiredSubscriptions: d.expiredSubscriptions,
    currentMonthRevenue: d.currentMonthRevenue,
    totalRevenue: d.totalRevenue,
    outstandingDebtsTotal: d.outstandingTotal,
    newSubscriptionsCount: d.newSubscriptionsCount,
    renewalsCount: d.renewalsCount,
    currentMonthExpenses: d.currentMonthExpenses,
    totalGroups: d.totalGroups,
    playersWithoutGroup: d.playersWithoutGroup,
    averageEvaluationScore: d.averageEvaluationScore,
  };
}

async function searchPlayers({ name }, ctx) {
  const players = await Player.find({ academyId: ctx.academyId })
    .select('fullName playerCode sport isActive groupId birthDate')
    .populate('groupId', 'name')
    .lean();
  const scored = players
    .map((p) => ({ p, s: nameMatchScore(p.fullName, p.playerCode, name) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.p.fullName.localeCompare(b.p.fullName, 'ar'));
  const list = scored.slice(0, 10).map(({ p }) => ({
    playerId: String(p._id),
    name: p.fullName,
    code: p.playerCode,
    sport: p.sport || null,
    group: p.groupId?.name || null,
    age: ageOf(p.birthDate),
    active: p.isActive !== false,
  }));
  return { matches: list, count: scored.length, note: scored.length > 1 ? 'أكثر من لاعب — اسأل المدير أيهم يقصد إن لم يكن واضحاً' : undefined };
}

async function playerDetails({ playerId }, ctx) {
  if (!mongoose.Types.ObjectId.isValid(playerId)) return { error: 'معرّف لاعب غير صحيح — استخدم search_players أولاً' };
  const player = await Player.findOne({ _id: playerId, academyId: ctx.academyId })
    .select('fullName playerCode sport birthDate isActive groupId attendanceDays created_at')
    .populate('groupId', 'name')
    .lean();
  if (!player) return { error: 'اللاعب غير موجود في هذه الأكاديمية' };

  const now = new Date();
  const [subs, lastEval, attendance, stats] = await Promise.all([
    Subscription.find({ playerId: player._id }).sort({ startDate: -1 }).limit(3).lean(),
    Evaluation.findOne({ playerId: player._id }).sort({ created_at: -1 })
      .select('fitness basicSkills attack defense commitment notes created_at evaluationDate').lean(),
    callController(getPlayerAttendanceSummary, ctx, { params: { id: String(player._id) } })
      .then((b) => b.data?.stats || null).catch(() => null),
    callController(getPlayerStats, ctx, { params: { playerId: String(player._id) } })
      .then((b) => b.data || null).catch(() => null),
  ]);

  return {
    currency: ctx.currency,
    player: {
      name: player.fullName,
      code: player.playerCode,
      sport: player.sport || null,
      group: player.groupId?.name || null,
      age: ageOf(player.birthDate),
      active: player.isActive !== false,
      attendanceDays: player.attendanceDays || [],
      joinedAt: day(player.created_at),
    },
    subscriptions: subs.map((s) => {
      const pay = paymentState(s);
      const fr = freezeState(s, now);
      return {
        type: s.type,
        amount: s.amount,
        paid: pay.paidAmount,
        remaining: pay.remainingAmount,
        paymentStatus: pay.paymentStatus,
        startDate: day(s.startDate),
        endDate: day(s.exhaustedAt || s.endDate),
        isCurrent: new Date(s.exhaustedAt || s.endDate) >= now && new Date(s.startDate) <= now,
        sessionsLimit: s.sessionsLimit ?? null,
        freeze: fr.freezeStatus ? { status: fr.freezeStatus, until: day(fr.currentFreeze?.endDate) } : null,
      };
    }),
    attendanceThisSubscription: attendance,
    latestEvaluation: lastEval ? {
      date: day(lastEval.evaluationDate || lastEval.created_at),
      fitness: lastEval.fitness, basicSkills: lastEval.basicSkills, attack: lastEval.attack,
      defense: lastEval.defense, commitment: lastEval.commitment,
    } : null,
    matchStats: stats ? {
      matches: stats.summary?.matches || 0,
      mvpCount: stats.summary?.mvpCount || 0,
      avgRating: stats.summary?.avgRating ?? null,
      totals: stats.summary?.fields || {},
      recent: (stats.recent || []).slice(0, 3).map((r) => ({
        match: r.matchName, date: r.date, opponent: r.opponent || null, rating: r.rating, mvp: r.mvp, stats: r.stats,
      })),
    } : null,
  };
}

async function debts({ search }, ctx) {
  const body = await callController(getAcademyDebts, ctx, {
    params: { academyId: String(ctx.academyId) },
    query: search ? { search } : {},
  });
  const d = body.data || { players: [], summary: {} };
  const rows = [...(d.players || [])]
    .sort((a, b) => b.totalDue - a.totalDue)
    .map((p) => ({ name: p.fullName, code: p.playerCode, totalDue: p.totalDue, subscriptions: p.subscriptions?.length || 0 }));
  return { currency: ctx.currency, summary: d.summary, players: cap(rows, 40) };
}

async function subscriptionsStatus({ status = 'expiring_soon', days = 7 }, ctx) {
  const within = Math.min(60, Math.max(1, Number(days) || 7));
  const now = new Date();
  const soon = new Date(now.getTime() + within * 86400000);
  const [latest, players] = await Promise.all([
    Subscription.aggregate([
      { $match: { academyId: oid(ctx.academyId) } },
      { $group: { _id: '$playerId', end: { $max: { $ifNull: ['$exhaustedAt', '$endDate'] } } } },
    ]),
    Player.find({ academyId: ctx.academyId, isActive: true }).select('fullName playerCode').lean(),
  ]);
  const endBy = new Map(latest.filter((r) => r._id).map((r) => [String(r._id), r.end]));
  const buckets = { active: [], expiring_soon: [], expired: [], no_subscription: [] };
  for (const p of players) {
    const end = endBy.get(String(p._id));
    const row = { name: p.fullName, code: p.playerCode, endDate: day(end) };
    if (!end) buckets.no_subscription.push(row);
    else if (end < now) buckets.expired.push(row);
    else {
      buckets.active.push(row);
      if (end <= soon) buckets.expiring_soon.push(row);
    }
  }
  const key = buckets[status] ? status : 'expiring_soon';
  const list = buckets[key].sort((a, b) => String(a.endDate).localeCompare(String(b.endDate)));
  return {
    counts: {
      activePlayers: players.length,
      withActiveSubscription: buckets.active.length,
      expiringWithinDays: buckets.expiring_soon.length,
      expired: buckets.expired.length,
      noSubscription: buckets.no_subscription.length,
    },
    expiringWindowDays: within,
    requested: key,
    players: cap(list),
  };
}

async function attendanceOn({ date }, ctx) {
  const dateStr = DATE_RE.test(String(date || '')) ? date : ctx.today;
  const weekday = weekdayAr(dateStr);
  const [records, expected] = await Promise.all([
    Attendance.find({ academyId: ctx.academyId, date: dateStr })
      .populate('playerId', 'fullName playerCode').sort({ timestamp: 1 }).lean(),
    Player.find({ academyId: ctx.academyId, isActive: true, attendanceDays: weekday })
      .select('fullName playerCode').lean(),
  ]);
  const present = new Map();
  for (const r of records) {
    const pid = String(r.playerId?._id || r.playerId);
    if (!present.has(pid)) {
      present.set(pid, { name: r.playerId?.fullName || '', code: r.playerId?.playerCode || '', time: r.time, kind: r.kind || 'normal' });
    }
  }
  let absent = expected.filter((p) => !present.has(String(p._id)));
  // أيام التجميد ليست غياباً.
  const frozen = [];
  if (absent.length) {
    const dayDate = new Date(`${dateStr}T12:00:00Z`);
    const subs = await Subscription.find({ playerId: { $in: absent.map((p) => p._id) }, 'freezes.0': { $exists: true } })
      .select('playerId freezes endDate exhaustedAt startDate').lean();
    const frozenIds = new Set(subs.filter((s) => freezeState(s, dayDate).freezeStatus === 'frozen').map((s) => String(s.playerId)));
    frozen.push(...absent.filter((p) => frozenIds.has(String(p._id))).map((p) => p.fullName));
    absent = absent.filter((p) => !frozenIds.has(String(p._id)));
  }
  return {
    date: dateStr,
    weekday,
    presentCount: present.size,
    present: cap([...present.values()]),
    expectedByAttendanceDays: expected.length,
    absentCount: absent.length,
    absent: cap(absent.map((p) => ({ name: p.fullName, code: p.playerCode }))),
    frozenNotCounted: frozen,
  };
}

async function financeReport({ from, to }, ctx) {
  const query = {};
  if (DATE_RE.test(String(from || ''))) query.from = from;
  if (DATE_RE.test(String(to || ''))) query.to = to;
  const body = await callController(getProfitLoss, ctx, { query });
  const d = body.data || {};
  return {
    currency: ctx.currency,
    period: d.period,
    revenue: d.revenue,
    expenses: d.expenses ? { total: d.expenses.total, byCategory: d.expenses.byCategory } : null,
    payrollPaid: d.payroll?.paid,
    costsTotal: d.costsTotal,
    netProfit: d.netProfit,
    previousPeriod: d.previous,
    changePercent: d.change,
  };
}

async function matches({ scope = 'upcoming' }, ctx) {
  const all = await Match.find({ academyId: ctx.academyId })
    .select('name date time location sport playerIds opponent ourScore theirScore statsRecordedAt hasFee feeAmount')
    .lean();
  const row = (m) => ({
    name: m.name, date: m.date, time: m.time, location: m.location, sport: m.sport || null,
    players: (m.playerIds || []).length, opponent: m.opponent || null,
    score: m.ourScore != null && m.theirScore != null ? `${m.ourScore}-${m.theirScore}` : null,
    statsRecorded: Boolean(m.statsRecordedAt), fee: m.hasFee ? m.feeAmount : null,
  });
  const up = all.filter((m) => m.date >= ctx.today).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`));
  const past = all.filter((m) => m.date < ctx.today).sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`));
  if (scope === 'past') return { past: cap(past.map(row), 15), totalMatches: all.length };
  if (scope === 'all') return { upcoming: cap(up.map(row), 15), past: cap(past.map(row), 15) };
  return { upcoming: cap(up.map(row), 15), totalMatches: all.length };
}

async function leaderboard({ sport, field }, ctx) {
  const body = await callController(getLeaderboard, ctx, { query: { ...(sport ? { sport } : {}), ...(field ? { field } : {}) } });
  const d = body.data || {};
  return {
    sport: d.sport,
    field: d.field,
    availableFields: d.fields,
    top: (d.rows || []).map((r, i) => ({ rank: i + 1, name: r.fullName, value: r.value, matches: r.matches })),
  };
}

// ─── تعريفات OpenAI ─────────────────────────────────────────────────────────

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

const TOOL_DEFINITIONS = [
  fn('academy_overview', 'Academy totals: players, active/expired subscriptions, this month revenue & expenses, outstanding debts, groups.'),
  fn('search_players', 'Find players by (part of) Arabic name or player code. Use before player_details. Returns playerId values.', {
    name: { type: 'string', description: 'اسم اللاعب أو جزء منه أو كود اللاعب' },
  }, ['name']),
  fn('player_details', 'Full file of ONE player: subscriptions (amount/paid/remaining/dates/freeze), attendance of current subscription, latest evaluation, match stats.', {
    playerId: { type: 'string', description: 'playerId from search_players' },
  }, ['playerId']),
  fn('debts', 'Players who owe money (unpaid remaining on subscriptions), sorted by amount, with totals.', {
    search: { type: 'string', description: 'optional name filter' },
  }),
  fn('subscriptions_status', 'Subscription status of active players: expiring soon, expired, active, or without any subscription. Includes counts for all buckets.', {
    status: { type: 'string', enum: ['expiring_soon', 'expired', 'active', 'no_subscription'] },
    days: { type: 'integer', description: 'window for expiring_soon (default 7, max 60)' },
  }),
  fn('attendance_on', 'Who attended on a date, and who was expected (by their attendance days) but absent. Frozen subscriptions are not absences.', {
    date: { type: 'string', description: 'YYYY-MM-DD (default today, Cairo time)' },
  }),
  fn('finance_report', 'Profit & loss for a period: revenue (subscriptions/matches/store), expenses by category, paid payroll, net profit, comparison with previous period. Default = current month.', {
    from: { type: 'string', description: 'YYYY-MM-DD' },
    to: { type: 'string', description: 'YYYY-MM-DD' },
  }),
  fn('matches', 'Academy matches: upcoming (default), past (with results), or all.', {
    scope: { type: 'string', enum: ['upcoming', 'past', 'all'] },
  }),
  fn('leaderboard', 'Top 10 players in match statistics for a sport and stat field (e.g. points, goals, assists, rating).', {
    sport: { type: 'string', description: 'Arabic sport name, default academy sport' },
    field: { type: 'string', description: 'stat key such as points, goals, assists, rebounds, rating' },
  }),
];

const HANDLERS = {
  academy_overview: academyOverview,
  search_players: searchPlayers,
  player_details: playerDetails,
  debts,
  subscriptions_status: subscriptionsStatus,
  attendance_on: attendanceOn,
  finance_report: financeReport,
  matches,
  leaderboard,
};

/** ينفّذ أداة ويرجّع نصاً JSON محدود الطول (الأخطاء ترجع كبيانات للموديل). */
async function runTool(name, rawArgs, ctx) {
  const handler = HANDLERS[name];
  if (!handler) return JSON.stringify({ error: `unknown tool ${name}` });
  let args = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return JSON.stringify({ error: 'invalid arguments' });
  }
  try {
    const result = await handler(args || {}, ctx);
    let text = JSON.stringify(result);
    if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}…(truncated)`;
    return text;
  } catch (err) {
    return JSON.stringify({ error: err.message || 'tool failed' });
  }
}

module.exports = {
  TOOL_DEFINITIONS,
  runTool,
  // للاختبارات
  normalizeArabic,
  nameMatchScore,
  cairoDateStr,
  weekdayAr,
  addDays,
  callController,
};
