// اتصال بـ OpenAI Chat Completions (Function Calling) عبر fetch مباشرة — بلا مكتبة.
//
// المفتاح لا يُرفع للـ Git ولا يوضع في التطبيق أبداً. يُقرأ من:
//   1) OPENAI_API_KEY (متغير بيئة)، أو
//   2) ملف OPENAI_API_KEY_FILE (افتراضياً /home/claude/secrets/openai-key.txt)
// بدون مفتاح ⇒ المساعد يرد "غير مُعدّ" وباقي التطبيق يعمل عادي.
const fs = require('fs');
const logger = require('../logger');

const DEFAULT_KEY_FILE = '/home/claude/secrets/openai-key.txt';
const API_URL = 'https://api.openai.com/v1/chat/completions';
const TIMEOUT_MS = 45_000;

class AiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // not_configured | upstream | timeout
  }
}

let cachedKey = null;
let lastCheck = 0;

/** يرجّع المفتاح أو null. يعيد المحاولة كل دقيقة لو غير موجود (بلا إعادة تشغيل). */
function loadApiKey() {
  if (cachedKey) return cachedKey;
  if (lastCheck !== 0 && Date.now() - lastCheck < 60_000) return null;
  lastCheck = Date.now();
  const fromEnv = (process.env.OPENAI_API_KEY || '').trim();
  if (fromEnv) {
    cachedKey = fromEnv;
    return cachedKey;
  }
  const file = process.env.OPENAI_API_KEY_FILE || DEFAULT_KEY_FILE;
  try {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key) {
      cachedKey = key;
      logger.info('[AI] OpenAI key loaded');
    }
  } catch {
    // الملف غير موجود — المساعد غير مُعدّ بعد.
  }
  return cachedKey;
}

const isConfigured = () => Boolean(loadApiKey());
// مفتاح المشروع مقيّد بـ gpt-4.1-mini (تحقّقنا من /v1/models). يُغيَّر بـ OPENAI_MODEL.
const modelName = () => process.env.OPENAI_MODEL || 'gpt-4.1-mini';

/** للاختبارات فقط: يمسح المفتاح المخزّن. */
const _resetKeyCache = () => {
  cachedKey = null;
  lastCheck = 0;
};

/**
 * طلب واحد لـ Chat Completions. يرجّع { message, usage }.
 * message: { role:'assistant', content, tool_calls? }
 */
async function chatCompletion({ messages, tools }) {
  const key = loadApiKey();
  if (!key) throw new AiError('not_configured', 'OpenAI key is not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: modelName(),
        messages,
        ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
        max_completion_tokens: 900,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new AiError(err.name === 'AbortError' ? 'timeout' : 'upstream', err.message);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message || '';
    } catch { /* ignore */ }
    // لا نسجّل المفتاح أبداً — فقط الحالة ورسالة الخطأ.
    logger.warn(`[AI] OpenAI ${res.status}: ${detail.slice(0, 200)}`);
    if (res.status === 401) _resetKeyCache(); // مفتاح خاطئ/ملغى ⇒ أعد القراءة لاحقاً
    throw new AiError('upstream', `OpenAI error ${res.status}`);
  }

  const body = await res.json();
  const message = body?.choices?.[0]?.message;
  if (!message) throw new AiError('upstream', 'Empty response from OpenAI');
  return {
    message,
    usage: {
      promptTokens: body.usage?.prompt_tokens || 0,
      completionTokens: body.usage?.completion_tokens || 0,
    },
  };
}

module.exports = { chatCompletion, isConfigured, modelName, AiError, _resetKeyCache };
