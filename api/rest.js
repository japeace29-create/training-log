const { kvCommand } = require('./_lib');
const { userIdFromRequest, botRequest } = require('./_auth');

// Таймер отдыха закончился — бот пишет об этом, чтобы не смотреть в экран.
module.exports = async (req, res) => {
  try {
    const userId = userIdFromRequest(req);
    if (!userId) {
      res.status(401).json({ error: 'Нужно войти через Telegram' });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    // Короче минуты отдых не бывает, так что чаще одного раза в 20 секунд
    // сообщения слать незачем.
    const fresh = await kvCommand(['SET', 'training-log:rest:' + userId, '1', 'EX', 20, 'NX']);
    if (fresh !== 'OK') {
      res.status(200).json({ skipped: 'throttled' });
      return;
    }

    const body = req.body || {};
    // Прошлую отбивку убираем, чтобы в переписке не копилась лента одинаковых.
    const prev = Number(body.prev);
    if (Number.isInteger(prev) && prev > 0) {
      try { await botRequest('deleteMessage', { chat_id: userId, message_id: prev }); }
      catch (e) { /* не удалилась — не страшно */ }
    }
    const name = String(body.exercise || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const message = await botRequest('sendMessage', {
      chat_id: userId,
      text: '⏱ Отдых окончен' + (name ? ' — ' + name : '')
    });
    res.status(200).json({ id: message.message_id });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
