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
  return {
    enabled: !!r.enabled,
    days,
    time: String(r.time),
    tz: typeof r.tz === 'string' ? r.tz.slice(0, 64) : 'UTC'
  };
}

function normalize(d){
  return {
    sessions: Array.isArray(d.sessions) ? d.sessions : [],
    overrides: (d.overrides && typeof d.overrides === 'object') ? d.overrides : {},
    profile: (d.profile && typeof d.profile === 'object') ? d.profile : null,
    draft: d.draft || null,
    reminders: reminders(d.reminders)
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
