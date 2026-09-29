const crypto = require('crypto');
const { kvCommand, kvGet, kvSet } = require('./_lib');
const { siteUrl, safeEqual, webhookSecret, botRequest } = require('./_auth');
const compete = require('./_compete');

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

// Открыть один раз после выкладки (или после смены токена бота): направляет бота на этот сайт.
// Раньше это был отдельный адрес /api/setup, теперь он перенаправляется сюда: у Vercel
// на бесплатном тарифе не больше двенадцати функций, и отдельная под это не нужна.
async function setup(req, res) {
  const site = siteUrl(req);
  await botRequest('setWebhook', {
    url: site + '/api/bot',
    secret_token: webhookSecret(),
    allowed_updates: ['message', 'callback_query']
  });
  await botRequest('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Дневник', web_app: { url: site } }
  });
  await botRequest('setMyCommands', {
    commands: [{ command: 'start', description: 'Открыть дневник и получить код для входа' }]
  });
  await botRequest('setMyDescription', {
    description: 'Дневник тренировок: подберёт программу по короткому тесту, подскажет веса с учётом прогрессии и сохранит историю. Нажмите «Старт».'
  });
  const me = await botRequest('getMe');
  res.status(200).json({ ok: true, bot: '@' + me.username, site });
}

// Нажатия кнопок под видео: засчитать, отклонить, пожаловаться, решения владельца.
async function handleCallback(cb, site) {
  const uid = String(cb.from.id);
  const [act, compId, attId] = String(cb.data || '').split(':');
  let result = { toast: '' };
  if (act === 'ok' || act === 'no') result = await compete.decide(uid, compId, attId, act, site);
  else if (act === 'rp') result = await compete.report(uid, compId, attId, site);
  else if (act === 'ao' || act === 'ad' || act === 'ab') result = await compete.ownerAction(uid, act, compId, attId, site);
  try {
    await botRequest('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: result.error ? result.error : (result.toast || ''),
      show_alert: !!result.error
    });
    // Кнопки после ответа заменяем итогом, чтобы нельзя было нажать дважды.
    if (!result.error && result.label && cb.message) {
      await botRequest('editMessageReplyMarkup', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: result.label, callback_data: 'noop' }]] }
      });
    }
  } catch (e) { console.error('callback answer failed', e.message); }
}

// Telegram webhook: any private message gets the Mini App button and a one-time code for the website.
module.exports = async (req, res) => {
  try {
    if (req.method === 'GET' && new URL(req.url, 'http://localhost').searchParams.get('setup')) {
      await setup(req, res);
      return;
    }
    if (req.method !== 'POST' || !safeEqual(req.headers['x-telegram-bot-api-secret-token'] || '', webhookSecret())) {
      res.status(401).end();
      return;
    }
    const site = siteUrl(req);
    if (req.body && req.body.callback_query && req.body.callback_query.from) {
      await handleCallback(req.body.callback_query, site);
      res.status(200).end();
      return;
    }
    const msg = req.body && req.body.message;
    if (!msg || !msg.from || !msg.chat || msg.chat.type !== 'private') {
      res.status(200).end();
      return;
    }
    const reply = (text, extra) => res.status(200).json({ method: 'sendMessage', chat_id: msg.chat.id, parse_mode: 'HTML', text, ...(extra || {}) });

    // Обычный ответ на любое сообщение: кнопки входа и код на десять минут.
    // lead — фраза перед ним, например причина, по которой не сработало приглашение.
    const welcome = async lead => {
      const [code, token] = await Promise.all([issueCode(msg.from), issueLink(msg.from)]);
      res.status(200).json({
        method: 'sendMessage',
        chat_id: msg.chat.id,
        parse_mode: 'HTML',
        text: (lead ? String(lead).replace(/[&<>]/g, '') + '\n\n' : '') +
          '<b>Дневник тренировок</b> — программа под вас, веса с учётом прогрессии и история.\n\n' +
          '«Открыть дневник» — прямо здесь, в Telegram.\n\n' +
          '«Открыть в браузере» — вход без кода. Оттуда дневник можно поставить иконкой на экран «Домой»: ' +
          'меню «Поделиться» → «На экран „Домой"». Ссылка работает 10 минут.\n\n' +
          'Если понадобится войти вручную — код <b>' + code + '</b>, он тоже на 10 минут.',
        reply_markup: { inline_keyboard: [
          [{ text: 'Открыть дневник', web_app: { url: site } }],
          [{ text: 'Открыть в браузере', url: site + '?login=' + token }]
        ] }
      });
    };

    // Ссылка-приглашение в вызов: t.me/бот?start=join_<код>.
    const invite = /^\/start(?:@\w+)?\s+join_([a-f0-9]{10})\s*$/.exec(msg.text || '');
    if (invite) {
      const hint = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || '';
      const joined = await compete.join(String(msg.from.id), invite[1], hint, site);
      if (joined.error) {
        // Человек мог прийти сюда впервые и только по этой ссылке: кроме причины
        // отказа ему нужны и обычные кнопки, иначе он остаётся ни с чем.
        await welcome(joined.error);
        return;
      }
      reply(`Вы приняли вызов «${joined.title.replace(/[&<>]/g, '')}». Записывайте результат в дневнике и присылайте видео: без него он не считается.`, {
        reply_markup: { inline_keyboard: [[{ text: 'Открыть вызов', web_app: { url: site + '?tab=compete&c=' + joined.comp } }]] }
      });
      return;
    }

    // Видео или «кружок» — подтверждение попытки в вызове.
    if (msg.video || msg.video_note) {
      const done = await compete.attachTelegramVideo(String(msg.from.id), msg, site);
      if (done.error) {
        reply(done.error);
        return;
      }
      reply(`Видео получено ✅ Теперь его проверит ${String(done.opponent).replace(/[&<>]/g, '')}: как только ответит, я напишу.`, {
        reply_markup: { inline_keyboard: [[{ text: 'Открыть вызов', web_app: { url: site + '?tab=compete&c=' + done.comp.id } }]] }
      });
      return;
    }

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

    await welcome();
  } catch (e) {
    console.error(e);
    res.status(200).end();
  }
};
