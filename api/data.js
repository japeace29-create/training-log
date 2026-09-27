const { kvCommand, kvGet, kvSet } = require('./_lib');
const { userIdFromRequest } = require('./_auth');

// Открытие приложения отмечаем для статистики: кто когда пришёл и заходил.
async function trackVisit(userId){
  const now = String(Date.now());
  await Promise.all([
    kvCommand(['HSET', 'training-log:seen', userId, now]),
    kvCommand(['HSETNX', 'training-log:first', userId, now])
  ]);
}

function reminders(r){
  if (!r || typeof r !== 'object') return null;
  const days = Array.isArray(r.days) ? r.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  if (!/^\d{2}:\d{2}$/.test(String(r.time || ''))) return null;
  const weighDay = Number.isInteger(r.weighDay) && r.weighDay >= 0 && r.weighDay <= 6 ? r.weighDay : null;
  return {
    enabled: !!r.enabled,
    days,
    time: String(r.time),
    tz: typeof r.tz === 'string' ? r.tz.slice(0, 64) : 'UTC',
    weighDay,
    weighTime: /^\d{2}:\d{2}$/.test(String(r.weighTime || '')) ? String(r.weighTime) : '09:00'
  };
}

function rest(r){
  if (!r || typeof r !== 'object') return null;
  const seconds = Math.round(Number(r.seconds) / 15) * 15;
  if (!(seconds >= 30 && seconds <= 600)) return null;
  return { enabled: !!r.enabled, seconds, notify: !!r.notify };
}

// История веса: по одной записи на дату, не больше пятисот последних.
function weights(list){
  if (!Array.isArray(list)) return [];
  const byDate = new Map();
  for (const item of list){
    if (!item || !/^\d{4}-\d{2}-\d{2}$/.test(String(item.date))) continue;
    const kg = Math.round(Number(item.kg) * 10) / 10;
    if (!(kg >= 30 && kg <= 250)) continue;
    byDate.set(String(item.date), kg);
  }
  return [...byDate.entries()]
    .map(([date, kg]) => ({ date, kg }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-500);
}

// Выбранные вручную упражнения: ключ вида "A:3", значение — название.
function swaps(v){
  if (!v || typeof v !== 'object') return {};
  const out = {};
  for (const [key, name] of Object.entries(v)){
    if (!/^[ABC]:\d{1,2}$/.test(key)) continue;
    if (typeof name !== 'string' || !name || name.length > 80) continue;
    out[key] = name;
  }
  return out;
}

// Свои упражнения: название, день, как записывать и какие мышцы.
const GROUPS = ['Ноги', 'Спина', 'Грудь', 'Плечи', 'Руки', 'Пресс'];
function customList(list){
  if (!Array.isArray(list)) return [];
  const out = [];
  const ids = new Set();
  for (const item of list){
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim().slice(0, 40);
    if (!name || !['A', 'B', 'C'].includes(item.type)) continue;
    // Одинаковые id убрали бы сразу оба упражнения, поэтому выдаём новый.
    let id = String(item.id || '').slice(0, 24);
    if (!id || ids.has(id)) id = 'c' + out.length + Date.now().toString(36);
    ids.add(id);
    out.push({
      id,
      name,
      type: item.type,
      isTime: !!item.isTime,
      group: GROUPS.includes(item.group) ? item.group : GROUPS[0]
    });
    if (out.length >= 20) break;
  }
  return out;
}

// Суперсеты: ключ вида "A:1" — упражнение идёт в паре со следующим.
function pairs(v){
  if (!v || typeof v !== 'object') return {};
  const out = {};
  for (const key of Object.keys(v)){
    if (/^[ABC]:\d{1,2}$/.test(key) && v[key]) out[key] = true;
  }
  return out;
}

function normalize(d){
  return {
    sessions: Array.isArray(d.sessions) ? d.sessions : [],
    overrides: (d.overrides && typeof d.overrides === 'object') ? d.overrides : {},
    profile: (d.profile && typeof d.profile === 'object') ? d.profile : null,
    draft: d.draft || null,
    reminders: reminders(d.reminders),
    rest: rest(d.rest),
    weights: weights(d.weights),
    swaps: swaps(d.swaps),
    goal: [2, 3, 4, 5].includes(d.goal) ? d.goal : 3,
    split: d.split === 3 ? 3 : 2,
    custom: customList(d.custom),
    // null — приёмы решает опыт, true/false — человек выбрал сам.
    advanced: typeof d.advanced === 'boolean' ? d.advanced : null,
    pairs: pairs(d.pairs)
  };
}

module.exports = async (req, res) => {
  try {
    const userId = userIdFromRequest(req);
    if (!userId) {
      res.status(401).json({ error: 'Нужна авторизация — открой через бота или введи код' });
      return;
    }
    const key = 'training-log:data:' + userId;

    if (req.method === 'GET') {
      const [raw] = await Promise.all([kvGet(key), trackVisit(userId)]);
      res.status(200).json(normalize(raw ? JSON.parse(raw) : {}));
      return;
    }

    if (req.method === 'POST') {
      await kvSet(key, JSON.stringify(normalize(req.body || {})));
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};

// Выгрузка и восстановление пользуются той же проверкой данных.
module.exports.normalize = normalize;
