const { kvCommand } = require('./_lib');
const { userIdFromRequest } = require('./_auth');

const DAY = 86400000;
const MAX_USERS_SCANNED = 500;

// Upstash отдаёт HGETALL плоским массивом [поле, значение, ...].
function toMap(raw){
  if (!raw) return {};
  if (!Array.isArray(raw)) return raw;
  const map = {};
  for (let i = 0; i < raw.length; i += 2) map[raw[i]] = raw[i + 1];
  return map;
}

module.exports = async (req, res) => {
  try {
    const userId = userIdFromRequest(req);
    if (!userId) {
      res.status(401).json({ error: 'Нужно войти через Telegram' });
      return;
    }
    const owner = (process.env.OWNER_TELEGRAM_ID || '').trim();
    if (!owner) {
      res.status(403).json({ error: 'Статистика выключена: добавьте переменную OWNER_TELEGRAM_ID в настройках проекта на Vercel' });
      return;
    }
    if (owner !== userId) {
      res.status(403).json({ error: 'Статистика доступна только владельцу' });
      return;
    }

    const [seen, first] = await Promise.all([
      kvCommand(['HGETALL', 'training-log:seen']),
      kvCommand(['HGETALL', 'training-log:first'])
    ]);
    const seenMap = toMap(seen);
    const firstMap = toMap(first);
    const ids = Object.keys(seenMap);
    const now = Date.now();
    const within = (map, days) => Object.keys(map).filter(id => now - Number(map[id]) < days * DAY).length;

    let profiles = 0;
    let withWorkout = 0;
    let workouts = 0;
    if (ids.length) {
      const values = await kvCommand(['MGET', ...ids.slice(0, MAX_USERS_SCANNED).map(id => 'training-log:data:' + id)]);
      (values || []).forEach(raw => {
        let data;
        try { data = JSON.parse(raw); } catch (e) { return; }
        if (!data) return;
        if (data.profile) profiles++;
        const count = Array.isArray(data.sessions) ? data.sessions.length : 0;
        workouts += count;
        if (count) withWorkout++;
      });
    }

    res.status(200).json({
      users: ids.length,
      active7: within(seenMap, 7),
      active30: within(seenMap, 30),
      joined7: within(firstMap, 7),
      profiles,
      withWorkout,
      workouts
    });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
