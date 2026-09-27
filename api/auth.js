const { kvCommand } = require('./_lib');
const { verifyInitData, signSession, displayName, botRequest } = require('./_auth');

let botUsername = null;

async function userFromCode(req, code) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const triesKey = 'training-log:tries:' + ip;
  const tries = await kvCommand(['INCR', triesKey]);
  if (tries === 1) await kvCommand(['EXPIRE', triesKey, 600]);
  if (tries > 10) return { error: 'Слишком много попыток. Подождите 10 минут', status: 429 };
  const raw = await kvCommand(['GETDEL', 'training-log:code:' + code.replace(/\D/g, '')]);
  return raw ? { user: JSON.parse(raw) } : { error: 'Код неверный или устарел — напишите боту ещё раз', status: 401 };
}

// Вход по ссылке из бота: ключ живёт 10 минут и выдерживает пару открытий
// (встроенный браузер Telegram, потом Safari), но не больше трёх.
async function userFromLink(req, token) {
  if (!/^[a-f0-9]{32}$/.test(token)) return { error: 'Ссылка неверная', status: 401 };
  const key = 'training-log:link:' + token;
  const raw = await kvCommand(['GET', key]);
  if (!raw) return { error: 'Ссылка устарела — напишите боту ещё раз', status: 401 };
  const uses = await kvCommand(['INCR', key + ':uses']);
  if (uses === 1) await kvCommand(['EXPIRE', key + ':uses', 600]);
  if (uses > 3) {
    await kvCommand(['DEL', key]);
    return { error: 'Ссылка уже использована — напишите боту ещё раз', status: 401 };
  }
  return { user: JSON.parse(raw) };
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      if (!botUsername) botUsername = (await botRequest('getMe')).username;
      res.status(200).json({ bot: botUsername });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    const body = req.body || {};
    let result;
    if (typeof body.initData === 'string') {
      const user = verifyInitData(body.initData);
      result = user ? { user } : { error: 'Не удалось проверить вход через Telegram', status: 401 };
    } else if (typeof body.code === 'string') {
      result = await userFromCode(req, body.code);
    } else if (typeof body.link === 'string') {
      result = await userFromLink(req, body.link);
    } else {
      result = { error: 'Нет данных для входа', status: 400 };
    }
    if (result.error) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(200).json({ token: signSession(String(result.user.id)), name: displayName(result.user) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
