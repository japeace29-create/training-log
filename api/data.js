const { kvGet, kvSet } = require('./_lib');

const KEY = 'training-log:data';

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const raw = await kvGet(KEY);
      const data = raw ? JSON.parse(raw) : { sessions: [], overrides: {}, draft: null };
      res.status(200).json({
        sessions: Array.isArray(data.sessions) ? data.sessions : [],
        overrides: (data.overrides && typeof data.overrides === 'object') ? data.overrides : {},
        draft: data.draft || null
      });
      return;
    }

    if (req.method === 'POST') {
      const payload = req.body || {};
      const data = {
        sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
        overrides: (payload.overrides && typeof payload.overrides === 'object') ? payload.overrides : {},
        draft: payload.draft || null
      };
      await kvSet(KEY, JSON.stringify(data));
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};

