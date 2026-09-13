const crypto = require('crypto');
const { kvGet, kvSet } = require('./_lib');

const KEY = 'training-log:data';

function normalize(d){
  return {
    sessions: Array.isArray(d.sessions) ? d.sessions : [],
    overrides: (d.overrides && typeof d.overrides === 'object') ? d.overrides : {},
    profile: (d.profile && typeof d.profile === 'object') ? d.profile : null
  };
}

// The client URI-encodes the key so it can contain any characters.
function keyMatches(header){
  let given;
  try { given = Buffer.from(decodeURIComponent(header || '')); } catch (e) { return false; }
  const expected = Buffer.from(process.env.APP_KEY);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

module.exports = async (req, res) => {
  if (!process.env.APP_KEY) {
    res.status(500).json({ error: 'На сервере не задан код доступа: добавьте переменную APP_KEY в настройках проекта на Vercel' });
    return;
  }
  if (!keyMatches(req.headers['x-app-key'])) {
    res.status(401).json({ error: 'Неверный код доступа' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const raw = await kvGet(KEY);
      res.status(200).json(normalize(raw ? JSON.parse(raw) : {}));
      return;
    }

    if (req.method === 'POST') {
      await kvSet(KEY, JSON.stringify(normalize(req.body || {})));
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
