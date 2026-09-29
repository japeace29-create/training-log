// Вызовы: соревнование двух человек с видео-подтверждением. Здесь вся логика;
// api/compete.js отвечает приложению, api/bot.js — кнопкам и видео в Telegram,
// api/cron.js раз в четверть часа вызывает sweep() для сроков и напоминаний.

const crypto = require('crypto');
const { kvCommand, kvGet, kvSet } = require('./_lib');
const { botRequest } = require('./_auth');

const MAX_ACTIVE = 5;                       // вызовов на человека одновременно
const MAX_ATTEMPTS = 5;                     // попыток на человека в одном вызове
const REVIEW_GRACE_MS = 72 * 3600 * 1000;   // сколько после срока ждём проверки соперника
const NUDGE_MS = 12 * 3600 * 1000;          // через сколько напоминаем о непроверенном видео
const UNITS = ['повторений', 'секунд', 'минут', 'кг', 'метров'];
const DEFAULT_TZ = 'Europe/Moscow';

const K = {
  comp: id => 'training-log:comp:' + id,
  atts: id => 'training-log:comp:' + id + ':att',
  mine: uid => 'training-log:comps:' + uid,
  active: 'training-log:comps:active',
  invite: code => 'training-log:invite:' + code,
  nick: uid => 'training-log:nick:' + uid,
  pending: uid => 'training-log:pending-video:' + uid,
  banned: 'training-log:banned',
  tz: uid => 'training-log:tz:' + uid
};

const fail = (status, error) => ({ status, error });
const rid = n => crypto.randomBytes(n).toString('hex');
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const cleanText = (s, max) => String(s || '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const num = v => String(Math.round(v * 10) / 10).replace('.', ',');
const fmt = (v, unit) => num(v) + ' ' + unit;
const ownerId = () => String(process.env.OWNER_TELEGRAM_ID || '').trim();

function fromFlat(raw){
  const out = [];
  if (!raw) return out;
  if (Array.isArray(raw)) for (let i = 0; i < raw.length; i += 2) out.push(raw[i + 1]);
  else Object.values(raw).forEach(v => out.push(v));
  return out;
}
function parse(raw){
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

async function getComp(id){
  if (!/^[a-f0-9]{8}$/.test(String(id || ''))) return null;
  return parse(await kvGet(K.comp(id)));
}
function putComp(comp){
  return kvSet(K.comp(comp.id), JSON.stringify(comp));
}
async function getAttempts(compId){
  const raw = await kvCommand(['HGETALL', K.atts(compId)]);
  return fromFlat(raw).map(parse).filter(Boolean).sort((a, b) => a.at - b.at);
}
function putAttempt(compId, att){
  return kvCommand(['HSET', K.atts(compId), att.id, JSON.stringify(att)]);
}

async function names(uids){
  const list = [...new Set(uids)];
  const values = list.length ? await kvCommand(['MGET', ...list.map(K.nick)]) : [];
  const out = {};
  list.forEach((u, i) => { out[u] = (values && values[i]) || 'Участник'; });
  return out;
}
async function nameOf(uid){
  return (await names([uid]))[uid];
}
async function isBanned(uid){
  return (await kvCommand(['SISMEMBER', K.banned, String(uid)])) === 1;
}
// Суточный лимит на действие: чтобы нельзя было завалить чужой чат.
async function quota(uid, kind, max){
  const key = 'training-log:q:' + kind + ':' + uid;
  const n = await kvCommand(['INCR', key]);
  if (n === 1) await kvCommand(['EXPIRE', key, 86400]);
  return n <= max;
}

// Часовой пояс лежит отдельным ключом: читать ради него весь дневник человека дорого.
// Приложение обновляет ключ при каждом сохранении, а пока его нет — берём из данных.
async function tzOf(uid){
  const cached = await kvGet(K.tz(uid));
  if (cached) return cached;
  const data = parse(await kvGet('training-log:data:' + uid));
  const tz = (data && ((data.reminders && data.reminders.tz) || data.tz)) || DEFAULT_TZ;
  await kvCommand(['SET', K.tz(uid), tz, 'EX', 7 * 86400]);
  return tz;
}
function dateIn(tz){
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}
function addDays(date, n){
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Срок считаем по часам создателя: «до 5 октября» — до конца его пятого числа.
async function isOver(comp){
  return dateIn(await tzOf(comp.creator)) > comp.end;
}

async function tell(chat, text, markup){
  try {
    await botRequest('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', ...(markup ? { reply_markup: markup } : {}) });
  } catch (e) { console.error('compete tell failed for ' + chat, e.message); }
}
const appButton = (site, comp, text) => ({ inline_keyboard: [[{ text: text || 'Открыть вызов', web_app: { url: site + '?tab=compete&c=' + comp.id } }]] });

// ---------- ссылки на YouTube ------------------------------------------------------------

function parseYouTube(link){
  let url;
  try { url = new URL(String(link || '').trim()); } catch (e) { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1);
  else if (host === 'youtube.com'){
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = /^\/(?:shorts|live|embed)\/([\w-]{11})/.exec(url.pathname);
      if (m) id = m[1];
    }
  }
  return /^[\w-]{11}$/.test(id || '') ? id : null;
}
// Открытый интерфейс YouTube не отдаёт дату загрузки, зато отдаёт название и
// говорит, доступно ли видео и разрешена ли вставка. Код в названии — защита от
// старых роликов: заранее его не знает никто.
async function checkYouTube(id, code){
  let res;
  try {
    res = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id) + '&format=json');
  } catch (e) {
    return { error: 'YouTube сейчас не отвечает. Попробуйте чуть позже.' };
  }
  if (res.status === 401) return { error: 'Автор запретил вставлять это видео. Разрешите встраивание в настройках ролика на YouTube.' };
  if (res.status === 404 || res.status === 400) return { error: 'Видео не нашлось или закрыто. Откройте доступ по ссылке и повторите.' };
  if (!res.ok) return { error: 'YouTube сейчас не отвечает. Попробуйте чуть позже.' };
  const info = await res.json().catch(() => ({}));
  const title = String(info.title || '');
  if (!title.includes(code)) return { error: 'В названии ролика нет кода ' + code + '. Впишите его в название и отправьте ссылку ещё раз.' };
  return { ok: true, title: title.slice(0, 100), author: String(info.author_name || '').slice(0, 60), thumb: String(info.thumbnail_url || '') };
}

// ---------- итоги и победитель -----------------------------------------------------------

function standings(comp, atts){
  return comp.players.map(uid => {
    const ok = atts.filter(a => a.user === uid && a.status === 'ok').map(a => a.value);
    return {
      uid,
      best: ok.length ? (comp.dir === 'min' ? Math.min(...ok) : Math.max(...ok)) : null,
      pending: atts.filter(a => a.user === uid && a.status === 'review').length
    };
  });
}
function decideWinner(comp, atts){
  const s = standings(comp, atts);
  if (s.length < 2) return { winner: null, reason: 'alone', s };
  const [a, b] = s;
  if (a.best == null && b.best == null) return { winner: null, reason: 'none', s };
  if (a.best == null) return { winner: b.uid, s };
  if (b.best == null) return { winner: a.uid, s };
  if (a.best === b.best) return { winner: null, reason: 'tie', s };
  const aWins = comp.dir === 'min' ? a.best < b.best : a.best > b.best;
  return { winner: aWins ? a.uid : b.uid, s };
}

// ---------- создание и вступление --------------------------------------------------------

async function myComps(uid){
  const ids = (await kvCommand(['LRANGE', K.mine(uid), -20, -1])) || [];
  const list = [];
  for (const id of ids){
    const comp = await getComp(id);
    if (comp) list.push(comp);
  }
  return list;
}
async function activeCount(uid){
  return (await myComps(uid)).filter(c => c.status === 'open' || c.status === 'active').length;
}
async function remember(uid, compId){
  await kvCommand(['RPUSH', K.mine(uid), compId]);
  await kvCommand(['LTRIM', K.mine(uid), -40, -1]);
}
async function setNick(uid, nick, onlyIfEmpty){
  const clean = cleanText(nick, 24);
  if (clean.length < 2) return false;
  await kvCommand(onlyIfEmpty ? ['SET', K.nick(uid), clean, 'NX'] : ['SET', K.nick(uid), clean]);
  return true;
}

async function create(uid, body){
  if (await isBanned(uid)) return fail(403, 'Создавать вызовы вам сейчас нельзя');
  if (!(await quota(uid, 'create', 10))) return fail(429, 'На сегодня хватит: слишком много вызовов подряд');
  const title = cleanText(body.title, 40);
  if (title.length < 3) return fail(400, 'Назовите вызов: хотя бы три буквы');
  const unit = UNITS.includes(body.unit) ? body.unit : null;
  if (!unit) return fail(400, 'Выберите, в чём меряем');
  const end = String(body.end || '');
  const today = dateIn(await tzOf(uid));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || end <= today) return fail(400, 'Срок должен быть позже сегодняшнего дня');
  if (end > addDays(today, 60)) return fail(400, 'Срок не дальше двух месяцев');
  if ((await activeCount(uid)) >= MAX_ACTIVE) return fail(409, 'Уже идёт пять вызовов — завершите или отмените один');
  await setNick(uid, body.nick, true);
  const comp = {
    id: rid(4), title, dir: body.dir === 'min' ? 'min' : 'max', unit, end,
    creator: uid, players: [uid], status: 'open', created: Date.now(), code: rid(5)
  };
  await putComp(comp);
  await remember(uid, comp.id);
  await kvCommand(['SADD', K.active, comp.id]);
  await kvCommand(['SET', K.invite(comp.code), comp.id, 'EX', 30 * 86400]);
  return { comp: comp.id, code: comp.code };
}

async function join(uid, code, nickHint, site){
  if (await isBanned(uid)) return fail(403, 'Участвовать в вызовах вам сейчас нельзя');
  if (!/^[a-f0-9]{10}$/.test(String(code || ''))) return fail(400, 'Код приглашения неверный');
  const id = await kvCommand(['GETDEL', K.invite(code)]);
  if (!id) return fail(404, 'Приглашение устарело или уже использовано');
  const comp = await getComp(id);
  if (!comp || comp.status !== 'open') return fail(404, 'Этот вызов уже не ждёт соперника');
  if (comp.creator === uid){
    // Свою ссылку не тратим: её ещё нужно отправить другу.
    await kvCommand(['SET', K.invite(code), comp.id, 'EX', 30 * 86400]);
    return fail(400, 'Это ваше приглашение — отправьте его другу');
  }
  if ((await activeCount(uid)) >= MAX_ACTIVE){
    await kvCommand(['SET', K.invite(code), comp.id, 'EX', 30 * 86400]);
    return fail(409, 'У вас уже пять вызовов — завершите один, потом присоединяйтесь');
  }
  if (await isOver(comp)){
    return fail(410, 'Срок этого вызова уже прошёл');
  }
  await setNick(uid, nickHint, true);
  comp.players.push(uid);
  comp.status = 'active';
  comp.joined = Date.now();
  await putComp(comp);
  await remember(uid, comp.id);
  const name = await nameOf(uid);
  await tell(comp.creator, `В вызове «${esc(comp.title)}» появился соперник: <b>${esc(name)}</b>. Записывайте результат в дневнике: без видео он не считается.`, appButton(site, comp));
  return { comp: comp.id, title: comp.title };
}

// ---------- попытки и видео ---------------------------------------------------------------

function memberOf(comp, uid){
  return comp && comp.players.includes(uid);
}
function otherPlayer(comp, uid){
  return comp.players.find(p => p !== uid) || null;
}

async function attempt(uid, body){
  const comp = await getComp(body.comp);
  if (!memberOf(comp, uid)) return fail(404, 'Такого вызова нет');
  if (await isBanned(uid)) return fail(403, 'Участвовать в вызовах вам сейчас нельзя');
  if (comp.status !== 'active') return fail(409, comp.status === 'open' ? 'Соперник ещё не принял вызов' : 'Вызов уже закончился');
  if (await isOver(comp)) return fail(409, 'Срок вызова прошёл');
  if (!(await quota(uid, 'attempt', 30))) return fail(429, 'На сегодня попыток достаточно');
  const raw = Number(String(body.value == null ? '' : body.value).replace(',', '.'));
  const value = Math.round(raw * 10) / 10;
  if (!(value > 0 && value <= 1000000)) return fail(400, 'Впишите результат: число больше нуля');
  const atts = await getAttempts(comp.id);
  const mine = atts.filter(a => a.user === uid && a.status !== 'removed');
  // Прежняя попытка без видео заменяется новой, а не считается за попытку.
  for (const a of mine.filter(a => a.status === 'need_video')){
    await kvCommand(['HDEL', K.atts(comp.id), a.id]);
  }
  if (mine.filter(a => a.status !== 'need_video').length >= MAX_ATTEMPTS) return fail(409, 'Попыток больше нет: не больше пяти на вызов');
  const att = { id: rid(4), user: uid, value, at: Date.now(), code: String(crypto.randomInt(1000, 10000)), status: 'need_video', video: null };
  await putAttempt(comp.id, att);
  await kvCommand(['SET', K.pending(uid), comp.id + ':' + att.id, 'EX', 3600]);
  return { attempt: att.id, code: att.code };
}

async function findMyAttempt(uid, compId, attId){
  const comp = await getComp(compId);
  if (!memberOf(comp, uid)) return { error: fail(404, 'Такого вызова нет') };
  const att = parse(await kvCommand(['HGET', K.atts(comp.id), String(attId || '')]));
  if (!att) return { error: fail(404, 'Такой попытки нет') };
  return { comp, att };
}

async function reviewText(comp, att){
  const name = await nameOf(att.user);
  return `Результат от <b>${esc(name)}</b> в вызове «${esc(comp.title)}»: <b>${esc(fmt(att.value, comp.unit))}</b>.\n\n`
    + `Код на видео: <b>${att.code}</b> — его должно быть слышно или видно. Посмотрите и решите.`;
}
const reviewKeyboard = (site, comp, att) => ({
  inline_keyboard: [
    [{ text: '✅ Засчитать', callback_data: `ok:${comp.id}:${att.id}` }, { text: '❌ Не засчитывать', callback_data: `no:${comp.id}:${att.id}` }],
    [{ text: '🚩 Пожаловаться', callback_data: `rp:${comp.id}:${att.id}` }],
    [{ text: 'Открыть вызов', web_app: { url: site + '?tab=compete&c=' + comp.id } }]
  ]
});

// Отправляет чужое видео в чат: сам ролик, а под ним — текст с кнопками.
async function sendMedia(chat, att, text, markup){
  try {
    const v = att.video;
    if (!v) return;
    if (v.kind === 'yt'){
      await botRequest('sendMessage', { chat_id: chat, parse_mode: 'HTML', text: text + '\n\nhttps://youtu.be/' + v.id, ...(markup ? { reply_markup: markup } : {}) });
    } else if (v.note){
      await botRequest('sendVideoNote', { chat_id: chat, video_note: v.file });
      await botRequest('sendMessage', { chat_id: chat, parse_mode: 'HTML', text, ...(markup ? { reply_markup: markup } : {}) });
    } else {
      await botRequest('sendVideo', { chat_id: chat, video: v.file, parse_mode: 'HTML', caption: text, ...(markup ? { reply_markup: markup } : {}) });
    }
  } catch (e) { console.error('compete sendMedia failed for ' + chat, e.message); }
}

async function notifyReview(comp, att, site){
  const reviewer = otherPlayer(comp, att.user);
  if (!reviewer) return;
  await sendMedia(reviewer, att, await reviewText(comp, att), reviewKeyboard(site, comp, att));
}

async function attachLink(uid, body, site){
  const found = await findMyAttempt(uid, body.comp, body.attempt);
  if (found.error) return found.error;
  const { comp, att } = found;
  if (att.user !== uid) return fail(403, 'Это не ваша попытка');
  if (att.status !== 'need_video') return fail(409, 'К этой попытке видео уже приложено');
  const id = parseYouTube(body.link);
  if (!id) return fail(400, 'Нужна ссылка на видео YouTube');
  const check = await checkYouTube(id, att.code);
  if (check.error) return fail(422, check.error);
  att.video = { kind: 'yt', id, title: check.title, author: check.author, thumb: check.thumb };
  att.status = 'review';
  att.sentAt = Date.now();
  await putAttempt(comp.id, att);
  await kvCommand(['DEL', K.pending(uid)]);
  await notifyReview(comp, att, site);
  return { ok: true };
}

// Видео, присланное боту: привязываем к последней попытке, которая ждёт ролика.
async function attachTelegramVideo(uid, msg, site){
  if (await isBanned(uid)) return fail(403, 'Участвовать в вызовах вам сейчас нельзя');
  const pending = await kvGet(K.pending(uid));
  if (!pending) return fail(404, 'Сначала запишите результат в дневнике: «Вызов» → вызов → «Записать результат». Потом пришлите видео.');
  const [compId, attId] = String(pending).split(':');
  const found = await findMyAttempt(uid, compId, attId);
  if (found.error) return fail(404, 'Попытка не нашлась. Запишите результат в дневнике заново.');
  const { comp, att } = found;
  if (att.user !== uid || att.status !== 'need_video') return fail(409, 'К этой попытке видео уже приложено');
  // Пересланное могло быть снято когда угодно и кем угодно.
  if (msg.forward_origin || msg.forward_date) return fail(400, 'Пересланные видео не принимаем: снимите и отправьте своё.');
  const media = msg.video || msg.video_note;
  const seconds = Number(media && media.duration) || 0;
  if (seconds < 3) return fail(400, 'Видео слишком короткое: хотя бы три секунды.');
  if (seconds > 300) return fail(400, 'Видео слишком длинное: не больше пяти минут.');
  if (Number(media.file_size) > 150 * 1024 * 1024) return fail(400, 'Видео слишком тяжёлое.');
  att.video = { kind: 'tg', file: media.file_id, note: !!msg.video_note, duration: seconds };
  att.status = 'review';
  att.sentAt = Date.now();
  await putAttempt(comp.id, att);
  await kvCommand(['DEL', K.pending(uid)]);
  await notifyReview(comp, att, site);
  const opponent = await nameOf(otherPlayer(comp, uid));
  return { ok: true, comp, opponent };
}

// ---------- проверка, жалобы, модерация ------------------------------------------------------

async function decide(uid, compId, attId, verdict, site){
  const found = await findMyAttempt(uid, compId, attId);
  if (found.error) return found.error;
  const { comp, att } = found;
  if (att.user === uid) return fail(403, 'Свой результат подтверждает соперник');
  if (att.status !== 'review') return fail(409, att.status === 'ok' || att.status === 'no' ? 'Вы уже ответили на это видео' : 'Видео сейчас не ждёт проверки');
  att.status = verdict === 'ok' ? 'ok' : 'no';
  att.by = uid;
  att.decidedAt = Date.now();
  await putAttempt(comp.id, att);
  const name = await nameOf(uid);
  if (att.status === 'ok'){
    await tell(att.user, `✅ Ваш результат в вызове «${esc(comp.title)}» засчитан: ${esc(fmt(att.value, comp.unit))}. Проверял: <b>${esc(name)}</b>.`, appButton(site, comp));
  } else {
    await tell(att.user, `❌ Ваш результат ${esc(fmt(att.value, comp.unit))} в вызове «${esc(comp.title)}» не засчитан. Проверял: <b>${esc(name)}</b>. Можно записать новую попытку и снять видео так, чтобы всё было видно.`, appButton(site, comp));
  }
  return { ok: true, status: att.status, toast: att.status === 'ok' ? 'Засчитано' : 'Не засчитано', label: att.status === 'ok' ? '✅ Вы засчитали' : '❌ Вы не засчитали' };
}

async function report(uid, compId, attId, site){
  const found = await findMyAttempt(uid, compId, attId);
  if (found.error) return found.error;
  const { comp, att } = found;
  if (att.user === uid) return fail(403, 'На свои видео жаловаться нельзя');
  if (att.status === 'held' || att.status === 'removed') return fail(409, 'Жалоба уже отправлена');
  if (!(await quota(uid, 'report', 10))) return fail(429, 'Слишком много жалоб за день');
  att.status = 'held';
  att.reportedBy = uid;
  await putAttempt(comp.id, att);
  const owner = ownerId();
  if (owner){
    const text = `🚩 Жалоба на видео в вызове «${esc(comp.title)}».\nАвтор: <b>${esc(await nameOf(att.user))}</b> (${att.user}), результат ${esc(fmt(att.value, comp.unit))}.\nЖалоба от: ${esc(await nameOf(uid))}.`;
    await sendMedia(owner, att, text, { inline_keyboard: [
      [{ text: 'Удалить видео', callback_data: `ad:${comp.id}:${att.id}` }, { text: 'Всё в порядке', callback_data: `ao:${comp.id}:${att.id}` }],
      [{ text: 'Заблокировать автора', callback_data: `ab:${comp.id}:${att.id}` }]
    ] });
  } else {
    att.status = 'removed';
    await putAttempt(comp.id, att);
  }
  return { ok: true, toast: 'Жалоба отправлена, видео скрыто', label: '🚩 Жалоба отправлена' };
}

async function ownerAction(uid, act, compId, attId, site){
  if (!ownerId() || uid !== ownerId()) return fail(403, 'Это действие только для владельца');
  const comp = await getComp(compId);
  const att = comp && parse(await kvCommand(['HGET', K.atts(comp.id), String(attId || '')]));
  if (!comp || !att) return fail(404, 'Попытка не нашлась');
  if (act === 'ao'){
    att.status = 'review';
    await putAttempt(comp.id, att);
    await notifyReview(comp, att, site);
    return { ok: true, toast: 'Вернул на проверку', label: '✔ Оставлено' };
  }
  att.status = 'removed';
  await putAttempt(comp.id, att);
  await tell(att.user, `Ваше видео в вызове «${esc(comp.title)}» удалено модератором: результат не засчитан.`);
  if (act === 'ab'){
    await kvCommand(['SADD', K.banned, att.user]);
    for (const c of await myComps(att.user)){
      if (c.status === 'open' || c.status === 'active') await cancelComp(c, att.user, site, 'участник заблокирован');
    }
    return { ok: true, toast: 'Автор заблокирован', label: '⛔ Автор заблокирован' };
  }
  return { ok: true, toast: 'Видео удалено', label: '🗑 Удалено' };
}

async function cancelComp(comp, byUid, site, why){
  comp.status = 'cancelled';
  comp.cancelledBy = byUid;
  await putComp(comp);
  await kvCommand(['SREM', K.active, comp.id]);
  if (comp.code) await kvCommand(['DEL', K.invite(comp.code)]);
  const other = otherPlayer(comp, byUid);
  if (other) await tell(other, `Вызов «${esc(comp.title)}» отменён${why ? ': ' + esc(why) : ''}.`);
}
async function cancel(uid, compId, site){
  const comp = await getComp(compId);
  if (!memberOf(comp, uid)) return fail(404, 'Такого вызова нет');
  if (comp.status !== 'open' && comp.status !== 'active') return fail(409, 'Вызов уже закончился');
  await cancelComp(comp, uid, site, 'участник вышел');
  return { ok: true };
}

async function watch(uid, compId, attId, site){
  const found = await findMyAttempt(uid, compId, attId);
  if (found.error) return found.error;
  const { comp, att } = found;
  if (!att.video) return fail(404, 'Видео ещё нет');
  if (att.status === 'held' || att.status === 'removed') return fail(409, 'Видео скрыто');
  const canReview = att.user !== uid && att.status === 'review';
  await sendMedia(uid, att, await reviewText(comp, att), canReview ? reviewKeyboard(site, comp, att) : null);
  return { ok: true };
}

// ---------- что видит приложение ------------------------------------------------------------

async function view(uid, compId){
  const comp = await getComp(compId);
  if (!memberOf(comp, uid)) return fail(404, 'Такого вызова нет');
  const atts = await getAttempts(comp.id);
  const who = await names(comp.players);
  const s = standings(comp, atts);
  const outcome = comp.status === 'finished' ? decideWinner(comp, atts) : null;
  return {
    comp: {
      id: comp.id, title: comp.title, dir: comp.dir, unit: comp.unit, end: comp.end, status: comp.status,
      creator: comp.creator === uid, code: comp.status === 'open' && comp.creator === uid ? comp.code : null
    },
    players: comp.players.map(p => ({ id: p, name: who[p], me: p === uid })),
    standings: s.map(x => ({ id: x.uid, name: who[x.uid], me: x.uid === uid, best: x.best, pending: x.pending })),
    winner: outcome ? (outcome.winner ? { id: outcome.winner, name: who[outcome.winner], me: outcome.winner === uid } : { id: null, reason: outcome.reason }) : null,
    attempts: atts.filter(a => a.status !== 'removed').map(a => ({
      id: a.id, mine: a.user === uid, name: who[a.user], value: a.value, at: a.at, status: a.status, code: a.code,
      canReview: a.status === 'review' && a.user !== uid,
      video: a.video ? (a.video.kind === 'yt'
        ? { kind: 'yt', id: a.video.id, title: a.video.title, thumb: a.video.thumb }
        : { kind: 'tg', note: !!a.video.note }) : null
    }))
  };
}

async function list(uid){
  const comps = (await myComps(uid)).reverse();
  const out = [];
  for (const comp of comps){
    const atts = comp.status === 'open' ? [] : await getAttempts(comp.id);
    const s = standings(comp, atts);
    const me = s.find(x => x.uid === uid);
    const them = s.find(x => x.uid !== uid);
    const opponent = otherPlayer(comp, uid);
    out.push({
      id: comp.id, title: comp.title, status: comp.status, end: comp.end, unit: comp.unit, dir: comp.dir,
      opponent: opponent ? await nameOf(opponent) : null,
      me: me ? me.best : null, them: them ? them.best : null,
      result: comp.status === 'finished' ? (comp.result && comp.result.winner === uid ? 'win' : comp.result && comp.result.winner ? 'lose' : 'draw') : null,
      review: atts.filter(a => a.status === 'review' && a.user !== uid).length,
      needVideo: atts.filter(a => a.status === 'need_video' && a.user === uid).length
    });
  }
  return { challenges: out, nick: await kvGet(K.nick(uid)) };
}

async function badge(uid){
  let n = 0;
  for (const comp of (await myComps(uid)).filter(c => c.status === 'active')){
    const atts = await getAttempts(comp.id);
    n += atts.filter(a => (a.status === 'review' && a.user !== uid) || (a.status === 'need_video' && a.user === uid)).length;
  }
  return { n };
}

// ---------- сроки, напоминания, итоги (раз в четверть часа из cron) ----------------------------

async function finalize(comp, atts, site){
  const outcome = decideWinner(comp, atts);
  comp.status = 'finished';
  comp.finishedAt = Date.now();
  comp.result = { winner: outcome.winner || null };
  await putComp(comp);
  await kvCommand(['SREM', K.active, comp.id]);
  const who = await names(comp.players);
  const [a, b] = outcome.s;
  let line;
  if (outcome.winner){
    const w = outcome.s.find(x => x.uid === outcome.winner);
    const l = outcome.s.find(x => x.uid !== outcome.winner);
    line = `Победил <b>${esc(who[w.uid])}</b>: ${esc(fmt(w.best, comp.unit))}` + (l && l.best != null ? ` против ${esc(fmt(l.best, comp.unit))}.` : `, у соперника нет засчитанного результата.`);
  } else if (outcome.reason === 'tie'){
    line = `Ничья: у обоих ${esc(fmt(a.best, comp.unit))}.`;
  } else {
    line = 'Ни у кого нет засчитанного результата — победителя нет.';
  }
  for (const p of comp.players){
    await tell(p, `🏁 Вызов «${esc(comp.title)}» завершён.\n\n${line}`, appButton(site, comp, 'Открыть итоги'));
  }
}

async function sweep(site){
  const ids = (await kvCommand(['SMEMBERS', K.active])) || [];
  const out = { finished: 0, reminded: 0 };
  for (const id of ids){
    const comp = await getComp(id);
    if (!comp || (comp.status !== 'open' && comp.status !== 'active')){
      await kvCommand(['SREM', K.active, id]);
      continue;
    }
    const today = dateIn(await tzOf(comp.creator));
    if (comp.status === 'open'){
      if (today > comp.end){
        comp.status = 'expired';
        await putComp(comp);
        await kvCommand(['SREM', K.active, comp.id]);
        await kvCommand(['DEL', K.invite(comp.code)]);
        await tell(comp.creator, `Вызов «${esc(comp.title)}» истёк: соперник так и не принял приглашение.`);
        out.finished++;
      }
      continue;
    }
    const atts = await getAttempts(comp.id);
    // За день до конца напоминаем тем, у кого ещё нет засчитанного результата.
    if (!comp.remindedEnd && addDays(today, 1) === comp.end){
      comp.remindedEnd = true;
      await putComp(comp);
      for (const p of comp.players){
        if (!atts.some(a => a.user === p && (a.status === 'ok' || a.status === 'review'))){
          await tell(p, `⏰ Вызов «${esc(comp.title)}» заканчивается завтра, а у вас ещё нет результата.`, appButton(site, comp));
          out.reminded++;
        }
      }
    }
    // Соперник не ответил на видео за полдня — напоминаем один раз.
    for (const a of atts.filter(a => a.status === 'review' && !a.nudged && Date.now() - (a.sentAt || a.at) > NUDGE_MS)){
      a.nudged = true;
      await putAttempt(comp.id, a);
      const reviewer = otherPlayer(comp, a.user);
      if (reviewer) await tell(reviewer, `Видео в вызове «${esc(comp.title)}» ждёт вашей проверки.`, appButton(site, comp));
      out.reminded++;
    }
    if (today > comp.end){
      if (!comp.endedAt){ comp.endedAt = Date.now(); await putComp(comp); }
      const waiting = atts.filter(a => a.status === 'review');
      if (waiting.length && Date.now() - comp.endedAt < REVIEW_GRACE_MS) continue;
      // Соперник так и не ответил за трое суток: результат засчитываем, чтобы не наказывать честного.
      for (const a of waiting){
        a.status = 'ok';
        a.auto = true;
        await putAttempt(comp.id, a);
      }
      await finalize(comp, await getAttempts(comp.id), site);
      out.finished++;
    }
  }
  return out;
}

module.exports = {
  create, join, attempt, attachLink, attachTelegramVideo, decide, report, ownerAction,
  cancel, watch, view, list, badge, sweep, setNick, parseYouTube, checkYouTube,
  standings, decideWinner, dateIn, addDays, isBanned
};
