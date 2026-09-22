const { kvGet, kvDel, kvSet, randomToken } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const code = ((req.body && req.body.code) || '').toString().trim();
    if (!/^\d{6}$/.test(code)) {
      res.status(400).json({ error: 'Код — это 6 цифр из бота' });
      return;
    }
    const raw = await kvGet('code:' + code);
    if (!raw) {
      res.status(401).json({ error: 'Код неверный или истёк — запроси новый у бота' });
      return;
    }
    const { chatId } = JSON.parse(raw);
    await kvDel('code:' + code);
    const token = randomToken();
    await kvSet('token:' + token, JSON.stringify({ chatId, createdAt: Date.now() }));
    res.status(200).json({ token });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
