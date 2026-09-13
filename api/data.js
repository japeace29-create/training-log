const { kvGet, kvSet } = require('./_lib');
const { userIdFromRequest } = require('./_auth');

function normalize(d){
  return {
    sessions: Array.isArray(d.sessions) ? d.sessions : [],
    overrides: (d.overrides && typeof d.overrides === 'object') ? d.overrides : {},
    profile: (d.profile && typeof d.profile === 'object') ? d.profile : null
  };
}

module.exports = async (req, res) => {
  try {
    const userId = userIdFromRequest(req);
    if (!userId) {
      res.status(401).json({ error: 'Нужно войти через Telegram' });
      return;
    }
    const key = 'training-log:user:' + userId;

    if (req.method === 'GET') {
      const raw = await kvGet(key);
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
