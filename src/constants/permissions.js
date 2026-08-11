// مفاتيح الصلاحيات المتاحة لحسابات "admin" المُنشأة بواسطة مدير الأكاديمية.
// مصدر وحيد للحقيقة يُستخدم في تحقق موديل User وفي middleware.requirePermission.
module.exports = [
  'register_players',
  'record_subscriptions',
  'record_evaluations',
  'add_matches',
  'use_album',
  'use_store',
  'view_reports',
  'view_dashboard_revenue',
];
