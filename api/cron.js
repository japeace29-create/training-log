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

// Опоздать на пару часов не страшно, а вот будить ночью нельзя.
function inWindow(time, local){
  const [hours, minutes] = String(time || '').split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return false;
  const due = hours * 60 + minutes;
  return local.minutes >= due && local.minutes <= due + LATE_LIMIT_MINUTES;
}

// Что сегодня положено отправить этому человеку. Вынесено отдельно,
// чтобы правила можно было проверить без похода в Telegram.
function decide(data, local, remindedDate, weighedDate){
  const out = { workout: false, weight: false };
  const r = data && data.reminders;
  if (!r) return out;

  if (r.enabled && Array.isArray(r.days) && r.days.includes(local.weekday)
      && inWindow(r.time, local) && remindedDate !== local.date){
    out.workout = true;
  }
  if (Number.isInteger(r.weighDay) && r.weighDay === local.weekday
      && inWindow(r.weighTime || '09:00', local) && weighedDate !== local.date){
    out.weight = true;
  }
  return out;
}

function reminderText(data, local){
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  // Очередь зависит от того, две тренировки в программе или три.
  const days = data.split === 3 ? ['A', 'B', 'C'] : ['A', 'B'];
  const previous = sessions.length ? sessions[sessions.length - 1].type : null;
  const type = days[(days.indexOf(previous) + 1) % days.length];
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

function weightText(data, local){
  const list = Array.isArray(data.weights) ? data.weights : [];
  const last = list.length ? list[list.length - 1] : null;
  let tail = 'Первая запись задаст точку отсчёта.';
  if (last){
    const days = Math.round((Date.parse(local.date) - Date.parse(last.date)) / 86400000);
    const kg = String(last.kg).replace('.', ',');
    tail = days <= 1 ? `Вчера было ${kg} кг.` : `Прошлый раз — ${days} дн. назад, ${kg} кг.`;
  }
  return `⚖️ Пора встать на весы.\n\n${tail} От веса тела считаются рекомендуемые веса в упражнениях.`;
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
    const [values, remindedRaw, weighedRaw] = await Promise.all([
      kvCommand(['MGET', ...ids.map(id => 'training-log:data:' + id)]),
      kvCommand(['HGETALL', 'training-log:reminded']),
      kvCommand(['HGETALL', 'training-log:reminded-weight'])
    ]);
    const reminded = toMap(remindedRaw);
    const weighed = toMap(weighedRaw);
    const site = siteUrl(req);
    // Кнопка может открыть приложение сразу на нужной вкладке.
    const button = (text, tab) => ({
      inline_keyboard: [[{ text, web_app: { url: tab ? site + '?tab=' + tab : site } }]]
    });
    let sent = 0;
    let weightSent = 0;

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      let data;
      try { data = JSON.parse(values[i]); } catch (e) { continue; }
      if (!data || !data.reminders) continue;

      const local = localNow(data.reminders.tz);
      const todo = decide(data, local, reminded[id], weighed[id]);

      if (todo.workout) {
        // Отметку ставим до отправки: упавший запрос не должен повторяться весь день.
        await kvCommand(['HSET', 'training-log:reminded', id, local.date]);
        const sessions = Array.isArray(data.sessions) ? data.sessions : [];
        if (!sessions.some(s => s.date === local.date)) {
          try {
            await botRequest('sendMessage', {
              chat_id: id,
              parse_mode: 'HTML',
              text: reminderText(data, local),
              reply_markup: button('Открыть дневник')
            });
            sent++;
          } catch (e) {
            console.error('Reminder failed for ' + id, e.message);
          }
        }
      }

      if (todo.weight) {
        await kvCommand(['HSET', 'training-log:reminded-weight', id, local.date]);
        const list = Array.isArray(data.weights) ? data.weights : [];
        if (!list.some(w => w.date === local.date)) {
          try {
            await botRequest('sendMessage', {
              chat_id: id,
              parse_mode: 'HTML',
              text: weightText(data, local),
              reply_markup: button('Записать вес', 'progress')
            });
            weightSent++;
          } catch (e) {
            console.error('Weight reminder failed for ' + id, e.message);
          }
        }
      }
    }

    res.status(200).json({ checked: ids.length, sent, weight: weightSent });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};

module.exports.decide = decide;
module.exports.localNow = localNow;
