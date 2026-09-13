const crypto = require('crypto');
const { kvCommand } = require('./_lib');
const { siteUrl, safeEqual, webhookSecret } = require('./_auth');

async function issueCode(user) {
  const value = JSON.stringify({
    id: user.id,
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name
  });
  for (let i = 0; i < 5; i++) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const ok = await kvCommand(['SET', 'training-log:code:' + code, value, 'EX', 600, 'NX']);
    if (ok === 'OK') return code;
  }
  throw new Error('Не удалось выдать код');
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
    const code = await issueCode(msg.from);
    res.status(200).json({
      method: 'sendMessage',
      chat_id: msg.chat.id,
      parse_mode: 'HTML',
      text: '<b>Дневник тренировок</b> — программа под вас, веса с учётом прогрессии и история.\n\n' +
        'Нажмите «Открыть дневник», чтобы пользоваться прямо в Telegram.\n\n' +
        'Для входа на сайте или с иконки на экране «Домой» — код <b>' + code + '</b>. Он действует 10 минут.',
      reply_markup: { inline_keyboard: [[{ text: 'Открыть дневник', web_app: { url: siteUrl(req) } }]] }
    });
  } catch (e) {
    console.error(e);
    res.status(200).end();
  }
};
