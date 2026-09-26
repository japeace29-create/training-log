const { kvCommand } = require('./_lib');
const { siteUrl, botRequest } = require('./_auth');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LATE_LIMIT_MINUTES = 120;
const MAX_USERS = 500;

function toMap(raw){
  if (!raw) return {};
  if (!Array.isArray(raw)) return raw;
  const map = {};
  for (let i = 0; i < raw.length; i += 2) map[raw[i]] = raw[i + 1];
  return map;
}

// Местное время пользователя: напоминание приходит по его часам, а не по UTC.
function localNow(tz){
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
    }).formatToParts(new Date());
  } catch (e) {
    return localNow('UTC');
  }
  const get = type => (parts.find(p => p.type === type) || {}).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WEEKDAYS.indexOf(get('weekday')),
    minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute'))
  };
}

function reminderText(data, local){
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const type = sessions.length % 2 === 0 ? 'A' : 'B';
  const last = sessions.length ? sessions[sessions.length - 1].date : null;
  let tail = 'Это ваша первая тренировка — начнём с лёгкого.';
  if (last){
    const days = Math.round((Date.parse(local.date) - Date.parse(last)) / 86400000);
    tail = days <= 1 ? 'Прошлая тренировка была вчера.'
      : days < 7 ? `Прошлая тренировка была ${days} дн. назад.`
      : 'Перерыв больше недели — начните с меньшего веса.';
  }
  return `⏰ Пора на тренировку.\n\nСегодня <b>Тренировка ${type}</b>. ${tail}`;
}

module.exports = async (req, res) => {
  try {
    // Защита от частых вызовов: запуск не чаще раза в минуту.
    const fresh = await kvCommand(['SET', 'training-log:cron', String(Date.now()), 'EX', 55, 'NX']);
    if (fresh !== 'OK') {
      res.status(200).json({ skipped: 'throttled' });
      return;
    }

    const ids = Object.keys(toMap(await kvCommand(['HGETALL', 'training-log:seen']))).slice(0, MAX_USERS);
    if (!ids.length) {
      res.status(200).json({ checked: 0, sent: 0 });
      return;
    }
    const [values, remindedRaw] = await Promise.all([
      kvCommand(['MGET', ...ids.map(id => 'training-log:data:' + id)]),
      kvCommand(['HGETALL', 'training-log:reminded'])
    ]);
    const reminded = toMap(remindedRaw);
    const site = siteUrl(req);
    let sent = 0;

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      let data;
      try { data = JSON.parse(values[i]); } catch (e) { continue; }
      const r = data && data.reminders;
      if (!r || !r.enabled || !Array.isArray(r.days) || !r.days.length || !r.time) continue;

      const local = localNow(r.tz);
      if (!r.days.includes(local.weekday)) continue;
      const [hours, minutes] = String(r.time).split(':').map(Number);
      const due = hours * 60 + minutes;
      if (local.minutes < due || local.minutes > due + LATE_LIMIT_MINUTES) continue;
      if (reminded[id] === local.date) continue;

      await kvCommand(['HSET', 'training-log:reminded', id, local.date]);
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      if (sessions.some(s => s.date === local.date)) continue;

      try {
        await botRequest('sendMessage', {
          chat_id: id,
          parse_mode: 'HTML',
          text: reminderText(data, local),
          reply_markup: { inline_keyboard: [[{ text: 'Открыть дневник', web_app: { url: site } }]] }
        });
        sent++;
      } catch (e) {
        console.error('Reminder failed for ' + id, e.message);
      }
    }

    res.status(200).json({ checked: ids.length, sent });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
