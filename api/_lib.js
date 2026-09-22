// Общий модуль для работы с Vercel KV (Upstash Redis REST API).
// Переменные KV_REST_API_URL / KV_REST_API_TOKEN подставляются
// автоматически, когда в проекте на Vercel подключено хранилище KV.

const crypto = require('crypto');

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvCommand(command) {
  if (!KV_URL || !KV_TOKEN) {
    throw new Error('KV не подключено: нет KV_REST_API_URL / KV_REST_API_TOKEN');
  }
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    body: JSON.stringify(command)
  });
  if (!res.ok) {
    throw new Error('KV request failed: ' + res.status);
  }
  const data = await res.json();
  return data.result;
}

async function kvGet(key) {
  return kvCommand(['GET', key]);
}

async function kvSet(key, value) {
  return kvCommand(['SET', key, value]);
}

async function kvSetEx(key, seconds, value) {
  return kvCommand(['SETEX', key, seconds, value]);
}

async function kvDel(key) {
  return kvCommand(['DEL', key]);
}

// Проверка подписи initData, которую Telegram Mini App передаёт на фронте.
// Возвращает { chatId, user } если подпись верна, иначе null.
function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const pairs = [];
    for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
    pairs.sort();
    const dataCheckString = pairs.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash !== hash) return null;
    const userRaw = params.get('user');
    if (!userRaw) return null;
    const user = JSON.parse(userRaw);
    return { chatId: String(user.id), user };
  } catch (e) {
    return null;
  }
}

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function tgApi(method, payload) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN не задан');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json();
}

// Достаёт chatId из заголовка Authorization запроса к /api/data:
// либо "tma <initData>" (открыто прямо в Telegram Mini App),
// либо "Bearer <token>" (код был один раз введён на сайте/PWA).
async function getAuthedChatId(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!header) return null;
  if (header.startsWith('tma ')) {
    const initData = header.slice(4);
    const result = verifyInitData(initData, process.env.BOT_TOKEN);
    return result ? result.chatId : null;
  }
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7);
    const raw = await kvGet('token:' + token);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      return data.chatId ? String(data.chatId) : null;
    } catch (e) {
      return null;
    }
  }
  return null;
}

module.exports = {
  kvGet, kvSet, kvSetEx, kvDel,
  verifyInitData, randomCode, randomToken,
  tgApi, getAuthedChatId
};
