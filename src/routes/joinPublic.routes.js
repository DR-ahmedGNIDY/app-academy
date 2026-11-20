const express = require('express');
const rateLimit = require('express-rate-limit');
const Academy = require('../models/academy.model');
const RegistrationRequest = require('../models/registrationRequest.model');
const { notify } = require('../utils/notificationService');
const logger = require('../utils/logger');
const {
  JOIN_PAGE_CSP,
  isValidJoinCode,
  validateRegistration,
  renderJoinForm,
  renderJoinThanks,
  renderJoinClosed,
} = require('../utils/registrationForm');

// الفورم الأونلاين العام: GET/POST /join/:code — بدون تسجيل دخول.
const router = express.Router();

const pageLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
// إرسال الطلبات: حد صارم لكل جهاز (حماية من الإغراق).
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => sendHtml(res, 429, renderJoinClosed('')),
});

function sendHtml(res, status, html) {
  res.set('Content-Security-Policy', JOIN_PAGE_CSP);
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  res.status(status).type('html').send(html);
}

/** الأكاديمية المفتوح لها الفورم + الرياضات المعروضة، أو null. */
async function openAcademy(code) {
  if (!isValidJoinCode(code)) return { academy: null };
  const academy = await Academy.findOne({ 'onlineRegistration.code': code, isActive: { $ne: false } })
    .select('name logo_url phone sports onlineRegistration');
  if (!academy) return { academy: null };
  if (!academy.onlineRegistration?.enabled) return { academy, closed: true };
  const all = academy.sports?.length ? academy.sports : ['كرة سلة'];
  const chosen = (academy.onlineRegistration.sports || []).filter((s) => all.includes(s));
  return { academy, sports: chosen.length ? chosen : all };
}

router.get('/:code', pageLimiter, async (req, res) => {
  const { academy, closed, sports } = await openAcademy(req.params.code);
  if (!academy || closed) return sendHtml(res, academy ? 200 : 404, renderJoinClosed(academy?.name));
  return sendHtml(res, 200, renderJoinForm({
    academy, sports, welcomeMessage: academy.onlineRegistration.welcomeMessage,
  }));
});

router.post('/:code', submitLimiter, async (req, res) => {
  const { academy, closed, sports } = await openAcademy(req.params.code);
  if (!academy || closed) return sendHtml(res, academy ? 200 : 404, renderJoinClosed(academy?.name));

  // حقل مخفي: البرامج الآلية تملأه، الإنسان لا يراه ⇒ نتظاهر بالنجاح بلا حفظ.
  if (String(req.body?.website ?? '').trim()) {
    logger.warn(`[JOIN] honeypot hit for academy ${academy._id}`);
    return sendHtml(res, 200, renderJoinThanks({ academy, playerName: String(req.body.playerName || '') }));
  }

  const result = validateRegistration(req.body, { sports });
  if (result.errors) {
    return sendHtml(res, 422, renderJoinForm({
      academy, sports, welcomeMessage: academy.onlineRegistration.welcomeMessage,
      errors: result.errors, values: result.values,
    }));
  }

  const { data } = result;
  // نفس اللاعب ونفس الموبايل وطلبه لسه معلّق ⇒ لا نكرّر الطلب.
  const duplicate = await RegistrationRequest.findOne({
    academyId: academy._id,
    parentPhone: data.parentPhone,
    playerName: data.playerName,
    status: { $in: ['pending', 'processing'] },
  }).select('_id');

  if (!duplicate) {
    const request = await RegistrationRequest.create({ academyId: academy._id, ...data });
    notify({
      recipientType: 'academy', recipientId: academy._id, academyId: academy._id,
      type: 'NEW_REGISTRATION_REQUEST',
      title: 'طلب تسجيل جديد',
      body: `${data.playerName}${data.sport ? ` — ${data.sport}` : ''}`,
      meta: { requestId: request._id.toString() },
    });
    logger.info(`[JOIN] new registration request ${request._id} for academy ${academy._id}`);
  }
  return sendHtml(res, 200, renderJoinThanks({ academy, playerName: data.playerName }));
});

module.exports = router;
