const crypto = require('crypto');
const { kvCommand, kvGet, kvSet } = require('./_lib');
const { siteUrl, safeEqual, webhookSecret } = require('./_auth');

function userValue(user) {
  return JSON.stringify({
    id: user.id,
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name
  });
}

async function issueCode(user) {
  const value = userValue(user);
  for (let i = 0; i < 5; i++) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const ok = await kvCommand(['SET', 'training-log:code:' + code, value, 'EX', 600, 'NX']);
    if (ok === 'OK') return code;
  }
  throw new Error('Не удалось выдать код');
}

// Ключ для ссылки в браузер живёт те же 10 минут. Он не одноразовый:
// Telegram сначала откроет ссылку у себя, и человеку обычно нужно ещё раз
// открыть её в Safari — второй вход не должен упираться в сгоревший ключ.
async function issueLink(user) {
  const token = crypto.randomBytes(16).toString('hex');
  await kvCommand(['SET', 'training-log:link:' + token, userValue(user), 'EX', 600]);
  return token;
}

const MAX_PHOTOS = 60;

// Снимок, присланный боту, становится фото прогресса: запоминаем его номер
// в Telegram. Сам файл остаётся в переписке, у нас только ссылка на него.
async function keepPhoto(user, msg){
  const sizes = msg.photo;
  const best = sizes[sizes.length - 1];
  const key = 'training-log:photos:' + user.id;
  let list = [];
  try { list = JSON.parse(await kvGet(key) || '[]'); } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  if (!list.some(p => p.id === best.file_unique_id)) {
    list.push({ id: best.file_unique_id, file: best.file_id, at: (msg.date || Math.floor(Date.now() / 1000)) * 1000 });
  }
  await kvSet(key, JSON.stringify(list.slice(-MAX_PHOTOS)));
}

// Telegram webhook: any private message gets the Mini App button and a one-time code for the website.
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST' || !safeEqual(req.headers['x-telegram-bot-api-secret-token'] || '', webhookSecret())) {
      res.status(401).end();
      return;
    }
    const msg = req.body && req.body.message;
    if (!msg || !msg.from || !msg.chat || msg.chat.type !== 'private') {
      res.status(200).end();
      return;
    }
    const site = siteUrl(req);

    // Фото — это снимок для дневника, а не просьба о входе.
    if (Array.isArray(msg.photo) && msg.photo.length) {
      await keepPhoto(msg.from, msg);
      // Альбом приходит несколькими сообщениями: отвечаем на него один раз.
      const first = await kvCommand(['SET', 'training-log:photo-ack:' + msg.from.id, '1', 'EX', 20, 'NX']);
      if (first !== 'OK') {
        res.status(200).end();
        return;
      }
      res.status(200).json({
        method: 'sendMessage',
        chat_id: msg.chat.id,
        text: 'Фото добавлено в дневник ✅\n\nОно появится на вкладке «Прогресс». Снимок остаётся в этой переписке — в дневнике хранится только ссылка на него.',
        reply_markup: { inline_keyboard: [[{ text: 'Открыть фото', web_app: { url: site + '?tab=progress' } }]] }
      });
      return;
    }
    if (msg.document && /^image\//.test(msg.document.mime_type || '')) {
      res.status(200).json({
        method: 'sendMessage',
        chat_id: msg.chat.id,
        text: 'Пришлите снимок как обычное фото, а не файлом: так Telegram его сожмёт, и он откроется в дневнике.'
      });
      return;
    }

    const [code, token] = await Promise.all([issueCode(msg.from), issueLink(msg.from)]);
    res.status(200).json({
      method: 'sendMessage',
      chat_id: msg.chat.id,
      parse_mode: 'HTML',
      text: '<b>Дневник тренировок</b> — программа под вас, веса с учётом прогрессии и история.\n\n' +
        '«Открыть дневник» — прямо здесь, в Telegram.\n\n' +
        '«Открыть в браузере» — вход без кода. Оттуда дневник можно поставить иконкой на экран «Домой»: ' +
        'меню «Поделиться» → «На экран „Домой"». Ссылка работает 10 минут.\n\n' +
        'Если понадобится войти вручную — код <b>' + code + '</b>, он тоже на 10 минут.',
      reply_markup: { inline_keyboard: [
        [{ text: 'Открыть дневник', web_app: { url: site } }],
        [{ text: 'Открыть в браузере', url: site + '?login=' + token }]
      ] }
    });
  } catch (e) {
    console.error(e);
    res.status(200).end();
  }
};
