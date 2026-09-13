const crypto = require('crypto');

const SESSION_DAYS = 180;

function botToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('Не задан токен бота: добавьте переменную TELEGRAM_BOT_TOKEN в настройках проекта на Vercel');
  }
  return token;
}

function siteUrl(req) {
  return 'https://' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || req.headers.host);
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function webhookSecret() {
  return hmac(botToken(), 'training-log-webhook').toString('hex');
}

function sessionSignature(payload) {
  return hmac(hmac(botToken(), 'training-log-session'), payload).toString('base64url');
}

// Stateless session: "<telegramId>.<expiresAt>.<signature>".
function signSession(userId) {
  const payload = userId + '.' + (Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400);
  return payload + '.' + sessionSignature(payload);
}

function userIdFromRequest(req) {
  const m = /^Bearer (\d+)\.(\d+)\.([\w-]+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const [, userId, expiresAt, signature] = m;
  if (Number(expiresAt) < Date.now() / 1000) return null;
  return safeEqual(signature, sessionSignature(userId + '.' + expiresAt)) ? userId : null;
}

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => k + '=' + v)
    .join('\n');
  const expected = hmac(hmac('WebAppData', botToken()), checkString).toString('hex');
  if (!safeEqual(hash, expected)) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date')) > 86400) return null;
  try {
    const user = JSON.parse(params.get('user'));
    return user && user.id ? user : null;
  } catch (e) {
    return null;
  }
}

function displayName(user) {
  if (user.username) return '@' + user.username;
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || String(user.id);
}

async function botRequest(method, params) {
  const res = await fetch('https://api.telegram.org/bot' + botToken() + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {})
  });
  const data = await res.json();
  if (!data.ok) throw new Error('Telegram ' + method + ': ' + data.description);
  return data.result;
}

module.exports = {
  siteUrl,
  safeEqual,
  webhookSecret,
  signSession,
  userIdFromRequest,
  verifyInitData,
  displayName,
  botRequest
};
