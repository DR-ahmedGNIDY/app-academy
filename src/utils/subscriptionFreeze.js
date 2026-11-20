/**
 * تجميد الاشتراك — دوال نقية (بدون قاعدة بيانات).
 *
 * القاعدة: التجميد بعدد أيام محدد يبدأ من تاريخ (اليوم أو لاحقاً) وينتهي قبل
 * نهاية الاشتراك. عند إنشائه يُمدَّد endDate فوراً بعدد الأيام، فلا يبدو الاشتراك
 * منتهياً أثناء التجميد. "فك التجميد" المبكر يُرجع الأيام غير المستخدمة.
 *
 * freeze = { startDate, endDate (نهاية حصرية = بداية يوم الرجوع), days, reason,
 *            note, createdByName, endedEarlyAt }
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FREEZE_DAYS = 365;
const FREEZE_REASONS = ['injury', 'travel', 'exams', 'illness', 'other'];

const startOfDay = (d) => {
  const x = new Date(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate());
};
const addDays = (d, n) => {
  const x = new Date(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate() + n, x.getHours(), x.getMinutes(), x.getSeconds(), x.getMilliseconds());
};
const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** التجميد الحالي أو القادم (غير منتهٍ). يوجد واحد على الأكثر في نفس الوقت. */
function openFreeze(sub, now = new Date()) {
  return (sub.freezes || []).find((f) => f.days > 0 && new Date(f.endDate) > now) || null;
}

/** التجميد الساري الآن (بدأ ولم ينتهِ). */
function activeFreeze(sub, now = new Date()) {
  const f = openFreeze(sub, now);
  return f && new Date(f.startDate) <= now ? f : null;
}

/** حالة التجميد للعرض: frozen | scheduled | null + بيانات التجميد المفتوح. */
function freezeState(sub, now = new Date()) {
  const f = openFreeze(sub, now);
  if (!f) return { freezeStatus: null, currentFreeze: null };
  return {
    freezeStatus: new Date(f.startDate) <= now ? 'frozen' : 'scheduled',
    currentFreeze: {
      _id: f._id ? String(f._id) : undefined,
      startDate: f.startDate,
      endDate: f.endDate,
      days: f.days,
      reason: f.reason || 'other',
    },
  };
}

/**
 * يتحقق من طلب تجميد ويرجّع { freeze, newEndDate } أو { error }.
 * startDate: Date أو 'YYYY-MM-DD' (افتراضي اليوم).
 */
function planFreeze(sub, { startDate, days, reason }, now = new Date()) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > MAX_FREEZE_DAYS) {
    return { error: `عدد أيام التجميد يجب أن يكون بين 1 و ${MAX_FREEZE_DAYS}` };
  }
  if (sub.exhaustedAt || new Date(sub.endDate) < now) {
    return { error: 'لا يمكن تجميد اشتراك منتهٍ' };
  }
  if (openFreeze(sub, now)) return { error: 'الاشتراك مجمّد بالفعل — فك التجميد الحالي أولاً' };

  let start;
  if (startDate) {
    start = typeof startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(startDate)
      ? (() => { const [y, m, d] = startDate.split('-').map(Number); return new Date(y, m - 1, d); })()
      : startOfDay(startDate);
    if (Number.isNaN(start.getTime())) return { error: 'تاريخ بداية التجميد غير صحيح' };
  } else {
    start = startOfDay(now);
  }
  if (start < startOfDay(now)) return { error: 'لا يمكن بدء التجميد في تاريخ سابق' };
  if (start >= new Date(sub.endDate)) return { error: 'تاريخ بداية التجميد بعد نهاية الاشتراك' };

  return {
    freeze: {
      startDate: start,
      endDate: addDays(start, n),
      days: n,
      reason: FREEZE_REASONS.includes(reason) ? reason : 'other',
    },
    newEndDate: addDays(sub.endDate, n),
  };
}

/**
 * فك التجميد الآن. يرجّع { usedDays, returnedDays, newEndDate, remove } أو { error }.
 * - لم يبدأ بعد ⇒ يُلغى بالكامل وترجع كل الأيام.
 * - بدأ ⇒ تُحتسب الأيام حتى أمس (يوم الرجوع غير مجمّد) وترجع البقية.
 */
function planResume(sub, now = new Date()) {
  const f = openFreeze(sub, now);
  if (!f) return { error: 'الاشتراك غير مجمّد' };
  const start = startOfDay(f.startDate);
  const today = startOfDay(now);
  const used = start >= today ? 0 : Math.min(f.days, Math.round((today - start) / DAY_MS));
  const returned = f.days - used;
  return {
    freeze: f,
    usedDays: used,
    returnedDays: returned,
    newFreezeEnd: addDays(start, used),
    newEndDate: addDays(sub.endDate, -returned),
    remove: used === 0,
  };
}

/** نطاقات الأيام المجمّدة كنصوص 'YYYY-MM-DD' شاملة (لاستبعادها من الغياب). */
function frozenDayRanges(sub) {
  return (sub.freezes || [])
    .filter((f) => f.days > 0)
    .map((f) => ({ fromStr: dateStr(startOfDay(f.startDate)), toStr: dateStr(addDays(startOfDay(f.endDate), -1)) }))
    .filter((r) => r.fromStr <= r.toStr);
}

module.exports = {
  DAY_MS,
  MAX_FREEZE_DAYS,
  FREEZE_REASONS,
  openFreeze,
  activeFreeze,
  freezeState,
  planFreeze,
  planResume,
  frozenDayRanges,
};
