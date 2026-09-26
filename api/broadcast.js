const { kvCommand } = require('./_lib');
const { userIdFromRequest, siteUrl, botRequest } = require('./_auth');

const JOB_KEY = 'training-log:broadcast';
const LOCK_KEY = 'training-log:broadcast-lock';
const MAX_USERS = 500;
// Функция на Vercel живёт недолго, поэтому за один вызов отправляем сколько
// успеем, а остаток дописываем следующими вызовами по сохранённому курсору.
const TIME_BUDGET_MS = 8000;
const PAUSE_MS = 50;      // ~20 сообщений в секунду при лимите Telegram в 30
const MAX_RETRIES = 2;
const TEXT_LIMIT = 1024;  // столько помещается в подпись к фотографии

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Upstash отдаёт HGETALL плоским массивом [поле, значение, ...].
function toMap(raw){
  if (!raw) return {};
  if (!Array.isArray(raw)) return raw;
  const map = {};
  for (let i = 0; i < raw.length; i += 2) map[raw[i]] = raw[i + 1];
  return map;
}

// Наружу отдаём только счётчики: список получателей остаётся на сервере.
function progress(job){
  if (!job) return null;
  return {
    text: job.text,
    photo: job.photo,
    total: job.ids.length,
    sent: job.sent,
    failed: job.failed,
    blocked: job.blocked,
    done: !!job.done,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    lastError: job.lastError || null
  };
}

async function readJob(){
  const raw = await kvCommand(['GET', JOB_KEY]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function saveJob(job){
  return kvCommand(['SET', JOB_KEY, JSON.stringify(job), 'EX', 7 * 86400]);
}

function photoUrl(photo, site){
  const s = String(photo || '').trim();
  if (!s) return null;
  if (s.startsWith('/')) return site + s;
  return /^https:\/\/[^\s]+$/.test(s) ? s : null;
}

async function sendOne(chatId, job, site){
  const reply_markup = { inline_keyboard: [[{ text: 'Открыть дневник', web_app: { url: site } }]] };
  if (job.photo) {
    // После первой отправки Telegram даёт file_id: дальше картинку не нужно
    // скачивать заново с нашего сайта для каждого получателя.
    const result = await botRequest('sendPhoto', {
      chat_id: chatId, photo: job.fileId || job.photo, caption: job.text, parse_mode: 'HTML', reply_markup
    });
    const sizes = result && result.photo;
    if (!job.fileId && Array.isArray(sizes) && sizes.length) job.fileId = sizes[sizes.length - 1].file_id;
    return result;
  }
  return botRequest('sendMessage', {
    chat_id: chatId, text: job.text, parse_mode: 'HTML', reply_markup,
    link_preview_options: { is_disabled: true }
  });
}

async function run(job, site){
  const started = Date.now();
  let retries = 0;
  while (job.cursor < job.ids.length && Date.now() - started < TIME_BUDGET_MS) {
    const id = job.ids[job.cursor];
    try {
      await sendOne(id, job, site);
      job.sent++;
    } catch (e) {
      // 429: Telegram сам говорит, сколько подождать. Курсор не двигаем.
      if (e.retryAfter && retries < MAX_RETRIES) {
        retries++;
        await sleep(Math.min(e.retryAfter, 5) * 1000);
        continue;
      }
      // 403 — человек заблокировал бота или удалил аккаунт, это не ошибка.
      if (e.code === 403) job.blocked++;
      else { job.failed++; job.lastError = String(e && e.message || e); }
    }
    retries = 0;
    job.cursor++;
    await sleep(PAUSE_MS);
  }
  job.done = job.cursor >= job.ids.length;
  if (job.done) job.finishedAt = Date.now();
  await saveJob(job);
  return job;
}

module.exports = async (req, res) => {
  try {
    const userId = userIdFromRequest(req);
    if (!userId) {
      res.status(401).json({ error: 'Нужно войти через Telegram' });
      return;
    }
    const owner = (process.env.OWNER_TELEGRAM_ID || '').trim();
    if (!owner) {
      res.status(403).json({ error: 'Рассылка выключена: добавьте переменную OWNER_TELEGRAM_ID в настройках проекта на Vercel' });
      return;
    }
    if (owner !== userId) {
      res.status(403).json({ error: 'Рассылка доступна только владельцу' });
      return;
    }
    const site = siteUrl(req);

    if (req.method === 'GET') {
      res.status(200).json({ job: progress(await readJob()) });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const body = req.body || {};
    const mode = body.mode || 'test';
    const text = String(body.text || '').trim();
    const photo = photoUrl(body.photo, site);
    if (body.photo && !photo) {
      res.status(400).json({ error: 'Ссылка на картинку должна начинаться с https:// или с /' });
      return;
    }

    if (mode === 'test') {
      if (!text) { res.status(400).json({ error: 'Пустое сообщение' }); return; }
      if (text.length > TEXT_LIMIT) { res.status(400).json({ error: `Слишком длинно: ${text.length} из ${TEXT_LIMIT} символов` }); return; }
      await sendOne(owner, { text, photo }, site);
      res.status(200).json({ ok: true });
      return;
    }

    if (mode === 'cancel') {
      const job = await readJob();
      if (job && !job.done) {
        job.done = true;
        job.finishedAt = Date.now();
        job.cancelled = true;
        await saveJob(job);
      }
      res.status(200).json({ job: progress(job) });
      return;
    }

    // Запуск и продолжение идут под замком: повторный вызов с той же вкладки
    // (или из второго окна) не должен отправить сообщения дважды.
    const lock = await kvCommand(['SET', LOCK_KEY, String(Date.now()), 'EX', 30, 'NX']);
    if (lock !== 'OK') {
      res.status(409).json({ error: 'Рассылка уже идёт — подождите несколько секунд' });
      return;
    }

    try {
      let job = await readJob();
      if (mode === 'start') {
        if (!text) { res.status(400).json({ error: 'Пустое сообщение' }); return; }
        if (text.length > TEXT_LIMIT) { res.status(400).json({ error: `Слишком длинно: ${text.length} из ${TEXT_LIMIT} символов` }); return; }
        if (job && !job.done) {
          res.status(409).json({ error: 'Предыдущая рассылка не закончена', job: progress(job) });
          return;
        }
        const ids = Object.keys(toMap(await kvCommand(['HGETALL', 'training-log:seen']))).slice(0, MAX_USERS);
        if (!ids.length) { res.status(400).json({ error: 'Некому отправлять: список пользователей пуст' }); return; }
        job = { text, photo, ids, cursor: 0, sent: 0, failed: 0, blocked: 0, done: false, startedAt: Date.now() };
      } else if (mode === 'resume') {
        if (!job || job.done) { res.status(200).json({ job: progress(job) }); return; }
      } else {
        res.status(400).json({ error: 'Неизвестный режим' });
        return;
      }
      res.status(200).json({ job: progress(await run(job, site)) });
    } finally {
      await kvCommand(['DEL', LOCK_KEY]);
    }
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
