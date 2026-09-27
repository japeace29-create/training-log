const crypto = require('crypto');
const { kvCommand } = require('./_lib');
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
