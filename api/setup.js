const { siteUrl, webhookSecret, botRequest } = require('./_auth');

// Open once after deploying (or after changing the bot token): points the bot at this site.
module.exports = async (req, res) => {
  try {
    const site = siteUrl(req);
    await botRequest('setWebhook', {
      url: site + '/api/bot',
      secret_token: webhookSecret(),
      allowed_updates: ['message']
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
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
