const { kvGet, kvSet } = require('./_lib');
const { userIdFromRequest, botRequest, botToken } = require('./_auth');

// Фото прогресса лежат в самом Telegram: человек присылает снимок боту, а у нас
// остаётся только ссылка на него (file_id). Своего хранилища для фотографий нет,
// и просить его не нужно.
const MAX_BYTES = 4 * 1024 * 1024;   // выше лимита ответа функции на Vercel лучше не подходить

function key(userId){
  return 'training-log:photos:' + userId;
}
async function readList(userId){
  const raw = await kvGet(key(userId));
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}
function mimeOf(path){
  return /\.png$/i.test(path) ? 'image/png' : /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg';
}

module.exports = async (req, res) => {
  try {
    const userId = userIdFromRequest(req);
    if (!userId) {
      res.status(401).json({ error: 'Нужно войти через Telegram' });
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id') || '';
    if (id && !/^[\w-]{1,64}$/.test(id)) {
      res.status(400).json({ error: 'Неверный номер фото' });
      return;
    }
    const list = await readList(userId);

    if (req.method === 'GET' && !id) {
      // Наружу отдаём только номер и время: file_id остаётся на сервере.
      // По времени снимка, а не по порядку прихода: присылать могут и старые.
      res.status(200).json({ photos: list.map(p => ({ id: p.id, at: p.at })).sort((a, b) => a.at - b.at) });
      return;
    }

    const entry = list.find(p => p.id === id);
    if (req.method === 'DELETE') {
      if (!entry) { res.status(404).json({ error: 'Такого фото нет' }); return; }
      await kvSet(key(userId), JSON.stringify(list.filter(p => p.id !== id)));
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'GET') {
      // Отдаём только своё: номер ищется в списке этого человека.
      if (!entry) { res.status(404).json({ error: 'Такого фото нет' }); return; }
      const info = await botRequest('getFile', { file_id: entry.file });
      const file = await fetch('https://api.telegram.org/file/bot' + botToken() + '/' + info.file_path);
      if (!file.ok) { res.status(502).json({ error: 'Telegram не отдал фото' }); return; }
      const bytes = Buffer.from(await file.arrayBuffer());
      if (bytes.length > MAX_BYTES) { res.status(413).json({ error: 'Фото слишком большое' }); return; }
      res.setHeader('Content-Type', mimeOf(info.file_path));
      res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.status(200).end(bytes);
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
