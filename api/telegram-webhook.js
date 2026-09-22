const { kvGet, kvSetEx, kvDel, randomCode, tgApi } = require('./_lib');

const Q1_KEYBOARD = [
  [{ text: 'Набор мышечной массы', callback_data: 'q1:mass' }],
  [{ text: 'Похудение / сушка', callback_data: 'q1:loss' }],
  [{ text: 'Общая форма и здоровье', callback_data: 'q1:fit' }],
  [{ text: 'Сила / силовые показатели', callback_data: 'q1:strength' }]
];
const Q2_KEYBOARD = [
  [{ text: 'Полный новичок', callback_data: 'q2:beginner' }],
  [{ text: 'Немного занимался раньше', callback_data: 'q2:some' }],
  [{ text: 'Есть опыт, но давно не тренировался', callback_data: 'q2:returning' }],
  [{ text: 'Тренируюсь регулярно', callback_data: 'q2:regular' }]
];
const Q3_KEYBOARD = [
  [{ text: '2 дня', callback_data: 'q3:2' }, { text: '3 дня', callback_data: 'q3:3' }],
  [{ text: '4 дня', callback_data: 'q3:4' }, { text: '5+ дней', callback_data: 'q3:5plus' }]
];
const GOAL_LABELS = {
  mass: 'набор мышечной массы',
  loss: 'похудение',
  fit: 'общую форму и здоровье',
  strength: 'силовые показатели'
};
const DAYS_LABELS = { '2': '2 раза в неделю', '3': '3 раза в неделю', '4': '4 раза в неделю', '5plus': '5+ раз в неделю' };

function appUrl() {
  return process.env.APP_URL || 'https://training-log-vert-psi.vercel.app';
}

async function startQuiz(chatId) {
  const sent = await tgApi('sendMessage', {
    chat_id: chatId,
    text: 'Какая у тебя основная цель?',
    reply_markup: { inline_keyboard: Q1_KEYBOARD }
  });
  const messageId = sent.result && sent.result.message_id;
  await kvSetEx('quiz:' + chatId, 900, JSON.stringify({ messageId }));
}

async function handleCallback(cq) {
  const chatId = cq.message.chat.id;
  const data = cq.data || '';
  const raw = await kvGet('quiz:' + chatId);
  const state = raw ? JSON.parse(raw) : {};

  await tgApi('answerCallbackQuery', { callback_query_id: cq.id });
  if (!state.messageId) return;

  if (data.startsWith('q1:')) {
    state.goal = data.slice(3);
    await kvSetEx('quiz:' + chatId, 900, JSON.stringify(state));
    await tgApi('editMessageText', {
      chat_id: chatId, message_id: state.messageId,
      text: 'Какой у тебя опыт тренировок?',
      reply_markup: { inline_keyboard: Q2_KEYBOARD }
    });
    return;
  }

  if (data.startsWith('q2:')) {
    state.experience = data.slice(3);
    await kvSetEx('quiz:' + chatId, 900, JSON.stringify(state));
    await tgApi('editMessageText', {
      chat_id: chatId, message_id: state.messageId,
      text: 'Сколько дней в неделю готов ходить в зал?',
      reply_markup: { inline_keyboard: Q3_KEYBOARD }
    });
    return;
  }

  if (data.startsWith('q3:')) {
    state.days = data.slice(3);
    const code = randomCode();
    await kvSetEx('code:' + code, 600, JSON.stringify({ chatId: String(chatId) }));
    await kvDel('quiz:' + chatId);
    const goalLabel = GOAL_LABELS[state.goal] || 'общую форму';
    const daysLabel = DAYS_LABELS[state.days] || 'по твоему графику';
    const text =
      `Готово! Программа под цель «${goalLabel}» ждёт в дневнике — база на всё тело (A/B), ${daysLabel}. ` +
      `Подходы и повторения можно донастроить во вкладке «Настройки».\n\n` +
      `Открыть прямо здесь — кнопка ниже.\n` +
      `Если заходишь с сайта или с иконки на главном экране — код: ${code} (действует 10 минут).`;
    await tgApi('editMessageText', {
      chat_id: chatId, message_id: state.messageId,
      text,
      reply_markup: { inline_keyboard: [[{ text: 'Открыть дневник', web_app: { url: appUrl() } }]] }
    });
    return;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true });
    return;
  }
  try {
    const update = req.body || {};

    if (update.message && update.message.text === '/start') {
      await startQuiz(update.message.chat.id);
      res.status(200).json({ ok: true });
      return;
    }

    if (update.callback_query) {
      await handleCallback(update.callback_query);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('telegram-webhook error', e);
    // Всегда 200, иначе Telegram будет бесконечно повторять апдейт
    res.status(200).json({ ok: true });
  }
};
