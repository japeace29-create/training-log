const { userIdFromRequest, siteUrl } = require('./_auth');
const compete = require('./_compete');

// Вызовы для приложения: список, карточка, создание, попытки, проверка.
module.exports = async (req, res) => {
  try {
    const userId = userIdFromRequest(req);
    if (!userId) {
      res.status(401).json({ error: 'Нужно войти через Telegram' });
      return;
    }
    const site = siteUrl(req);
    const send = result => {
      if (result && result.error) res.status(result.status || 400).json({ error: result.error });
      else res.status(200).json(result);
    };

    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      if (url.searchParams.get('badge')) return send(await compete.badge(userId));
      const id = url.searchParams.get('id');
      if (id) return send(await compete.view(userId, id));
      return send(await compete.list(userId));
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const body = req.body || {};
    switch (body.action) {
      case 'nick': {
        const ok = await compete.setNick(userId, body.nick, false);
        return send(ok ? { ok: true } : { status: 400, error: 'Имя — от двух до 24 знаков' });
      }
      case 'create': return send(await compete.create(userId, body));
      case 'join': return send(await compete.join(userId, String(body.code || '').trim().toLowerCase(), body.nick, site));
      case 'attempt': return send(await compete.attempt(userId, body));
      case 'link': return send(await compete.attachLink(userId, body, site));
      case 'decide': return send(await compete.decide(userId, body.comp, body.attempt, body.verdict === 'ok' ? 'ok' : 'no', site));
      case 'report': return send(await compete.report(userId, body.comp, body.attempt, site));
      case 'cancel': return send(await compete.cancel(userId, body.comp, site));
      case 'watch': return send(await compete.watch(userId, body.comp, body.attempt, site));
      default:
        res.status(400).json({ error: 'Неизвестное действие' });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
