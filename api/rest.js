const crypto = require('crypto');
const { kvCommand } = require('./_lib');
const { userIdFromRequest, botRequest, siteUrl } = require('./_auth');

// У QStash теперь свой адрес на регион (европейский — qstash-eu-central-1),
// поэтому берём его из переменной: консоль выдаёт её рядом с токеном.
const QSTASH = (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/+$/, '');
const JOB_KEY = 'training-log:rest-job:';
const ACTIVE_KEY = 'training-log:rest-active:';

// Отложенная доставка: сообщение отправит сервер, даже если приложение к тому
// моменту закрыли. Задание кладём в базу под случайным ключом, а планировщик
// в нужную секунду дёргает /api/rest-fire и называет этот ключ.
async function schedule(req, userId, seconds, name) {
  const token = process.env.QSTASH_TOKEN;
  // Без планировщика ничего не ломается: приложение отправит сообщение само,
  // как и раньше, — но только если в этот момент открыто.
  if (!token) return { scheduled: false };

  const job = crypto.randomBytes(16).toString('hex');
  const live = seconds + 90;
  await Promise.all([
    kvCommand(['SET', JOB_KEY + job, JSON.stringify({ user: userId, name }), 'EX', live]),
    kvCommand(['SET', ACTIVE_KEY + userId, job, 'EX', live])
  ]);

  const res = await fetch(QSTASH + '/v2/publish/' + siteUrl(req) + '/api/rest-fire', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Upstash-Delay': seconds + 's',
      // Повтор пришёл бы через минуту после окончания — отдых к тому времени
      // давно закончился, так что пробуем один раз.
      'Upstash-Retries': '0'
    },
    body: JSON.stringify({ job })
  });
  if (!res.ok) {
    await kvCommand(['DEL', JOB_KEY + job]);
    throw new Error('QStash ' + res.status + ': ' + (await res.text()).slice(0, 200));
  }
  return { scheduled: true, job };
}

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
    const body = req.body || {};
    const name = String(body.exercise || '').replace(/\s+/g, ' ').trim().slice(0, 60);

    // Отдых прервали или начали следующий подход — заказ больше не нужен.
    if (body.cancel) {
      const job = String(body.cancel).replace(/[^a-f0-9]/g, '').slice(0, 32);
      if (job) {
        const active = await kvCommand(['GET', ACTIVE_KEY + userId]);
        await kvCommand(['DEL', JOB_KEY + job]);
        if (active === job) await kvCommand(['DEL', ACTIVE_KEY + userId]);
      }
      res.status(200).json({ ok: true });
      return;
    }

    // Отдых только начался: заказываем сообщение на будущее.
    if (body.schedule) {
      const seconds = Math.round(Number(body.schedule));
      if (!(seconds >= 30 && seconds <= 600)) {
        res.status(400).json({ error: 'Неверное время отдыха' });
        return;
      }
      res.status(200).json(await schedule(req, userId, seconds, name));
      return;
    }

    // Старый путь: отсчёт закончился на телефоне, и он просит отправить сразу.
    // Короче минуты отдых не бывает, так что чаще одного раза в 20 секунд
    // сообщения слать незачем.
    const fresh = await kvCommand(['SET', 'training-log:rest:' + userId, '1', 'EX', 20, 'NX']);
    if (fresh !== 'OK') {
      res.status(200).json({ skipped: 'throttled' });
      return;
    }

    // Прошлую отбивку убираем, чтобы в переписке не копилась лента одинаковых.
    const prev = Number(body.prev);
    if (Number.isInteger(prev) && prev > 0) {
      try { await botRequest('deleteMessage', { chat_id: userId, message_id: prev }); }
      catch (e) { /* не удалилась — не страшно */ }
    }
    const message = await botRequest('sendMessage', {
      chat_id: userId,
      text: '⏱ Отдых окончен' + (name ? ' — ' + name : '')
    });
    res.status(200).json({ id: message.message_id });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
