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
