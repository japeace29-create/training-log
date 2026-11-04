const { kvCommand } = require('./_lib');
const { botRequest } = require('./_auth');

// Сюда стучится планировщик, когда отдых закончился. Ключ задания случайный,
// одноразовый и живёт пару минут: угадать его нельзя, а повторно использовать
// не выйдет — он исчезает при первом обращении. Поэтому отдельная подпись
// здесь не нужна, ключ и есть пропуск.
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    const job = String((req.body && req.body.job) || '').replace(/[^a-f0-9]/g, '');
    if (job.length !== 32) {
      res.status(200).json({ ok: true, skipped: 'bad job' });
      return;
    }
    const raw = await kvCommand(['GETDEL', 'training-log:rest-job:' + job]);
    // Задание отменили: человек нажал «Пропустить» или закончил тренировку.
    if (!raw) {
      res.status(200).json({ ok: true, skipped: 'cancelled' });
      return;
    }
    const data = JSON.parse(raw);

    // Пока отдых шёл, человек мог отметить следующий подход — тогда актуально
    // уже другое задание, а это молча пропускаем.
    const active = await kvCommand(['GET', 'training-log:rest-active:' + data.user]);
    if (active && active !== job) {
      res.status(200).json({ ok: true, skipped: 'replaced' });
      return;
    }
    await kvCommand(['DEL', 'training-log:rest-active:' + data.user]);

    // Прошлую отбивку убираем, чтобы в переписке не копилась лента одинаковых.
    const prev = await kvCommand(['GETDEL', 'training-log:rest-msg:' + data.user]);
    if (prev) {
      try { await botRequest('deleteMessage', { chat_id: data.user, message_id: Number(prev) }); }
      catch (e) { /* не удалилась — не страшно */ }
    }
    const message = await botRequest('sendMessage', {
      chat_id: data.user,
      text: '⏱ Отдых окончен' + (data.name ? ' — ' + data.name : '')
    });
    await kvCommand(['SET', 'training-log:rest-msg:' + data.user, String(message.message_id), 'EX', 86400]);
    res.status(200).json({ ok: true, id: message.message_id });
  } catch (e) {
    console.error(e);
    // Отвечаем 200: повтор пришёл бы через минуту, когда отдых давно окончен.
    res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
};
