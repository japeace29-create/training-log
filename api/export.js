const { kvGet, kvSet } = require('./_lib');
const { userIdFromRequest, botToken } = require('./_auth');
const { normalize } = require('./data');

const SEP = ';';   // Excel с русской локалью ждёт точку с запятой
const HEADER = ['дата', 'тренировка', 'упражнение', 'подход', 'вес, кг', 'повторения', 'секунды', 'выполнено', 'заметка к упражнению', 'заметка к тренировке'];

function cell(value){
  const text = String(value == null ? '' : value);
  return /[";\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

// Числа с запятой: иначе Excel читает 42.5 как дату.
function num(value){
  const n = Number(value);
  return n ? String(n).replace('.', ',') : '';
}

function toCsv(data){
  const rows = [HEADER.join(SEP)];
  (data.sessions || []).forEach(session => {
    (session.exercises || []).forEach(ex => {
      (ex.sets || []).forEach((set, i) => {
        const reps = Number(set.value2) || 0;
        const weight = Number(set.value1) || 0;
        if (!ex.isTime && !reps) return;
        if (ex.isTime && !weight) return;
        rows.push([
          session.date,
          session.type,
          ex.name,
          i + 1,
          ex.isTime ? '' : num(weight),
          ex.isTime ? '' : reps,
          ex.isTime ? weight : '',
          set.done ? 'да' : 'нет',
          ex.note || '',
          session.note || ''
        ].map(cell).join(SEP));
      });
    });
  });
  (data.weights || []).forEach(w => {
    rows.push([w.date, '', 'Вес тела', '', num(w.kg), '', '', 'да', '', ''].map(cell).join(SEP));
  });
  return '﻿' + rows.join('\r\n') + '\r\n';
}

async function sendDocument(userId, filename, text, mime, caption){
  const form = new FormData();
  form.append('chat_id', String(userId));
  form.append('caption', caption);
  form.append('document', new Blob([text], { type: mime }), filename);
  const res = await fetch('https://api.telegram.org/bot' + botToken() + '/sendDocument', {
    method: 'POST',
    body: form
  });
  const result = await res.json();
  if (!result.ok) throw new Error('Telegram sendDocument: ' + result.description);
  return result.result;
}

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
    const key = 'training-log:data:' + userId;
    const body = req.body || {};

    // Восстановление: файл проходит через ту же проверку, что и обычное сохранение.
    if (body.restore) {
      const clean = normalize(body.restore);
      await kvSet(key, JSON.stringify(clean));
      res.status(200).json({ ok: true, sessions: clean.sessions.length, weights: clean.weights.length });
      return;
    }

    const raw = await kvGet(key);
    const data = normalize(raw ? JSON.parse(raw) : {});
    const stamp = new Date().toISOString().slice(0, 10);
    const count = (data.sessions || []).length;

    if (body.format === 'json') {
      const file = JSON.stringify(data, null, 2);
      await sendDocument(userId, `training-log-${stamp}.json`, file, 'application/json',
        `Резервная копия: ${count} тренировок. Этот файл можно загрузить обратно в настройках.`);
      res.status(200).json({ ok: true, bytes: file.length });
      return;
    }

    const csv = toCsv(data);
    await sendDocument(userId, `training-log-${stamp}.csv`, csv, 'text/csv',
      `Выгрузка: ${count} тренировок. Открывается в Excel, Numbers и Google Таблицах.`);
    res.status(200).json({ ok: true, bytes: csv.length });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};

module.exports.toCsv = toCsv;
